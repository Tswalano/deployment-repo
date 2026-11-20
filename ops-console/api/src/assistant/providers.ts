import Anthropic from '@anthropic-ai/sdk';
import { randomBytes } from 'crypto';
import { aws } from '../aws';
import { config } from '../config';
import { connection } from '../connections';
import { db } from '../db';
import { DeployError } from '../deploys';
import { ActionCtx } from './actions';
import { Role, runTool, toolDefs, toolLabel } from './tools';

/**
 * The AI behind "Ask Ops Console" is the workspace's own: admins add an API key per provider (Anthropic for Claude,
 * OpenAI for ChatGPT), billed by that provider, and pick the models people can use (one is the default). Keys are kept
 * encrypted in the workspace's own AWS account (SSM Parameter Store, SecureString), never in the console's database;
 * the database only records which keys exist (last four characters, who set them) and the models.
 */
export type Provider = 'anthropic' | 'openai';
export const PROVIDERS: Provider[] = ['anthropic', 'openai'];
export const PROVIDER_NAMES: Record<Provider, string> = { anthropic: 'Claude (Anthropic)', openai: 'ChatGPT (OpenAI)' };
export interface KeyInfo { last4: string; updatedBy: string; updatedAt: string }
export interface ModelEntry { id: string; provider: Provider; model: string; addedBy: string; addedAt: string }
export interface AssistantConfig { keys: Partial<Record<Provider, KeyInfo>>; models: ModelEntry[]; defaultModelId: string | null; legacy?: Provider }
// in the workspace's AWS account (the connect role may write /apps/*); one parameter per provider
const keyParam = (p: Provider) => `/apps/ops-console-assistant/${p === 'anthropic' ? 'ANTHROPIC' : 'OPENAI'}_API_KEY`;
const LEGACY_KEY_PARAM = '/apps/ops-console-assistant/API_KEY';   // the single key of the first version

// Claude models offered (current generation; each supports the request below: adaptive thinking, effort, fallbacks)
export const CLAUDE_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
const CLAUDE_DEFAULT = 'claude-opus-5-5';
const CLAUDE_FALLBACK = new Set(['claude-opus-5-5', 'claude-sonnet-5-5']);   // server-side refusal fallback ("default" routing)
// OpenAI: whatever chat-capable models the key lists (no model names are assumed here)
const OPENAI_SKIP = /(audio|realtime|tts|transcribe|whisper|image|dall-e|embedding|moderation|search|instruct|babbage|davinci|computer|codex)/;

// ------------------------------------------------------------------ test hooks
let anthropicFactory: (apiKey: string) => Pick<Anthropic, 'beta' | 'models'> = (apiKey) => new Anthropic({ apiKey });
export function setAnthropicFactory(f: ((apiKey: string) => Pick<Anthropic, 'beta' | 'models'>) | null): void {
    anthropicFactory = f ?? ((apiKey) => new Anthropic({ apiKey }));
}
const keyCache = new Map<string, { at: number; key: string }>();
interface KeyStore { get(region: string, name: string): Promise<string | null>; put(region: string, name: string, v: string): Promise<void>; del(region: string, name: string): Promise<void> }
const awsStore: KeyStore = { get: (r, n) => aws().getParameter!(r, n), put: (r, n, v) => aws().putParameter!(r, n, v), del: (r, n) => aws().deleteParameter!(r, n) };
let store: KeyStore = awsStore;
export function setKeyStore(s: KeyStore | null): void { store = s ?? awsStore; keyCache.clear(); }
let openaiFetch: typeof fetch = (...a) => fetch(...a);
export function setOpenAIFetch(f: typeof fetch | null): void { openaiFetch = f ?? ((...a) => fetch(...a)); }

// ------------------------------------------------------------------ the configuration (keys in the workspace's own AWS account)
type LegacySettings = { provider: Provider; model: string; keyLast4: string; updatedBy: string; updatedAt: string };
/** The workspace's configuration; the first version's single key/model is read as one key and one (default) model. */
export async function getConfig(): Promise<AssistantConfig> {
    const { rows } = await db().query<{ value: AssistantConfig | LegacySettings }>("SELECT value FROM settings WHERE key = 'assistant'");
    const v = rows[0]?.value;
    if (!v) return { keys: {}, models: [], defaultModelId: null };
    if ('provider' in v) {
        return { keys: { [v.provider]: { last4: v.keyLast4, updatedBy: v.updatedBy, updatedAt: v.updatedAt } }, legacy: v.provider,
            models: [{ id: 'm-first', provider: v.provider, model: v.model, addedBy: v.updatedBy, addedAt: v.updatedAt }], defaultModelId: 'm-first' };
    }
    return { keys: v.keys ?? {}, models: v.models ?? [], defaultModelId: v.defaultModelId ?? null };
}
async function saveConfig(c: AssistantConfig, by: string): Promise<AssistantConfig> {
    if (!c.models.some((m) => m.id === c.defaultModelId)) c.defaultModelId = c.models[0]?.id ?? null;
    const value = { keys: c.keys, models: c.models, defaultModelId: c.defaultModelId };
    if (!Object.keys(c.keys).length && !c.models.length) await db().query("DELETE FROM settings WHERE key = 'assistant'");
    else await db().query(`INSERT INTO settings (key, value, updated_by) VALUES ('assistant', $1, $2)
                           ON CONFLICT (workspace_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`, [JSON.stringify(value), by]);
    return { ...value };
}
/** Models people can use now: those whose provider has a key. */
export const usableModels = (c: AssistantConfig) => c.models.filter((m) => c.keys[m.provider]);
export function pickModel(c: AssistantConfig, id?: string | null): ModelEntry | null {
    const usable = usableModels(c);
    return (id ? usable.find((m) => m.id === id) : null) ?? usable.find((m) => m.id === c.defaultModelId) ?? usable[0] ?? null;
}

async function keyRegion(): Promise<string> {
    if (!config.multiTenant) return process.env.AWS_REGION || 'af-south-1';
    const c = await connection();
    if (!c || c.status !== 'connected') throw new DeployError('Connect the AWS account first: API keys are stored in it.', 409);
    return c.region;
}
export async function getKey(workspaceId: number, provider: Provider): Promise<string | null> {
    const cacheKey = `${workspaceId}:${provider}`;
    const hit = keyCache.get(cacheKey);
    if (hit && Date.now() - hit.at < 5 * 60_000) return hit.key;
    const region = await keyRegion();
    let key = await store.get(region, keyParam(provider));
    if (!key && (await getConfig()).legacy === provider) key = await store.get(region, LEGACY_KEY_PARAM);
    if (key) keyCache.set(cacheKey, { at: Date.now(), key });
    return key;
}
/** Add or replace a provider's key (the caller has checked it with the provider). */
export async function setKey(workspaceId: number, provider: Provider, apiKey: string, by: string): Promise<AssistantConfig> {
    const c = await getConfig();
    const region = await keyRegion();
    await store.put(region, keyParam(provider), apiKey);
    if (c.legacy) await store.del(region, LEGACY_KEY_PARAM).catch(() => undefined);   // moved to its provider's parameter
    if (c.legacy && c.legacy !== provider) {   // keep the other provider's first-version key too
        const old = await store.get(region, LEGACY_KEY_PARAM).catch(() => null);
        if (old) await store.put(region, keyParam(c.legacy), old);
    }
    keyCache.delete(`${workspaceId}:${provider}`);
    c.keys[provider] = { last4: apiKey.slice(-4), updatedBy: by, updatedAt: new Date().toISOString() };
    delete c.legacy;
    return saveConfig(c, by);
}
/** Remove a provider's key and its models. */
export async function removeKey(workspaceId: number, provider: Provider, by: string): Promise<AssistantConfig> {
    const c = await getConfig();
    const region = await keyRegion();
    await store.del(region, keyParam(provider)).catch(() => undefined);
    if (c.legacy === provider) await store.del(region, LEGACY_KEY_PARAM).catch(() => undefined);
    keyCache.delete(`${workspaceId}:${provider}`);
    delete c.keys[provider];
    c.models = c.models.filter((m) => m.provider !== provider);
    if (c.legacy === provider) delete c.legacy;
    return saveConfig(c, by);
}
export async function addModel(provider: Provider, model: string, by: string): Promise<AssistantConfig> {
    const c = await getConfig();
    if (!c.keys[provider]) throw new DeployError(`Add the ${PROVIDER_NAMES[provider]} API key first.`, 409);
    if (c.models.some((m) => m.provider === provider && m.model === model)) throw new DeployError(`${model} is already added.`, 409);
    if (c.models.length >= 10) throw new DeployError('Up to 10 models can be added.', 409);
    c.models.push({ id: `m-${randomBytes(6).toString('hex')}`, provider, model, addedBy: by, addedAt: new Date().toISOString() });
    return saveConfig(c, by);
}
export async function removeModel(id: string, by: string): Promise<AssistantConfig> {
    const c = await getConfig();
    if (!c.models.some((m) => m.id === id)) throw new DeployError('Model not found.', 404);
    c.models = c.models.filter((m) => m.id !== id);
    return saveConfig(c, by);
}
export async function setDefaultModel(id: string, by: string): Promise<AssistantConfig> {
    const c = await getConfig();
    if (!c.models.some((m) => m.id === id)) throw new DeployError('Model not found.', 404);
    c.defaultModelId = id;
    return saveConfig(c, by);
}
/** Set up in one step (a key, if given, a model, made the default). */
export async function saveSettings(workspaceId: number, s: { provider: Provider; model: string; apiKey?: string | null }, by: string): Promise<AssistantConfig> {
    if (s.apiKey) await setKey(workspaceId, s.provider, s.apiKey, by);
    else if (!(await getConfig()).keys[s.provider]) throw new DeployError(`Paste the ${PROVIDER_NAMES[s.provider]} API key.`);
    let c = await getConfig();
    if (!c.models.some((m) => m.provider === s.provider && m.model === s.model)) c = await addModel(s.provider, s.model, by);
    return setDefaultModel(c.models.find((m) => m.provider === s.provider && m.model === s.model)!.id, by);
}
/** Turn it off: every key deleted from the AWS account, every model removed. */
export async function removeSettings(workspaceId: number): Promise<void> {
    const region = await keyRegion();
    for (const p of PROVIDERS) { await store.del(region, keyParam(p)).catch(() => undefined); keyCache.delete(`${workspaceId}:${p}`); }
    await store.del(region, LEGACY_KEY_PARAM).catch(() => undefined);
    await db().query("DELETE FROM settings WHERE key = 'assistant'");
}

// ------------------------------------------------------------------ checking a key: the models it can use
export const validKey = (provider: Provider, key: string) => (provider === 'anthropic' ? /^sk-ant-[A-Za-z0-9_-]{20,300}$/ : /^sk-[A-Za-z0-9_-]{20,300}$/).test(key);

export async function listModels(provider: Provider, key: string): Promise<{ models: string[]; suggested: string | null }> {
    if (!validKey(provider, key)) throw new DeployError(`That doesn't look like ${provider === 'anthropic' ? 'an Anthropic key (sk-ant-…)' : 'an OpenAI key (sk-…)'}.`);
    if (provider === 'anthropic') {
        let ids: string[] = [];
        try {
            for await (const m of anthropicFactory(key).models.list()) ids.push(m.id);
        } catch (err) { throw keyError(err instanceof Anthropic.APIError ? err.status : undefined, 'Anthropic'); }
        ids = CLAUDE_MODELS.filter((m) => ids.includes(m));
        if (!ids.length) throw new DeployError('This Anthropic key has no access to the supported Claude models (Opus 5.5, Sonnet 5.5, Haiku 5.5).');
        return { models: ids, suggested: ids.includes(CLAUDE_DEFAULT) ? CLAUDE_DEFAULT : ids[0] };
    }
    const r = await openaiFetch('https://api.openai.com/v1/models', { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) }).catch(() => null);
    if (!r?.ok) throw keyError(r?.status, 'OpenAI');
    const body = await r.json() as { data?: { id: string; created?: number }[] };
    const models = (body.data ?? []).filter((m) => /^(gpt-|o\d)/.test(m.id) && !OPENAI_SKIP.test(m.id))
        .sort((a, b) => (b.created ?? 0) - (a.created ?? 0)).map((m) => m.id);
    if (!models.length) throw new DeployError('This OpenAI key lists no chat models.');
    return { models, suggested: null };   // the admin chooses: OpenAI's model line-up changes often
}
function keyError(status: number | undefined, who: string) {
    if (status === 401 || status === 403) return new DeployError(`${who} rejected the key. Check it was copied completely and is still active.`);
    if (status === 429) return new DeployError(`${who} is rate-limiting this key, or its credit has run out.`, 409);
    return new DeployError(`${who} couldn't be reached to check the key. Try again in a moment.`, 409);
}

// ------------------------------------------------------------------ one question, either provider
export type Stored = Record<string, unknown>;
export interface RunCtx {
    key: string; model: string; system: string; role: Role; items: Stored[]; actionCtx?: ActionCtx;
    emit: (e: { type: 'tool'; label: string } | { type: 'text'; delta: string }) => void | Promise<void>;
    usage: { input: number; cached: number; output: number };
}
const MAX_TURNS = 8;   // tool round trips per question

/** Claude: streamed Messages API turns; the console runs the tool calls. Items are Anthropic messages, stored as returned. */
export async function runAnthropic(c: RunCtx): Promise<void> {
    try { await anthropicTurns(c); } catch (err) {
        if (!(err instanceof Anthropic.APIError)) throw err;
        if (err.status === 401 || err.status === 403) throw new DeployError('Anthropic rejected the workspace\'s API key (AI Console → Ask Ops Console).', 409);
        if (err.status === 429) throw new DeployError('Anthropic is rate-limiting the workspace\'s key, or its credit has run out.', 409);
        if (err.status === 400 || err.status === 404) throw new DeployError(`Anthropic couldn't answer (${err.message.slice(0, 160)}).`, 409);
        throw new DeployError('Anthropic is busy or unavailable right now. Try again in a moment.', 409);
    }
}
async function anthropicTurns(c: RunCtx): Promise<void> {
    const client = anthropicFactory(c.key);
    for (let turn = 0; turn < MAX_TURNS; turn++) {
        const stream = client.beta.messages.stream({
            model: c.model,
            max_tokens: 16000,
            ...(CLAUDE_FALLBACK.has(c.model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
            output_config: { effort: 'low' },              // chat: quick, consolidated tool calls
            cache_control: { type: 'ephemeral' },          // caches tools + system + the conversation so far
            system: [{ type: 'text', text: c.system }],
            tools: toolDefs(),
            messages: c.items as unknown as Anthropic.Beta.BetaMessageParam[],
        });
        stream.on('text', (delta: string) => { void c.emit({ type: 'text', delta }); });
        const msg = await stream.finalMessage();
        c.usage.input += msg.usage.input_tokens + (msg.usage.cache_creation_input_tokens ?? 0);
        c.usage.cached += msg.usage.cache_read_input_tokens ?? 0;
        c.usage.output += msg.usage.output_tokens;
        c.items.push({ role: 'assistant', content: msg.content });
        if (msg.stop_reason === 'refusal') { await c.emit({ type: 'text', delta: "\n\nI can't help with that one." }); return; }
        if (msg.stop_reason === 'pause_turn') continue;
        const calls = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
        if (msg.stop_reason !== 'tool_use' || !calls.length) return;   // end_turn, max_tokens, ...
        const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
        for (const call of calls) {
            await c.emit({ type: 'tool', label: toolLabel(call.name) });
            const r = await runTool(call.name, call.input, c.role, c.actionCtx);
            results.push({ type: 'tool_result', tool_use_id: call.id, content: r.content, ...(r.isError ? { is_error: true } : {}) });
        }
        c.items.push({ role: 'user', content: results });   // all results of the turn in one message
    }
}

/**
 * OpenAI: streamed Responses API turns (POST /v1/responses), stateless (store: false) with the encrypted reasoning
 * included, so the conversation is kept here like Claude's: every output item goes back as it came, followed by a
 * function_call_output item per tool call.
 */
export async function runOpenAI(c: RunCtx): Promise<void> {
    const tools = toolDefs().map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.input_schema, strict: false }));
    for (let turn = 0; turn < MAX_TURNS; turn++) {
        const res = await openaiFetch('https://api.openai.com/v1/responses', {
            method: 'POST',
            headers: { authorization: `Bearer ${c.key}`, 'content-type': 'application/json' },
            body: JSON.stringify({ model: c.model, instructions: c.system, input: c.items, tools, stream: true, store: false,
                include: ['reasoning.encrypted_content'], max_output_tokens: 16000 }),
            signal: AbortSignal.timeout(180_000),
        });
        if (!res.ok || !res.body) {
            const detail = await res.json().catch(() => ({})) as { error?: { message?: string } };
            if (res.status === 401 || res.status === 403) throw new DeployError('OpenAI rejected the workspace\'s API key (AI Console → Ask Ops Console).', 409);
            if (res.status === 429) throw new DeployError('OpenAI is rate-limiting the workspace\'s key, or its credit has run out.', 409);
            throw new DeployError(`OpenAI couldn't answer (${detail.error?.message?.slice(0, 160) ?? `HTTP ${res.status}`}).`, 409);
        }
        let response = null as OAResponse | null;
        for await (const ev of sseEvents(res.body)) {
            if (ev.type === 'response.output_text.delta' && typeof ev.delta === 'string') await c.emit({ type: 'text', delta: ev.delta });
            else if (ev.type === 'response.completed' || ev.type === 'response.incomplete') response = ev.response as OAResponse;
            else if (ev.type === 'response.failed') throw new DeployError(`OpenAI couldn't answer (${(ev.response as { error?: { message?: string } })?.error?.message?.slice(0, 160) ?? 'failed'}).`, 409);
            else if (ev.type === 'error') throw new DeployError(`OpenAI couldn't answer (${String(ev.message ?? 'error').slice(0, 160)}).`, 409);
        }
        if (!response) throw new DeployError('OpenAI ended the answer early. Try again.', 409);
        const u = response.usage ?? {};
        const cached = u.input_tokens_details?.cached_tokens ?? 0;
        c.usage.input += (u.input_tokens ?? 0) - cached; c.usage.cached += cached; c.usage.output += u.output_tokens ?? 0;
        const output = response.output ?? [];
        c.items.push(...output);
        const calls = output.filter((o) => o.type === 'function_call') as { call_id: string; name: string; arguments: string }[];
        if (!calls.length || response.status === 'incomplete') return;
        for (const call of calls) {
            await c.emit({ type: 'tool', label: toolLabel(call.name) });
            let args: unknown = null;
            try { args = JSON.parse(call.arguments || '{}'); } catch { /* invalid JSON: runTool reports it */ }
            const r = await runTool(call.name, args, c.role, c.actionCtx);
            c.items.push({ type: 'function_call_output', call_id: call.call_id, output: r.content });
        }
    }
}

interface OAResponse { status?: string; output?: Stored[]; usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } } }

/** Server-sent events from a fetch body: one parsed JSON object per `data:` event ([DONE] and bad lines skipped). */
async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
    const reader = body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
            const chunk = buf.slice(0, i); buf = buf.slice(i).replace(/^\r?\n\r?\n/, '');
            const data = chunk.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
            if (!data || data === '[DONE]') continue;
            try { yield JSON.parse(data) as Record<string, unknown>; } catch { /* skip */ }
        }
    }
}

/** What the person sees of a stored conversation, whichever provider wrote it. */
export function visibleTurns(provider: Provider, items: Stored[]): { role: 'user' | 'assistant'; text: string; tools?: string[]; actions?: string[] }[] {
    const out: { role: 'user' | 'assistant'; text: string; tools?: string[]; actions?: string[] }[] = [];
    let pending: string[] = [];
    let actions: string[] = [];
    const say = (text: string) => { if (text) { out.push({ role: 'assistant', text, tools: [...new Set(pending)], ...(actions.length ? { actions } : {}) }); pending = []; actions = []; } };
    // a proposal made during the turn (from the tool result) is shown with the answer that follows it
    const proposal = (content: unknown) => {
        try { const id = (JSON.parse(String(content)) as { result?: { actionId?: string } }).result?.actionId; if (id && !actions.includes(id)) actions.push(id); } catch { /* not JSON */ }
    };
    for (const m of items) {
        if (provider === 'openai') {
            if (m.role === 'user' && typeof m.content === 'string') out.push({ role: 'user', text: m.content });
            else if (m.type === 'function_call') pending.push(toolLabel(String(m.name)));
            else if (m.type === 'function_call_output') proposal(m.output);
            else if (m.type === 'message' && m.role === 'assistant') say(((m.content as { type: string; text?: string }[]) ?? []).filter((b) => b.type === 'output_text').map((b) => b.text).join(''));
            continue;
        }
        const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : (m.content as { type: string; text?: string; name?: string }[]);
        if (m.role === 'user') {
            for (const b of blocks as { type: string; content?: unknown }[]) if (b.type === 'tool_result') proposal(b.content);
            const t = blocks.filter((b) => b.type === 'text').map((b) => b.text).join(''); if (t) out.push({ role: 'user', text: t }); continue;
        }
        pending.push(...blocks.filter((b) => b.type === 'tool_use').map((b) => toolLabel(b.name ?? '')));
        say(blocks.filter((b) => b.type === 'text').map((b) => b.text).join(''));
    }
    return out;
}
