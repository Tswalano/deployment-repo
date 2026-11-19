import { Context, Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { ask, getConversation, listConversations, monthUsage } from '../assistant/chat';
import { CLAUDE_MODELS, getKey, getSettings, listModels, Provider, PROVIDER_NAMES, removeSettings, saveSettings, validKey } from '../assistant/providers';
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

assistant.get('/', async (c) => {
    const s = await getSettings();
    return c.json({
        enabled: !!s, provider: s?.provider ?? null, providerName: s ? PROVIDER_NAMES[s.provider] : null, model: s?.model ?? null,
        canConfigure: c.get('user')!.role === 'admin',
        conversations: s ? await listConversations(c.get('user')!.id) : [],
    });
});

assistant.get('/conversations/:id', async (c) => {
    const conv = await getConversation(c.get('user')!.id, c.req.param('id'));
    return conv ? c.json(conv) : c.json({ error: 'Conversation not found.' }, 404);
});

// ------------------------------------------------------------------ settings (admins)
assistant.get('/settings', requireRole('admin'), async (c) => {
    const s = await getSettings();
    return c.json({ settings: s, usage: await monthUsage(), providers: PROVIDER_NAMES, claudeModels: CLAUDE_MODELS });
});
/** Check a key (a new one, or the saved one for the saved provider) and list the models it can use. */
assistant.post('/models', requireRole('admin'), rateLimit(20, 10 * 60_000, (c) => `assistant-models:${c.get('user')!.id}`), async (c) => {
    const b = await c.req.json().catch(() => ({})) as { provider?: unknown; apiKey?: unknown };
    if (!isProvider(b.provider)) return c.json({ error: 'Choose Claude or ChatGPT.' }, 400);
    try {
        const s = await getSettings();
        const key = typeof b.apiKey === 'string' && b.apiKey.trim() ? b.apiKey.trim() : s?.provider === b.provider ? await getKey(wsOf(c)!) : null;
        if (!key) return c.json({ error: `Paste the ${PROVIDER_NAMES[b.provider]} API key.` }, 400);
        return c.json(await listModels(b.provider, key));
    } catch (err) { return fail(c, err); }
});
assistant.put('/settings', requireRole('admin'), rateLimit(20, 10 * 60_000, (c) => `assistant-settings:${c.get('user')!.id}`), async (c) => {
    const user = c.get('user')!;
    const b = await c.req.json().catch(() => ({})) as { provider?: unknown; model?: unknown; apiKey?: unknown };
    if (!isProvider(b.provider)) return c.json({ error: 'Choose Claude or ChatGPT.' }, 400);
    const model = typeof b.model === 'string' ? b.model.trim() : '';
    const apiKey = typeof b.apiKey === 'string' && b.apiKey.trim() ? b.apiKey.trim() : null;
    if (apiKey && !validKey(b.provider, apiKey)) return c.json({ error: `That doesn't look like ${b.provider === 'anthropic' ? 'an Anthropic key (sk-ant-…)' : 'an OpenAI key (sk-…)'}.` }, 400);
    try {
        const current = await getSettings();
        const key = apiKey ?? (current?.provider === b.provider ? await getKey(wsOf(c)!) : null);
        if (!key) return c.json({ error: `Paste the ${PROVIDER_NAMES[b.provider]} API key.` }, 400);
        const { models } = await listModels(b.provider, key);   // the key works, and the model is one it can use
        if (!models.includes(model)) return c.json({ error: 'Choose one of the models this key can use.' }, 400);
        const saved = await saveSettings(wsOf(c)!, { provider: b.provider, model, apiKey }, user.username);
        await audit({ id: user.id, username: user.username }, 'assistant.settings', null, { provider: saved.provider, model: saved.model, keyChanged: !!apiKey }, c.get('ip'));
        return c.json({ settings: saved });
    } catch (err) { return fail(c, err); }
});
assistant.delete('/settings', requireRole('admin'), async (c) => {
    const user = c.get('user')!;
    try {
        await removeSettings(wsOf(c)!);
        await audit({ id: user.id, username: user.username }, 'assistant.settings.removed', null, {}, c.get('ip'));
        return c.json({ ok: true });
    } catch (err) { return fail(c, err); }
});

// ------------------------------------------------------------------ asking
assistant.post('/ask', rateLimit(20, 10 * 60_000, (c) => `assistant:${c.get('user')!.id}`), async (c) => {
    const user = c.get('user')!;
    const b = await c.req.json().catch(() => ({})) as { question?: unknown; conversationId?: unknown };
    const ws = wsOf(c)!;
    const { rows: [w] } = await db().query<{ name: string }>('SELECT name FROM workspaces WHERE id = $1', [ws]);
    c.header('X-Accel-Buffering', 'no');   // nginx: pass each event on at once instead of buffering the answer
    return streamSSE(c, async (stream) => {
        const emit = (e: { type: string }) => stream.writeSSE({ event: e.type, data: JSON.stringify(e) });
        try {
            await withWorkspace(ws, () => ask({
                userId: user.id, workspaceId: ws, workspace: w?.name ?? 'this workspace', role: user.role,
                conversationId: typeof b.conversationId === 'string' && /^[0-9a-f]{24}$/.test(b.conversationId) ? b.conversationId : null,
                question: String(b.question ?? ''), emit,
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
