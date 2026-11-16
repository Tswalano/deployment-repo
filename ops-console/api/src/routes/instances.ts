import { Hono } from 'hono';
import { audit } from '../audit';
import { aws } from '../aws';
import { COLLECT_DOCUMENT, freshInstance, InstanceRow } from '../collector';
import { db } from '../db';
import { dbSeries } from '../insights';
import { denyDemo, Env, requireRole } from '../middleware';

const instances = new Hono<Env>();
instances.use('*', requireRole('viewer'));

const ID_RE = /^i-[0-9a-f]{8,17}$/;
const REGION_RE = /^[a-z]{2}(-gov)?-[a-z]+-\d$/;
const ENVIRONMENTS = ['production', 'staging', 'development'];

function view(r: InstanceRow) {
    return {
        id: r.id, name: r.name, awsInstanceId: r.aws_instance_id, region: r.region, environment: r.environment,
        createdAt: r.created_at, lastFetchedAt: r.last_fetched_at, lastOkAt: r.last_ok_at, lastError: r.last_error,
        status: r.last_status,
    };
}

async function all(): Promise<InstanceRow[]> {
    const { rows } = await db().query<InstanceRow>('SELECT * FROM instances ORDER BY lower(name)');
    return Promise.all(rows.map((r) => freshInstance(r)));
}

instances.get('/', async (c) => c.json({ instances: (await all()).map(view) }));

/** Everything the Overview page needs in one call. */
instances.get('/overview', async (c) => {
    const list = await all();
    const snaps = list.map((r) => r.last_status).filter((s): s is NonNullable<typeof s> => !!s);
    const apps = snaps.flatMap((s) => s.apps);
    const sum = (f: (s: (typeof snaps)[number]) => number) => snaps.reduce((a, s) => a + f(s), 0);
    const memTotal = sum((s) => s.host.memory.total), memUsed = sum((s) => s.host.memory.used);
    const diskTotal = sum((s) => s.host.disk.total), diskUsed = sum((s) => s.host.disk.used);
    const warnings = apps.reduce((a, x) => a + Math.max(0, x.warnings24h - x.errors24h), 0);
    const errors = apps.reduce((a, x) => a + x.errors24h, 0);
    const certsSoon = snaps.flatMap((s) => s.certificates).filter((x) => x.daysLeft !== null && x.daysLeft < 21).length;

    const { rows: samples } = await db().query(
        `SELECT instance_id AS "instanceId", at, mem_pct AS "memPct", disk_pct AS "diskPct", load1, swap_pct AS "swapPct",
                apps_healthy AS "appsHealthy", apps_total AS "appsTotal"
           FROM instance_samples WHERE at > now() - interval '24 hours' ORDER BY at`);

    const activity = list.flatMap((r) => (r.last_status?.deployEvents ?? []).map((e) => ({ ...e, instance: r.name })))
        .sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 12);

    const { rows: [alertCounts] } = await db().query(
        `SELECT count(*) FILTER (WHERE resolved_at IS NULL)::int AS open,
                count(*) FILTER (WHERE resolved_at IS NULL AND severity = 'critical')::int AS critical FROM alerts`);
    return c.json({
        alerts: alertCounts,
        generatedAt: new Date().toISOString(),
        kpis: {
            instances: list.length,
            instancesOnline: list.filter((r) => r.last_ok_at && !r.last_error).length,
            appsTotal: apps.length,
            appsHealthy: apps.filter((a) => a.healthy).length,
            warnings24h: warnings,
            errors24h: errors,
            memPct: memTotal ? Math.round((memUsed / memTotal) * 1000) / 10 : null,
            diskPct: diskTotal ? Math.round((diskUsed / diskTotal) * 1000) / 10 : null,
            databases: snaps.reduce((a, s) => a + s.databases.length, 0),
            certificatesExpiringSoon: certsSoon,
            deploying: snaps.map((s) => s.deploying).filter(Boolean),
        },
        instances: list.map(view),
        samples,
        activity,
    });
});

instances.get('/:id', async (c) => {
    const id = Number(c.req.param('id'));
    const { rows } = await db().query<InstanceRow>('SELECT * FROM instances WHERE id = $1', [id]);
    if (!rows.length) return c.json({ error: 'Instance not found' }, 404);
    const user = c.get('user')!;
    const force = c.req.query('refresh') === '1' && user.role !== 'viewer';   // viewers get the 30s cache
    const row = await freshInstance(rows[0], force);
    const { rows: samples } = await db().query(
        `SELECT at, mem_pct AS "memPct", disk_pct AS "diskPct", load1, swap_pct AS "swapPct",
                apps_healthy AS "appsHealthy", apps_total AS "appsTotal"
           FROM instance_samples WHERE instance_id = $1 AND at > now() - interval '24 hours' ORDER BY at`, [id]);
    return c.json({ instance: view(row), samples, dbSeries: await dbSeries(id) });
});

// ------------------------------------------------------------------ admin: add / rename / remove
// Guards are per route (not a second '*' router on the same prefix, which would also catch the GETs).
const adminOnly = [requireRole('admin'), denyDemo] as const;

instances.post('/', ...adminOnly, async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const awsId = String(b.awsInstanceId ?? '').trim();
    const region = String(b.region ?? '').trim();
    const environment = ENVIRONMENTS.includes(b.environment) ? b.environment : 'production';
    if (!ID_RE.test(awsId)) return c.json({ error: 'Instance ID looks like i-0123456789abcdef0.' }, 400);
    if (!REGION_RE.test(region)) return c.json({ error: 'Region looks like af-south-1.' }, 400);

    const { rows: dup } = await db().query('SELECT 1 FROM instances WHERE aws_instance_id = $1', [awsId]);
    if (dup.length) return c.json({ error: 'That instance is already added.' }, 409);

    let info;
    try {
        info = await aws().describeInstance(region, awsId);
    } catch (err) {
        return c.json({ error: `Couldn't look up the instance: ${(err as Error).message.slice(0, 160)}` }, 400);
    }
    if (!info) return c.json({ error: `No instance ${awsId} in ${region}.` }, 400);
    if (!info.managedTag) {
        return c.json({ error: `Tag the instance with ops-console = managed first (EC2 console → Tags). The console may only manage tagged instances.` }, 400);
    }
    if (info.state !== 'running') return c.json({ error: `The instance is ${info.state}. Start it, then add it.` }, 400);
    if (!(await aws().ssmOnline(region, awsId).catch(() => false))) {
        return c.json({ error: 'SSM can\'t reach the instance. It needs the SSM agent and an instance profile with AmazonSSMManagedInstanceCore.' }, 400);
    }

    const name = String(b.name ?? '').trim().slice(0, 60) || info.name || awsId;
    const { rows } = await db().query<InstanceRow>(
        `INSERT INTO instances (name, aws_instance_id, region, environment, added_by) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [name, awsId, region, environment, c.get('user')!.id]);
    await audit({ id: c.get('user')!.id, username: c.get('user')!.username }, 'instance.add', `${name} (${awsId})`,
        { region, environment, type: info.type, az: info.az }, c.get('ip'));
    const fetched = await freshInstance(rows[0], true);   // first snapshot right away
    return c.json({ instance: view(fetched), document: COLLECT_DOCUMENT }, 201);
});

instances.patch('/:id', ...adminOnly, async (c) => {
    const id = Number(c.req.param('id'));
    const b = await c.req.json().catch(() => ({}));
    const name = b.name === undefined ? undefined : String(b.name).trim().slice(0, 60);
    const environment = b.environment === undefined ? undefined : String(b.environment);
    if (name === '' ) return c.json({ error: 'Name can\'t be empty.' }, 400);
    if (environment !== undefined && !ENVIRONMENTS.includes(environment)) return c.json({ error: 'Unknown environment.' }, 400);
    const { rows } = await db().query<InstanceRow>(
        `UPDATE instances SET name = COALESCE($2, name), environment = COALESCE($3, environment) WHERE id = $1 RETURNING *`,
        [id, name ?? null, environment ?? null]);
    if (!rows.length) return c.json({ error: 'Instance not found' }, 404);
    await audit({ id: c.get('user')!.id, username: c.get('user')!.username }, 'instance.update', rows[0].name, { name, environment }, c.get('ip'));
    return c.json({ instance: view(rows[0]) });
});

instances.delete('/:id', ...adminOnly, async (c) => {
    const id = Number(c.req.param('id'));
    const { rows } = await db().query('DELETE FROM instances WHERE id = $1 RETURNING name, aws_instance_id', [id]);
    if (!rows.length) return c.json({ error: 'Instance not found' }, 404);
    await audit({ id: c.get('user')!.id, username: c.get('user')!.username }, 'instance.remove', `${rows[0].name} (${rows[0].aws_instance_id})`, {}, c.get('ip'));
    return c.json({ ok: true });
});

export default instances;
