import { raise, resolve } from './alerts';
import { aws } from './aws';
import { db } from './db';

/**
 * AWS spend from Cost Explorer. Every request costs USD 0.01, so one refresh = 2 requests (daily-by-service for last
 * month + this month, and the month-end forecast), done at most once a day automatically and once an hour on demand.
 */
export interface CostSettings { monthlyBudget: number | null; zarRate: number | null }
export interface CostSummary {
    fetchedAt: string; currency: string;
    monthToDate: number; lastMonth: number; lastMonthSamePeriod: number; forecast: number; forecastSource: 'aws' | 'linear';
    daily: { day: string; total: number; top?: { name: string; amount: number }[] }[];
    services: { name: string; monthToDate: number; lastMonth: number }[];
    period: { monthStart: string; today: string; daysInMonth: number };
}
export interface RawCostRow { day: string; service: string; amount: number; unit: string }

const AUTO_EVERY_MS = 20 * 3_600_000;
const MANUAL_EVERY_MS = 3_600_000;
const ymd = (d: Date) => d.toISOString().slice(0, 10);

export async function costSettings(): Promise<CostSettings> {
    const { rows } = await db().query("SELECT value FROM settings WHERE key = 'costs'");
    return { monthlyBudget: null, zarRate: null, ...(rows[0]?.value ?? {}) };
}
export async function saveCostSettings(s: CostSettings, by: string): Promise<void> {
    await db().query(`INSERT INTO settings (key, value, updated_by) VALUES ('costs', $1, $2)
                      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`, [JSON.stringify(s), by]);
}

export function summarise(rows: RawCostRow[], forecastRemainder: number | null, now = new Date()): Omit<CostSummary, 'fetchedAt'> {
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const lastStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
    const dayOfMonth = now.getUTCDate();
    const ms = ymd(monthStart), ls = ymd(lastStart);
    const samePeriodEnd = ymd(new Date(Date.UTC(lastStart.getUTCFullYear(), lastStart.getUTCMonth(), dayOfMonth)));
    let mtd = 0, last = 0, lastSame = 0;
    const byDay = new Map<string, number>(), svc = new Map<string, { m: number; l: number }>();
    const daySvc = new Map<string, Map<string, number>>();
    for (const r of rows) {
        byDay.set(r.day, (byDay.get(r.day) ?? 0) + r.amount);
        const ds = daySvc.get(r.day) ?? new Map<string, number>();
        ds.set(r.service, (ds.get(r.service) ?? 0) + r.amount);
        daySvc.set(r.day, ds);
        const e = svc.get(r.service) ?? { m: 0, l: 0 };
        if (r.day >= ms) { mtd += r.amount; e.m += r.amount; }
        else if (r.day >= ls) { last += r.amount; e.l += r.amount; if (r.day < samePeriodEnd) lastSame += r.amount; }
        svc.set(r.service, e);
    }
    const round = (n: number) => Math.round(n * 100) / 100;
    const services = [...svc.entries()].map(([name, v]) => ({ name, monthToDate: round(v.m), lastMonth: round(v.l) }))
        .filter((s) => s.monthToDate >= 0.005 || s.lastMonth >= 0.005).sort((a, b) => b.monthToDate - a.monthToDate || b.lastMonth - a.lastMonth);
    const top = services.slice(0, 8);
    const rest = services.slice(8);
    if (rest.length) top.push({ name: `${rest.length} other services`, monthToDate: round(rest.reduce((n, s) => n + s.monthToDate, 0)), lastMonth: round(rest.reduce((n, s) => n + s.lastMonth, 0)) });
    const linear = dayOfMonth > 0 ? (mtd / dayOfMonth) * daysInMonth : mtd;
    return {
        currency: rows[0]?.unit ?? 'USD',
        monthToDate: round(mtd), lastMonth: round(last), lastMonthSamePeriod: round(lastSame),
        forecast: round(forecastRemainder != null ? mtd + forecastRemainder : linear), forecastSource: forecastRemainder != null ? 'aws' : 'linear',
        daily: [...byDay.entries()].sort().map(([day, total]) => ({
            day, total: round(total),
            top: [...(daySvc.get(day) ?? new Map()).entries()].filter(([, a]) => a >= 0.005).sort((a, b) => b[1] - a[1]).slice(0, 4)
                .map(([name, amount]) => ({ name, amount: round(amount) })),
        })),
        services: top,
        period: { monthStart: ms, today: ymd(now), daysInMonth },
    };
}

let inflight: Promise<CostSummary> | null = null;

export async function latestCosts(): Promise<CostSummary | null> {
    const { rows } = await db().query('SELECT data FROM cost_snapshots ORDER BY fetched_at DESC LIMIT 1');
    return rows[0]?.data ?? null;
}

/** Refresh from Cost Explorer unless the last fetch is recent enough (manual: 1h, automatic: 20h). */
export async function refreshCosts(kind: 'auto' | 'manual'): Promise<{ summary: CostSummary; fetched: boolean }> {
    const latest = await latestCosts();
    const age = latest ? Date.now() - Date.parse(latest.fetchedAt) : Infinity;
    if (age < (kind === 'auto' ? AUTO_EVERY_MS : MANUAL_EVERY_MS)) return { summary: latest!, fetched: false };
    if (inflight) return { summary: await inflight, fetched: false };
    inflight = (async () => {
        const a = aws();
        if (!a.costRows) throw new Error('Cost Explorer is not available.');
        const now = new Date();
        const start = ymd(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)));
        const end = ymd(new Date(now.getTime() + 86_400_000));
        const rows = await a.costRows(start, end);
        const nextMonth = ymd(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)));
        const remainder = end < nextMonth ? await a.costForecast!(end, nextMonth).catch(() => null) : 0;
        const summary: CostSummary = { fetchedAt: new Date().toISOString(), ...summarise(rows, remainder, now) };
        await db().query('INSERT INTO cost_snapshots (data) VALUES ($1)', [JSON.stringify(summary)]);
        await db().query("DELETE FROM cost_snapshots WHERE fetched_at < now() - interval '90 days'");
        await budgetAlerts(summary);
        return summary;
    })().finally(() => { inflight = null; });
    return { summary: await inflight, fetched: true };
}

export async function budgetAlerts(s: CostSummary): Promise<void> {
    const { monthlyBudget: b } = await costSettings();
    const key = 'cost_budget';
    if (!b) return resolve(key);
    const money = (n: number) => `${s.currency} ${n.toFixed(2)}`;
    if (s.monthToDate > b) {
        await raise({ key, rule: 'cost_budget', severity: 'critical', instanceId: null, title: `AWS spend is over budget: ${money(s.monthToDate)} of ${money(b)}`,
            detail: `Month to date ${money(s.monthToDate)}; forecast ${money(s.forecast)} for the month.` });
    } else if (s.forecast > b) {
        await raise({ key, rule: 'cost_budget', severity: 'warning', instanceId: null, title: `AWS spend is forecast to exceed the budget (${money(s.forecast)} vs ${money(b)})`,
            detail: `Month to date ${money(s.monthToDate)}. Largest: ${s.services.slice(0, 3).map((x) => `${x.name} ${money(x.monthToDate)}`).join(', ')}.` });
    } else await resolve(key);
}
