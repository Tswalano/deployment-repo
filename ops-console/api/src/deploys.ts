import { aws } from './aws';
import { InstanceRow } from './collector';
import { db } from './db';
import { forgetDetail } from './insights';

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
    status: 'running' | 'success' | 'failed';
    ssm_status: string | null;
    output: string | null;
    created_at: string;
    finished_at: string | null;
}

export function deploymentView(d: DeploymentRow, withOutput: boolean) {
    return {
        id: d.id, instanceId: d.instance_id, project: d.project, action: d.action, ref: d.ref,
        requestedBy: d.requested_by_name, status: d.status, ssmStatus: d.ssm_status,
        createdAt: d.created_at, finishedAt: d.finished_at,
        output: withOutput ? d.output : undefined,
    };
}

/** Actor string recorded by the pipeline (must match the document's allowedPattern). */
export const actorFor = (username: string) => `${username}@ops-console`.replace(/[^A-Za-z0-9._@:-]/g, '').slice(0, 64);

export class DeployError extends Error {
    constructor(message: string, public status: 400 | 409 = 400) { super(message); }
}

export async function startDeployment(inst: InstanceRow, project: string, action: 'deploy' | 'rollback', ref: string,
                                      user: { id: number; username: string }): Promise<DeploymentRow> {
    if (!PROJECT_RE.test(project)) throw new DeployError('Invalid project.');
    if (ref && (!REF_RE.test(ref) || ref.includes('..'))) throw new DeployError('Invalid git ref.');
    if (action === 'rollback' && ref && !SHA_RE.test(ref)) throw new DeployError('Roll back to a commit SHA (7–40 hex characters), or leave it empty for the previous good deploy.');
    if (!inst.last_status?.apps.some((a) => a.project === project)) throw new DeployError(`${project} isn't an app on ${inst.name}.`);
    if (inst.last_status?.deploying) throw new DeployError(`A pipeline run is already in progress on ${inst.name} (${inst.last_status.deploying.project}).`, 409);

    await syncRunning(inst.id);
    let row: DeploymentRow;
    try {
        ({ rows: [row] } = await db().query<DeploymentRow>(
            `INSERT INTO deployments (instance_id, project, action, ref, requested_by, requested_by_name)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`, [inst.id, project, action, ref, user.id, user.username]));
    } catch (err) {
        if ((err as { code?: string }).code === '23505') throw new DeployError(`Another deployment on ${inst.name} is still running.`, 409);
        throw err;
    }
    try {
        const commandId = await aws().sendDocument(inst.region, inst.aws_instance_id, DEPLOY_DOCUMENT, {
            action: [action], project: [project], ref: [ref], actor: [actorFor(user.username)],
        });
        const { rows } = await db().query<DeploymentRow>('UPDATE deployments SET command_id = $2 WHERE id = $1 RETURNING *', [row.id, commandId]);
        return rows[0];
    } catch (err) {
        const msg = `Couldn't start via SSM: ${(err as Error).message.slice(0, 200)}`;
        await db().query(`UPDATE deployments SET status = 'failed', ssm_status = 'NotSent', output = $2, finished_at = now() WHERE id = $1`, [row.id, msg]);
        throw new DeployError(msg);
    }
}

/** Bring a running deployment up to date from SSM (no-op once finished). */
export async function syncDeployment(d: DeploymentRow): Promise<DeploymentRow> {
    if (d.status !== 'running') return d;
    const { rows: [inst] } = await db().query<InstanceRow>('SELECT * FROM instances WHERE id = $1', [d.instance_id]);
    if (!inst) return d;
    const age = Date.now() - new Date(d.created_at).getTime();
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
