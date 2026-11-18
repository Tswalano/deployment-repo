import { Context, Hono, MiddlewareHandler } from 'hono';
import { forgetStanding } from './billing';
import { DeployError } from '../deploys';
import { denyDemo, Env, rateLimit } from '../middleware';
import {
    changeEmail, extendTrial, health, isPlatformAdmin, listWorkspaces, overview, platformAudit, PlatformActor, reactivate, setComplimentary,
    suspend, workspaceDetail,
} from '../platform';

/** /api/platform: the platform owner portal. Platform admins only (404 for everyone else: the portal isn't advertised). */
const platform = new Hono<Env>();
const onlyPlatformAdmins: MiddlewareHandler<Env> = async (c, next) => ((await isPlatformAdmin(c.get('user'))) ? next() : c.json({ error: 'Not found' }, 404));
platform.use('*', onlyPlatformAdmins);

const fail = (c: Context<Env>, err: unknown) => err instanceof DeployError
    ? c.json({ error: err.message }, err.status)
    : c.json({ error: (err as Error).message.slice(0, 300) }, 500);
const actor = (c: Context<Env>): PlatformActor => { const u = c.get('user')!; return { id: u.id, username: u.username, workspaceId: u.workspaceId, ip: c.get('ip') ?? null }; };
const wsId = (c: Context<Env>) => Number(c.req.param('id'));
const body = async (c: Context<Env>) => c.req.json().catch(() => ({})) as Promise<Record<string, unknown>>;

platform.get('/overview', async (c) => { try { return c.json(await overview()); } catch (err) { return fail(c, err); } });
platform.get('/workspaces', async (c) => { try { return c.json({ workspaces: await listWorkspaces() }); } catch (err) { return fail(c, err); } });
platform.get('/workspaces/:id', async (c) => { try { return c.json(await workspaceDetail(wsId(c))); } catch (err) { return fail(c, err); } });
platform.get('/health', async (c) => { try { return c.json(await health()); } catch (err) { return fail(c, err); } });
platform.get('/audit', async (c) => { try { return c.json({ entries: await platformAudit() }); } catch (err) { return fail(c, err); } });

const act = rateLimit(30, 10 * 60_000, (c) => `platform:${c.get('user')!.id}`);
platform.post('/workspaces/:id/suspend', denyDemo, act, async (c) => {
    try { await suspend(wsId(c), String((await body(c)).reason ?? ''), actor(c)); forgetStanding(wsId(c)); return c.json({ ok: true }); } catch (err) { return fail(c, err); }
});
platform.post('/workspaces/:id/reactivate', denyDemo, act, async (c) => {
    try { await reactivate(wsId(c), actor(c)); forgetStanding(wsId(c)); return c.json({ ok: true }); } catch (err) { return fail(c, err); }
});
platform.post('/workspaces/:id/trial', denyDemo, act, async (c) => {
    try { const until = await extendTrial(wsId(c), Number((await body(c)).days), actor(c)); forgetStanding(wsId(c)); return c.json({ ok: true, trialEndsAt: until }); } catch (err) { return fail(c, err); }
});
platform.post('/workspaces/:id/complimentary', denyDemo, act, async (c) => {
    const b = await body(c);
    const plan = b.plan === 'starter' || b.plan === 'pro' ? b.plan : b.plan === null ? null : 'invalid';
    try {
        if (plan === 'invalid') throw new DeployError('Choose Starter or Pro.');
        await setComplimentary(wsId(c), plan, typeof b.until === 'string' && b.until ? b.until : null, actor(c));
        forgetStanding(wsId(c));
        return c.json({ ok: true });
    } catch (err) { return fail(c, err); }
});
platform.put('/users/:userId/email', denyDemo, act, async (c) => {
    try { await changeEmail(Number(c.req.param('userId')), String((await body(c)).email ?? ''), actor(c)); return c.json({ ok: true }); } catch (err) { return fail(c, err); }
});

export default platform;
