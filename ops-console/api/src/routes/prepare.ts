import { randomBytes } from 'crypto';
import { Context, Hono } from 'hono';
import { audit } from '../audit';
import { aws } from '../aws';
import { InstanceRow } from '../collector';
import { config } from '../config';
import { db } from '../db';
import { DeploymentRow, deploymentView } from '../deploys';
import { denyDemo, Env, rateLimit, requireRole } from '../middleware';

export const PREPARE_DOCUMENT = 'OpsConsole-PrepareServer';

/**
 * Prepare a customer's fresh server (multi-customer mode, Phase 12b-2): install what the console needs with
 * OpsConsole-PrepareServer, tracked like a deploy. Mounted at /api/instances (guards per route).
 */
const prepare = new Hono<Env>();
const multiOnly = async (c: Context<Env>, next: () => Promise<void>) => (config.multiTenant ? next() : c.json({ error: 'Not found' }, 404));

async function instance(c: Context<Env>): Promise<InstanceRow | null> {
    const { rows } = await db().query<InstanceRow>('SELECT * FROM instances WHERE id = $1', [Number(c.req.param('id'))]);
    return rows[0] ?? null;
}

/** The latest preparation run of this server (to resume the progress view). */
prepare.get('/:id/prepare', multiOnly, requireRole('viewer'), async (c) => {
    const inst = await instance(c);
    if (!inst) return c.json({ error: 'Instance not found' }, 404);
    const { rows: [d] } = await db().query<DeploymentRow>(`SELECT * FROM deployments WHERE instance_id = $1 AND action = 'prepare' ORDER BY created_at DESC LIMIT 1`, [inst.id]);
    const canSee = c.get('user')!.role !== 'viewer';
    return c.json({ deployment: d ? deploymentView(d, canSee) : null, configured: !!(config.serverBundleUrl && config.serverBundleSha256) });
});

prepare.post('/:id/prepare', multiOnly, requireRole('admin'), denyDemo, rateLimit(6, 10 * 60_000, (c) => `prepare:${c.get('user')!.id}`), async (c) => {
    const inst = await instance(c);
    if (!inst) return c.json({ error: 'Instance not found' }, 404);
    if (!config.serverBundleUrl || !config.serverBundleSha256) return c.json({ error: 'Server preparation is not set up on this console yet (SERVER_BUNDLE_URL / SERVER_BUNDLE_SHA256).' }, 409);
    const b = await c.req.json().catch(() => ({}));
    const user = c.get('user')!;
    try {
        const info = await aws().describeInstance(inst.region, inst.aws_instance_id);
        if (!info) return c.json({ error: 'The server no longer exists in your AWS account.' }, 409);
        if (info.state !== 'running') return c.json({ error: `The server is ${info.state}: start it first.` }, 409);
        if (!(await aws().ssmOnline(inst.region, inst.aws_instance_id))) {
            if (inst.profile_attached_at) {
                return c.json({ error: 'The server was already running when the console gave it access, so AWS Session Manager hasn\'t connected it yet. Reboot it once (about two minutes), then prepare it. Otherwise it connects by itself within about 30 minutes.', code: 'reboot_to_connect' }, 409);
            }
            return c.json({ error: "The server isn't reachable through AWS Session Manager yet. Just after adding it this takes a few minutes. If it stays this way, reboot it once, and check it has internet access (outbound HTTPS) and the OpsConsoleInstance profile.", code: 'not_reachable' }, 409);
        }
        // the status agent's read-only database password, kept in the customer's own account
        const existing = await aws().getParameter!(inst.region, '/apps/ops-dashboard/PGPASSWORD').catch(() => null);
        if (!existing) await aws().putParameter!(inst.region, '/apps/ops-dashboard/PGPASSWORD', randomBytes(24).toString('base64url'));
        let opened: string[] = [];
        if (b.openWeb === true) {
            const groups = (await aws().sshAccess!(inst.region, inst.aws_instance_id)).filter((g) => g.managedTag).map((g) => g.groupId);
            opened = await aws().openWebPorts!(inst.region, groups);
        }
        let row: DeploymentRow;
        try {
            ({ rows: [row] } = await db().query<DeploymentRow>(
                `INSERT INTO deployments (instance_id, project, action, ref, requested_by, requested_by_name, trigger) VALUES ($1, '_server', 'prepare', '', $2, $3, 'console') RETURNING *`,
                [inst.id, user.id, user.username]));
        } catch (err) {
            if ((err as { code?: string }).code === '23505') return c.json({ error: 'Something is already running on this server: wait for it to finish.' }, 409);
            throw err;
        }
        try {
            const commandId = await aws().sendDocument(inst.region, inst.aws_instance_id, PREPARE_DOCUMENT, { bundleUrl: [config.serverBundleUrl], sha256: [config.serverBundleSha256] });
            const { rows: [d] } = await db().query<DeploymentRow>('UPDATE deployments SET command_id = $2 WHERE id = $1 RETURNING *', [row.id, commandId]);
            await audit({ id: user.id, username: user.username }, 'instance.prepare', `${inst.name} (${inst.aws_instance_id})`, { openedWeb: opened }, c.get('ip'));
            return c.json({ deployment: deploymentView(d, true), openedWeb: opened }, 202);
        } catch (err) {
            await db().query(`UPDATE deployments SET status = 'failed', ssm_status = 'NotSent', output = $2, finished_at = now() WHERE id = $1`, [row.id, `Couldn't start via SSM: ${(err as Error).message.slice(0, 200)}`]);
            throw err;
        }
    } catch (err) {
        return c.json({ error: `AWS: ${(err as Error).message.slice(0, 240)}` }, 502);
    }
});

export default prepare;
