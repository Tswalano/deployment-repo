import Anthropic from '@anthropic-ai/sdk';
import { aws } from '../aws';
import { config } from '../config';
import { connection } from '../connections';
import { db } from '../db';
import { DeployError } from '../deploys';
import { Role, runTool, toolDefs, toolLabel } from './tools';

/**
 * The AI provider behind "Ask Ops Console" is the workspace's own: an admin picks Anthropic (Claude) or OpenAI and
 * pastes their API key, which is billed by that provider. The key is kept encrypted in the workspace's own AWS account
 * (SSM Parameter Store, SecureString), never in the console's database; the database only records the provider, the
 * model and the key's last four characters.
 */
export type Provider = 'anthropic' | 'openai';
export interface AssistantSettings { provider: Provider; model: string; keyLast4: string; updatedBy: string; updatedAt: string }
export const PROVIDER_NAMES: Record<Provider, string> = { anthropic: 'Claude (Anthropic)', openai: 'ChatGPT (OpenAI)' };
const KEY_PARAM = '/apps/ops-console-assistant/API_KEY';   // in the workspace's AWS account (the connect role may write /apps/*)

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
const keyCache = new Map<number, { at: number; key: string }>();
interface KeyStore { get(region: string, name: string): Promise<string | null>; put(region: string, name: string, v: string): Promise<void>; del(region: string, name: string): Promise<void> }
const awsStore: KeyStore = { get: (r, n) => aws().getParameter!(r, n), put: (r, n, v) => aws().putParameter!(r, n, v), del: (r, n) => aws().deleteParameter!(r, n) };
let store: KeyStore = awsStore;
export function setKeyStore(s: KeyStore | null): void { store = s ?? awsStore; keyCache.clear(); }
let openaiFetch: typeof fetch = (...a) => fetch(...a);
export function setOpenAIFetch(f: typeof fetch | null): void { openaiFetch = f ?? ((...a) => fetch(...a)); }

// ------------------------------------------------------------------ settings and the key (in the workspace's own AWS account)
export async function getSettings(): Promise<AssistantSettings | null> {
    const { rows } = await db().query<{ value: AssistantSettings }>("SELECT value FROM settings WHERE key = 'assistant'");
    return rows[0]?.value ?? null;
}
async function keyRegion(): Promise<string> {
    if (!config.multiTenant) return process.env.AWS_REGION || 'af-south-1';
    const c = await connection();
    if (!c || c.status !== 'connected') throw new DeployError('Connect the AWS account first: the API key is stored in it.', 409);
    return c.region;
}
export async function getKey(workspaceId: number): Promise<string | null> {
    const hit = keyCache.get(workspaceId);
    if (hit && Date.now() - hit.at < 5 * 60_000) return hit.key;
    const key = await store.get(await keyRegion(), KEY_PARAM);
    if (key) keyCache.set(workspaceId, { at: Date.now(), key });
    return key;
}
export async function saveSettings(workspaceId: number, s: { provider: Provider; model: string; apiKey?: string | null }, by: string): Promise<AssistantSettings> {
    const current = await getSettings();
    const region = await keyRegion();
    let last4 = current?.keyLast4 ?? '';
    if (s.apiKey) {
        await store.put(region, KEY_PARAM, s.apiKey);
        last4 = s.apiKey.slice(-4);
        keyCache.delete(workspaceId);
    } else if (!current || current.provider !== s.provider) {
        throw new DeployError(`Paste the ${PROVIDER_NAMES[s.provider]} API key.`);
    }
    const value: AssistantSettings = { provider: s.provider, model: s.model, keyLast4: last4, updatedBy: by, updatedAt: new Date().toISOString() };
    await db().query(`INSERT INTO settings (key, value, updated_by) VALUES ('assistant', $1, $2)
                      ON CONFLICT (workspace_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`, [JSON.stringify(value), by]);
    return value;
}
export async function removeSettings(workspaceId: number): Promise<void> {
    await store.del(await keyRegion(), KEY_PARAM).catch(() => undefined);
    keyCache.delete(workspaceId);
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
    key: string; model: string; system: string; role: Role; items: Stored[];
    emit: (e: { type: 'tool'; label: string } | { type: 'text'; delta: string }) => void | Promise<void>;
    usage: { input: number; cached: number; output: number };
}
const MAX_TURNS = 8;   // tool round trips per question

/** Claude: streamed Messages API turns; the console runs the tool calls. Items are Anthropic messages, stored as returned. */
export async function runAnthropic(c: RunCtx): Promise<void> {
    try { await anthropicTurns(c); } catch (err) {
        if (!(err instanceof Anthropic.APIError)) throw err;
        if (err.status === 401 || err.status === 403) throw new DeployError('Anthropic rejected the workspace\'s API key (Settings → Ask Ops Console).', 409);
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
            const r = await runTool(call.name, call.input, c.role);
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
            if (res.status === 401 || res.status === 403) throw new DeployError('OpenAI rejected the workspace\'s API key (Settings → Ask Ops Console).', 409);
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
            const r = await runTool(call.name, args, c.role);
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
export function visibleTurns(provider: Provider, items: Stored[]): { role: 'user' | 'assistant'; text: string; tools?: string[] }[] {
    const out: { role: 'user' | 'assistant'; text: string; tools?: string[] }[] = [];
    let pending: string[] = [];
    const say = (text: string) => { if (text) { out.push({ role: 'assistant', text, tools: [...new Set(pending)] }); pending = []; } };
    for (const m of items) {
        if (provider === 'openai') {
            if (m.role === 'user' && typeof m.content === 'string') out.push({ role: 'user', text: m.content });
            else if (m.type === 'function_call') pending.push(toolLabel(String(m.name)));
            else if (m.type === 'message' && m.role === 'assistant') say(((m.content as { type: string; text?: string }[]) ?? []).filter((b) => b.type === 'output_text').map((b) => b.text).join(''));
            continue;
        }
        const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : (m.content as { type: string; text?: string; name?: string }[]);
        if (m.role === 'user') { const t = blocks.filter((b) => b.type === 'text').map((b) => b.text).join(''); if (t) out.push({ role: 'user', text: t }); continue; }
        pending.push(...blocks.filter((b) => b.type === 'tool_use').map((b) => toolLabel(b.name ?? '')));
        say(blocks.filter((b) => b.type === 'text').map((b) => b.text).join(''));
    }
    return out;
}
