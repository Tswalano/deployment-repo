import { Context, Hono } from 'hono';
import { audit } from '../audit';
import { InstanceRow } from '../collector';
import { db } from '../db';
import { DeployError } from '../deploys';
import { denyDemo, Env, rateLimit, requireRole } from '../middleware';
import { inventory, rotate, updateValue } from '../secrets';

/** /api/instances/:id/secrets: names, versions and ages (never values); admins rotate or replace. */
const secrets = new Hono<Env>();
const guard = [requireRole('deployer'), denyDemo] as const;   // scoped per route: this router is mounted on /api/instances

async function load(c: Context<Env>): Promise<InstanceRow | null> {
    const { rows } = await db().query<InstanceRow>('SELECT * FROM instances WHERE id = $1', [Number(c.req.param('id'))]);
    return rows[0] ?? null;
}
const fail = (c: Context<Env>, err: unknown) => err instanceof DeployError ? c.json({ error: err.message }, err.status) : c.json({ error: (err as Error).message.slice(0, 300) }, 502);

secrets.get('/:id/secrets', ...guard, async (c) => {
    const inst = await load(c);
    if (!inst) return c.json({ error: 'Instance not found' }, 404);
    try { return c.json(await inventory(inst)); } catch (err) { return fail(c, err); }
});

secrets.post('/:id/secrets/rotate', ...guard, requireRole('admin'), rateLimit(6, 30 * 60_000, (c) => `rotate:${c.get('user')!.id}`), async (c) => {
    const inst = await load(c);
    if (!inst) return c.json({ error: 'Instance not found' }, 404);
    const b = await c.req.json().catch(() => ({}));
    const kind = b.kind === 'jwt' ? 'jwt' : b.kind === 'db-password' ? 'db-password' : null;
    if (!kind) return c.json({ error: 'kind must be db-password or jwt' }, 400);
    const target = String(b.target ?? '');
    if (String(b.confirm ?? '') !== target) return c.json({ error: `Type ${target || 'the target'} to confirm.` }, 400);
    const user = c.get('user')!;
    try {
        const r = await rotate(inst, kind, target, user.username);
        await audit({ id: user.id, username: user.username }, `secret.rotate`, `${kind} ${target} on ${inst.name}`,
            { ok: !!r.ok, updated: r.updated, restarted: r.restarted, restored: r.restored, dryRun: r.dryRun }, c.get('ip'));
        return c.json(r, r.ok ? 200 : 409);
    } catch (err) { return fail(c, err); }
});

secrets.put('/:id/secrets/value', ...guard, requireRole('admin'), rateLimit(10, 30 * 60_000, (c) => `secret-put:${c.get('user')!.id}`), async (c) => {
    const inst = await load(c);
    if (!inst) return c.json({ error: 'Instance not found' }, 404);
    const b = await c.req.json().catch(() => ({}));
    const user = c.get('user')!;
    const service = String(b.service ?? ''), key = String(b.key ?? '');
    try {
        const r = await updateValue(inst, service, key, String(b.value ?? ''), user.username);
        await audit({ id: user.id, username: user.username }, 'secret.update', `/apps/${service}/${key} on ${inst.name}`, { ok: true, dryRun: r.dryRun }, c.get('ip'));
        return c.json(r);
    } catch (err) {
        await audit({ id: user.id, username: user.username }, 'secret.update', `/apps/${service}/${key} on ${inst.name}`, { ok: false, error: (err as Error).message.slice(0, 200) }, c.get('ip'));
        return fail(c, err);
    }
});

export default secrets;
