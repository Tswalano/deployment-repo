import { db } from './db';

export type Env = 'production' | 'staging' | 'development';
export const ENVIRONMENTS: Env[] = ['production', 'staging', 'development'];

export interface FreezeWindow {
    id: string;
    name: string;
    environments: Env[];
    kind: 'weekly' | 'once';
    /** weekly: start/end day 0=Sunday … 6=Saturday plus HH:MM, in `timezone`; the window may wrap past Saturday */
    startDay?: number; startTime?: string; endDay?: number; endTime?: string;
    /** once: ISO timestamps */
    startAt?: string; endAt?: string;
}

export interface DeployPolicy {
    timezone: string;
    approvals: Record<Env, boolean>;
    rollbackNeedsApproval: boolean;
    rollbackAllowedInFreeze: boolean;
    requestTtlMinutes: number;
    freezes: FreezeWindow[];
}

export const DEFAULT_POLICY: DeployPolicy = {
    timezone: 'Africa/Johannesburg',
    approvals: { production: false, staging: false, development: false },
    rollbackNeedsApproval: false,
    rollbackAllowedInFreeze: true,
    requestTtlMinutes: 120,
    freezes: [],
};

let cache: { at: number; value: DeployPolicy } | null = null;

export async function deployPolicy(): Promise<DeployPolicy> {
    if (cache && Date.now() - cache.at < 10_000) return cache.value;
    const { rows } = await db().query("SELECT value FROM settings WHERE key = 'deploy_policy'");
    const v = (rows[0]?.value ?? {}) as Partial<DeployPolicy>;
    const value = { ...DEFAULT_POLICY, ...v, approvals: { ...DEFAULT_POLICY.approvals, ...(v.approvals ?? {}) }, freezes: v.freezes ?? [] };
    cache = { at: Date.now(), value };
    return value;
}

export async function saveDeployPolicy(p: DeployPolicy, by: string): Promise<void> {
    await db().query(
        `INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('deploy_policy', $1, now(), $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
        [JSON.stringify(p), by]);
    cache = null;
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const validTz = (tz: string) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } };

export function validatePolicy(input: any, current: DeployPolicy): DeployPolicy | string {   // eslint-disable-line @typescript-eslint/no-explicit-any
    const timezone = typeof input.timezone === 'string' ? input.timezone : current.timezone;
    if (!validTz(timezone)) return 'Unknown timezone.';
    const approvals = { ...current.approvals };
    for (const e of ENVIRONMENTS) if (typeof input.approvals?.[e] === 'boolean') approvals[e] = input.approvals[e];
    const freezes: FreezeWindow[] = [];
    const list = Array.isArray(input.freezes) ? input.freezes : current.freezes;
    if (list.length > 20) return 'At most 20 freeze windows.';
    for (const [i, f] of list.entries()) {
        const name = String(f.name ?? '').trim().slice(0, 60);
        if (!name) return `Freeze window ${i + 1} needs a name.`;
        const environments = (Array.isArray(f.environments) ? f.environments : []).filter((e: string) => ENVIRONMENTS.includes(e as Env)) as Env[];
        if (!environments.length) return `“${name}” must apply to at least one environment.`;
        const id = /^[a-z0-9]{6,16}$/.test(f.id) ? f.id : Math.random().toString(36).slice(2, 10);
        if (f.kind === 'weekly') {
            const days = [f.startDay, f.endDay].map(Number);
            if (days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return `“${name}”: pick start and end days.`;
            if (!TIME_RE.test(f.startTime) || !TIME_RE.test(f.endTime)) return `“${name}”: times must be HH:MM.`;
            if (days[0] === days[1] && f.startTime === f.endTime) return `“${name}”: start and end are the same.`;
            freezes.push({ id, name, environments, kind: 'weekly', startDay: days[0], startTime: f.startTime, endDay: days[1], endTime: f.endTime });
        } else if (f.kind === 'once') {
            const s = Date.parse(f.startAt), e = Date.parse(f.endAt);
            if (Number.isNaN(s) || Number.isNaN(e) || e <= s) return `“${name}”: end must be after start.`;
            if (e - s > 31 * 86_400_000) return `“${name}”: one-off freezes can last at most 31 days.`;
            freezes.push({ id, name, environments, kind: 'once', startAt: new Date(s).toISOString(), endAt: new Date(e).toISOString() });
        } else return `“${name}”: kind must be weekly or once.`;
    }
    const ttl = Math.round(Number(input.requestTtlMinutes ?? current.requestTtlMinutes));
    return {
        timezone, approvals, freezes,
        rollbackNeedsApproval: typeof input.rollbackNeedsApproval === 'boolean' ? input.rollbackNeedsApproval : current.rollbackNeedsApproval,
        rollbackAllowedInFreeze: typeof input.rollbackAllowedInFreeze === 'boolean' ? input.rollbackAllowedInFreeze : current.rollbackAllowedInFreeze,
        requestTtlMinutes: Number.isFinite(ttl) ? Math.max(10, Math.min(24 * 60, ttl)) : current.requestTtlMinutes,
    };
}

// ------------------------------------------------------------------ freeze evaluation
const WEEK = 7 * 1440;
/** Minutes since Sunday 00:00 in `tz` for instant `d`. */
function weekMinute(d: Date, tz: string): number {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)!.value;
    const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
    return day * 1440 + Number(get('hour')) * 60 + Number(get('minute'));
}
const toMin = (day: number, hhmm: string) => day * 1440 + Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

export interface ActiveFreeze { id: string; name: string; endsAt: string }

/** The freeze window active for `env` at `now` (if several overlap, the one ending last). */
export function activeFreeze(p: DeployPolicy, env: string, now = new Date()): ActiveFreeze | null {
    let best: ActiveFreeze | null = null;
    const consider = (f: FreezeWindow, end: Date) => { if (!best || end.toISOString() > best.endsAt) best = { id: f.id, name: f.name, endsAt: end.toISOString() }; };
    for (const f of p.freezes) {
        if (!f.environments.includes(env as Env)) continue;
        if (f.kind === 'once') {
            if (now.getTime() >= Date.parse(f.startAt!) && now.getTime() < Date.parse(f.endAt!)) consider(f, new Date(f.endAt!));
            continue;
        }
        const nowM = weekMinute(now, p.timezone);
        const s = toMin(f.startDay!, f.startTime!), e = toMin(f.endDay!, f.endTime!);
        const len = ((e - s) % WEEK + WEEK) % WEEK || WEEK;
        const into = ((nowM - s) % WEEK + WEEK) % WEEK;
        if (into < len) consider(f, new Date(Math.floor(now.getTime() / 60_000) * 60_000 + (len - into) * 60_000));
    }
    return best;
}

/** Everything the UI needs to explain what a deploy of this kind will do right now. */
export async function policyFor(env: string) {
    const p = await deployPolicy();
    return {
        freeze: activeFreeze(p, env),
        needsApproval: { deploy: !!p.approvals[env as Env], rollback: !!p.approvals[env as Env] && p.rollbackNeedsApproval },
        rollbackAllowedInFreeze: p.rollbackAllowedInFreeze,
        requestTtlMinutes: p.requestTtlMinutes,
    };
}
