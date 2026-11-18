import { Context, Hono } from 'hono';
import { checkLimit } from '../billing';
import { audit } from '../audit';
import { InstanceRow } from '../collector';
import { db } from '../db';
import { DeployError, deploymentView } from '../deploys';
import { githubConfig } from '../github';
import { denyDemo, Env, rateLimit, requireRole } from '../middleware';
import { appAddress, appsDomain, check, createApp, detect, enableHttps, validate } from '../newapp';

/** Mounted on /api; every route carries its own guards. */
const newapp = new Hono<Env>();
const fail = (c: Context<Env>, err: unknown) => err instanceof DeployError
    ? c.json({ error: err.message, code: err.code }, err.status)
    : c.json({ error: (err as Error).message.slice(0, 300) }, 502);
async function inst(c: Context<Env>): Promise<InstanceRow | null> {
    const { rows } = await db().query<InstanceRow>('SELECT * FROM instances WHERE id = $1', [Number(c.req.param('id'))]);
    return rows[0] ?? null;
}

/** What package.json says: scripts, a start/build/migrate guess and warnings. */
newapp.get('/github/detect', requireRole('admin'), denyDemo, async (c) => {
    if (!(await githubConfig())) return c.json({ error: 'GitHub is not connected.' }, 409);
    try { return c.json(await detect(c.req.query('repo') ?? '', c.req.query('branch') ?? 'main', c.req.query('subdir') ?? '')); } catch (err) { return fail(c, err); }
});

newapp.get('/instances/:id/new-app/check', requireRole('admin'), denyDemo, async (c) => {
    const i = await inst(c);
    if (!i) return c.json({ error: 'Instance not found' }, 404);
    try { return c.json({ ...(await check(i, c.req.query('project') ?? '', (c.req.query('subdomain') ?? '').toLowerCase())), appsDomain: await appsDomain() }); } catch (err) { return fail(c, err); }
});

newapp.post('/instances/:id/new-app', requireRole('admin'), denyDemo, rateLimit(30, 30 * 60_000, (c) => `new-app:${c.get('user')!.id}`), async (c) => {
    const i = await inst(c);
    if (!i) return c.json({ error: 'Instance not found' }, 404);
    const user = c.get('user')!;
    try {
        const v = validate(await c.req.json().catch(() => ({})));
        await checkLimit(user.workspaceId ?? 1, 'apps');
        const d = await createApp(i, v, user);
        await audit({ id: user.id, username: user.username }, 'app.create', `${v.project} on ${i.name}`,
            { repo: v.repo, branch: v.branch, domain: `${v.subdomain}.${await appsDomain()}`, db: v.db, deployment: d.id, override: v.override || undefined }, c.get('ip'));
        return c.json({ deployment: deploymentView(d, true) }, 202);
    } catch (err) { return fail(c, err); }
});

/** Recent creations (for the wizard's history and the instance page). */
newapp.get('/instances/:id/new-app', requireRole('deployer'), denyDemo, async (c) => {
    const { rows } = await db().query(
        `SELECT id, deployment_id AS "deploymentId", project, repo, branch, domain, with_db AS "withDb", port, tls, status, created_by AS "createdBy",
                created_at AS "createdAt", finished_at AS "finishedAt" FROM app_creations WHERE instance_id = $1 ORDER BY created_at DESC LIMIT 20`,
        [Number(c.req.param('id'))]);
    return c.json({ creations: rows });
});

/** An app's address: DNS status and HTTPS (shown on the app page while HTTPS is missing). */
newapp.get('/instances/:id/apps/:project/address', requireRole('viewer'), async (c) => {
    const i = await inst(c);
    if (!i) return c.json({ error: 'Instance not found' }, 404);
    try { return c.json({ address: await appAddress(i, c.req.param('project')) }); } catch (err) { return fail(c, err); }
});
newapp.post('/instances/:id/apps/:project/https', requireRole('deployer'), denyDemo, rateLimit(10, 10 * 60_000, (c) => `https:${c.get('user')!.id}`), async (c) => {
    const i = await inst(c);
    if (!i) return c.json({ error: 'Instance not found' }, 404);
    const project = c.req.param('project');
    try {
        const r = await enableHttps(i, project);
        const user = c.get('user')!;
        if (r.tls) await audit({ id: user.id, username: user.username }, 'app.https', `${project} on ${i.name}`, {}, c.get('ip'));
        return c.json(r);
    } catch (err) { return fail(c, err); }
});

export default newapp;
