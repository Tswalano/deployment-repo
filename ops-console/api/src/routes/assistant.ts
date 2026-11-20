import { Context, Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { ask, deleteConversations, getConversation, listConversations, monthUsage } from '../assistant/chat';
import { addModel, AssistantConfig, CLAUDE_MODELS, getConfig, getKey, listModels, ModelEntry, pickModel, Provider, PROVIDER_NAMES, PROVIDERS, removeKey, removeModel, removeSettings, saveSettings, setDefaultModel, setKey, usableModels, validKey } from '../assistant/providers';
import { audit } from '../audit';
import { config } from '../config';
import { db, withWorkspace } from '../db';
import { DeployError } from '../deploys';
import { denyDemo, Env, rateLimit, requireRole } from '../middleware';

/**
 * /api/assistant: "Ask Ops Console" (read-only answers about the workspace) with the workspace's own AI provider key.
 * Not in the demo. Admins choose the provider (Claude or ChatGPT) and model and paste the key; the key is never shown again.
 */
const assistant = new Hono<Env>();
assistant.use('*', requireRole('viewer'), denyDemo);
const wsOf = (c: Context<Env>) => c.get('user')!.workspaceId ?? (config.multiTenant ? null : 1);
const isProvider = (p: unknown): p is Provider => p === 'anthropic' || p === 'openai';
const fail = (c: Context<Env>, err: unknown) => {
    if (err instanceof DeployError) return c.json({ error: err.message, code: err.code }, err.status as 400);
    throw err;
};

const modelView = (m: ModelEntry, defaultId: string | null) => ({ id: m.id, provider: m.provider, providerName: PROVIDER_NAMES[m.provider], model: m.model, isDefault: m.id === defaultId, addedBy: m.addedBy, addedAt: m.addedAt });

assistant.get('/', async (c) => {
    const cfg = await getConfig();
    const models = usableModels(cfg);
    const def = pickModel(cfg);
    return c.json({
        enabled: models.length > 0, provider: def?.provider ?? null, providerName: def ? PROVIDER_NAMES[def.provider] : null, model: def?.model ?? null,
        models: models.map((m) => modelView(m, def?.id ?? null)), defaultModelId: def?.id ?? null,
        canConfigure: c.get('user')!.role === 'admin',
        conversations: await listConversations(c.get('user')!.id),
    });
});

// ------------------------------------------------------------------ the person's own chats
assistant.get('/conversations', async (c) => c.json({ conversations: await listConversations(c.get('user')!.id, Number(c.req.query('limit') || 100)) }));
assistant.get('/conversations/:id', async (c) => {
    const conv = await getConversation(c.get('user')!.id, c.req.param('id'));
    return conv ? c.json(conv) : c.json({ error: 'Conversation not found.' }, 404);
});
assistant.delete('/conversations/:id', async (c) => {
    const n = await deleteConversations(c.get('user')!.id, c.req.param('id'));
    return n ? c.json({ ok: true, deleted: n }) : c.json({ error: 'Conversation not found.' }, 404);
});
assistant.delete('/conversations', async (c) => {
    const user = c.get('user')!;
    const n = await deleteConversations(user.id);
    await audit({ id: user.id, username: user.username }, 'assistant.chats_cleared', null, { deleted: n }, c.get('ip'));
    return c.json({ ok: true, deleted: n });
});

// ------------------------------------------------------------------ configuration (admins): one key per provider, the models people can use
const keyProblem = (p: Provider, k: string) => (validKey(p, k) ? null : `That doesn't look like ${p === 'anthropic' ? 'an Anthropic key (sk-ant-…)' : 'an OpenAI key (sk-…)'}.`);
const configView = (cfg: AssistantConfig) => ({
    keys: Object.fromEntries(PROVIDERS.map((p) => [p, cfg.keys[p] ?? null])),
    models: cfg.models.map((m) => ({ ...modelView(m, cfg.defaultModelId), usable: !!cfg.keys[m.provider] })),
    defaultModelId: cfg.defaultModelId,
});
const admin = [requireRole('admin'), rateLimit(30, 10 * 60_000, (c) => `assistant-settings:${c.get('user')!.id}`)] as const;
const who = (c: Context<Env>) => ({ id: c.get('user')!.id, username: c.get('user')!.username });

assistant.get('/settings', requireRole('admin'), async (c) => {
    return c.json({ ...configView(await getConfig()), usage: await monthUsage(), providers: PROVIDER_NAMES, claudeModels: CLAUDE_MODELS });
});
/** The models a key can use: a key being added, or the stored one for that provider. */
assistant.post('/models', ...admin, async (c) => {
    const b = await c.req.json().catch(() => ({})) as { provider?: unknown; apiKey?: unknown };
    if (!isProvider(b.provider)) return c.json({ error: 'Choose Claude or ChatGPT.' }, 400);
    try {
        const key = typeof b.apiKey === 'string' && b.apiKey.trim() ? b.apiKey.trim() : await getKey(wsOf(c)!, b.provider);
        if (!key) return c.json({ error: `Add the ${PROVIDER_NAMES[b.provider]} API key first.` }, 400);
        return c.json(await listModels(b.provider, key));
    } catch (err) { return fail(c, err); }
});
/** Add or change a provider's key (checked with the provider first). */
assistant.put('/keys/:provider', ...admin, async (c) => {
    const p = c.req.param('provider');
    if (!isProvider(p)) return c.json({ error: 'Choose Claude or ChatGPT.' }, 400);
    const b = await c.req.json().catch(() => ({})) as { apiKey?: unknown };
    const apiKey = typeof b.apiKey === 'string' ? b.apiKey.trim() : '';
    const problem = keyProblem(p, apiKey);
    if (problem) return c.json({ error: problem }, 400);
    try {
        const had = !!(await getConfig()).keys[p];
        await listModels(p, apiKey);
        const cfg = await setKey(wsOf(c)!, p, apiKey, c.get('user')!.username);
        await audit(who(c), had ? 'assistant.key_changed' : 'assistant.key_added', PROVIDER_NAMES[p], {}, c.get('ip'));
        return c.json(configView(cfg));
    } catch (err) { return fail(c, err); }
});
assistant.delete('/keys/:provider', ...admin, async (c) => {
    const p = c.req.param('provider');
    if (!isProvider(p)) return c.json({ error: 'Choose Claude or ChatGPT.' }, 400);
    try {
        const cfg = await removeKey(wsOf(c)!, p, c.get('user')!.username);
        await audit(who(c), 'assistant.key_removed', PROVIDER_NAMES[p], {}, c.get('ip'));
        return c.json(configView(cfg));
    } catch (err) { return fail(c, err); }
});
/** Add a model people can use (one the provider's key can use). */
assistant.post('/configured-models', ...admin, async (c) => {
    const b = await c.req.json().catch(() => ({})) as { provider?: unknown; model?: unknown };
    if (!isProvider(b.provider)) return c.json({ error: 'Choose Claude or ChatGPT.' }, 400);
    const model = typeof b.model === 'string' ? b.model.trim() : '';
    try {
        const key = await getKey(wsOf(c)!, b.provider);
        if (!key) return c.json({ error: `Add the ${PROVIDER_NAMES[b.provider]} API key first.` }, 400);
        if (!(await listModels(b.provider, key)).models.includes(model)) return c.json({ error: 'Choose one of the models the key can use.' }, 400);
        const cfg = await addModel(b.provider, model, c.get('user')!.username);
        await audit(who(c), 'assistant.model_added', model, { provider: b.provider }, c.get('ip'));
        return c.json(configView(cfg));
    } catch (err) { return fail(c, err); }
});
assistant.post('/configured-models/:id/default', ...admin, async (c) => {
    try { return c.json(configView(await setDefaultModel(c.req.param('id'), c.get('user')!.username))); } catch (err) { return fail(c, err); }
});
assistant.delete('/configured-models/:id', ...admin, async (c) => {
    try {
        const cfg = await removeModel(c.req.param('id'), c.get('user')!.username);
        await audit(who(c), 'assistant.model_removed', c.req.param('id'), {}, c.get('ip'));
        return c.json(configView(cfg));
    } catch (err) { return fail(c, err); }
});
/** Set up in one step: a key (if given) and a model, made the default. */
assistant.put('/settings', ...admin, async (c) => {
    const b = await c.req.json().catch(() => ({})) as { provider?: unknown; model?: unknown; apiKey?: unknown };
    if (!isProvider(b.provider)) return c.json({ error: 'Choose Claude or ChatGPT.' }, 400);
    const model = typeof b.model === 'string' ? b.model.trim() : '';
    const apiKey = typeof b.apiKey === 'string' && b.apiKey.trim() ? b.apiKey.trim() : null;
    if (apiKey && keyProblem(b.provider, apiKey)) return c.json({ error: keyProblem(b.provider, apiKey) }, 400);
    try {
        const key = apiKey ?? await getKey(wsOf(c)!, b.provider);
        if (!key) return c.json({ error: `Paste the ${PROVIDER_NAMES[b.provider]} API key.` }, 400);
        if (!(await listModels(b.provider, key)).models.includes(model)) return c.json({ error: 'Choose one of the models this key can use.' }, 400);
        const cfg = await saveSettings(wsOf(c)!, { provider: b.provider, model, apiKey }, c.get('user')!.username);
        await audit(who(c), 'assistant.settings', null, { provider: b.provider, model, keyChanged: !!apiKey }, c.get('ip'));
        const def = cfg.models.find((m) => m.id === cfg.defaultModelId)!;
        return c.json({ ...configView(cfg), settings: { provider: def.provider, model: def.model, keyLast4: cfg.keys[def.provider]!.last4 } });
    } catch (err) { return fail(c, err); }
});
assistant.delete('/settings', ...admin, async (c) => {
    try {
        await removeSettings(wsOf(c)!);
        await audit(who(c), 'assistant.settings.removed', null, {}, c.get('ip'));
        return c.json({ ok: true });
    } catch (err) { return fail(c, err); }
});

// ------------------------------------------------------------------ asking
assistant.post('/ask', rateLimit(20, 10 * 60_000, (c) => `assistant:${c.get('user')!.id}`), async (c) => {
    const user = c.get('user')!;
    const b = await c.req.json().catch(() => ({})) as { question?: unknown; conversationId?: unknown; modelId?: unknown };
    const ws = wsOf(c)!;
    const { rows: [w] } = await db().query<{ name: string }>('SELECT name FROM workspaces WHERE id = $1', [ws]);
    c.header('X-Accel-Buffering', 'no');   // nginx: pass each event on at once instead of buffering the answer
    return streamSSE(c, async (stream) => {
        const emit = (e: { type: string }) => stream.writeSSE({ event: e.type, data: JSON.stringify(e) });
        try {
            await withWorkspace(ws, () => ask({
                userId: user.id, username: user.username, workspaceId: ws, workspace: w?.name ?? 'this workspace', role: user.role,
                conversationId: typeof b.conversationId === 'string' && /^[0-9a-f]{24}$/.test(b.conversationId) ? b.conversationId : null,
                modelId: typeof b.modelId === 'string' ? b.modelId.slice(0, 40) : null, question: String(b.question ?? ''), emit,
            }));
            await withWorkspace(ws, () => audit({ id: user.id, username: user.username }, 'assistant.ask', null, {}, c.get('ip')));
        } catch (err) {
            const message = err instanceof DeployError ? err.message : 'The assistant could not answer right now. Try again in a moment.';
            if (!(err instanceof DeployError)) console.error('assistant failed:', (err as Error).message);
            await emit({ type: 'error', message } as { type: string });
        }
    });
});

export default assistant;
