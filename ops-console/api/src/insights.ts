import { gunzipSync } from 'zlib';
import { aws } from './aws';
import { InstanceRow } from './collector';
import { db } from './db';
import { DeployError, PROJECT_RE } from './deploys';

export const DETAIL_DOCUMENT = 'OpsConsole-AppDetail';
export const LOGS_DOCUMENT = 'OpsConsole-AppLogs';
const DETAIL_FRESH_MS = 30_000;

const decode = (out: string) => JSON.parse(gunzipSync(Buffer.from(out.trim(), 'base64')).toString('utf8'));

// ------------------------------------------------------------------ app detail (agent's /api/app/<p>)
/* eslint-disable @typescript-eslint/no-explicit-any */
const detailCache = new Map<string, { at: number; data: any }>();
const inflight = new Map<string, Promise<any>>();

export async function appDetail(inst: InstanceRow, project: string, fetch: boolean): Promise<{ data: any; fetchedAt: string }> {
    if (!PROJECT_RE.test(project)) throw new DeployError('Invalid project.');
    const key = `${inst.id}/${project}`;
    const hit = detailCache.get(key);
    if (!fetch && hit && Date.now() - hit.at < DETAIL_FRESH_MS) return { data: hit.data, fetchedAt: new Date(hit.at).toISOString() };
    const running = inflight.get(key + (fetch ? '+f' : ''));
    if (running) return running;
    const p = (async () => {
        const out = await aws().runDocument(inst.region, inst.aws_instance_id, DETAIL_DOCUMENT, { project: [project], fetch: [fetch ? 'yes' : 'no'] });
        const data = decode(out);
        const at = Date.now();
        detailCache.set(key, { at, data });
        return { data, fetchedAt: new Date(at).toISOString() };
    })().finally(() => inflight.delete(key + (fetch ? '+f' : '')));
    inflight.set(key + (fetch ? '+f' : ''), p);
    return p;
}

export function forgetDetail(instanceId: number, project?: string): void {
    for (const k of detailCache.keys()) if (k.startsWith(`${instanceId}/`) && (!project || k === `${instanceId}/${project}`)) detailCache.delete(k);
}

/**
 * Shape the agent's detail for the UI. Viewers (and the public demo) get health and metrics only:
 * no table names/row counts, no DB users or client apps, no unit paths/env, no health response body,
 * no server config or uncommitted file names.
 */
export function shapeDetail(d: any, operator: boolean) {
    const g = d.git ?? {};
    const u = d.unit ?? {};
    const h = d.health ?? {};
    const dbd = d.database ?? null;
    const commit = (c: any) => ({ sha: c.sha, subject: c.subject, author: c.author, date: c.date });
    return {
        branch: d.branch ?? 'main',
        deploySummary: d.deploy_summary ? {
            deploys7d: d.deploy_summary.deploys_7d ?? 0, successRate7d: d.deploy_summary.success_rate_7d ?? null,
            medianDurationS: d.deploy_summary.median_duration_s ?? null,
        } : null,
        unit: {
            active: u.active, sub: u.sub, result: u.result, restarts: u.restarts ?? null, memory: u.memory ?? null,
            tasks: u.tasks ?? null, cpuSeconds: u.cpu_seconds ?? null, startedAt: u.started_at || null, uptimeSeconds: u.uptime_seconds ?? null,
            enabled: u.enabled ?? null,
            ...(operator ? { user: u.user ?? null, unitFile: u.unit_file ?? null, workingDir: u.working_dir ?? null, env: u.env ?? [] } : {}),
        },
        health: { url: operator ? h.url : undefined, code: h.code ?? null, ms: h.ms ?? null, contentType: h.content_type ?? null, ...(operator ? { body: h.body ?? null } : {}) },
        git: {
            sha: g.sha ?? null, subject: g.subject ?? null, author: g.author ?? null, date: g.date ?? null,
            tracking: g.tracking ?? null, behind: g.behind ?? null, lastFetch: g.last_fetch ?? null,
            commits: (g.commits ?? []).map(commit), upstream: (g.upstream_commits ?? []).map(commit),
            dirty: operator ? (g.dirty_files ?? []) : (g.dirty_files ?? []).length,
        },
        warnings24h: d.warnings_24h ? { count: d.warnings_24h.count ?? 0, errors: d.warnings_24h.errors ?? 0 } : null,
        config: operator ? (d.config ?? null) : null,
        fetchError: d.fetch_error ?? null,
        database: !dbd ? null : !dbd.ok ? { ok: false, error: operator ? dbd.error : 'unavailable' } : {
            ok: true, name: dbd.name, size: dbd.size, stats: dbd.stats ?? {}, blocked: dbd.blocked ?? null,
            statsReset: dbd.stats_reset ?? null, migrationsApplied: dbd.migrations_applied ?? null,
            tableCount: (dbd.tables ?? []).length,
            rows: (dbd.tables ?? []).reduce((n: number, t: any) => n + (t.rows ?? 0), 0),
            deadRows: (dbd.tables ?? []).reduce((n: number, t: any) => n + (t.dead ?? 0), 0),
            activeQueries: (dbd.active_queries ?? []).map((q: any) => ({
                pid: q.pid, state: q.state, seconds: q.seconds, wait: q.wait, ...(operator ? { app: q.app, user: q.user } : {}),
            })),
            connectionsByState: (dbd.connections ?? []).reduce((m: Record<string, number>, c: any) => ({ ...m, [c.state]: (m[c.state] ?? 0) + 1 }), {}),
            ...(operator ? {
                tables: (dbd.tables ?? []).map((t: any) => ({
                    table: t.table, rows: t.rows, dead: t.dead, size: t.size, indexSize: t.index_size, seqScans: t.seq_scans,
                    idxScans: t.idx_scans, inserts: t.inserts, updates: t.updates, deletes: t.deletes,
                    lastVacuum: t.last_vacuum, lastAnalyze: t.last_analyze,
                })),
                unusedIndexes: dbd.unused_indexes ?? [],
                migrationsTable: dbd.migrations_table ?? null,
            } : {}),
        },
    };
}

// ------------------------------------------------------------------ database metric history
export interface DbPoint { at: string; size: number | null; connections: number | null; tps: number | null; cacheHitPct: number | null; deadlocks: number | null }

/** Per-database series over the last `hours`, with rates derived from consecutive counter samples. */
export async function dbSeries(instanceId: number, hours = 24, only?: string): Promise<Record<string, DbPoint[]>> {
    const { rows } = await db().query(
        `SELECT db, at, size, connections, xact_commit, xact_rollback, blks_hit, blks_read, deadlocks
           FROM db_samples WHERE instance_id = $1 AND at > now() - make_interval(hours => $2) ${only ? 'AND db = $3' : ''}
          ORDER BY db, at`, only ? [instanceId, hours, only] : [instanceId, hours]);
    const out: Record<string, DbPoint[]> = {};
    const prev: Record<string, any> = {};
    const n = (v: unknown) => (v == null ? null : Number(v));
    for (const r of rows) {
        const p = prev[r.db];
        let tps: number | null = null, hit: number | null = null, dl: number | null = null;
        if (p) {
            const secs = (new Date(r.at).getTime() - new Date(p.at).getTime()) / 1000;
            const dx = n(r.xact_commit)! + n(r.xact_rollback)! - n(p.xact_commit)! - n(p.xact_rollback)!;
            const dh = n(r.blks_hit)! - n(p.blks_hit)!, dr = n(r.blks_read)! - n(p.blks_read)!;
            if (secs > 0 && dx >= 0) tps = Math.round((dx / secs) * 100) / 100;          // negative = stats reset
            if (dh >= 0 && dr >= 0 && dh + dr > 0) hit = Math.round((dh / (dh + dr)) * 10000) / 100;
            const dd = n(r.deadlocks)! - n(p.deadlocks)!;
            if (dd >= 0) dl = dd;
        }
        (out[r.db] ??= []).push({ at: r.at, size: n(r.size), connections: n(r.connections), tps, cacheHitPct: hit, deadlocks: dl });
        prev[r.db] = r;
    }
    return out;
}

// ------------------------------------------------------------------ logs
export const LOG_LEVELS = ['all', 'warning', 'error'] as const;
export const LOG_SINCE = ['15m', '1h', '6h', '24h', '7d', 'boot'] as const;
export const LOG_QUERY_RE = /^[A-Za-z0-9 ._:/@#=-]{0,60}$/;

export async function fetchLogs(inst: InstanceRow, project: string, o: { lines: number; level: string; since: string; q: string }) {
    if (!PROJECT_RE.test(project)) throw new DeployError('Invalid project.');
    if (!(LOG_LEVELS as readonly string[]).includes(o.level)) throw new DeployError('Unknown level.');
    if (!(LOG_SINCE as readonly string[]).includes(o.since)) throw new DeployError('Unknown time range.');
    if (!LOG_QUERY_RE.test(o.q)) throw new DeployError('Search may only use letters, digits, spaces and . _ : / @ # = -');
    const lines = Math.max(10, Math.min(1000, Math.round(o.lines) || 200));
    const out = await aws().runDocument(inst.region, inst.aws_instance_id, LOGS_DOCUMENT, {
        project: [project], lines: [String(lines)], level: [o.level], since: [o.since], q: [o.q],
    });
    const d = decode(out) as { entries: { ts: number; level: string; source: string; message: string }[]; by_level: Record<string, number>; source: string; truncated: boolean };
    return { entries: d.entries, byLevel: d.by_level, source: d.source, truncated: d.truncated };
}
