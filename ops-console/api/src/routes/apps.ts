import { Context, Hono } from 'hono';
import { audit } from '../audit';
import { freshInstance, InstanceRow } from '../collector';
import { db } from '../db';
import { approveDeployment, DeployError, deploymentView, DeploymentRow, expirePending, PROJECT_RE, rejectDeployment, requestDeployment, syncDeployment, syncRunning } from '../deploys';
import { policyFor } from '../policy';
import { appDetail, dbSeries, fetchLogs, shapeDetail } from '../insights';
import { denyDemo, Env, rateLimit, requireRole } from '../middleware';

/** Per-app views and actions, mounted under /api/instances/:id/apps/:project. */
const apps = new Hono<Env>();
apps.use('*', requireRole('viewer'));

const canOperate = (c: Context<Env>) => ['deployer', 'admin'].includes(c.get('user')!.role) && !c.get('user')!.isDemo;

async function load(c: Context<Env>): Promise<{ inst: InstanceRow; project: string } | Response> {
    const id = Number(c.req.param('id'));
    const project = c.req.param('project') ?? '';
    if (!PROJECT_RE.test(project)) return c.json({ error: 'App not found' }, 404);
    const { rows } = await db().query<InstanceRow>('SELECT * FROM instances WHERE id = $1', [id]);
    if (!rows.length) return c.json({ error: 'Instance not found' }, 404);
    return { inst: await freshInstance(rows[0]), project };
}

apps.get('/:id/apps/:project', async (c) => {
    const r = await load(c);
    if (r instanceof Response) return r;
    const { inst, project } = r;
    const app = inst.last_status?.apps.find((a) => a.project === project);
    if (!app) return c.json({ error: 'App not found' }, 404);
    await syncRunning(inst.id);
    await expirePending();
    const { rows } = await db().query<DeploymentRow>(
        'SELECT * FROM deployments WHERE instance_id = $1 AND project = $2 ORDER BY created_at DESC LIMIT 20', [inst.id, project]);
    const withOutput = canOperate(c);
    return c.json({
        instance: { id: inst.id, name: inst.name, awsInstanceId: inst.aws_instance_id, region: inst.region, environment: inst.environment, lastOkAt: inst.last_ok_at, lastError: inst.last_error },
        app,
        database: inst.last_status?.databases.find((d) => d.name === app.db) ?? null,
        certificate: inst.last_status?.certificates.find((x) => x.domain === app.domain) ?? null,
        deploying: inst.last_status?.deploying?.project === project ? inst.last_status.deploying : null,
        events: (inst.last_status?.deployEvents ?? []).filter((e) => e.project === project),
        deployments: rows.map((d) => deploymentView(d, withOutput)),
        canOperate: withOutput,
        policy: await policyFor(inst.environment),
        repo: (await db().query('SELECT repo, branch, auto_deploy AS "autoDeploy", linked_by AS "linkedBy" FROM app_repos WHERE instance_id = $1 AND project = $2', [inst.id, project])).rows[0] ?? null,
    });
});

const operate = [requireRole('deployer'), denyDemo, rateLimit(20, 60_000, (c) => `deploy:${c.get('user')!.id}`)] as const;

for (const action of ['deploy', 'rollback'] as const) {
    apps.post(`/:id/apps/:project/${action}`, ...operate, async (c) => {
        const r = await load(c);
        if (r instanceof Response) return r;
        const b = await c.req.json().catch(() => ({}));
        const ref = String(b.ref ?? '').trim();
        const override = typeof b.override === 'string' ? b.override : undefined;
        const user = c.get('user')!;
        try {
            const d = await requestDeployment(r.inst, r.project, action, ref, user, override);
            const what = d.status === 'pending_approval' ? `app.${action}_requested` : override !== undefined ? `app.${action}_override` : `app.${action}`;
            await audit({ id: user.id, username: user.username }, what, `${r.project} on ${r.inst.name}`,
                { ref: ref || '(default)', deployment: d.id, ...(override !== undefined ? { reason: d.override_reason } : {}) }, c.get('ip'));
            return c.json({ deployment: deploymentView(d, true) }, 202);
        } catch (err) {
            if (err instanceof DeployError) return c.json({ error: err.message, code: err.code }, err.status);
            throw err;
        }
    });
}

/** Full detail from the instance's agent: unit, health, git (incl. commits waiting on origin), DB metrics. */
apps.get('/:id/apps/:project/detail', async (c) => {
    const r = await load(c);
    if (r instanceof Response) return r;
    if (!r.inst.last_status?.apps.some((a) => a.project === r.project)) return c.json({ error: 'App not found' }, 404);
    const operator = canOperate(c);
    const fetch = c.req.query('fetch') === '1' && operator;      // git fetch only for deployers/admins
    try {
        const { data, fetchedAt } = await appDetail(r.inst, r.project, fetch);
        const shaped = shapeDetail(data, operator);
        const series = shaped.database?.ok && 'name' in shaped.database
            ? (await dbSeries(r.inst.id, 24, shaped.database.name))[shaped.database.name] ?? [] : [];
        return c.json({ detail: shaped, dbSeries: series, fetchedAt });
    } catch (err) {
        if (err instanceof DeployError) return c.json({ error: err.message }, err.status);
        return c.json({ error: `Couldn't load details: ${(err as Error).message.slice(0, 160)}` }, 502);
    }
});

apps.get('/:id/apps/:project/logs', requireRole('deployer'), denyDemo, rateLimit(30, 60_000, (c) => `logs:${c.get('user')!.id}`), async (c) => {
    const r = await load(c);
    if (r instanceof Response) return r;
    if (!r.inst.last_status?.apps.some((a) => a.project === r.project)) return c.json({ error: 'App not found' }, 404);
    const o = {
        lines: Number(c.req.query('lines') || 200), level: c.req.query('level') || 'all',
        since: c.req.query('since') || '24h', q: (c.req.query('q') || '').trim(),
    };
    try {
        const logs = await fetchLogs(r.inst, r.project, o);
        const user = c.get('user')!;
        await audit({ id: user.id, username: user.username }, 'app.logs', `${r.project} on ${r.inst.name}`,
            { level: o.level, since: o.since, q: o.q || undefined }, c.get('ip'));
        return c.json({ ...logs, fetchedAt: new Date().toISOString() });
    } catch (err) {
        if (err instanceof DeployError) return c.json({ error: err.message }, err.status);
        return c.json({ error: `Couldn't fetch logs: ${(err as Error).message.slice(0, 160)}` }, 502);
    }
});

/** /api/deployments: recent console deployments, and one deployment's live status. */
export const deployments = new Hono<Env>();
deployments.use('*', requireRole('viewer'));

deployments.get('/', async (c) => {
    await syncRunning();
    await expirePending();
    const status = c.req.query('status');
    const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') || 30)));
    const { rows } = await db().query<DeploymentRow & { instance_name: string }>(
        `SELECT d.*, i.name AS instance_name, i.environment AS instance_env FROM deployments d JOIN instances i ON i.id = d.instance_id
          ${status === 'pending' ? "WHERE d.status = 'pending_approval'" : ''}
          ORDER BY d.created_at DESC LIMIT $1`, [limit]);
    return c.json({ deployments: rows.map((d) => ({ ...deploymentView(d, false), instance: d.instance_name, environment: (d as DeploymentRow & { instance_env?: string }).instance_env })) });
});

deployments.get('/:id', async (c) => {
    const { rows } = await db().query<DeploymentRow>('SELECT * FROM deployments WHERE id = $1', [Number(c.req.param('id'))]);
    if (!rows.length) return c.json({ error: 'Deployment not found' }, 404);
    const d = await syncDeployment(rows[0]);
    return c.json({ deployment: deploymentView(d, canOperate(c)) });
});

const decide = [requireRole('deployer'), denyDemo, rateLimit(30, 60_000, (c) => `decide:${c.get('user')!.id}`)] as const;

deployments.post('/:id/approve', ...decide, async (c) => {
    const user = c.get('user')!;
    try {
        const d = await approveDeployment(Number(c.req.param('id')), user);
        await audit({ id: user.id, username: user.username }, `app.${d.action}_approved`, `${d.project} (#${d.id})`, { requestedBy: d.requested_by_name, ref: d.ref || '(default)' }, c.get('ip'));
        return c.json({ deployment: deploymentView(d, true) });
    } catch (err) {
        if (err instanceof DeployError) return c.json({ error: err.message, code: err.code }, err.status);
        throw err;
    }
});

/** Reject someone else's request, or cancel your own. */
deployments.post('/:id/reject', ...decide, async (c) => {
    const user = c.get('user')!;
    const b = await c.req.json().catch(() => ({}));
    try {
        const d = await rejectDeployment(Number(c.req.param('id')), user, String(b.reason ?? ''));
        await audit({ id: user.id, username: user.username }, `app.${d.action}_${d.status}`, `${d.project} (#${d.id})`, { reason: d.decision_reason }, c.get('ip'));
        return c.json({ deployment: deploymentView(d, true) });
    } catch (err) {
        if (err instanceof DeployError) return c.json({ error: err.message }, err.status);
        throw err;
    }
});

export default apps;
