import { Context, Hono, MiddlewareHandler } from 'hono';
import { audit } from '../audit';
import { invoicesCsv, invoicesPdf, invoiceView, InvoiceRow, listInvoices, syncInvoices, billingEnabled, cancel, checkout, confirmCheckout, handlePaystackEvent, PLANS, cardLink, creditBalance, resume, PlanId, standing, standingOf, verifyPaystackSignature, WorkspaceBilling } from '../billing';
import { config } from '../config';
import { db } from '../db';
import { DeployError } from '../deploys';
import { denyDemo, Env, rateLimit, requireRole } from '../middleware';

const billing = new Hono<Env>();
const fail = (c: Context<Env>, err: unknown) => err instanceof DeployError ? c.json({ error: err.message, code: err.code }, err.status) : c.json({ error: 'Billing is unavailable right now.' }, 502);
const multiOnly: MiddlewareHandler<Env> = async (c, next) => (config.multiTenant ? next() : c.json({ error: 'Not found' }, 404));

billing.get('/', multiOnly, requireRole('viewer'), async (c) => {
    const id = c.get('user')!.workspaceId!;
    const { rows: [w] } = await db().query<WorkspaceBilling>('SELECT * FROM workspaces WHERE id = $1', [id]);
    const s = standing(w);
    const n = async (q: string, args: unknown[] = []) => (await db().query<{ n: number }>(q, args)).rows[0].n;
    const usage = {
        servers: await n('SELECT count(*)::int AS n FROM instances'),
        apps: (await db().query<{ last_status: { apps?: unknown[] } | null }>('SELECT last_status FROM instances')).rows.reduce((a, r) => a + (r.last_status?.apps?.length ?? 0), 0),
        members: await n('SELECT count(*)::int AS n FROM workspace_members WHERE workspace_id = $1', [id]),
    };
    const lim = (x: number) => (Number.isFinite(x) ? x : null);
    return c.json({
        enabled: billingEnabled(), plan: w.plan, status: w.billing_status, trialEndsAt: w.trial_ends_at, currentPeriodEnd: w.current_period_end,
        graceUntil: w.grace_until, active: s.active, reason: s.reason, hasSubscription: !!w.subscription_code || !!w.paystack_authorization, billingEmail: w.billing_email,
        complimentary: !!w.complimentary, compUntil: w.comp_until ?? null, suspended: !!w.suspended_at,
        credit: (await creditBalance(id)) / 100, card: w.card_label ?? null, lastChargeError: w.billing_status === 'past_due' ? w.last_charge_error ?? null : null,
        legacySubscription: !!w.subscription_code, customLimits: !!w.limit_overrides,
        limits: { servers: lim(s.limits.servers), apps: lim(s.limits.apps), members: lim(s.limits.members), approvals: s.limits.approvals }, usage,
        plans: (Object.keys(PLANS) as PlanId[]).map((p) => ({ id: p, name: PLANS[p].name, price: PLANS[p].amount / 100, limits: PLANS[p].limits })),
    });
});

billing.post('/checkout', multiOnly, requireRole('admin'), denyDemo, rateLimit(10, 10 * 60_000, (c) => `checkout:${c.get('user')!.id}`), async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const user = c.get('user')!;
    if (!user.email) return c.json({ error: 'Add an email address to your account first (Account page): Paystack sends receipts there.' }, 409);
    try {
        const r = await checkout(user.workspaceId!, b.plan, user.email);
        await audit({ id: user.id, username: user.username }, 'billing.checkout', b.plan, { reference: r.reference }, c.get('ip'));
        return c.json(r);
    } catch (err) { return fail(c, err); }
});

billing.post('/confirm', multiOnly, requireRole('admin'), denyDemo, async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const user = c.get('user')!;
    try {
        const w = await confirmCheckout(user.workspaceId!, String(b.reference ?? ''));
        forgetStanding(user.workspaceId!);
        await audit({ id: user.id, username: user.username }, 'billing.subscribed', w.plan, { reference: b.reference }, c.get('ip'));
        return c.json({ ok: true, plan: w.plan, status: w.billing_status });
    } catch (err) { return fail(c, err); }
});

billing.post('/cancel', multiOnly, requireRole('admin'), denyDemo, async (c) => {
    const user = c.get('user')!;
    try {
        await cancel(user.workspaceId!);
        forgetStanding(user.workspaceId!);
        await audit({ id: user.id, username: user.username }, 'billing.cancel', null, {}, c.get('ip'));
        return c.json({ ok: true });
    } catch (err) { return fail(c, err); }
});

billing.post('/resume', multiOnly, requireRole('admin'), denyDemo, async (c) => {
    const user = c.get('user')!;
    try {
        await resume(user.workspaceId!);
        forgetStanding(user.workspaceId!);
        await audit({ id: user.id, username: user.username }, 'billing.resume', null, {}, c.get('ip'));
        return c.json({ ok: true });
    } catch (err) { return fail(c, err); }
});

/** Change the card (a R5 card check, kept as credit; a failed renewal is retried right after). */
billing.get('/manage', multiOnly, requireRole('admin'), denyDemo, async (c) => {
    const user = c.get('user')!;
    if (!user.email) return c.json({ error: 'Add an email address to the account first (Account page): Paystack sends receipts there.' }, 409);
    try { return c.json({ url: await cardLink(user.workspaceId!, user.email) }); } catch (err) { return fail(c, err); }
});

// ------------------------------------------------------------------ invoices (generated by the console from Paystack-confirmed payments;
// Paystack's API keeps invoice data but offers no downloadable invoice documents)
billing.get('/invoices', multiOnly, requireRole('admin'), denyDemo, async (c) => {
    await syncInvoices(c.get('user')!.workspaceId!).catch(() => undefined);   // best effort: pick up renewals the webhook missed
    return c.json({ invoices: (await listInvoices()).map(invoiceView) });
});
billing.get('/invoices/export', multiOnly, requireRole('admin'), denyDemo, async (c) => {
    const months = Math.min(24, Math.max(1, Number(c.req.query('months') || 6)));
    const list = await listInvoices(months);
    if (!list.length) return c.json({ error: `No invoices in the last ${months} months.` }, 404);
    const stamp = new Date().toISOString().slice(0, 10);
    if (c.req.query('format') === 'csv') {
        c.header('Content-Disposition', `attachment; filename="invoices-last-${months}-months-${stamp}.csv"`);
        return c.body(invoicesCsv(list), 200, { 'content-type': 'text/csv; charset=utf-8' });
    }
    c.header('Content-Disposition', `attachment; filename="invoices-last-${months}-months-${stamp}.pdf"`);
    return c.body(invoicesPdf(list.slice().reverse()), 200, { 'content-type': 'application/pdf' });   // oldest first
});
billing.get('/invoices/:id/pdf', multiOnly, requireRole('admin'), denyDemo, async (c) => {
    const { rows: [i] } = await db().query<InvoiceRow>('SELECT * FROM invoices WHERE id = $1', [Number(c.req.param('id'))]);
    if (!i) return c.json({ error: 'Invoice not found' }, 404);   // another workspace's invoice doesn't exist for you
    c.header('Content-Disposition', `attachment; filename="${i.number}.pdf"`);
    return c.body(invoicesPdf([i]), 200, { 'content-type': 'application/pdf' });
});

/** Paystack → console. Public; authenticated by the HMAC-SHA512 signature; each event handled once. */
billing.post('/paystack', rateLimit(120, 60_000, () => 'paystack-webhook'), async (c) => {
    const body = await c.req.text();
    if (!verifyPaystackSignature(body, c.req.header('x-paystack-signature'))) return c.json({ error: 'bad signature' }, 401);
    let e: { event?: string; data?: Record<string, unknown> };
    try { e = JSON.parse(body); } catch { return c.json({ error: 'bad json' }, 400); }
    if (!e.event) return c.json({ ok: true });
    const fresh = await handlePaystackEvent({ event: e.event, data: e.data ?? {} });
    return c.json({ ok: true, duplicate: !fresh || undefined });
});

/**
 * Multi-customer: a workspace that isn't paid up is read-only. Reads always work; so do signing in, your account,
 * billing, switching or creating workspaces, and leaving one. Its servers and apps keep running regardless.
 */
const allowed = ['/api/auth/', '/api/account/', '/api/billing/', '/api/workspaces', '/api/platform/'];
const standingCache = new Map<number, { at: number; active: boolean; reason: string | null }>();
export const billingGuard: MiddlewareHandler<Env> = async (c, next) => {
    const user = c.get('user');
    if (!config.multiTenant || !user?.workspaceId || ['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) return next();
    const path = c.req.path;
    if (allowed.some((p) => path.startsWith(p)) || (c.req.method === 'DELETE' && path === `/api/team/members/${user.id}`)) return next();
    let s = standingCache.get(user.workspaceId);
    if (!s || Date.now() - s.at > 30_000) {
        const st = await standingOf(user.workspaceId);
        s = { at: Date.now(), active: st.active, reason: st.reason };
        standingCache.set(user.workspaceId, s);
    }
    if (!s.active) return c.json({ error: `${s.reason} Your servers and apps keep running.`, code: 'billing_required' }, 402);
    return next();
};
/** After a payment or cancellation, re-check at once. */
export const forgetStanding = (workspaceId: number) => standingCache.delete(workspaceId);

export default billing;
