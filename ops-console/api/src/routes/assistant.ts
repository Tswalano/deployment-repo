import { Context, Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { ask, assistantEnabled, getConversation, listConversations, MODEL, remaining } from '../assistant/chat';
import { audit } from '../audit';
import { config } from '../config';
import { db, withWorkspace } from '../db';
import { DeployError } from '../deploys';
import { denyDemo, Env, rateLimit, requireRole } from '../middleware';

/** /api/assistant: "Ask Ops Console" (read-only answers about the workspace). Not in the demo: every question costs money. */
const assistant = new Hono<Env>();
assistant.use('*', requireRole('viewer'), denyDemo);
const wsOf = (c: Context<Env>) => c.get('user')!.workspaceId ?? (config.multiTenant ? null : 1);

assistant.get('/', async (c) => {
    const user = c.get('user')!;
    if (!assistantEnabled()) return c.json({ enabled: false });
    return c.json({ enabled: true, model: MODEL, ...(await remaining(wsOf(c)!)), conversations: await listConversations(user.id) });
});

assistant.get('/conversations/:id', async (c) => {
    const conv = await getConversation(c.get('user')!.id, c.req.param('id'));
    return conv ? c.json(conv) : c.json({ error: 'Conversation not found.' }, 404);
});

assistant.post('/ask', rateLimit(20, 10 * 60_000, (c) => `assistant:${c.get('user')!.id}`), async (c) => {
    const user = c.get('user')!;
    const b = await c.req.json().catch(() => ({})) as { question?: unknown; conversationId?: unknown };
    const ws = wsOf(c)!;
    const { rows: [w] } = await db().query<{ name: string }>('SELECT name FROM workspaces WHERE id = $1', [ws]);
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
