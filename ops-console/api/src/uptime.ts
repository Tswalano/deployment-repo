import { dispatch, raise, resolve } from './alerts';
import { InstanceRow } from './collector';
import { db, forEachWorkspace } from './db';
import { alertSettings } from './settings';

const PROBE_EVERY_MS = 60_000;
const STARTUP_GRACE_MS = 3 * 60_000;     // apps start in parallel at 04:00; don't call them down yet
const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
const startedAt = Date.now();

export interface ProbeResult { ok: boolean; status: number | null; ms: number; error: string | null }
export type Probe = (url: string) => Promise<ProbeResult>;

/** GET the public health URL (TLS + nginx + app), no redirects, 10s timeout. 2xx = up. */
export const realProbe: Probe = async (url) => {
    const t0 = Date.now();
    try {
        const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000), headers: { 'user-agent': 'ops-console-uptime/1' } });
        await res.arrayBuffer().catch(() => undefined);
        return { ok: res.status >= 200 && res.status < 300, status: res.status, ms: Date.now() - t0, error: null };
    } catch (err) {
        const e = err as Error & { cause?: { code?: string } };
        return { ok: false, status: null, ms: Date.now() - t0, error: (e.cause?.code || e.name || 'error').slice(0, 60) };
    }
};
let probe: Probe = realProbe;
export function setProbe(p: Probe): void {
    probe = p;
}

/** Public health URL for an app: https://<domain><path of its local HEALTH_URL>. */
export function publicUrl(domain: string | null, healthPath: string | null): string | null {
    if (!domain || !HOST_RE.test(domain)) return null;
    const path = healthPath && /^\/[A-Za-z0-9._~/-]{0,100}$/.test(healthPath) ? healthPath : '/';
    return `https://${domain}${path}`;
}

/** Probe every app on every instance once, record results and open/close "app down" and "slow" alerts. */
export async function probeAll(now = Date.now()): Promise<void> {
    const cfg = await alertSettings();
    const { rows } = await db().query<InstanceRow>('SELECT * FROM instances');
    for (const inst of rows) {
        for (const a of inst.last_status?.apps ?? []) {
            const url = publicUrl(a.domain, a.healthPath ?? null);
            if (!url) continue;
            const r = await probe(url);
            await db().query('INSERT INTO uptime_checks (instance_id, project, ok, status, ms, error) VALUES ($1, $2, $3, $4, $5, $6)',
                [inst.id, a.project, r.ok, r.status, r.ms, r.error]);

            const key = `app_down:${inst.id}:${a.project}`;
            if (r.ok) {
                await resolve(key);
            } else if (now - startedAt >= STARTUP_GRACE_MS || process.env.NODE_ENV === 'test') {
                const { rows: last } = await db().query<{ ok: boolean }>(
                    'SELECT ok FROM uptime_checks WHERE instance_id = $1 AND project = $2 ORDER BY at DESC, id DESC LIMIT $3',
                    [inst.id, a.project, cfg.thresholds.downChecks]);
                if (last.length >= cfg.thresholds.downChecks && last.every((x) => !x.ok)) {
                    await raise({ key, rule: 'app_down', severity: 'critical', instanceId: inst.id, project: a.project,
                        title: `${a.project} is down`,
                        detail: `${url} failed ${last.length} checks in a row (last: ${r.status ? `HTTP ${r.status}` : r.error}).` });
                }
            }

            // slow: p95 of the last 15 minutes above the threshold (needs at least 10 samples)
            const { rows: [lat] } = await db().query(
                `SELECT count(*)::int AS n, percentile_cont(0.95) WITHIN GROUP (ORDER BY ms) AS p95
                   FROM uptime_checks WHERE instance_id = $1 AND project = $2 AND ok AND at > now() - interval '15 minutes'`,
                [inst.id, a.project]);
            const slowKey = `app_slow:${inst.id}:${a.project}`;
            if (lat.n >= 10 && lat.p95 > cfg.thresholds.latencyMs) {
                await raise({ key: slowKey, rule: 'app_slow', severity: 'warning', instanceId: inst.id, project: a.project,
                    title: `${a.project} is slow`, detail: `p95 response time ${Math.round(lat.p95)} ms over the last 15 minutes (threshold ${cfg.thresholds.latencyMs} ms).` });
            } else if (lat.n >= 10) await resolve(slowKey);
        }
    }
    await dispatch().catch((err) => console.error('alert dispatch failed:', (err as Error).message));
}

/** Roll raw checks into daily rows (today and yesterday, UTC) and expire old data. */
export async function rollup(): Promise<void> {
    await db().query(
        `INSERT INTO uptime_daily (instance_id, project, day, checks, ok, p50_ms, p95_ms)
         SELECT instance_id, project, (at AT TIME ZONE 'UTC')::date, count(*), count(*) FILTER (WHERE ok),
                percentile_cont(0.5) WITHIN GROUP (ORDER BY ms) FILTER (WHERE ok),
                percentile_cont(0.95) WITHIN GROUP (ORDER BY ms) FILTER (WHERE ok)
           FROM uptime_checks WHERE at >= (now() AT TIME ZONE 'UTC')::date - 1
          GROUP BY 1, 2, 3
         ON CONFLICT (instance_id, project, day) DO UPDATE
            SET checks = EXCLUDED.checks, ok = EXCLUDED.ok, p50_ms = EXCLUDED.p50_ms, p95_ms = EXCLUDED.p95_ms`);
    await db().query("DELETE FROM uptime_checks WHERE at < now() - interval '30 days'");
    await db().query("DELETE FROM uptime_daily WHERE day < current_date - 400");
    await db().query("DELETE FROM alerts WHERE resolved_at < now() - interval '180 days'");
    await db().query("DELETE FROM notifications WHERE at < now() - interval '180 days'");
}

export function startUptime(): NodeJS.Timeout {
    let n = 0;
    const tick = async () => {
        const doRollup = n++ % 10 === 0;
        await forEachWorkspace(async () => { await probeAll(); if (doRollup) await rollup(); });
    };
    const t = setInterval(() => void tick().catch((err) => console.error('uptime tick failed:', (err as Error).message)), PROBE_EVERY_MS);
    t.unref();
    setTimeout(() => void tick().catch(() => undefined), 20_000).unref();
    return t;
}

// ------------------------------------------------------------------ reading
export interface UptimeSummary {
    instanceId: number; instance: string; project: string; domain: string | null; url: string | null;
    last: { at: string; ok: boolean; status: number | null; ms: number | null } | null;
    uptime: { h24: number | null; d7: number | null; d30: number | null; d90: number | null };
    p95ms24h: number | null;
    days: { day: string; checks: number; ok: number; pct: number | null }[];
}

const pctOf = (ok: number, n: number) => (n ? Math.round((ok / n) * 100000) / 1000 : null);

export async function uptimeSummaries(days = 90): Promise<UptimeSummary[]> {
    const { rows: insts } = await db().query<InstanceRow>('SELECT * FROM instances ORDER BY lower(name)');
    const { rows: daily } = await db().query(
        `SELECT instance_id, project, day::text AS day, checks, ok FROM uptime_daily WHERE day > current_date - $1::int ORDER BY day`, [days]);
    const { rows: recent } = await db().query(
        `SELECT instance_id, project, count(*)::int AS n, count(*) FILTER (WHERE ok)::int AS ok,
                percentile_cont(0.95) WITHIN GROUP (ORDER BY ms) FILTER (WHERE ok) AS p95
           FROM uptime_checks WHERE at > now() - interval '24 hours' GROUP BY 1, 2`);
    const { rows: last } = await db().query(
        `SELECT DISTINCT ON (instance_id, project) instance_id, project, at, ok, status, ms
           FROM uptime_checks ORDER BY instance_id, project, at DESC`);
    const out: UptimeSummary[] = [];
    for (const inst of insts) {
        for (const a of inst.last_status?.apps ?? []) {
            const mine = daily.filter((d) => d.instance_id === inst.id && d.project === a.project);
            const window = (n: number) => {
                const since = new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
                const ds = mine.filter((d) => d.day > since);
                return pctOf(ds.reduce((s, d) => s + d.ok, 0), ds.reduce((s, d) => s + d.checks, 0));
            };
            const r = recent.find((x) => x.instance_id === inst.id && x.project === a.project);
            const l = last.find((x) => x.instance_id === inst.id && x.project === a.project);
            out.push({
                instanceId: inst.id, instance: inst.name, project: a.project, domain: a.domain, url: publicUrl(a.domain, a.healthPath ?? null),
                last: l ? { at: l.at, ok: l.ok, status: l.status, ms: l.ms } : null,
                uptime: { h24: r ? pctOf(r.ok, r.n) : null, d7: window(7), d30: window(30), d90: window(90) },
                p95ms24h: r?.p95 != null ? Math.round(r.p95) : null,
                days: mine.map((d) => ({ day: d.day, checks: d.checks, ok: d.ok, pct: pctOf(d.ok, d.checks) })),
            });
        }
    }
    return out;
}

/** 24h of 10-minute buckets for one app (availability and latency). */
export async function uptimeSeries(instanceId: number, project: string) {
    const { rows } = await db().query(
        `SELECT to_timestamp(floor(extract(epoch FROM at) / 600) * 600) AS at, count(*)::int AS n, count(*) FILTER (WHERE ok)::int AS ok,
                round(avg(ms) FILTER (WHERE ok))::int AS avg_ms, max(ms) FILTER (WHERE ok) AS max_ms
           FROM uptime_checks WHERE instance_id = $1 AND project = $2 AND at > now() - interval '24 hours'
          GROUP BY 1 ORDER BY 1`, [instanceId, project]);
    return rows.map((r) => ({ at: r.at, checks: r.n, ok: r.ok, avgMs: r.avg_ms, maxMs: r.max_ms }));
}
