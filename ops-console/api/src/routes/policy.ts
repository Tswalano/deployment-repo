import { Hono } from 'hono';
import { checkLimit } from '../billing';
import { audit } from '../audit';
import { denyDemo, Env, requireRole } from '../middleware';
import { activeFreeze, deployPolicy, ENVIRONMENTS, saveDeployPolicy, validatePolicy } from '../policy';

const policy = new Hono<Env>();
policy.use('*', requireRole('viewer'));

/** Readable by everyone (it explains why a deploy is blocked); only admins change it. */
policy.get('/', async (c) => {
    const p = await deployPolicy();
    return c.json({ policy: p, frozenNow: Object.fromEntries(ENVIRONMENTS.map((e) => [e, activeFreeze(p, e)])) });
});

policy.put('/', requireRole('admin'), denyDemo, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const next = validatePolicy(body, await deployPolicy());
    if (typeof next === 'string') return c.json({ error: next }, 400);
    const user = c.get('user')!;
    if (Object.values(next.approvals).some(Boolean)) {
        try { await checkLimit(user.workspaceId ?? 1, 'approvals'); } catch (err) { return c.json({ error: (err as Error).message, code: 'plan_limit' }, 409); }
    }
    await saveDeployPolicy(next, user.username);
    await audit({ id: user.id, username: user.username }, 'policy.update', 'deploy policy',
        { approvals: next.approvals, rollbackNeedsApproval: next.rollbackNeedsApproval, rollbackAllowedInFreeze: next.rollbackAllowedInFreeze,
          freezes: next.freezes.map((f) => f.name), timezone: next.timezone }, c.get('ip'));
    return c.json({ policy: next, frozenNow: Object.fromEntries(ENVIRONMENTS.map((e) => [e, activeFreeze(next, e)])) });
});

export default policy;
