import { audit } from './audit';
import { aws } from './aws';
import { InstanceRow } from './collector';
import { db } from './db';
import { DeployError, DeploymentRow, Requester, syncDeployment } from './deploys';

/**
 * Server components: databases (PostgreSQL, MariaDB, SQLite), services (Valkey, nginx) and runtimes (Python, Node.js)
 * on one server, from the OS repositories (OpsConsole-Components). The inventory is read on demand and kept with the
 * instance; installing, starting, stopping or removing runs in the background as a job tracked like a deploy (one job
 * per server at a time, shown in Activity).
 */
export const COMPONENTS_DOCUMENT = 'OpsConsole-Components';
export type ComponentId = 'postgresql' | 'mariadb' | 'valkey' | 'sqlite' | 'python';
export type ComponentAction = 'install' | 'start' | 'stop' | 'remove';
export const CHANGEABLE: Record<ComponentId, ComponentAction[]> = {
    postgresql: ['install', 'start', 'stop'],
    mariadb: ['install', 'start', 'stop', 'remove'],
    valkey: ['install', 'start', 'stop', 'remove'],
    sqlite: ['install', 'remove'],
    python: ['install', 'remove'],
};
const CACHE_MS = 10 * 60_000;

export interface Component {
    id: string; name: string; category: 'database' | 'service' | 'runtime'; installed: boolean; version: string | null; versions?: string[];
    active: boolean | null; memoryMb: number; needMb: number; service: string | null; offered: string[]; note: string; readOnly?: boolean;
}
export interface Inventory { components: Component[]; host: { memoryTotalMb: number; memoryAvailableMb: number; swapFreeMb: number; consoleHost: boolean } }

const parse = (out: string): (Inventory & { ok: boolean; error: string | null }) | null => {
    try { const j = JSON.parse(out.trim().split('\n').filter(Boolean).pop() ?? '{}'); return Array.isArray(j.components) ? j : null; } catch { return null; }
};

/** Whether this server's AWS account has the components document (it arrives with a connection update). */
export async function componentsAvailable(inst: InstanceRow): Promise<boolean> {
    return aws().documentExists ? aws().documentExists!(inst.region, COMPONENTS_DOCUMENT) : true;
}

async function latestJob(inst: InstanceRow): Promise<DeploymentRow | null> {
    const { rows: [d] } = await db().query<DeploymentRow>(`SELECT * FROM deployments WHERE instance_id = $1 AND action = 'component' ORDER BY created_at DESC LIMIT 1`, [inst.id]);
    return d ? syncDeployment(d) : null;
}

/** The inventory: kept for 10 minutes, read again when asked, or after a component job finished since. */
export async function inventory(inst: InstanceRow, fresh: boolean): Promise<{ inventory: Inventory | null; at: string | null; job: DeploymentRow | null; available: boolean }> {
    const available = await componentsAvailable(inst);
    const job = await latestJob(inst);
    const row = inst as InstanceRow & { components: Inventory | null; components_at: Date | null };
    const at = row.components_at ? new Date(row.components_at).getTime() : 0;
    const stale = !row.components || Date.now() - at > CACHE_MS || (job?.finished_at && new Date(job.finished_at).getTime() > at);
    if (!available || job?.status === 'running' || (!fresh && !stale)) {
        return { inventory: row.components, at: row.components_at ? new Date(row.components_at).toISOString() : null, job, available };
    }
    if (inst.ec2_state && inst.ec2_state !== 'running') throw new DeployError(`${inst.name} is ${inst.ec2_state}: start it to see its components.`, 409);
    const out = await aws().runDocument(inst.region, inst.aws_instance_id, COMPONENTS_DOCUMENT, { action: ['list'], component: [''], version: [''] }, 80_000);
    const inv = parse(out);
    if (!inv) throw new DeployError(`Couldn't read the server's components: ${out.trim().split('\n').pop()?.slice(0, 200) ?? 'no output'}`, 409);
    const keep: Inventory = { components: inv.components, host: inv.host };
    const { rows: [r] } = await db().query<{ components_at: Date }>('UPDATE instances SET components = $2, components_at = now() WHERE id = $1 RETURNING components_at', [inst.id, JSON.stringify(keep)]);
    return { inventory: keep, at: new Date(r.components_at).toISOString(), job, available };
}

/** Start a component job (admins). Checks here are for clear messages; the server script re-checks everything. */
export async function changeComponent(inst: InstanceRow, action: ComponentAction, component: ComponentId, version: string, user: Requester & { id: number }, ip: string | null): Promise<DeploymentRow> {
    if (!(component in CHANGEABLE) || !CHANGEABLE[component].includes(action)) throw new DeployError(`${component} can't be ${action === 'stop' ? 'stopped' : `${action}ed`} from the console.`);
    if (version && !/^\d{1,2}(\.\d{1,2})?$/.test(version)) throw new DeployError('Invalid version.');
    if (component === 'python' && !/^3\.1\d$/.test(version)) throw new DeployError('Choose a Python version, for example 3.12.');
    if (!(await componentsAvailable(inst))) throw new DeployError('This AWS account needs a connection update before components can be managed (see the notice on this page).', 409, 'connection_update_needed');
    const info = await aws().describeInstance(inst.region, inst.aws_instance_id);
    if (!info) throw new DeployError('The server no longer exists in AWS.', 409);
    if (info.state !== 'running') throw new DeployError(`The server is ${info.state}: start it first.`, 409);
    if (!info.managedTag) throw new DeployError('The server is no longer tagged ops-console=managed.', 409);
    const what = `${action} ${component}${version ? ` ${version}` : ''}`;
    let row: DeploymentRow;
    try {
        ({ rows: [row] } = await db().query<DeploymentRow>(
            `INSERT INTO deployments (instance_id, project, action, ref, requested_by, requested_by_name, trigger) VALUES ($1, '_server', 'component', $2, $3, $4, 'console') RETURNING *`,
            [inst.id, what, user.id, user.username]));
    } catch (err) {
        if ((err as { code?: string }).code === '23505') throw new DeployError('Something is already running on this server (a deploy or another change): wait for it to finish.', 409);
        throw err;
    }
    try {
        const commandId = await aws().sendDocument(inst.region, inst.aws_instance_id, COMPONENTS_DOCUMENT, { action: [action], component: [component], version: [version] });
        const { rows: [d] } = await db().query<DeploymentRow>('UPDATE deployments SET command_id = $2 WHERE id = $1 RETURNING *', [row.id, commandId]);
        await audit({ id: user.id, username: user.username }, `component.${action}`, `${component}${version ? ` ${version}` : ''} on ${inst.name}`, { instance: inst.aws_instance_id }, ip);
        return d;
    } catch (err) {
        await db().query(`UPDATE deployments SET status = 'failed', ssm_status = 'NotSent', output = $2, finished_at = now() WHERE id = $1`, [row.id, `Couldn't start via SSM: ${(err as Error).message.slice(0, 200)}`]);
        throw new DeployError(`Couldn't start it: ${(err as Error).message.slice(0, 200)}`, 409);
    }
}
