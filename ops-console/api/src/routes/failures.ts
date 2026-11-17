import { Hono } from 'hono';
import { audit } from '../audit';
import { DeployError } from '../deploys';
import { dismissFailure, listFailures } from '../failures';
import { denyDemo, Env, requireRole } from '../middleware';

/** Failed deployments that still need attention, and dismissing them. Mounted at /api/failures. */
const failures = new Hono<Env>();
failures.get('/', requireRole('viewer'), async (c) => c.json(await listFailures()));
failures.post('/dismiss', requireRole('deployer'), denyDemo, async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const user = c.get('user')!;
    try {
        const r = await dismissFailure(b, user.username);
        await audit({ id: user.id, username: user.username }, b.kind === 'create' ? 'failure.dismiss_create' : 'failure.dismiss_deploy', r.project,
            { instanceId: r.instanceId, at: b.at, creationId: b.creationId, note: b.note || undefined }, c.get('ip'));
        return c.json({ ok: true });
    } catch (err) {
        if (err instanceof DeployError) return c.json({ error: err.message }, err.status);
        throw err;
    }
});
export default failures;
