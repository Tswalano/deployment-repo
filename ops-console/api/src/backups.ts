import { randomBytes } from 'crypto';
import { gunzipSync } from 'zlib';
import { raise, resolve } from './alerts';
import { aws, hostAws } from './aws';
import { InstanceRow } from './collector';
import { config } from './config';
import { db } from './db';
import { DeployError } from './deploys';

export const LIST_DOCUMENT = 'OpsConsole-Backups';
export const ACTION_DOCUMENT = 'OpsConsole-BackupAction';
export const DB_RE = /^[a-z0-9_]{1,40}$/;
export const DUMP_RE = /^[A-Za-z0-9_.-]{1,120}\.dump$/;
const LIST_FRESH_MS = 60_000;
const LINK_SECONDS = 300;

/* eslint-disable @typescript-eslint/no-explicit-any */
const listCache = new Map<number, { at: number; data: any }>();

export interface VerificationRow {
    id: number; instance_id: number; db: string; file: string; ok: boolean; tables: number | null; rows: string | null;
    live_tables: number | null; live_rows: string | null; seconds: number | null; error: string | null;
    trigger: 'auto' | 'manual'; requested_by: string | null; at: string;
}
export const verificationView = (v: VerificationRow) => ({
    id: v.id, db: v.db, file: v.file, ok: v.ok, tables: v.tables, rows: v.rows == null ? null : Number(v.rows),
    liveTables: v.live_tables, liveRows: v.live_rows == null ? null : Number(v.live_rows), seconds: v.seconds,
    error: v.error || null, trigger: v.trigger, requestedBy: v.requested_by, at: v.at,
});

export async function listBackups(inst: InstanceRow, force = false): Promise<any> {
    const hit = listCache.get(inst.id);
    if (!force && hit && Date.now() - hit.at < LIST_FRESH_MS) return hit.data;
    const out = await aws().runDocument(inst.region, inst.aws_instance_id, LIST_DOCUMENT);
    const data = JSON.parse(gunzipSync(Buffer.from(out.trim(), 'base64')).toString('utf8'));
    listCache.set(inst.id, { at: Date.now(), data });
    return data;
}

function check(dbName: string, file: string) {
    if (!DB_RE.test(dbName) || dbName === '_globals') throw new DeployError('Invalid database.');
    if (!DUMP_RE.test(file) || !file.startsWith(`${dbName}-`)) throw new DeployError('Invalid backup file.');
}

const parseLine = (out: string) => {
    const line = out.trim().split('\n').filter(Boolean).pop() ?? '{}';
    try { return JSON.parse(line); } catch { return { ok: false, error: out.slice(0, 200) }; }
};

export async function runBackup(inst: InstanceRow) {
    const r = parseLine(await aws().runDocument(inst.region, inst.aws_instance_id, ACTION_DOCUMENT, { action: ['run'] }, 300_000));
    listCache.delete(inst.id);
    await db().query('UPDATE instances SET last_fetched_at = NULL WHERE id = $1', [inst.id]);   // refresh backup status
    if (!r.ok) throw new DeployError(`Backup failed${r.error ? `: ${r.error}` : ''}.`);
    return { seconds: r.seconds, status: r.status };
}

/** Restore a dump into a throwaway database on the instance and record the result. */
export async function verifyBackup(inst: InstanceRow, dbName: string, file: string, trigger: 'auto' | 'manual', by: string | null): Promise<VerificationRow> {
    check(dbName, file);
    const r = parseLine(await aws().runDocument(inst.region, inst.aws_instance_id, ACTION_DOCUMENT,
        { action: ['verify'], db: [dbName], file: [file] }, 300_000));
    if (r.error && r.tables === undefined) throw new DeployError(r.error);
    const { rows: [v] } = await db().query<VerificationRow>(
        `INSERT INTO backup_verifications (instance_id, db, file, ok, tables, rows, live_tables, live_rows, seconds, error, trigger, requested_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
        [inst.id, dbName, file, !!r.ok, r.tables ?? null, r.rows ?? null, r.live_tables ?? null, r.live_rows ?? null, r.seconds ?? null, r.error || null, trigger, by]);
    const key = `backup_unrestorable:${inst.id}:${dbName}`;
    if (v.ok) await resolve(key);
    else {
        await raise({ key, rule: 'backup_unrestorable', severity: 'critical', instanceId: inst.id, title: `Backup of ${dbName} could not be restored`,
            detail: `Restore test of ${file} on ${inst.name} failed${v.error ? `: ${v.error}` : ''}. The database itself is untouched, but this backup can't be relied on.` });
    }
    listCache.delete(inst.id);
    return v;
}

/** Upload one dump to the private transfer bucket and return a 5-minute download link. */
export async function exportBackup(inst: InstanceRow, dbName: string, file: string) {
    check(dbName, file);
    if (!config.transferBucket) throw new DeployError('Downloads are not set up (run infra/ops-console-s3/setup.sh).');
    const key = `downloads/${randomBytes(16).toString('hex')}/${file}`;
    const r = parseLine(await aws().runDocument(inst.region, inst.aws_instance_id, ACTION_DOCUMENT,
        { action: ['export'], db: [dbName], file: [file], bucket: [config.transferBucket], key: [key] }, 120_000));
    if (!r.ok) throw new DeployError(r.error || 'Export failed.');
    // the transfer bucket is the console host's: sign with the host's identity (a customer role has no access to it)
    const url = await hostAws().presignGet(config.transferRegion, config.transferBucket, key, LINK_SECONDS, file);
    return { url, expiresAt: new Date(Date.now() + LINK_SECONDS * 1000).toISOString(), bytes: r.bytes, sha256: r.sha256 };
}

/**
 * After each nightly run, restore-test the newest dump of every database once.
 * Remembers the backup run it last tested per instance in settings (autoverify:<id>).
 */
export async function autoVerify(inst: InstanceRow): Promise<void> {
    const b = inst.last_status?.backups;
    if (!b?.ok || !b.items?.length || inst.last_error || inst.last_status?.deploying) return;
    const key = `autoverify:${inst.id}`;
    const { rows } = await db().query('SELECT value FROM settings WHERE key = $1', [key]);
    if (rows[0]?.value?.at === b.at) return;
    for (const item of b.items) {
        if (!item.ok || !item.file || item.name === '_globals' || !DB_RE.test(item.name) || !DUMP_RE.test(item.file)) continue;
        await verifyBackup(inst, item.name, item.file, 'auto', null).catch((err) => console.error('auto verify failed:', (err as Error).message));
    }
    await db().query(
        `INSERT INTO settings (key, value, updated_by) VALUES ($1, $2, 'auto') ON CONFLICT (workspace_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [key, JSON.stringify({ at: b.at })]);
}
