import { Context, Hono } from 'hono';
import { audit } from '../audit';
import { InstanceRow } from '../collector';
import { costSettings, latestCosts, refreshCosts, saveCostSettings, budgetAlerts } from '../costs';
import { db } from '../db';
import { DeployError } from '../deploys';
import { denyDemo, Env, rateLimit, requireRole } from '../middleware';
import { editSchedule, schedulesFor, skipNextStop } from '../schedule';

const fail = (c: Context<Env>, err: unknown) => err instanceof DeployError ? c.json({ error: err.message }, err.status) : c.json({ error: (err as Error).message.slice(0, 300) }, 502);

/** /api/instances/:id/schedule (mounted on /api/instances; guards are per route). */
export const schedules = new Hono<Env>();
async function inst(c: Context<Env>): Promise<InstanceRow | null> {
    const { rows } = await db().query<InstanceRow>('SELECT * FROM instances WHERE id = $1', [Number(c.req.param('id'))]);
    return rows[0] ?? null;
}

schedules.get('/:id/schedule', requireRole('viewer'), async (c) => {
    const i = await inst(c);
    if (!i) return c.json({ error: 'Instance not found' }, 404);
    try { return c.json({ schedules: await schedulesFor(i) }); } catch (err) { return fail(c, err); }
});

schedules.put('/:id/schedule/:name', requireRole('admin'), denyDemo, rateLimit(20, 10 * 60_000, (c) => `sched:${c.get('user')!.id}`), async (c) => {
    const i = await inst(c);
    if (!i) return c.json({ error: 'Instance not found' }, 404);
    const b = await c.req.json().catch(() => ({}));
    const user = c.get('user')!;
    try {
        const r = await editSchedule(i, c.req.param('name'), {
            time: typeof b.time === 'string' ? b.time : undefined,
            days: Array.isArray(b.days) ? b.days.map(Number) : undefined,
            enabled: typeof b.enabled === 'boolean' ? b.enabled : undefined,
        }, user.username);
        await audit({ id: user.id, username: user.username }, 'schedule.update', `${c.req.param('name')} (${i.name})`, r, c.get('ip'));
        return c.json({ ...r, schedules: await schedulesFor(i) });
    } catch (err) { return fail(c, err); }
});

/** "Keep running tonight": deployers and admins (it only delays a stop). */
schedules.post('/:id/schedule/:name/skip', requireRole('deployer'), denyDemo, rateLimit(10, 10 * 60_000, (c) => `skip:${c.get('user')!.id}`), async (c) => {
    const i = await inst(c);
    if (!i) return c.json({ error: 'Instance not found' }, 404);
    const user = c.get('user')!;
    try {
        const r = await skipNextStop(i, c.req.param('name'), user.username);
        await audit({ id: user.id, username: user.username }, 'schedule.skip', `${c.req.param('name')} (${i.name})`, r, c.get('ip'));
        return c.json({ ...r, schedules: await schedulesFor(i) });
    } catch (err) { return fail(c, err); }
});

/** /api/costs: admins and deployers (never viewers or the public demo). */
export const costs = new Hono<Env>();
costs.use('*', requireRole('deployer'), denyDemo);

costs.get('/', async (c) => {
    try {
        const { summary } = await refreshCosts('auto').catch(async (err) => {
            const cached = await latestCosts();
            if (cached) return { summary: cached };
            throw err;
        });
        return c.json({ summary, settings: await costSettings() });
    } catch (err) { return fail(c, err); }
});

costs.post('/refresh', requireRole('admin'), async (c) => {
    const user = c.get('user')!;
    try {
        const r = await refreshCosts('manual');
        if (r.fetched) await audit({ id: user.id, username: user.username }, 'costs.refresh', 'Cost Explorer', {}, c.get('ip'));
        return c.json({ summary: r.summary, fetched: r.fetched, settings: await costSettings() });
    } catch (err) { return fail(c, err); }
});

costs.put('/settings', requireRole('admin'), async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const num = (v: unknown, max: number) => (v === null || v === '' || v === undefined ? null : Number.isFinite(Number(v)) && Number(v) > 0 && Number(v) <= max ? Math.round(Number(v) * 100) / 100 : NaN);
    // partial update: only the fields sent change (the Costs page sends the budget, Settings the currency)
    const cur = await costSettings();
    const s = {
        monthlyBudget: 'monthlyBudget' in b ? num(b.monthlyBudget, 1_000_000) : cur.monthlyBudget,
        zarRate: 'zarRate' in b ? num(b.zarRate, 1000) : cur.zarRate,
        currency: 'currency' in b ? b.currency : cur.currency,
    };
    if (Number.isNaN(s.monthlyBudget) || Number.isNaN(s.zarRate)) return c.json({ error: 'Budget and exchange rate must be positive numbers (or empty).' }, 400);
    if (s.currency !== 'USD' && s.currency !== 'ZAR') return c.json({ error: 'Currency must be USD or ZAR.' }, 400);
    if (s.currency === 'ZAR' && !s.zarRate) return c.json({ error: 'Enter the exchange rate (Rand per US dollar) to show costs in Rand.' }, 400);
    const user = c.get('user')!;
    await saveCostSettings(s, user.username);
    await audit({ id: user.id, username: user.username }, 'costs.settings', 'cost settings', s, c.get('ip'));
    const latest = await latestCosts();
    if (latest) await budgetAlerts(latest);
    return c.json({ settings: s });
});
