import { readFileSync, statfsSync } from 'fs';
import { connect as tlsConnect } from 'tls';
import { cpus, loadavg, totalmem, freemem, uptime as osUptime } from 'os';
import { monitorEventLoopDelay } from 'perf_hooks';
import { MiddlewareHandler } from 'hono';
import { config } from './config';
import { asSystem, db } from './db';

/**
 * Health of the console itself (the server it runs on, the Node process, its database, its background jobs and its
 * email), for the platform owner. Request timings and job heartbeats are kept in memory: they start fresh after a
 * restart, which the report says.
 */
const startedAt = Date.now();
const loop = monitorEventLoopDelay({ resolution: 20 });
loop.enable();

// ------------------------------------------------------------------ background jobs: heartbeats
const beats = new Map<string, { at: number; everyMs: number; ok: boolean; error: string | null }>();
/** Called by each background job when a run finishes (ok or not). */
export function beat(name: string, everyMs: number, error?: unknown): void {
    beats.set(name, { at: Date.now(), everyMs, ok: !error, error: error ? String((error as Error).message ?? error).slice(0, 200) : null });
}
/** Wrap a job so every run records a heartbeat. */
export const tracked = (name: string, everyMs: number, fn: () => Promise<unknown>) => async () => {
    try { await fn(); beat(name, everyMs); } catch (err) { beat(name, everyMs, err); throw err; }
};

// ------------------------------------------------------------------ requests: per-minute buckets for the last hour
interface Bucket { minute: number; n: number; errors: number; ms: number[] }
const buckets: Bucket[] = [];
export const requestMetrics: MiddlewareHandler = async (c, next) => {
    const t = performance.now();
    try { await next(); } finally {
        if (c.req.path.startsWith('/api/') && c.req.path !== '/api/health') {
            const minute = Math.floor(Date.now() / 60_000);
            let b = buckets[buckets.length - 1];
            if (!b || b.minute !== minute) { b = { minute, n: 0, errors: 0, ms: [] }; buckets.push(b); while (buckets.length > 60) buckets.shift(); }
            b.n++;
            if (c.res.status >= 500) b.errors++;
            if (b.ms.length < 2000) b.ms.push(performance.now() - t);
        }
    }
};
const pct = (xs: number[], p: number) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]); };

function memAvailable(): number {
    try { const m = /MemAvailable:\s+(\d+) kB/.exec(readFileSync('/proc/meminfo', 'utf8')); if (m) return Number(m[1]) * 1024; } catch { /* not Linux */ }
    return freemem();
}
const readJson = (p: string) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };

function certDaysLeft(host: string): Promise<number | null> {
    return new Promise((resolve) => {
        const s = tlsConnect({ host, port: 443, servername: host, timeout: 5000 }, () => {
            const to = s.getPeerCertificate()?.valid_to; s.end();
            resolve(to ? Math.floor((Date.parse(to) - Date.now()) / 86400e3) : null);
        });
        s.on('error', () => resolve(null)); s.on('timeout', () => { s.destroy(); resolve(null); });
    });
}

export interface Concern { level: 'warn' | 'bad'; text: string }

export async function consoleHealth() {
    const now = Date.now();
    // server
    const disk = (() => { try { const s = statfsSync('/'); return { total: s.blocks * s.bsize, free: s.bavail * s.bsize }; } catch { return null; } })();
    const mem = { total: totalmem(), available: memAvailable() };
    const host = { cpus: cpus().length, load: loadavg().map((x) => Math.round(x * 100) / 100), mem, disk, uptimeSeconds: Math.round(osUptime()) };
    // process
    const pm = process.memoryUsage();
    const proc = { node: process.version, uptimeSeconds: Math.round((now - startedAt) / 1000), rss: pm.rss, heapUsed: pm.heapUsed,
        eventLoopP99Ms: Math.round(loop.percentile(99) / 1e6) };
    loop.reset();
    // requests (last 15 and 60 minutes)
    const since = (min: number) => buckets.filter((b) => b.minute > Math.floor(now / 60_000) - min);
    const sum = (bs: Bucket[]) => { const ms = bs.flatMap((b) => b.ms); const n = bs.reduce((a, b) => a + b.n, 0); const e = bs.reduce((a, b) => a + b.errors, 0);
        return { requests: n, errors: e, errorRate: n ? Math.round((e / n) * 1000) / 10 : 0, p50: pct(ms, 0.5), p95: pct(ms, 0.95) }; };
    const requests = { last15m: sum(since(15)), last60m: sum(since(60)), perMinute: buckets.slice(-60).map((b) => ({ minute: b.minute * 60_000, n: b.n, errors: b.errors })) };
    // database
    const dbs = await asSystem(async () => {
        const { rows: [r] } = await db().query<{ size: string; conns: number; longest: number | null }>(
            `SELECT pg_database_size(current_database())::text AS size,
                    (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database())::int AS conns,
                    (SELECT extract(epoch FROM max(now() - query_start))::int FROM pg_stat_activity WHERE datname = current_database() AND state = 'active' AND pid <> pg_backend_pid()) AS longest`);
        const { rows: [m] } = await db().query<{ fails: number; last: string | null }>(
            `SELECT count(*) FILTER (WHERE NOT ok)::int AS fails, max(error) FILTER (WHERE NOT ok) AS last FROM notifications WHERE at > now() - interval '24 hours'`);
        return { size: Number(r.size), connections: r.conns, longestQuerySeconds: r.longest, emailFailures24h: m.fails, lastEmailError: m.last };
    }).catch((err) => ({ error: (err as Error).message.slice(0, 200) }));
    // jobs
    const jobs = [...beats.entries()].map(([name, b]) => ({ name, lastRun: new Date(b.at).toISOString(), everySeconds: Math.round(b.everyMs / 1000),
        late: now - b.at > b.everyMs * 3 + 60_000, ok: b.ok, error: b.error }));
    // backups of the console's own database (written by the nightly job on this server)
    const backups = readJson('/opt/deploy-state/backups.json');
    const offsite = readJson('/opt/deploy-state/offsite.json');
    const consoleDump = backups?.items?.find((i: { name: string }) => i.name === 'opsconsole') ?? null;
    let certDays: number | null = null;
    try { const h = new URL(config.publicUrl).hostname; if (!/^(localhost|127\.)/.test(h)) certDays = await certDaysLeft(h); } catch { /* no public URL */ }

    // things to look at
    const c: Concern[] = [];
    if (disk) { const used = 1 - disk.free / disk.total; if (used > 0.9) c.push({ level: 'bad', text: `Disk ${Math.round(used * 100)}% full.` }); else if (used > 0.8) c.push({ level: 'warn', text: `Disk ${Math.round(used * 100)}% full.` }); }
    const memUsed = 1 - mem.available / mem.total;
    if (memUsed > 0.92) c.push({ level: 'bad', text: `Memory ${Math.round(memUsed * 100)}% used.` }); else if (memUsed > 0.85) c.push({ level: 'warn', text: `Memory ${Math.round(memUsed * 100)}% used.` });
    if (host.load[1] > host.cpus * 1.5) c.push({ level: 'warn', text: `CPU load ${host.load[1]} over 5 minutes on ${host.cpus} CPU${host.cpus === 1 ? '' : 's'}.` });
    if (requests.last15m.requests >= 20 && requests.last15m.errorRate > 2) c.push({ level: 'bad', text: `${requests.last15m.errorRate}% of requests failed in the last 15 minutes.` });
    if ((requests.last15m.p95 ?? 0) > 2000) c.push({ level: 'warn', text: `Slow responses: 95% within ${requests.last15m.p95} ms (last 15 minutes).` });
    if (proc.eventLoopP99Ms > 200) c.push({ level: 'warn', text: `The console was briefly unresponsive (event loop delay ${proc.eventLoopP99Ms} ms).` });
    for (const j of jobs) if (j.late) c.push({ level: 'bad', text: `Background job "${j.name}" hasn't run since ${new Date(j.lastRun).toLocaleString()}.` });
    else if (!j.ok) c.push({ level: 'warn', text: `Background job "${j.name}" failed its last run: ${j.error}` });
    if ('emailFailures24h' in dbs && dbs.emailFailures24h > 0) c.push({ level: 'warn', text: `${dbs.emailFailures24h} notification${dbs.emailFailures24h === 1 ? '' : 's'} failed to send in 24 hours.` });
    if ('longestQuerySeconds' in dbs && (dbs.longestQuerySeconds ?? 0) > 60) c.push({ level: 'warn', text: `A database query has been running for ${dbs.longestQuerySeconds}s.` });
    if (backups && Date.now() - Date.parse(backups.at) > 26 * 3600e3) c.push({ level: 'bad', text: `The last database backup on this server was ${new Date(backups.at).toLocaleString()}.` });
    if (backups && !consoleDump?.ok) c.push({ level: 'bad', text: "The console's own database wasn't in the last backup." });
    if (offsite?.configured && !offsite.ok) c.push({ level: 'warn', text: `Off-site backup copies are failing: ${offsite.error ?? 'see Backups'}.` });
    if (certDays != null && certDays < 14) c.push({ level: certDays < 5 ? 'bad' : 'warn', text: `The HTTPS certificate expires in ${certDays} days.` });
    if (Number(process.versions.node.split('.')[0]) < 20) c.push({ level: 'warn', text: `Node.js ${process.version} is past its end of life; plan an upgrade.` });

    return { checkedAt: new Date(now).toISOString(), host, process: proc, requests, database: dbs, jobs,
        backups: backups ? { at: backups.at, ok: backups.ok, consoleDb: consoleDump, offsite: offsite ? { configured: offsite.configured, ok: offsite.ok, at: offsite.at, error: offsite.error } : null } : null,
        certificateDaysLeft: certDays, concerns: c };
}
