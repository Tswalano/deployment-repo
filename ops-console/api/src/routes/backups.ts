import { Context, Hono } from 'hono';
import { audit } from '../audit';
import { exportBackup, listBackups, runBackup, verificationView, VerificationRow, verifyBackup } from '../backups';
import { InstanceRow } from '../collector';
import { config } from '../config';
import { db } from '../db';
import { DeployError } from '../deploys';
import { denyDemo, Env, rateLimit, requireRole } from '../middleware';
import { copyLink, offsiteCopies, offsiteTarget, setOffsite, setSnapshots, snapshotState, verifyCopy } from '../offsite';

const backups = new Hono<Env>();
backups.use('*', requireRole('viewer'));

const fail = (c: Context<Env>, err: unknown) => err instanceof DeployError
    ? c.json({ error: err.message }, err.status)
    : c.json({ error: `SSM: ${(err as Error).message.slice(0, 160)}` }, 502);

async function instance(c: Context<Env>): Promise<InstanceRow | null> {
    const { rows } = await db().query<InstanceRow>('SELECT * FROM instances WHERE id = $1', [Number(c.req.param('instanceId'))]);
    return rows[0] ?? null;
}

/** Inventory of every instance's backups (names, sizes, times; never contents) plus restore-test history. */
backups.get('/', async (c) => {
    const { rows: insts } = await db().query<InstanceRow>('SELECT * FROM instances ORDER BY lower(name)');
    const target = await offsiteTarget();
    const force = c.req.query('refresh') === '1' && c.get('user')!.role !== 'viewer';
    let bucketExists: boolean | null = null;
    const out = [];
    for (const inst of insts) {
        const { rows: v } = await db().query<VerificationRow>(
            'SELECT * FROM backup_verifications WHERE instance_id = $1 ORDER BY at DESC LIMIT 100', [inst.id]);
        try {
            const d = await listBackups(inst, force);
            // off-site copies of this server (the workspace's bucket); a listing error never hides the local backups
            let copies = null, copiesError = null;
            if (target) {
                try { copies = await offsiteCopies(inst, target, force); bucketExists = copies !== null; }
                catch (err) { copiesError = (err as Error).message.slice(0, 200); }
            }
            out.push({
                instanceId: inst.id, instance: inst.name, ok: true, location: d.location, diskFree: d.disk_free, timer: d.timer,
                lastRun: d.status ? { at: d.status.at, ok: d.status.ok, keepDays: d.status.keep_days, totalBytes: d.status.total_bytes, items: d.status.items } : null,
                files: d.files.map((f: { db: string; file: string; bytes: number; mtime: number; offsite?: boolean }) => ({ db: f.db, file: f.file, bytes: f.bytes, at: new Date(f.mtime * 1000).toISOString(), offsite: !!f.offsite })),
                verifications: v.map(verificationView),
                offsite: d.offsite ? { configured: !!d.offsite.configured, ok: !!d.offsite.ok, at: d.offsite.at, copied: d.offsite.copied, pending: d.offsite.pending,
                    error: d.offsite.error ?? null, keepLocalDays: d.offsite.keep_local_days } : null,
                copies, copiesError,
            });
        } catch (err) {
            out.push({ instanceId: inst.id, instance: inst.name, ok: false, error: (err as Error).message.slice(0, 200), verifications: v.map(verificationView),
                region: inst.region, state: inst.ec2_state ?? null, lastOkAt: inst.last_ok_at ?? null });
        }
    }
    return c.json({ instances: out, downloads: !!config.transferBucket, offsite: target ? { bucket: target.bucket, region: target.region, bucketExists } : null });
});

backups.post('/:instanceId/run', requireRole('deployer'), denyDemo, rateLimit(3, 10 * 60_000, (c) => `backup-run:${c.get('user')!.id}`), async (c) => {
    const inst = await instance(c);
    if (!inst) return c.json({ error: 'Instance not found' }, 404);
    const user = c.get('user')!;
    try {
        const r = await runBackup(inst);
        await audit({ id: user.id, username: user.username }, 'backup.run', inst.name, { seconds: r.seconds }, c.get('ip'));
        return c.json(r);
    } catch (err) { return fail(c, err); }
});

backups.post('/:instanceId/verify', requireRole('deployer'), denyDemo, rateLimit(10, 10 * 60_000, (c) => `backup-verify:${c.get('user')!.id}`), async (c) => {
    const inst = await instance(c);
    if (!inst) return c.json({ error: 'Instance not found' }, 404);
    const b = await c.req.json().catch(() => ({}));
    const user = c.get('user')!;
    try {
        const v = await verifyBackup(inst, String(b.db ?? ''), String(b.file ?? ''), 'manual', user.username);
        await audit({ id: user.id, username: user.username }, 'backup.verify', `${v.db}/${v.file} on ${inst.name}`, { ok: v.ok }, c.get('ip'));
        return c.json({ verification: verificationView(v) });
    } catch (err) { return fail(c, err); }
});

/** Admin only: a 5-minute link to one dump (it contains every row of that database). */
backups.post('/:instanceId/download', requireRole('admin'), denyDemo, rateLimit(10, 10 * 60_000, (c) => `backup-dl:${c.get('user')!.id}`), async (c) => {
    const inst = await instance(c);
    if (!inst) return c.json({ error: 'Instance not found' }, 404);
    const b = await c.req.json().catch(() => ({}));
    const user = c.get('user')!;
    try {
        const r = await exportBackup(inst, String(b.db ?? ''), String(b.file ?? ''));
        await audit({ id: user.id, username: user.username }, 'backup.download', `${b.db}/${b.file} on ${inst.name}`, { bytes: r.bytes, sha256: r.sha256 }, c.get('ip'));
        return c.json(r);
    } catch (err) { return fail(c, err); }
});

// ------------------------------------------------------------------ off-site copies (the workspace's own S3 bucket)
backups.post('/:instanceId/offsite', requireRole('admin'), denyDemo, rateLimit(10, 10 * 60_000, (c) => `offsite:${c.get('user')!.id}`), async (c) => {
    const inst = await instance(c);
    if (!inst) return c.json({ error: 'Instance not found' }, 404);
    const b = await c.req.json().catch(() => ({}));
    const user = c.get('user')!;
    try {
        const r = await setOffsite(inst, b.enabled === true);
        await audit({ id: user.id, username: user.username }, 'backup.offsite', inst.name, { enabled: b.enabled === true }, c.get('ip'));
        return c.json(r);
    } catch (err) { return fail(c, err); }
});

/** Admin only: a 5-minute link to one off-site copy. */
backups.post('/:instanceId/copies/download', requireRole('admin'), denyDemo, rateLimit(10, 10 * 60_000, (c) => `copy-dl:${c.get('user')!.id}`), async (c) => {
    const inst = await instance(c);
    if (!inst) return c.json({ error: 'Instance not found' }, 404);
    const b = await c.req.json().catch(() => ({}));
    const user = c.get('user')!;
    try {
        const r = await copyLink(inst, String(b.key ?? ''));
        await audit({ id: user.id, username: user.username }, 'backup.download', `${b.key} (off-site) of ${inst.name}`, {}, c.get('ip'));
        return c.json(r);
    } catch (err) { return fail(c, err); }
});

backups.post('/:instanceId/copies/verify', requireRole('deployer'), denyDemo, rateLimit(10, 10 * 60_000, (c) => `copy-verify:${c.get('user')!.id}`), async (c) => {
    const inst = await instance(c);
    if (!inst) return c.json({ error: 'Instance not found' }, 404);
    const b = await c.req.json().catch(() => ({}));
    const user = c.get('user')!;
    try {
        const v = await verifyCopy(inst, String(b.key ?? ''), user.username);
        await audit({ id: user.id, username: user.username }, 'backup.verify', `${v.db}/${v.file} (off-site) on ${inst.name}`, { ok: v.ok }, c.get('ip'));
        return c.json({ verification: verificationView(v) });
    } catch (err) { return fail(c, err); }
});

// ------------------------------------------------------------------ nightly server snapshots (optional)
backups.get('/snapshots', async (c) => {
    try { return c.json(await snapshotState()); } catch (err) { return fail(c, err); }
});
backups.put('/snapshots', requireRole('admin'), denyDemo, async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const user = c.get('user')!;
    try {
        await setSnapshots(b.enabled === true);
        await audit({ id: user.id, username: user.username }, 'backup.snapshots', b.enabled === true ? 'on' : 'off', {}, c.get('ip'));
        return c.json(await snapshotState());
    } catch (err) { return fail(c, err); }
});

export default backups;
