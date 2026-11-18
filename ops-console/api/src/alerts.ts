import { InstanceRow } from './collector';
import { deployKey, dismissedDeploys } from './failures';
import { db } from './db';
import { notifier, sendEmail } from './notify';
import { alertSettings, AlertSettings } from './settings';

export type Severity = 'critical' | 'warning' | 'info';
const RANK: Record<Severity, number> = { info: 1, warning: 2, critical: 3 };
const PUBLIC_URL = process.env.PUBLIC_URL || 'https://ops.glenify.studio';

export interface AlertRow {
    id: number; key: string; rule: string; severity: Severity; instance_id: number | null; project: string | null;
    title: string; detail: string; opened_at: string; last_seen_at: string; resolved_at: string | null;
    acked_by: string | null; acked_at: string | null; last_notified_at: string | null; notify_count: number;
}

export interface Condition {
    key: string; rule: string; severity: Severity; instanceId: number | null; project?: string | null; title: string; detail: string;
}

export function alertView(a: AlertRow & { instance_name?: string | null }) {
    return {
        id: a.id, rule: a.rule, severity: a.severity, instanceId: a.instance_id, instance: a.instance_name ?? null, project: a.project,
        title: a.title, detail: a.detail, openedAt: a.opened_at, lastSeenAt: a.last_seen_at, resolvedAt: a.resolved_at,
        ackedBy: a.acked_by, ackedAt: a.acked_at, notifyCount: a.notify_count, lastNotifiedAt: a.last_notified_at,
    };
}

/** Open (or refresh) the alert for a condition that is currently true. */
export async function raise(c: Condition): Promise<void> {
    const { rows } = await db().query<AlertRow>(
        `UPDATE alerts SET last_seen_at = now(), detail = $2, title = $3,
                severity = CASE WHEN $4 = 'critical' OR severity = 'critical' THEN 'critical' ELSE $4 END
          WHERE key = $1 AND resolved_at IS NULL RETURNING *`, [c.key, c.detail, c.title, c.severity]);
    if (rows.length) return;
    await db().query(
        `INSERT INTO alerts (key, rule, severity, instance_id, project, title, detail) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (workspace_id, key) WHERE resolved_at IS NULL DO NOTHING`,
        [c.key, c.rule, c.severity, c.instanceId, c.project ?? null, c.title, c.detail]);
}

/** Close the alert for a condition that is no longer true. */
export async function resolve(key: string): Promise<void> {
    await db().query('UPDATE alerts SET resolved_at = now() WHERE key = $1 AND resolved_at IS NULL', [key]);
}

/** Resolve every open alert of `rule` (optionally on one instance) whose key isn't in `stillTrue`. */
async function resolveOthers(rule: string, stillTrue: Set<string>, instanceId?: number): Promise<void> {
    const { rows } = await db().query<{ key: string }>(
        `SELECT key FROM alerts WHERE rule = $1 AND resolved_at IS NULL ${instanceId ? 'AND instance_id = $2' : ''}`,
        instanceId ? [rule, instanceId] : [rule]);
    for (const r of rows) if (!stillTrue.has(r.key)) await resolve(r.key);
}

// ------------------------------------------------------------------ rules over an instance snapshot
const unreachableSince = new Map<number, number>();
const dbStuckStreak = new Map<number, number>();

export async function evaluateInstance(inst: InstanceRow, s?: AlertSettings): Promise<void> {
    const cfg = s ?? await alertSettings();
    const t = cfg.thresholds;
    const id = inst.id;
    const snap = inst.last_status;

    // instance unreachable through SSM for 10+ minutes (the box itself failing is covered by CloudWatch)
    const key = `instance_unreachable:${id}`;
    const powered = inst.ec2_state && inst.ec2_state !== 'running';   // stopped on purpose (or by the schedule): not an outage
    // never reached yet (a server just added, waiting to connect or to be prepared): not an outage either; its page explains what to do
    if (inst.last_error && (powered || !inst.last_ok_at)) {
        unreachableSince.delete(id);
        await resolve(key);
        return;
    }
    if (inst.last_error) {
        const since = unreachableSince.get(id) ?? Date.now();
        unreachableSince.set(id, since);
        if (Date.now() - since >= 10 * 60_000) {
            await raise({ key, rule: 'instance_unreachable', severity: 'critical', instanceId: id, title: `${inst.name} is unreachable`,
                detail: `The console can't read status through SSM: ${inst.last_error}. Last good snapshot ${inst.last_ok_at ?? 'never'}.` });
        }
    } else {
        unreachableSince.delete(id);
        await resolve(key);
    }
    if (!snap || inst.last_error) return;

    const h = snap.host;
    const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);

    const disk = pct(h.disk.used, h.disk.total);
    if (disk >= t.diskPct) {
        await raise({ key: `disk_high:${id}`, rule: 'disk_high', severity: disk >= 95 ? 'critical' : 'warning', instanceId: id,
            title: `Disk ${disk}% full on ${inst.name}`, detail: `${Math.round(h.disk.free / 1e9 * 10) / 10} GB free. Threshold ${t.diskPct}%.` });
    } else await resolve(`disk_high:${id}`);

    const mem = pct(h.memory.used, h.memory.total);
    if (mem >= t.memoryPct) {
        await raise({ key: `memory_high:${id}`, rule: 'memory_high', severity: 'warning', instanceId: id,
            title: `Memory ${mem}% used on ${inst.name}`, detail: `Swap in use: ${Math.round(h.swap.used / 1e6)} MB. Threshold ${t.memoryPct}%.` });
    } else await resolve(`memory_high:${id}`);

    const certKeys = new Set<string>();
    for (const c of snap.certificates) {
        if (c.daysLeft == null || c.daysLeft >= t.certDays) continue;
        const k = `cert_expiring:${id}:${c.domain}`;
        certKeys.add(k);
        await raise({ key: k, rule: 'cert_expiring', severity: c.daysLeft < 5 ? 'critical' : 'warning', instanceId: id,
            title: `TLS certificate for ${c.domain} expires in ${c.daysLeft} days`, detail: 'certbot renews automatically from 30 days out; this means renewal is failing.' });
    }
    await resolveOthers('cert_expiring', certKeys, id);

    if (snap.backups) {
        const ageH = (Date.now() - new Date(snap.backups.at).getTime()) / 3_600_000;
        if (!snap.backups.ok) {
            await raise({ key: `backup:${id}`, rule: 'backup', severity: 'critical', instanceId: id, title: `Last database backup failed on ${inst.name}`,
                detail: `Backup run at ${snap.backups.at} did not succeed. Check db-backup.service logs.` });
        } else if (ageH > t.backupHours) {
            await raise({ key: `backup:${id}`, rule: 'backup', severity: 'warning', instanceId: id, title: `No database backup for ${Math.round(ageH)}h on ${inst.name}`,
                detail: `Last good backup ${snap.backups.at}. Threshold ${t.backupHours}h.` });
        } else await resolve(`backup:${id}`);
    }

    // a deploy that failed (or was rolled back automatically) and hasn't been followed by a success
    const failKeys = new Set<string>();
    const events = snap.deployEvents;
    const dismissed = await dismissedDeploys(id);   // dismissed on the Activity page: never raised again
    for (const e of events) {
        if (e.action !== 'deploy' || !['failed', 'rolled_back'].includes(e.status)) continue;
        if (dismissed.has(deployKey(e.project, e.at))) continue;
        if (Date.now() - new Date(e.at).getTime() > 24 * 3_600_000) continue;
        const later = events.some((x) => x.project === e.project && x.status === 'success' && x.at > e.at);
        if (later) continue;
        const k = `deploy_failed:${id}:${e.project}`;
        failKeys.add(k);
        await raise({ key: k, rule: 'deploy_failed', severity: 'warning', instanceId: id, project: e.project,
            title: `Deploy of ${e.project} ${e.status === 'rolled_back' ? 'failed and was rolled back' : 'failed'}`,
            detail: `${e.toSha || 'ref'} by ${e.actor} at ${e.at}. The previous version is ${e.status === 'rolled_back' ? 'running again' : 'still in place'}.` });
    }
    await resolveOthers('deploy_failed', failKeys, id);

    // database sessions stuck for two collections in a row (long-running statements or open transactions)
    const v = snap.dbServer;
    const stuck = !!v && ((v.longRunningQueries ?? 0) > 0 || (v.idleInTransaction ?? 0) > 0 || (v.waitingLocks ?? 0) > 0);
    const streak = stuck ? (dbStuckStreak.get(id) ?? 0) + 1 : 0;
    dbStuckStreak.set(id, streak);
    if (streak >= 2 && v) {
        await raise({ key: `db_sessions:${id}`, rule: 'db_sessions', severity: 'warning', instanceId: id, title: `Database sessions stuck on ${inst.name}`,
            detail: `${v.longRunningQueries ?? 0} statements running >60s, ${v.idleInTransaction ?? 0} idle in transaction, ${v.waitingLocks ?? 0} waiting locks.` });
    } else if (!stuck) await resolve(`db_sessions:${id}`);

    // apps without a public domain can't be probed: fall back to the instance's own health check
    const localKeys = new Set<string>();
    for (const a of snap.apps) {
        if (a.domain || a.healthy) continue;
        const k = `app_down:${id}:${a.project}`;
        localKeys.add(k);
        await raise({ key: k, rule: 'app_down', severity: 'critical', instanceId: id, project: a.project, title: `${a.project} is down on ${inst.name}`,
            detail: `Local health check: ${a.healthCode ?? 'no response'}; unit ${a.active}.` });
    }
    for (const a of snap.apps) if (!a.domain && a.healthy) await resolve(`app_down:${id}:${a.project}`);
}

// ------------------------------------------------------------------ notifications
function message(a: AlertRow & { instance_name?: string | null }, kind: 'opened' | 'reminder' | 'resolved') {
    const tag = kind === 'resolved' ? 'RESOLVED' : a.severity.toUpperCase();
    const subject = `[${tag}] ${a.title}`;
    const mins = Math.round(((a.resolved_at ? new Date(a.resolved_at).getTime() : Date.now()) - new Date(a.opened_at).getTime()) / 60_000);
    const lines = [
        kind === 'resolved' ? `Resolved after ${mins} min: ${a.title}` : kind === 'reminder' ? `Still open (${mins} min): ${a.title}` : a.title,
        '', a.detail, '',
        `Opened: ${a.opened_at}`,
        a.instance_name ? `Instance: ${a.instance_name}` : '',
        a.project ? `App: ${a.project}` : '',
        '', `${PUBLIC_URL}/alerts`,
    ].filter((l, i, arr) => l !== '' || arr[i - 1] !== '');
    return { subject, text: lines.join('\n') };
}

async function send(alertId: number | null, kind: string, subject: string, text: string, cfg: AlertSettings): Promise<{ channel: string; ok: boolean; error?: string }[]> {
    const results: { channel: string; ok: boolean; error?: string }[] = [];
    if (cfg.recipients.length) {
        const r = await sendEmail(kind === 'test' ? 'test' : 'alert', cfg.recipients, subject, text);
        results.push(r.ok ? { channel: 'email', ok: true } : { channel: 'email', ok: false, error: r.error ?? 'failed' });
    }
    if (cfg.webhookUrl) {
        try { await notifier().webhook(cfg.webhookUrl, `*${subject}*\n${text}`); results.push({ channel: 'webhook', ok: true }); }
        catch (err) { results.push({ channel: 'webhook', ok: false, error: (err as Error).message.slice(0, 300) }); }
    }
    for (const r of results) {
        await db().query('INSERT INTO notifications (alert_id, kind, channel, ok, error) VALUES ($1, $2, $3, $4, $5)',
            [alertId, kind, r.channel, r.ok, r.error ?? null]);
    }
    return results;
}

/** Send what's due: new alerts, reminders for open unacknowledged ones, and resolutions of notified ones. */
export async function dispatch(): Promise<void> {
    const cfg = await alertSettings();
    if (!cfg.recipients.length && !cfg.webhookUrl) return;
    const { rows } = await db().query<AlertRow & { instance_name: string | null }>(
        `SELECT a.*, i.name AS instance_name FROM alerts a LEFT JOIN instances i ON i.id = a.instance_id
          WHERE (a.resolved_at IS NULL) OR (a.resolved_at > now() - interval '1 day' AND a.notify_count > 0 AND a.last_notified_at < a.resolved_at)
          ORDER BY a.opened_at`);
    for (const a of rows) {
        if (RANK[a.severity] < RANK[cfg.minSeverity]) continue;
        let kind: 'opened' | 'reminder' | 'resolved' | null = null;
        if (a.resolved_at) kind = 'resolved';
        else if (a.notify_count === 0) kind = 'opened';
        else if (!a.acked_at && cfg.repeatHours > 0 && a.last_notified_at &&
                 Date.now() - new Date(a.last_notified_at).getTime() >= cfg.repeatHours * 3_600_000) kind = 'reminder';
        if (!kind) continue;
        const { subject, text } = message(a, kind);
        const results = await send(a.id, kind, subject, text, cfg);
        if (results.some((r) => r.ok) || kind === 'resolved') {
            await db().query('UPDATE alerts SET last_notified_at = now(), notify_count = notify_count + 1 WHERE id = $1', [a.id]);
        }
    }
}

/** Send a one-off message (approval requests, overrides) to every configured channel, whatever the severity setting. */
export async function announce(subject: string, text: string, kind: string): Promise<void> {
    const cfg = await alertSettings();
    await send(null, kind, subject, text, cfg).catch((err) => console.error('announce failed:', (err as Error).message));
}

export async function sendTest(by: string): Promise<{ channel: string; ok: boolean; error?: string }[]> {
    const cfg = await alertSettings();
    return send(null, 'test', '[TEST] Ops Console alerts are working',
        `This is a test notification sent by ${by} from the Ops Console.\n\nAlerts for app downtime, failed deploys, disk, memory, certificates, backups and stuck database sessions will arrive like this.\n\n${PUBLIC_URL}/alerts`, cfg);
}
