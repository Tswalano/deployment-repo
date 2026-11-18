import { aws, BackupCopy } from './aws';
import { ACTION_DOCUMENT, DB_RE, DUMP_RE, verifyBackup, VerificationRow } from './backups';
import { InstanceRow } from './collector';
import { connection } from './connections';
import { db } from './db';
import { DeployError } from './deploys';

/**
 * Off-site copies of the nightly database dumps, and optional nightly server snapshots.
 * The bucket is the workspace's own (ops-console-backups-<account>-<region>, created by the connect template), so the
 * copies stay in the customer's AWS account. Servers add copies under <instance id>/<db>/<file>; the console lists,
 * downloads and restore-tests them through the workspace's role. Nobody deletes them: the bucket's lifecycle does.
 */
export interface OffsiteTarget { bucket: string; region: string; accountId: string }
export async function offsiteTarget(): Promise<OffsiteTarget | null> {
    const c = await connection().catch(() => null);
    if (!c || c.status !== 'connected' || !c.account_id) return null;
    return { bucket: `ops-console-backups-${c.account_id}-${c.region}`, region: c.region, accountId: c.account_id };
}

const parseLine = (out: string) => {
    const line = out.trim().split('\n').filter(Boolean).pop() ?? '{}';
    try { return JSON.parse(line); } catch { return { ok: false, error: out.slice(0, 200) }; }
};
const KEY_RE = /^(i-[0-9a-f]{8,17})\/([a-z0-9_]{1,40})\/([A-Za-z0-9_.-]{1,120}\.(dump|sql))$/;

export interface CopyView { key: string; db: string; file: string; bytes: number; at: string; storageClass: string }
const copyCache = new Map<number, { at: number; copies: CopyView[] | null }>();
/** This server's copies in the bucket (newest first); null when the bucket doesn't exist yet. */
export async function offsiteCopies(inst: InstanceRow, t: OffsiteTarget, force = false): Promise<CopyView[] | null> {
    const hit = copyCache.get(inst.id);
    if (!force && hit && Date.now() - hit.at < 60_000) return hit.copies;
    const list = await aws().listBackupCopies!(t.region, t.bucket, `${inst.aws_instance_id}/`);
    const copies = list === null ? null : list.flatMap((o: BackupCopy) => {
        const m = KEY_RE.exec(o.key);
        return m && m[1] === inst.aws_instance_id ? [{ key: o.key, db: m[2], file: m[3], bytes: o.bytes, at: o.at, storageClass: o.storageClass }] : [];
    });
    copyCache.set(inst.id, { at: Date.now(), copies });
    return copies;
}

/** Switch copying on (catching up on existing dumps now) or off for one server. */
export async function setOffsite(inst: InstanceRow, enabled: boolean): Promise<{ ok: boolean; offsite: unknown }> {
    const t = await offsiteTarget();
    if (enabled && !t) throw new DeployError('Connect the AWS account first.', 409);
    if (enabled && (await offsiteCopies(inst, t!, true)) === null) {
        throw new DeployError(`The backup bucket ${t!.bucket} doesn't exist yet. Update the OpsConsoleAccess CloudFormation stack to the latest template (Settings → AWS account), then try again.`, 409);
    }
    const r = parseLine(await aws().runDocument(inst.region, inst.aws_instance_id, ACTION_DOCUMENT,
        { action: ['offsite'], bucket: [enabled ? t!.bucket : ''], region: [enabled ? t!.region : ''] }, 600_000));
    copyCache.delete(inst.id);
    await db().query('UPDATE instances SET last_fetched_at = NULL WHERE id = $1', [inst.id]);
    if (r.error && r.offsite === undefined) throw new DeployError(r.error);
    return { ok: !!r.ok, offsite: r.offsite ?? null };
}

function parseKey(inst: InstanceRow, key: string) {
    const m = KEY_RE.exec(key);
    if (!m || m[1] !== inst.aws_instance_id) throw new DeployError('Invalid copy.');
    return { db: m[2], file: m[3] };
}

/** A 5-minute link to one off-site copy, signed with the workspace's own role. */
export async function copyLink(inst: InstanceRow, key: string) {
    const t = await offsiteTarget();
    if (!t) throw new DeployError('Connect the AWS account first.', 409);
    const { file } = parseKey(inst, key);
    const url = await aws().presignGet(t.region, t.bucket, key, 300, file);
    return { url, expiresAt: new Date(Date.now() + 300_000).toISOString() };
}

/** Restore-test an off-site copy: bring it back to the server (a few days only), then the usual throwaway restore. */
export async function verifyCopy(inst: InstanceRow, key: string, by: string): Promise<VerificationRow> {
    const t = await offsiteTarget();
    if (!t) throw new DeployError('Connect the AWS account first.', 409);
    const { db: dbName, file } = parseKey(inst, key);
    if (!DB_RE.test(dbName) || dbName === '_globals' || !DUMP_RE.test(file)) throw new DeployError('Only database dumps can be restore-tested.');
    const r = parseLine(await aws().runDocument(inst.region, inst.aws_instance_id, ACTION_DOCUMENT,
        { action: ['fetch'], bucket: [t.bucket], region: [t.region], key: [key] }, 300_000));
    if (!r.ok) throw new DeployError(r.error || 'Could not bring the copy back to the server.');
    return verifyBackup(inst, dbName, file, 'manual', by);
}

// ------------------------------------------------------------------ nightly server snapshots (optional)
export const SNAPSHOT_RETAIN = 7;
/** One policy per region with managed servers; "on" when every one of them is enabled. */
export async function snapshotState(): Promise<{ available: boolean; enabled: boolean; retain: number; regions: { region: string; enabled: boolean }[] }> {
    const t = await offsiteTarget();
    if (!t || !aws().snapshotPolicy) return { available: false, enabled: false, retain: SNAPSHOT_RETAIN, regions: [] };
    const { rows } = await db().query<{ region: string }>('SELECT DISTINCT region FROM instances ORDER BY region');
    const regions = [];
    for (const r of rows) {
        const p = await aws().snapshotPolicy!(r.region);
        regions.push({ region: r.region, enabled: !!p?.enabled });
    }
    return { available: true, enabled: regions.length > 0 && regions.every((r) => r.enabled), retain: SNAPSHOT_RETAIN, regions };
}
export async function setSnapshots(enabled: boolean): Promise<void> {
    const t = await offsiteTarget();
    if (!t || !aws().setSnapshotPolicy) throw new DeployError('Connect the AWS account first.', 409);
    // the role DLM uses was created by the connect template in the connection's region
    const roleArn = `arn:aws:iam::${t.accountId}:role/OpsConsoleSnapshots-${t.region}`;
    const { rows } = await db().query<{ region: string }>('SELECT DISTINCT region FROM instances');
    if (!rows.length) throw new DeployError('Add a server first.', 409);
    for (const r of rows) await aws().setSnapshotPolicy!(r.region, enabled, roleArn, SNAPSHOT_RETAIN);
}
