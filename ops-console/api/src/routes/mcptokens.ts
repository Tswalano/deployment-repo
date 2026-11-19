import { Hono } from 'hono';
import { audit } from '../audit';
import { config } from '../config';
import { DeployError } from '../deploys';
import { createToken, listTokens, mcpTools, revokeToken } from '../mcp';
import { denyDemo, Env, rateLimit, requireRole } from '../middleware';

/** /api/mcp-tokens: personal access tokens for the workspace MCP endpoint. Everyone has their own; admins can see and revoke all. */
const tokens = new Hono<Env>();
tokens.use('*', requireRole('viewer'), denyDemo);

tokens.get('/', async (c) => {
    const user = c.get('user')!;
    const all = user.role === 'admin' && c.req.query('all') === '1';
    return c.json({
        url: `${config.publicUrl.replace(/\/$/, '')}/mcp`,
        oauth: true,
        tools: mcpTools().map((t) => ({ name: t.name, title: t.title, description: t.description, proposes: !t.annotations.readOnlyHint })),
        tokens: await listTokens(all ? null : user.id),
        canSeeAll: user.role === 'admin',
    });
});
tokens.post('/', rateLimit(10, 60 * 60_000, (c) => `mcp-token:${c.get('user')!.id}`), async (c) => {
    const user = c.get('user')!;
    const b = await c.req.json().catch(() => ({})) as { name?: unknown; days?: unknown };
    try {
        const { token, row } = await createToken(user.id, String(b.name ?? ''), b.days == null || b.days === '' ? null : Number(b.days));
        await audit({ id: user.id, username: user.username }, 'mcp.token_create', row.name, { id: row.id, expiresAt: row.expiresAt }, c.get('ip'));
        return c.json({ token, row });
    } catch (err) {
        if (err instanceof DeployError) return c.json({ error: err.message }, err.status as 400);
        throw err;
    }
});
tokens.delete('/:id', async (c) => {
    const user = c.get('user')!;
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || !(await revokeToken(id, user.id, user.role === 'admin'))) return c.json({ error: 'Token not found.' }, 404);
    await audit({ id: user.id, username: user.username }, 'mcp.token_revoke', String(id), {}, c.get('ip'));
    return c.json({ ok: true });
});

export default tokens;
