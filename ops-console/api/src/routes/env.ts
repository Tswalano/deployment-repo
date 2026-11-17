import { Context, Hono } from 'hono';
import { audit } from '../audit';
import { InstanceRow } from '../collector';
import { db } from '../db';
import { DeployError } from '../deploys';
import { listEnv, revealEnv, setEnv } from '../env';
import { denyDemo, Env, rateLimit, requireRole } from '../middleware';

/** /api/instances/:id/apps/:project/env. Deployers see names; admins reveal and change values. */
const env = new Hono<Env>();
const fail = (c: Context<Env>, err: unknown) => err instanceof DeployError ? c.json({ error: err.message }, err.status) : c.json({ error: (err as Error).message.slice(0, 300) }, 502);
async function inst(c: Context<Env>): Promise<InstanceRow | null> {
    const { rows } = await db().query<InstanceRow>('SELECT * FROM instances WHERE id = $1', [Number(c.req.param('id'))]);
    return rows[0] ?? null;
}

env.get('/:id/apps/:project/env', requireRole('deployer'), denyDemo, async (c) => {
    const i = await inst(c);
    if (!i) return c.json({ error: 'Instance not found' }, 404);
    try { return c.json(await listEnv(i, c.req.param('project'))); } catch (err) { return fail(c, err); }
});

env.post('/:id/apps/:project/env/reveal', requireRole('admin'), denyDemo, rateLimit(60, 10 * 60_000, (c) => `reveal:${c.get('user')!.id}`), async (c) => {
    const i = await inst(c);
    if (!i) return c.json({ error: 'Instance not found' }, 404);
    const key = String((await c.req.json().catch(() => ({}))).key ?? '');
    try {
        const value = await revealEnv(i, c.req.param('project'), key);
        const user = c.get('user')!;
        await audit({ id: user.id, username: user.username }, 'env.reveal', `${c.req.param('project')} ${key}`, {}, c.get('ip'));
        return c.json({ key, value });
    } catch (err) { return fail(c, err); }
});

env.put('/:id/apps/:project/env', requireRole('admin'), denyDemo, rateLimit(20, 10 * 60_000, (c) => `env:${c.get('user')!.id}`), async (c) => {
    const i = await inst(c);
    if (!i) return c.json({ error: 'Instance not found' }, 404);
    const b = await c.req.json().catch(() => ({}));
    const key = String(b.key ?? '').trim(), user = c.get('user')!;
    try {
        const r = await setEnv(i, c.req.param('project'), key, String(b.value ?? ''), user.username);
        await audit({ id: user.id, username: user.username }, `env.${r.verb === 'added' ? 'add' : 'change'}`, `${c.req.param('project')} ${key}`, { dryRun: r.dryRun }, c.get('ip'));
        return c.json(r);
    } catch (err) {
        await audit({ id: user.id, username: user.username }, 'env.change', `${c.req.param('project')} ${key}`, { ok: false, error: (err as Error).message.slice(0, 200) }, c.get('ip'));
        return fail(c, err);
    }
});

env.delete('/:id/apps/:project/env/:key', requireRole('admin'), denyDemo, rateLimit(20, 10 * 60_000, (c) => `env:${c.get('user')!.id}`), async (c) => {
    const i = await inst(c);
    if (!i) return c.json({ error: 'Instance not found' }, 404);
    const key = c.req.param('key'), user = c.get('user')!;
    try {
        const r = await setEnv(i, c.req.param('project'), key, null, user.username);
        await audit({ id: user.id, username: user.username }, 'env.remove', `${c.req.param('project')} ${key}`, { dryRun: r.dryRun }, c.get('ip'));
        return c.json(r);
    } catch (err) { return fail(c, err); }
});

export default env;
