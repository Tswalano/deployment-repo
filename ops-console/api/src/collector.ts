import { gunzipSync } from 'zlib';
import { aws } from './aws';
import { db } from './db';
import { syncRunning } from './deploys';

export const COLLECT_DOCUMENT = 'OpsConsole-CollectStatus';
const FRESH_MS = 30_000;            // serve cached snapshots younger than this
const SAMPLE_EVERY_MS = 4.5 * 60_000;
const POLL_EVERY_MS = 5 * 60_000;

export interface InstanceRow {
    id: number;
    name: string;
    aws_instance_id: string;
    region: string;
    environment: string;
    created_at: string;
    last_status: Snapshot | null;
    last_fetched_at: string | null;
    last_ok_at: string | null;
    last_error: string | null;
}

/** Normalised snapshot, the same shape whatever the instance reported ("agent" or "basic"). */
export interface Snapshot {
    source: 'agent' | 'basic';
    collectedAt: string;
    host: {
        hostname: string;
        uptimeSeconds: number;
        cpus: number;
        load: number[];
        memory: { total: number; used: number; available: number };
        swap: { total: number; used: number };
        disk: { total: number; used: number; free: number };
        instanceType?: string;
        az?: string;
    };
    apps: Array<{
        project: string; domain: string | null; service: string; active: string; healthy: boolean;
        healthCode: number | null; healthMs: number | null; memory: number | null; restarts: number | null;
        uptimeSeconds: number | null; sha: string | null; subject: string | null; db: string | null;
        warnings24h: number; errors24h: number;
        lastDeploy: { at: string; status: string; durationS: number; actor: string } | null;
    }>;
    services: Array<{ unit: string; active: string; memory: number | null }>;
    databases: Array<{ name: string; size: number; tables: number | null; connections: number }>;
    certificates: Array<{ domain: string; daysLeft: number | null }>;
    backups: { at: string; ok: boolean } | null;
    deploying: { project: string; step: string; actor: string; state: string } | null;
    deployEvents: Array<{ project: string; action: string; status: string; at: string; durationS: number; actor: string; fromSha: string; toSha: string }>;
    runningServices?: number;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function normalise(raw: { source: string; data: any }): Snapshot {
    const d = raw.data ?? {};
    const h = d.host ?? {};
    const snap: Snapshot = {
        source: raw.source === 'agent' ? 'agent' : 'basic',
        collectedAt: new Date().toISOString(),
        host: {
            hostname: h.hostname ?? '?', uptimeSeconds: h.uptime_seconds ?? 0, cpus: h.cpus ?? 1, load: h.load ?? [],
            memory: { total: h.memory?.total ?? 0, used: h.memory?.used ?? 0, available: h.memory?.available ?? 0 },
            swap: { total: h.swap?.total ?? 0, used: h.swap?.used ?? 0 },
            disk: { total: h.disk?.total ?? 0, used: h.disk?.used ?? 0, free: h.disk?.free ?? 0 },
            instanceType: d.instance?.instance_type, az: d.instance?.az,
        },
        apps: (d.projects ?? []).map((p: any) => {
            const code = p.health?.code ?? null;
            const ls = p.deploy_summary?.last_success;
            return {
                project: p.project, domain: p.domain ?? null, service: p.service, active: p.unit?.active ?? 'unknown',
                healthy: p.unit?.active === 'active' && code >= 200 && code < 300,
                healthCode: code, healthMs: p.health?.ms ?? null, memory: p.unit?.memory ?? null,
                restarts: p.unit?.restarts ?? null, uptimeSeconds: p.unit?.uptime_seconds ?? null,
                sha: p.git?.sha ?? null, subject: p.git?.subject ?? null, db: p.db ?? null,
                warnings24h: p.warnings_24h?.count ?? 0, errors24h: p.warnings_24h?.errors ?? 0,
                lastDeploy: ls ? { at: ls.finished_at, status: ls.status, durationS: ls.duration_s, actor: ls.actor } : null,
            };
        }),
        services: (d.services ?? []).map((s: any) => ({ unit: s.unit, active: s.active, memory: s.memory ?? null })),
        databases: (d.database?.databases ?? []).filter((x: any) => x.name !== 'postgres')
            .map((x: any) => ({ name: x.name, size: x.size, tables: x.tables ?? null, connections: x.connections ?? 0 })),
        certificates: (d.certificates ?? []).map((c: any) => ({ domain: c.domain, daysLeft: c.days_left ?? null })),
        backups: d.backups ? { at: d.backups.at, ok: !!d.backups.ok } : null,
        deploying: d.deploying ? { project: d.deploying.project, step: d.deploying.step, actor: d.deploying.actor, state: d.deploying.state } : null,
        deployEvents: (d.deploy_events ?? []).map((e: any) => ({
            project: e.project, action: e.action, status: e.status, at: e.finished_at, durationS: e.duration_s,
            actor: e.actor, fromSha: (e.from_sha || '').slice(0, 8), toSha: (e.to_sha || '').slice(0, 8),
        })),
    };
    if (raw.source !== 'agent') snap.runningServices = d.running_services;
    return snap;
}

export function decodeOutput(stdout: string): { source: string; data: unknown } {
    return JSON.parse(gunzipSync(Buffer.from(stdout.trim(), 'base64')).toString('utf8'));
}

const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);

const inflight = new Map<number, Promise<InstanceRow>>();

/** Return the instance with a snapshot no older than FRESH_MS (or `force`), fetching via SSM if needed. */
export async function freshInstance(row: InstanceRow, force = false): Promise<InstanceRow> {
    const age = row.last_fetched_at ? Date.now() - new Date(row.last_fetched_at).getTime() : Infinity;
    if (!force && age < FRESH_MS) return row;
    const running = inflight.get(row.id);
    if (running) return running;
    const p = collect(row).finally(() => inflight.delete(row.id));
    inflight.set(row.id, p);
    return p;
}

async function collect(row: InstanceRow): Promise<InstanceRow> {
    try {
        const out = await aws().runDocument(row.region, row.aws_instance_id, COLLECT_DOCUMENT);
        const snap = normalise(decodeOutput(out) as { source: string; data: unknown });
        const { rows } = await db().query(
            `UPDATE instances SET last_status = $2, last_fetched_at = now(), last_ok_at = now(), last_error = NULL
             WHERE id = $1 RETURNING *`, [row.id, JSON.stringify(snap)]);
        await maybeSample(row.id, snap);
        return rows[0] ?? row;
    } catch (err) {
        const msg = (err as Error).message.slice(0, 300);
        const { rows } = await db().query(
            'UPDATE instances SET last_fetched_at = now(), last_error = $2 WHERE id = $1 RETURNING *', [row.id, msg]);
        return rows[0] ?? row;
    }
}

async function maybeSample(instanceId: number, s: Snapshot): Promise<void> {
    const { rows } = await db().query('SELECT max(at) AS last FROM instance_samples WHERE instance_id = $1', [instanceId]);
    if (rows[0].last && Date.now() - new Date(rows[0].last).getTime() < SAMPLE_EVERY_MS) return;
    await db().query(
        `INSERT INTO instance_samples (instance_id, mem_pct, swap_pct, disk_pct, load1, apps_healthy, apps_total)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [instanceId, pct(s.host.memory.used, s.host.memory.total), pct(s.host.swap.used, s.host.swap.total),
            pct(s.host.disk.used, s.host.disk.total), s.host.load[0] ?? null,
            s.apps.filter((a) => a.healthy).length, s.apps.length]);
}

export function startPoller(): NodeJS.Timeout {
    const tick = async () => {
        const { rows } = await db().query<InstanceRow>('SELECT * FROM instances');
        await syncRunning().catch(() => undefined);
        for (const row of rows) await freshInstance(row, true).catch(() => undefined);
        await db().query("DELETE FROM instance_samples WHERE at < now() - interval '7 days'").catch(() => undefined);
    };
    setTimeout(() => void tick().catch(() => undefined), 10_000).unref();
    const t = setInterval(() => void tick().catch(() => undefined), POLL_EVERY_MS);
    t.unref();
    return t;
}
