import { announce } from './alerts';
import { aws, dryRun } from './aws';
import { InstanceRow } from './collector';
import { db } from './db';
import { DeployError } from './deploys';

/** A start/stop schedule as the console understands it (EventBridge Scheduler). */
export interface RawSchedule {
    name: string; group: string; expression: string; timezone: string; state: 'ENABLED' | 'DISABLED';
    targetArn: string; input: string | null; description?: string | null;
}
export interface ScheduleView {
    name: string; group: string; action: 'start' | 'stop' | 'unknown'; instanceIds: string[]; expression: string; timezone: string;
    enabled: boolean; next: string | null; time: string | null; days: number[] | null; editable: boolean;
    skip: { until: string; by: string } | null;
}

// ------------------------------------------------------------------ cron
const DOW = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
function field(spec: string, lo: number, hi: number, names?: string[]): Set<number> | null {
    if (spec === '*' || spec === '?') return null;   // any
    const out = new Set<number>();
    for (const part of spec.split(',')) {
        const [range, stepS] = part.split('/');
        const step = stepS ? Number(stepS) : 1;
        const val = (x: string) => (names && names.includes(x.toUpperCase()) ? names.indexOf(x.toUpperCase()) + 1 : Number(x));
        let a = lo, b = hi;
        if (range !== '*') { const [x, y] = range.split('-'); a = val(x); b = y === undefined ? (stepS ? hi : a) : val(y); }
        if ([a, b, step].some((n) => !Number.isFinite(n))) throw new Error(`bad cron field ${spec}`);
        for (let i = a; i <= b; i += step) out.add(i);
    }
    return out;
}

/** Parse AWS cron(min hour dom month dow year); dow is 1=SUN … 7=SAT. */
export function parseCron(expr: string) {
    const m = /^cron\((.+)\)$/.exec(expr.trim());
    if (!m) return null;
    const [min, hour, dom, mon, dow] = m[1].trim().split(/\s+/);
    return { min: field(min, 0, 59), hour: field(hour, 0, 23), dom: field(dom, 1, 31), mon: field(mon, 1, 12, ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']), dow: field(dow, 1, 7, DOW), raw: [min, hour, dom, mon, dow] };
}

function localParts(d: Date, tz: string) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
        .formatToParts(d).map((x) => [x.type, x.value]));
    return { dow: DOW.indexOf(String(p.weekday).toUpperCase()) + 1, mon: Number(p.month), dom: Number(p.day), hour: Number(p.hour), min: Number(p.minute) };
}

/** Next time (after `from`) an expression fires, or null (rate()/unsupported/none within 14 days). */
export function nextRun(expr: string, tz: string, from = new Date()): Date | null {
    const at = /^at\((\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)\)$/.exec(expr.trim());
    if (at) {
        // at() is wall-clock time in the schedule's timezone: find the instant whose local parts match
        const guess = new Date(`${at[1]}Z`);
        for (let off = -14 * 60; off <= 14 * 60; off += 15) {
            const d = new Date(guess.getTime() - off * 60_000);
            const l = localParts(d, tz);
            if (l.hour === guess.getUTCHours() && l.min === guess.getUTCMinutes() && l.dom === guess.getUTCDate()) return d > from ? d : null;
        }
        return null;
    }
    const c = parseCron(expr);
    if (!c) return null;
    const t = new Date(Math.floor(from.getTime() / 60_000) * 60_000 + 60_000);
    for (let i = 0; i < 14 * 1440; i++, t.setTime(t.getTime() + 60_000)) {
        const l = localParts(t, tz);
        if ((c.min && !c.min.has(l.min)) || (c.hour && !c.hour.has(l.hour))) continue;
        if ((c.mon && !c.mon.has(l.mon)) || (c.dom && !c.dom.has(l.dom)) || (c.dow && !c.dow.has(l.dow))) continue;
        return new Date(t);
    }
    return null;
}

/** "HH:MM" + days (0=Sunday…6=Saturday) → AWS cron. Every day → cron(M H * * ? *). */
export function buildCron(time: string, days: number[]): string {
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
    if (!m) throw new DeployError('Time must be HH:MM.');
    const ds = [...new Set(days)].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort();
    if (!ds.length) throw new DeployError('Pick at least one day.');
    const dow = ds.length === 7 ? null : ds.map((d) => DOW[d]).join(',');
    return dow ? `cron(${Number(m[2])} ${Number(m[1])} ? * ${dow} *)` : `cron(${Number(m[2])} ${Number(m[1])} * * ? *)`;
}

/** Simple schedules (one time, a set of weekdays) can be edited in the console; anything else is shown read-only. */
function simple(expr: string): { time: string; days: number[] } | null {
    const c = parseCron(expr);
    if (!c || c.dom || c.mon || !c.min || !c.hour || c.min.size !== 1 || c.hour.size !== 1) return null;
    const pad = (n: number) => String(n).padStart(2, '0');
    return { time: `${pad([...c.hour][0])}:${pad([...c.min][0])}`, days: c.dow ? [...c.dow].map((d) => d - 1).sort() : [0, 1, 2, 3, 4, 5, 6] };
}

// ------------------------------------------------------------------ targets
/** Which instances a schedule starts/stops: the AutoStartStop Lambda ({INSTANCE_IDS, ACTION}) or the EC2 universal target. */
export function interpret(s: RawSchedule): { action: 'start' | 'stop' | 'unknown'; instanceIds: string[] } {
    let input: Record<string, unknown> = {};
    try { input = s.input ? JSON.parse(s.input) : {}; } catch { /* not JSON */ }
    const uni = /aws-sdk:ec2:(start|stop)Instances$/i.exec(s.targetArn);
    if (uni) return { action: uni[1].toLowerCase() as 'start' | 'stop', instanceIds: (input.InstanceIds as string[]) ?? [] };
    const ids = String(input.INSTANCE_IDS ?? input.instance_ids ?? input.instanceIds ?? '').split(/[\s,]+/).filter((x) => /^i-[0-9a-f]+$/.test(x));
    const act = String(input.ACTION ?? input.action ?? '').toLowerCase();
    return { action: act === 'start' || act === 'stop' ? act : 'unknown', instanceIds: ids };
}

// ------------------------------------------------------------------ "keep running tonight"
interface Skip { region: string; group: string; name: string; until: string; by: string }
async function skips(): Promise<Skip[]> {
    const { rows } = await db().query("SELECT value FROM settings WHERE key = 'schedule_skips'");
    return (rows[0]?.value ?? []) as Skip[];
}
async function saveSkips(list: Skip[]): Promise<void> {
    await db().query(`INSERT INTO settings (key, value, updated_by) VALUES ('schedule_skips', $1, 'console')
                      ON CONFLICT (workspace_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [JSON.stringify(list)]);
}

const cache = new Map<string, { at: number; list: RawSchedule[] }>();
async function list(region: string, fresh = false): Promise<RawSchedule[]> {
    const hit = cache.get(region);
    if (!fresh && hit && Date.now() - hit.at < 60_000) return hit.list;
    const a = aws();
    if (!a.listSchedules) throw new DeployError('Schedules are not available.');
    const l = await a.listSchedules(region);
    cache.set(region, { at: Date.now(), list: l });
    return l;
}

export async function schedulesFor(inst: InstanceRow): Promise<ScheduleView[]> {
    const sk = await skips();
    return (await list(inst.region)).map((s) => ({ s, t: interpret(s) }))
        .filter(({ t }) => t.instanceIds.includes(inst.aws_instance_id))
        .map(({ s, t }) => {
            const e = simple(s.expression);
            const skip = sk.find((x) => x.region === inst.region && x.group === s.group && x.name === s.name) ?? null;
            const next = s.state === 'ENABLED' ? nextRun(s.expression, s.timezone) : null;
            return { name: s.name, group: s.group, action: t.action, instanceIds: t.instanceIds, expression: s.expression, timezone: s.timezone,
                enabled: s.state === 'ENABLED', next: next ? next.toISOString() : null, time: e?.time ?? null, days: e?.days ?? null,
                editable: !!e, skip: skip ? { until: skip.until, by: skip.by } : null };
        })
        .sort((x, y) => (x.action === y.action ? 0 : x.action === 'start' ? -1 : 1));
}

async function find(inst: InstanceRow, name: string): Promise<RawSchedule> {
    const s = (await list(inst.region, true)).find((x) => x.name === name);
    if (!s || !interpret(s).instanceIds.includes(inst.aws_instance_id)) throw new DeployError('That schedule does not target this instance.', 404);
    return s;
}

export async function editSchedule(inst: InstanceRow, name: string, change: { time?: string; days?: number[]; enabled?: boolean }, by: string) {
    const s = await find(inst, name);
    const patch: { expression?: string; state?: 'ENABLED' | 'DISABLED' } = {};
    if (change.time !== undefined || change.days !== undefined) {
        const cur = simple(s.expression);
        if (!cur && (change.time === undefined || change.days === undefined)) throw new DeployError('This schedule uses a custom expression; set both a time and days to replace it.');
        patch.expression = buildCron(change.time ?? cur!.time, change.days ?? cur!.days);
    }
    if (typeof change.enabled === 'boolean') patch.state = change.enabled ? 'ENABLED' : 'DISABLED';
    if (!patch.expression && !patch.state) throw new DeployError('Nothing to change.');
    if (!dryRun) await aws().updateSchedule!(inst.region, s.group, s.name, patch);
    if (patch.state === 'ENABLED') await saveSkips((await skips()).filter((x) => !(x.region === inst.region && x.name === s.name)));
    cache.delete(inst.region);
    const t = interpret(s);
    await announce(`[SCHEDULE] ${s.name} changed by ${by}`, `${by} changed the ${t.action} schedule for ${t.instanceIds.join(', ')}: ${patch.expression ? `${s.expression} → ${patch.expression} (${s.timezone})` : ''}${patch.state ? ` ${patch.state.toLowerCase()}` : ''}${dryRun ? ' (dry run)' : ''}.`, 'schedule');
    return { before: s.expression, after: patch.expression ?? s.expression, state: patch.state ?? s.state, dryRun };
}

/** Skip the next stop: pause the stop schedule now, re-enable it automatically after that stop time has passed. */
export async function skipNextStop(inst: InstanceRow, name: string, by: string) {
    const s = await find(inst, name);
    if (interpret(s).action !== 'stop') throw new DeployError('Only a stop schedule can be skipped.');
    if (s.state !== 'ENABLED') throw new DeployError('That schedule is already paused.');
    const next = nextRun(s.expression, s.timezone);
    if (!next) throw new DeployError('Could not work out the next stop time.');
    if (!dryRun) await aws().updateSchedule!(inst.region, s.group, s.name, { state: 'DISABLED' });
    const until = new Date(next.getTime() + 5 * 60_000).toISOString();
    await saveSkips([...(await skips()).filter((x) => !(x.region === inst.region && x.name === s.name)), { region: inst.region, group: s.group, name: s.name, until, by }]);
    cache.delete(inst.region);
    const others = interpret(s).instanceIds.filter((x) => x !== inst.aws_instance_id);
    await announce(`[SCHEDULE] Tonight's stop of ${inst.name} skipped by ${by}`,
        `${s.name} is paused until ${until} and re-enables itself after that.${others.length ? ` It also stops ${others.join(', ')}, which will keep running too.` : ''}${dryRun ? ' (dry run)' : ''}`, 'schedule');
    return { until, dryRun };
}

/** Re-enable schedules whose "skip" has run out (called by the poller). */
export async function reenableExpiredSkips(): Promise<void> {
    const list = await skips();
    const keep: Skip[] = [];
    for (const s of list) {
        if (Date.parse(s.until) > Date.now()) { keep.push(s); continue; }
        try {
            if (!dryRun) await aws().updateSchedule!(s.region, s.group, s.name, { state: 'ENABLED' });
            cache.delete(s.region);
        } catch (err) {
            console.error(`could not re-enable ${s.name}:`, (err as Error).message);
            keep.push(s);   // try again next tick
        }
    }
    if (keep.length !== list.length) await saveSkips(keep);
}
