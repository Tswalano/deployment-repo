import { Context, Hono, MiddlewareHandler } from 'hono';
import { forgetStanding } from './billing';
import { consoleHealth } from '../consolehealth';
import { DeployError } from '../deploys';
import { denyDemo, Env, rateLimit } from '../middleware';
import {
    changeEmail, extend, grantCredit, isPlatformAdmin, listWorkspaces, overview, platformAudit, PlatformActor, reactivate, retryCharge,
    setComplimentary, setLimits, suspend, workspaceDetail,
} from '../platform';

/** /api/platform: the platform owner portal. Platform admins only (404 for everyone else: the portal isn't advertised). */
const platform = new Hono<Env>();
const onlyPlatformAdmins: MiddlewareHandler<Env> = async (c, next) => ((await isPlatformAdmin(c.get('user'))) ? next() : c.json({ error: 'Not found' }, 404));
platform.use('*', onlyPlatformAdmins);

const fail = (c: Context<Env>, err: unknown) => err instanceof DeployError
    ? c.json({ error: err.message }, err.status)
    : c.json({ error: (err as Error).message.slice(0, 300) }, 500);
const actor = (c: Context<Env>): PlatformActor => { const u = c.get('user')!; return { id: u.id, username: u.username, ip: c.get('ip') ?? null }; };
const wsId = (c: Context<Env>) => Number(c.req.param('id'));
const body = async (c: Context<Env>) => c.req.json().catch(() => ({})) as Promise<Record<string, unknown>>;
const done = async (c: Context<Env>, fn: () => Promise<unknown>) => {
    try { const r = await fn(); forgetStanding(wsId(c)); return c.json({ ok: true, result: r ?? null }); } catch (err) { return fail(c, err); }
};

platform.get('/overview', async (c) => { try { return c.json(await overview()); } catch (err) { return fail(c, err); } });
platform.get('/workspaces', async (c) => { try { return c.json({ workspaces: await listWorkspaces() }); } catch (err) { return fail(c, err); } });
platform.get('/workspaces/:id', async (c) => { try { return c.json(await workspaceDetail(wsId(c))); } catch (err) { return fail(c, err); } });
platform.get('/console', async (c) => { try { return c.json(await consoleHealth()); } catch (err) { return fail(c, err); } });
platform.get('/audit', async (c) => { try { return c.json({ entries: await platformAudit() }); } catch (err) { return fail(c, err); } });

const act = rateLimit(30, 10 * 60_000, (c) => `platform:${c.get('user')!.id}`);
platform.post('/workspaces/:id/suspend', denyDemo, act, async (c) => { const b = await body(c); return done(c, () => suspend(wsId(c), String(b.reason ?? ''), actor(c))); });
platform.post('/workspaces/:id/reactivate', denyDemo, act, (c) => done(c, () => reactivate(wsId(c), actor(c))));
platform.post('/workspaces/:id/extend', denyDemo, act, async (c) => { const b = await body(c); return done(c, () => extend(wsId(c), Number(b.days), actor(c))); });
platform.post('/workspaces/:id/credit', denyDemo, act, async (c) => { const b = await body(c); return done(c, () => grantCredit(wsId(c), Number(b.amount), String(b.note ?? ''), actor(c))); });
platform.post('/workspaces/:id/retry', denyDemo, act, (c) => done(c, () => retryCharge(wsId(c), actor(c))));
platform.put('/workspaces/:id/limits', denyDemo, act, async (c) => {
    const b = await body(c);
    return done(c, () => setLimits(wsId(c), b.clear === true ? null : { servers: b.servers as number, apps: b.apps as number, members: b.members as number, approvals: b.approvals === true, until: (b.until as string) || null }, actor(c)));
});
platform.post('/workspaces/:id/complimentary', denyDemo, act, async (c) => {
    const b = await body(c);
    const plan = b.plan === 'starter' || b.plan === 'pro' ? b.plan : b.plan === null ? null : 'invalid';
    return done(c, async () => {
        if (plan === 'invalid') throw new DeployError('Choose Starter or Pro.');
        await setComplimentary(wsId(c), plan, typeof b.until === 'string' && b.until ? b.until : null, actor(c));
    });
});
platform.put('/users/:userId/email', denyDemo, act, async (c) => {
    try { await changeEmail(Number(c.req.param('userId')), String((await body(c)).email ?? ''), actor(c)); return c.json({ ok: true }); } catch (err) { return fail(c, err); }
});

export default platform;
