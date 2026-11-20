import { readFileSync } from 'fs';
import { join } from 'path';
import { Context, Hono } from 'hono';
import { audit } from '../audit';
import { aws } from '../aws';
import { config } from '../config';
import { connection, connectionView, consolePrincipal, disconnect, ensureConnection, REGION_RE, STACK_NAME, verifyConnection } from '../connections';
import { db } from '../db';
import { DeployError } from '../deploys';
import { COMPONENTS_DOCUMENT } from '../components';
import { addressTarget, AppsDomain, platformBase, platformDomainAvailable, workspaceAppsDomain } from '../newapp';
import { checkLimit } from '../billing';
import { denyDemo, Env, rateLimit, requireRole } from '../middleware';

/** Connect a workspace's own AWS account (multi-customer mode). Mounted at /api/aws-connection. */
const connect = new Hono<Env>();
connect.use('*', async (c, next) => (config.multiTenant ? next() : c.json({ error: 'Not found' }, 404)));
const admin = [requireRole('admin'), denyDemo] as const;
const fail = (c: Context<Env>, err: unknown) => err instanceof DeployError
    ? c.json({ error: err.message, code: err.code }, err.status)
    : c.json({ error: `AWS: ${(err as Error).message.slice(0, 200)}` }, 502);

export const REGIONS: [string, string][] = [
    ['af-south-1', 'Africa (Cape Town)'], ['eu-west-1', 'Europe (Ireland)'], ['eu-west-2', 'Europe (London)'], ['eu-central-1', 'Europe (Frankfurt)'],
    ['us-east-1', 'US East (N. Virginia)'], ['us-east-2', 'US East (Ohio)'], ['us-west-2', 'US West (Oregon)'], ['ap-southeast-1', 'Asia Pacific (Singapore)'],
    ['ap-southeast-2', 'Asia Pacific (Sydney)'], ['ap-south-1', 'Asia Pacific (Mumbai)'], ['me-central-1', 'Middle East (UAE)'], ['sa-east-1', 'South America (São Paulo)'],
];
const TEMPLATE = join(__dirname, '..', '..', 'assets', 'connect-aws.json');

/**
 * Whether the connected account has the console's newest commands. They arrive with the stack's template, so a
 * connection made before a new command existed needs a one-time stack update (Replace template). Checked against the
 * newest document; cached for 10 minutes per workspace.
 */
const NEWEST_DOCUMENT = COMPONENTS_DOCUMENT;
const updateCache = new Map<number, { at: number; needed: boolean }>();
async function updateNeeded(ws: number, region: string): Promise<boolean> {
    const hit = updateCache.get(ws);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.needed;
    const has = aws().documentExists ? await aws().documentExists!(region, NEWEST_DOCUMENT).catch(() => true) : true;
    updateCache.set(ws, { at: Date.now(), needed: !has });
    return !has;
}
export const forgetUpdateCheck = (ws: number) => updateCache.delete(ws);

connect.get('/', requireRole('viewer'), async (c) => {
    const conn = await ensureConnection();
    const principal = await consolePrincipal().catch(() => null);
    const q = new URLSearchParams({ stackName: STACK_NAME, param_ExternalId: conn.external_id, ...(principal ? { param_ConsolePrincipal: principal } : {}) });
    const quickCreateUrl = config.connectTemplateUrl
        ? `https://${conn.region}.console.aws.amazon.com/cloudformation/home?region=${conn.region}#/stacks/quickcreate?templateURL=${encodeURIComponent(config.connectTemplateUrl)}&${q}`
        : null;
    const isAdmin = c.get('user')!.role === 'admin';
    const v = connectionView(conn)!;
    const ws = c.get('user')!.workspaceId!;
    if (c.req.query('recheck') === '1') updateCache.delete(ws);
    const update = conn.status === 'connected' && (await updateNeeded(ws, conn.region))
        ? { needed: true, stackName: STACK_NAME, templateUrl: config.connectTemplateUrl || null,
            stacksUrl: `https://${conn.region}.console.aws.amazon.com/cloudformation/home?region=${conn.region}#/stacks?filteringText=${encodeURIComponent(STACK_NAME)}` }
        : { needed: false };
    return c.json({
        update: isAdmin ? update : { needed: update.needed },
        connection: { ...v, externalId: isAdmin ? v.externalId : undefined },   // only admins set up the role
        principal: isAdmin ? principal : undefined,
        quickCreateUrl: isAdmin ? quickCreateUrl : null,
        cloudFormationUrl: `https://${conn.region}.console.aws.amazon.com/cloudformation/home?region=${conn.region}#/stacks/create`,
        regions: REGIONS,
    });
});

/** The template with this workspace's values filled in (to upload in CloudFormation when there is no quick-create link). */
connect.get('/template', ...admin, async (c) => {
    const conn = await ensureConnection();
    const t = JSON.parse(readFileSync(TEMPLATE, 'utf8'));
    t.Parameters.ExternalId.Default = conn.external_id;
    const principal = await consolePrincipal().catch(() => null);
    if (principal) t.Parameters.ConsolePrincipal.Default = principal;
    c.header('Content-Disposition', 'attachment; filename="ops-console-connect-aws.json"');
    return c.body(JSON.stringify(t, null, 1), 200, { 'content-type': 'application/json' });
});

connect.post('/region', ...admin, async (c) => {
    const b = await c.req.json().catch(() => ({}));
    if (!REGION_RE.test(String(b.region ?? ''))) return c.json({ error: 'Choose a region.' }, 400);
    const conn = await connection();
    if (conn?.status === 'connected') return c.json({ error: 'Disconnect first to change the region.' }, 409);
    return c.json({ connection: connectionView(await ensureConnection(String(b.region))) });
});

connect.post('/verify', ...admin, rateLimit(10, 10 * 60_000, (c) => `awsverify:${c.get('user')!.workspaceId}`), async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const user = c.get('user')!;
    try {
        const r = await verifyConnection(b.roleArn, user.username);
        await audit({ id: user.id, username: user.username }, 'aws.connect', r.account_id, { region: r.region, roleArn: r.role_arn }, c.get('ip'));
        return c.json({ connection: connectionView(r) });
    } catch (err) { return fail(c, err); }
});

connect.post('/disconnect', ...admin, async (c) => {
    const user = c.get('user')!;
    const before = await connection();
    await disconnect();
    await audit({ id: user.id, username: user.username }, 'aws.disconnect', before?.account_id ?? null, { roleArn: before?.role_arn }, c.get('ip'));
    return c.json({ ok: true, note: `Delete the ${STACK_NAME} stack in your AWS account to remove the role completely.` });
});

// ------------------------------------------------------------------ servers in the connected account
connect.get('/servers', requireRole('deployer'), denyDemo, async (c) => {
    const conn = await connection();
    if (conn?.status !== 'connected') return c.json({ error: 'Connect your AWS account first.' }, 409);
    try {
        const list = await aws().listInstances!(conn.region);
        const { rows } = await db().query<{ aws_instance_id: string }>('SELECT aws_instance_id FROM instances');
        const added = new Set(rows.map((r) => r.aws_instance_id));
        return c.json({ region: conn.region, servers: list.map((s) => ({ ...s, added: added.has(s.id), linux: !/windows/i.test(s.platform) })) });
    } catch (err) { return fail(c, err); }
});

/** Add one of the account's servers: tag it (and its security groups), give it our instance profile if it has none. */
connect.post('/servers', ...admin, rateLimit(20, 10 * 60_000, (c) => `addserver:${c.get('user')!.id}`), async (c) => {
    const conn = await connection();
    if (conn?.status !== 'connected') return c.json({ error: 'Connect your AWS account first.' }, 409);
    const b = await c.req.json().catch(() => ({}));
    const id = String(b.awsInstanceId ?? '');
    const environment = ['production', 'staging', 'development'].includes(b.environment) ? b.environment : 'production';
    if (!/^i-[0-9a-f]{8,17}$/.test(id)) return c.json({ error: 'Choose a server.' }, 400);
    const user = c.get('user')!;
    try {
        const s = (await aws().listInstances!(conn.region)).find((x) => x.id === id);
        if (!s) return c.json({ error: 'That server was not found in your account.' }, 404);
        if (!(await db().query('SELECT 1 FROM instances WHERE aws_instance_id = $1', [id])).rows.length) await checkLimit(user.workspaceId!, 'servers');
        if (/windows/i.test(s.platform)) return c.json({ error: 'Only Linux servers are supported.' }, 409);
        const steps: string[] = [];
        if (!s.managedTag) { await aws().tagManaged!(conn.region, id, s.securityGroups); steps.push('tagged ops-console=managed'); }
        const profile = `OpsConsoleInstance-${conn.region}`;
        const attachedWhileRunning = !s.instanceProfile && s.state === 'running';
        if (!s.instanceProfile) { await aws().attachInstanceProfile!(conn.region, id, profile); steps.push(`attached ${profile}`); }
        const name = String(b.name ?? '').trim().slice(0, 60) || s.name || id;
        const { rows: [inst] } = await db().query(
            `INSERT INTO instances (name, aws_instance_id, region, environment, profile_attached_at) VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (workspace_id, aws_instance_id) DO UPDATE SET name = EXCLUDED.name, profile_attached_at = coalesce(EXCLUDED.profile_attached_at, instances.profile_attached_at)
             RETURNING id, name`, [name, id, conn.region, environment, attachedWhileRunning ? new Date().toISOString() : null]);
        await audit({ id: user.id, username: user.username }, 'instance.add', `${name} (${id})`, { region: conn.region, steps }, c.get('ip'));
        return c.json({ instance: inst, steps, rebootToConnect: attachedWhileRunning,
            note: attachedWhileRunning && !s.ssmOnline ? 'The server was already running, so it only picks up its new access after a restart: reboot it once (about two minutes) before preparing it.'
                : s.instanceProfile && s.instanceProfile !== profile ? `This server already has the instance profile ${s.instanceProfile}: give it AmazonSSMManagedInstanceCore (or switch it to ${profile}) so the console can reach it.` : null });
    } catch (err) { return fail(c, err); }
});

// ------------------------------------------------------------------ how the workspace's apps get addresses (Settings → App addresses)
connect.get('/apps-domain', requireRole('viewer'), async (c) => {
    const t = await addressTarget();
    return c.json({ appsDomain: await workspaceAppsDomain(), current: t ? { kind: t.kind, base: t.base } : null,
        platform: platformDomainAvailable() ? { base: await platformBase() } : null });
});
connect.put('/apps-domain', ...admin, async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const mode = b.mode === 'platform' || b.mode === 'external' ? b.mode : 'route53';
    const user = c.get('user')!;
    const save = async (value: AppsDomain) => {
        await db().query(`INSERT INTO settings (key, value, updated_by) VALUES ('apps_domain', $1, $2)
                          ON CONFLICT (workspace_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
            [JSON.stringify(value), user.username]);
        await audit({ id: user.id, username: user.username }, 'apps.domain', 'domain' in value ? value.domain : 'platform addresses', { mode }, c.get('ip'));
        const t = await addressTarget();
        return c.json({ appsDomain: value, current: t ? { kind: t.kind, base: t.base } : null });
    };
    if (mode === 'platform') {
        if (!platformDomainAvailable()) return c.json({ error: 'Provided addresses are not available on this platform.' }, 409);
        return save({ mode: 'platform' });
    }
    const domain = String(b.domain ?? '').trim().toLowerCase().replace(/\.$/, '');
    if (!/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/.test(domain)) return c.json({ error: 'Enter a domain like acme.com or apps.acme.com.' }, 400);
    if (config.platformAppsDomain && (domain === config.platformAppsDomain || domain.endsWith(`.${config.platformAppsDomain}`))) return c.json({ error: 'That domain belongs to the platform.' }, 400);
    if (mode === 'external') return save({ mode: 'external', domain });
    const conn = await connection();
    if (conn?.status !== 'connected') return c.json({ error: 'Connect the AWS account first.' }, 409);
    try {
        const zoneId = await aws().hostedZoneId!(domain);
        if (!zoneId) return c.json({ error: `There's no Route 53 hosted zone for ${domain} in the connected AWS account. Create one (and point the domain's name servers at it), or choose "Another DNS provider".` }, 409);
        return save({ mode: 'route53', domain, zoneId });
    } catch (err) { return fail(c, err); }
});

export default connect;
