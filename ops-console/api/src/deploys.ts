import { aws } from './aws';
import { InstanceRow } from './collector';
import { db } from './db';
import { announce } from './alerts';
import { forgetDetail } from './insights';
import { activeFreeze, deployPolicy } from './policy';

export const DEPLOY_DOCUMENT = 'OpsConsole-Deploy';

export const PROJECT_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
export const SHA_RE = /^[0-9a-f]{7,40}$/;

const GIVE_UP_UNREGISTERED_MS = 3 * 60_000;   // SSM never registered the command
const GIVE_UP_RUNNING_MS = 40 * 60_000;       // document timeout is 30 minutes

export interface DeploymentRow {
    id: number;
    instance_id: number;
    project: string;
    action: 'deploy' | 'rollback';
    ref: string;
    requested_by: number | null;
    requested_by_name: string;
    command_id: string | null;
    status: 'pending_approval' | 'running' | 'success' | 'failed' | 'rejected' | 'expired' | 'cancelled';
    ssm_status: string | null;
    output: string | null;
    created_at: string;
    finished_at: string | null;
    approved_by: string | null;
    approved_at: string | null;
    decision_reason: string | null;
    override_reason: string | null;
    expires_at: string | null;
    trigger?: string;
}

export function deploymentView(d: DeploymentRow, withOutput: boolean) {
    return {
        id: d.id, instanceId: d.instance_id, project: d.project, action: d.action, ref: d.ref,
        requestedBy: d.requested_by_name, status: d.status, ssmStatus: d.ssm_status,
        createdAt: d.created_at, finishedAt: d.finished_at, approvedBy: d.approved_by, approvedAt: d.approved_at,
        decisionReason: d.decision_reason, overrideReason: d.override_reason, expiresAt: d.expires_at, trigger: d.trigger ?? 'console',
        output: withOutput ? d.output : undefined,
    };
}

/** Actor string recorded by the pipeline (must match the document's allowedPattern). */
export const actorFor = (username: string) => `${username}@ops-console`.replace(/[^A-Za-z0-9._@:-]/g, '').slice(0, 64);

export class DeployError extends Error {
    constructor(message: string, public status: 400 | 403 | 404 | 409 = 400, public code?: string) { super(message); }
}

export interface Requester { id: number | null; username: string; role: 'admin' | 'deployer' | 'viewer' }
const PUBLIC_URL = process.env.PUBLIC_URL || 'https://ops.glenify.studio';
const fmt = (iso: string, tz: string) => new Date(iso).toLocaleString('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/**
 * Ask for a deploy or rollback. Applies the deploy policy:
 * - inside a freeze window: refused (rollbacks allowed if the policy says so), unless an admin overrides with a reason
 * - approvals required for the environment: recorded as pending_approval and announced; a different deployer/admin
 *   must approve it before anything runs (admin override with a reason skips this too)
 * - otherwise: started immediately
 */
export async function requestDeployment(inst: InstanceRow, project: string, action: 'deploy' | 'rollback', ref: string,
                                        user: Requester, override?: string, trigger: 'console' | 'github' = 'console'): Promise<DeploymentRow> {
    if (!PROJECT_RE.test(project)) throw new DeployError('Invalid project.');
    if (ref && (!REF_RE.test(ref) || ref.includes('..'))) throw new DeployError('Invalid git ref.');
    if (action === 'rollback' && ref && !SHA_RE.test(ref)) throw new DeployError('Roll back to a commit SHA (7–40 hex characters), or leave it empty for the previous good deploy.');
    if (!inst.last_status?.apps.some((a) => a.project === project)) throw new DeployError(`${project} isn't an app on ${inst.name}.`);
    const reason = (override ?? '').trim().slice(0, 300);
    if (override !== undefined) {
        if (user.role !== 'admin') throw new DeployError('Only admins can override the deploy policy.', 403);
        if (reason.length < 10) throw new DeployError('Give a reason of at least 10 characters for the override.');
    }

    const policy = await deployPolicy();
    const freeze = activeFreeze(policy, inst.environment);
    const freezeApplies = !!freeze && !(action === 'rollback' && policy.rollbackAllowedInFreeze);
    if (freezeApplies && !reason) {
        throw new DeployError(`Deploys to ${inst.environment} are frozen (“${freeze!.name}”) until ${fmt(freeze!.endsAt, policy.timezone)}.`, 409, 'frozen');
    }
    const env = inst.environment as keyof typeof policy.approvals;
    const needsApproval = !!policy.approvals[env] && (action === 'deploy' || policy.rollbackNeedsApproval);

    await syncRunning(inst.id);
    await expirePending();
    if (needsApproval && !reason) {
        let row: DeploymentRow;
        try {
            ({ rows: [row] } = await db().query<DeploymentRow>(
                `INSERT INTO deployments (instance_id, project, action, ref, requested_by, requested_by_name, status, expires_at, trigger)
                 VALUES ($1, $2, $3, $4, $5, $6, 'pending_approval', now() + make_interval(mins => $7), $8) RETURNING *`,
                [inst.id, project, action, ref, user.id, user.username, policy.requestTtlMinutes, trigger]));
        } catch (err) {
            if ((err as { code?: string }).code === '23505') throw new DeployError(`There is already a request waiting for approval for ${project} on ${inst.name}.`, 409);
            throw err;
        }
        await announce(`[APPROVAL NEEDED] ${action === 'deploy' ? 'Deploy' : 'Rollback'} of ${project} to ${inst.environment}`,
            `${user.username} wants to ${action} ${project}${ref ? ` (${ref})` : ''} on ${inst.name} (${inst.environment}).\n\n` +
            `Another deployer or admin must approve it within ${policy.requestTtlMinutes} minutes:\n${PUBLIC_URL}/instances/${inst.id}/apps/${project}?tab=deploy`, 'approval');
        return row;
    }
    const row = await launch(inst, project, action, ref, user, null, reason || null, undefined, trigger);
    if (reason) {
        await announce(`[OVERRIDE] ${user.username} ${action === 'deploy' ? 'deployed' : 'rolled back'} ${project} on ${inst.name}`,
            `${freezeApplies ? `Freeze “${freeze!.name}” was overridden. ` : ''}${needsApproval ? 'Approval was skipped. ' : ''}Reason given:\n\n${reason}\n\n${PUBLIC_URL}/instances/${inst.id}/apps/${project}?tab=deploy`, 'override');
    }
    return row;
}

/** Insert (or promote a pending row to) a running deployment and send the SSM command. */
async function launch(inst: InstanceRow, project: string, action: 'deploy' | 'rollback', ref: string, requester: { id: number | null; username: string },
                      pendingId: number | null, override: string | null, approver?: string, trigger: 'console' | 'github' = 'console'): Promise<DeploymentRow> {
    if (inst.last_status?.deploying) throw new DeployError(`A pipeline run is already in progress on ${inst.name} (${inst.last_status.deploying.project}).`, 409);
    let row: DeploymentRow;
    try {
        if (pendingId) {
            ({ rows: [row] } = await db().query<DeploymentRow>(
                `UPDATE deployments SET status = 'running', approved_by = $2, approved_at = now() WHERE id = $1 AND status = 'pending_approval' RETURNING *`,
                [pendingId, approver]));
            if (!row) throw new DeployError('That request is no longer waiting for approval.', 409);
        } else {
            ({ rows: [row] } = await db().query<DeploymentRow>(
                `INSERT INTO deployments (instance_id, project, action, ref, requested_by, requested_by_name, override_reason, trigger)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`, [inst.id, project, action, ref, requester.id, requester.username, override, trigger]));
        }
    } catch (err) {
        if ((err as { code?: string }).code === '23505') throw new DeployError(`Another deployment on ${inst.name} is still running.`, 409);
        throw err;
    }
    try {
        const commandId = await aws().sendDocument(inst.region, inst.aws_instance_id, DEPLOY_DOCUMENT, {
            action: [action], project: [project], ref: [ref], actor: [actorFor(requester.username)],
        });
        const { rows } = await db().query<DeploymentRow>('UPDATE deployments SET command_id = $2 WHERE id = $1 RETURNING *', [row.id, commandId]);
        return rows[0];
    } catch (err) {
        const msg = `Couldn't start via SSM: ${(err as Error).message.slice(0, 200)}`;
        await db().query(`UPDATE deployments SET status = 'failed', ssm_status = 'NotSent', output = $2, finished_at = now() WHERE id = $1`, [row.id, msg]);
        throw new DeployError(msg);
    }
}

async function pending(id: number): Promise<{ d: DeploymentRow; inst: InstanceRow }> {
    await expirePending();
    const { rows: [d] } = await db().query<DeploymentRow>('SELECT * FROM deployments WHERE id = $1', [id]);
    if (!d) throw new DeployError('Deployment not found.', 404);
    if (d.status !== 'pending_approval') throw new DeployError(`This request is ${d.status.replace('_', ' ')}.`, 409);
    const { rows: [inst] } = await db().query<InstanceRow>('SELECT * FROM instances WHERE id = $1', [d.instance_id]);
    if (!inst) throw new DeployError('Instance not found.', 404);
    return { d, inst };
}

/** A different deployer/admin approves: the freeze is checked again at this moment, then it starts. */
export async function approveDeployment(id: number, user: Requester): Promise<DeploymentRow> {
    const { d, inst } = await pending(id);
    if (d.requested_by !== null && d.requested_by === user.id) throw new DeployError('You can\'t approve your own request; another deployer or admin has to.', 403);
    const policy = await deployPolicy();
    const freeze = activeFreeze(policy, inst.environment);
    if (freeze && !(d.action === 'rollback' && policy.rollbackAllowedInFreeze)) {
        throw new DeployError(`Can't start now: deploys are frozen (“${freeze.name}”) until ${fmt(freeze.endsAt, policy.timezone)}.`, 409, 'frozen');
    }
    await syncRunning(inst.id);
    return launch(inst, d.project, d.action, d.ref, { id: d.requested_by, username: d.requested_by_name }, d.id, null, user.username);
}

export async function rejectDeployment(id: number, user: Requester, reason: string): Promise<DeploymentRow> {
    const { d } = await pending(id);
    const own = d.requested_by === user.id;
    const { rows: [row] } = await db().query<DeploymentRow>(
        `UPDATE deployments SET status = $2, decision_reason = $3, approved_by = $4, finished_at = now() WHERE id = $1 AND status = 'pending_approval' RETURNING *`,
        [d.id, own ? 'cancelled' : 'rejected', reason.trim().slice(0, 300) || null, user.username]);
    if (!row) throw new DeployError('That request is no longer waiting for approval.', 409);
    return row;
}

export async function expirePending(): Promise<void> {
    await db().query(`UPDATE deployments SET status = 'expired', finished_at = now() WHERE status = 'pending_approval' AND expires_at < now()`);
}

/** Bring a running deployment up to date from SSM (no-op once finished). */
export async function syncDeployment(d: DeploymentRow): Promise<DeploymentRow> {
    if (d.status !== 'running') return d;
    const { rows: [inst] } = await db().query<InstanceRow>('SELECT * FROM instances WHERE id = $1', [d.instance_id]);
    if (!inst) return d;
    const age = Date.now() - new Date(d.approved_at ?? d.created_at).getTime();
    let inv = null;
    if (d.command_id) {
        try {
            inv = await aws().getInvocation(inst.region, inst.aws_instance_id, d.command_id);
        } catch {
            return d;   // transient AWS error: try again next time
        }
    }
    if (!inv) {
        if (age < GIVE_UP_UNREGISTERED_MS) return d;
        return finish(d.id, 'failed', 'Unregistered', 'SSM never started the command.');
    }
    if (inv.status === 'running') {
        if (age < GIVE_UP_RUNNING_MS) {
            if (inv.detail !== d.ssm_status) {
                const { rows } = await db().query<DeploymentRow>('UPDATE deployments SET ssm_status = $2 WHERE id = $1 RETURNING *', [d.id, inv.detail]);
                return rows[0];
            }
            return d;
        }
        return finish(d.id, 'failed', inv.detail, 'Gave up waiting for the command.');
    }
    const output = [inv.stdout, inv.stderr].filter(Boolean).join('\n').slice(-20_000);
    const done = await finish(d.id, inv.status, inv.detail, output);
    // the instance's snapshot is now stale (new SHA, deploy events): fetch again on the next read
    await db().query('UPDATE instances SET last_fetched_at = NULL WHERE id = $1', [d.instance_id]);
    forgetDetail(d.instance_id, d.project);
    return done;
}

async function finish(id: number, status: 'success' | 'failed', ssmStatus: string, output: string): Promise<DeploymentRow> {
    const { rows } = await db().query<DeploymentRow>(
        `UPDATE deployments SET status = $2, ssm_status = $3, output = $4, finished_at = now() WHERE id = $1 RETURNING *`,
        [id, status, ssmStatus, output]);
    return rows[0];
}

export async function syncRunning(instanceId?: number): Promise<void> {
    const { rows } = await db().query<DeploymentRow>(
        `SELECT * FROM deployments WHERE status = 'running' ${instanceId ? 'AND instance_id = $1' : ''}`, instanceId ? [instanceId] : []);
    for (const d of rows) await syncDeployment(d).catch(() => undefined);
}
