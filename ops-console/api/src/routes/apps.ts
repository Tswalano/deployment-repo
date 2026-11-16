import { Context, Hono } from 'hono';
import { audit } from '../audit';
import { freshInstance, InstanceRow } from '../collector';
import { db } from '../db';
import { DeployError, deploymentView, DeploymentRow, PROJECT_RE, startDeployment, syncDeployment, syncRunning } from '../deploys';
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
    });
});

const operate = [requireRole('deployer'), denyDemo, rateLimit(20, 60_000, (c) => `deploy:${c.get('user')!.id}`)] as const;

for (const action of ['deploy', 'rollback'] as const) {
    apps.post(`/:id/apps/:project/${action}`, ...operate, async (c) => {
        const r = await load(c);
        if (r instanceof Response) return r;
        const b = await c.req.json().catch(() => ({}));
        const ref = String(b.ref ?? '').trim();
        const user = c.get('user')!;
        try {
            const d = await startDeployment(r.inst, r.project, action, ref, user);
            await audit({ id: user.id, username: user.username }, `app.${action}`, `${r.project} on ${r.inst.name}`,
                { ref: ref || '(default)', deployment: d.id }, c.get('ip'));
            return c.json({ deployment: deploymentView(d, true) }, 202);
        } catch (err) {
            if (err instanceof DeployError) return c.json({ error: err.message }, err.status);
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
    const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') || 30)));
    const { rows } = await db().query<DeploymentRow & { instance_name: string }>(
        `SELECT d.*, i.name AS instance_name FROM deployments d JOIN instances i ON i.id = d.instance_id
          ORDER BY d.created_at DESC LIMIT $1`, [limit]);
    return c.json({ deployments: rows.map((d) => ({ ...deploymentView(d, false), instance: d.instance_name })) });
});

deployments.get('/:id', async (c) => {
    const { rows } = await db().query<DeploymentRow>('SELECT * FROM deployments WHERE id = $1', [Number(c.req.param('id'))]);
    if (!rows.length) return c.json({ error: 'Deployment not found' }, 404);
    const d = await syncDeployment(rows[0]);
    return c.json({ deployment: deploymentView(d, canOperate(c)) });
});

export default apps;
