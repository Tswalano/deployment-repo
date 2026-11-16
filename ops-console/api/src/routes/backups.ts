import { Context, Hono } from 'hono';
import { audit } from '../audit';
import { exportBackup, listBackups, runBackup, verificationView, VerificationRow, verifyBackup } from '../backups';
import { InstanceRow } from '../collector';
import { config } from '../config';
import { db } from '../db';
import { DeployError } from '../deploys';
import { denyDemo, Env, rateLimit, requireRole } from '../middleware';

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
    const out = [];
    for (const inst of insts) {
        const { rows: v } = await db().query<VerificationRow>(
            'SELECT * FROM backup_verifications WHERE instance_id = $1 ORDER BY at DESC LIMIT 100', [inst.id]);
        try {
            const d = await listBackups(inst, c.req.query('refresh') === '1' && c.get('user')!.role !== 'viewer');
            out.push({
                instanceId: inst.id, instance: inst.name, ok: true, location: d.location, diskFree: d.disk_free, timer: d.timer,
                lastRun: d.status ? { at: d.status.at, ok: d.status.ok, keepDays: d.status.keep_days, totalBytes: d.status.total_bytes, items: d.status.items } : null,
                files: d.files.map((f: { db: string; file: string; bytes: number; mtime: number }) => ({ db: f.db, file: f.file, bytes: f.bytes, at: new Date(f.mtime * 1000).toISOString() })),
                verifications: v.map(verificationView),
            });
        } catch (err) {
            out.push({ instanceId: inst.id, instance: inst.name, ok: false, error: (err as Error).message.slice(0, 200), verifications: v.map(verificationView) });
        }
    }
    return c.json({ instances: out, downloads: !!config.transferBucket });
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

export default backups;
