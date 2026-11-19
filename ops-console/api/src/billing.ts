/**
 * Phase 12c: subscriptions with Paystack (multi-customer mode).
 *
 * Plans are Paystack "plans" (monthly, ZAR). Checkout is Paystack's hosted page; the transaction is verified on
 * return and every webhook event is signature-checked and handled once. A workspace keeps full access while it is
 * on trial, paid up, inside the 7-day grace after a failed payment, or cancelled but inside the period it paid for.
 * Otherwise it is read-only: its servers and apps keep running in the customer's own AWS account; only changes
 * through the console stop until they subscribe again.
 */
import { createHmac, timingSafeEqual } from 'crypto';
import { config } from './config';
import { asSystem, db } from './db';
import { DeployError } from './deploys';
import { makePdf, PdfOp } from './pdf';

export type PlanId = 'starter' | 'pro';
export interface Limits { servers: number; apps: number; members: number; approvals: boolean }
export const PLANS: Record<PlanId, { name: string; amount: number; limits: Limits }> = {
    starter: { name: 'Starter', amount: 19900, limits: { servers: 1, apps: 3, members: 2, approvals: false } },   // amounts in cents (ZAR)
    pro: { name: 'Pro', amount: 59900, limits: { servers: 5, apps: 20, members: 10, approvals: true } },
};
const UNLIMITED: Limits = { servers: Infinity, apps: Infinity, members: Infinity, approvals: true };
export const GRACE_DAYS = 7;

export interface WorkspaceBilling {
    id: number; name: string; plan: 'trial' | 'starter' | 'pro' | 'internal'; trial_ends_at: string | null; billing_status: string;
    paystack_customer: string | null; subscription_code: string | null; subscription_token: string | null;
    current_period_end: string | null; grace_until: string | null; billing_email: string | null;
    suspended_at?: string | null; suspended_reason?: string | null; complimentary?: boolean; comp_until?: string | null;
    limit_overrides?: LimitOverrides | null; paystack_authorization?: string | null; card_label?: string | null;
    last_charge_at?: string | null; last_charge_error?: string | null; next_retry_at?: string | null; charge_reference?: string | null;
}
/** Limits above the plan, set by the platform (each only raises; until = when they lapse). */
export interface LimitOverrides { servers?: number; apps?: number; members?: number; approvals?: boolean; until?: string | null }
/** The plan's limits, raised by the platform's overrides while they last. */
export function effectiveLimits(w: Pick<WorkspaceBilling, 'plan' | 'limit_overrides'>, now = Date.now()): Limits {
    const base = w.plan === 'internal' ? UNLIMITED : w.plan === 'trial' ? PLANS.pro.limits : PLANS[w.plan].limits;
    const o = w.limit_overrides;
    if (!o || (o.until && Date.parse(o.until) <= now)) return base;
    return { servers: Math.max(base.servers, o.servers ?? 0), apps: Math.max(base.apps, o.apps ?? 0), members: Math.max(base.members, o.members ?? 0), approvals: base.approvals || !!o.approvals };
}

export const billingEnabled = () => config.multiTenant && !!config.paystackSecret;

async function ws(id: number): Promise<WorkspaceBilling> {
    const { rows: [w] } = await db().query<WorkspaceBilling>('SELECT * FROM workspaces WHERE id = $1', [id]);
    if (!w) throw new DeployError('Workspace not found.', 404);
    return w;
}

/** What a workspace may do right now. */
export function standing(w: WorkspaceBilling, now = Date.now()): { active: boolean; reason: string | null; limits: Limits } {
    if (!config.multiTenant || w.plan === 'internal') return { active: true, reason: null, limits: UNLIMITED };
    const t = (iso: string | null) => (iso ? Date.parse(iso) : 0);
    const planLimits = effectiveLimits(w, now);
    if (w.suspended_at) return { active: false, reason: `This workspace is suspended${w.suspended_reason ? ` (${w.suspended_reason})` : ''}. Contact support.`, limits: planLimits };
    // a plan given by the platform: no payment needed while it lasts
    if (w.complimentary && w.plan !== 'trial' && (!w.comp_until || t(w.comp_until) > now)) return { active: true, reason: null, limits: planLimits };
    if (w.plan === 'trial') {
        return t(w.trial_ends_at) > now ? { active: true, reason: null, limits: planLimits }
            : { active: false, reason: 'Your free trial has ended. Choose a plan to keep making changes.', limits: planLimits };
    }
    const limits = planLimits;
    switch (w.billing_status) {
        case 'active': return { active: true, reason: null, limits };
        case 'past_due': return t(w.grace_until) > now ? { active: true, reason: null, limits }
            : { active: false, reason: 'A payment failed and the grace period is over. Update your card to continue.', limits };
        case 'cancelling': case 'cancelled': return t(w.current_period_end) > now ? { active: true, reason: null, limits }
            : { active: false, reason: 'Your subscription has ended. Choose a plan to continue.', limits };
        default: return { active: false, reason: 'Choose a plan to continue.', limits };
    }
}

export async function standingOf(workspaceId: number) { return standing(await ws(workspaceId)); }

/** Plan limits: servers, apps, team members, deploy approvals. Throws a friendly 409 when over. */
export async function checkLimit(workspaceId: number, kind: 'servers' | 'apps' | 'members' | 'approvals'): Promise<void> {
    if (!config.multiTenant) return;
    const w = await ws(workspaceId);
    const { limits } = standing(w);
    const planName = w.plan === 'trial' ? 'your trial' : `the ${PLANS[w.plan as PlanId]?.name ?? w.plan} plan`;
    if (kind === 'approvals') {
        if (!limits.approvals) throw new DeployError('Deploy approvals are part of the Pro plan.', 409, 'plan_limit');
        return;
    }
    let used = 0;
    if (kind === 'servers') used = (await db().query<{ n: number }>('SELECT count(*)::int AS n FROM instances')).rows[0].n;
    if (kind === 'members') used = (await db().query<{ n: number }>(
        `SELECT (SELECT count(*) FROM workspace_members WHERE workspace_id = $1) + (SELECT count(*) FROM workspace_invites WHERE workspace_id = $1 AND accepted_at IS NULL AND expires_at > now()) AS n`,
        [workspaceId])).rows[0].n;
    if (kind === 'apps') {
        const { rows } = await db().query<{ last_status: { apps?: unknown[] } | null }>('SELECT last_status FROM instances');
        used = rows.reduce((a, r) => a + (r.last_status?.apps?.length ?? 0), 0)
            + (await db().query<{ n: number }>("SELECT count(*)::int AS n FROM app_creations WHERE status = 'running'")).rows[0].n;
    }
    if (used >= limits[kind]) {
        const what = { servers: 'servers', apps: 'apps', members: 'team members (including pending invitations)' }[kind];
        throw new DeployError(`${planName[0].toUpperCase()}${planName.slice(1)} includes ${limits[kind]} ${what}. Upgrade to add more.`, 409, 'plan_limit');
    }
}

// ---------------------------------------------------------------------------------------------- Paystack API
type Fetch = typeof fetch;
let http: Fetch = (...a) => fetch(...a);
export function setPaystackFetch(f: Fetch): void { http = f; }

async function paystack<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    if (!config.paystackSecret) throw new DeployError('Billing is not set up on this platform yet.', 409);
    const r = await http(`https://api.paystack.co${path}`, {
        method: init.method ?? 'GET',
        headers: { authorization: `Bearer ${config.paystackSecret}`, 'content-type': 'application/json' },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(20_000),
    });
    const j = await r.json().catch(() => ({})) as { status?: boolean; message?: string; data?: T };
    if (!r.ok || !j.status) throw new DeployError(`Paystack: ${j.message ?? `HTTP ${r.status}`}`, 409);
    return j.data as T;
}

// ---------------------------------------------------------------------------------------------- credits
/** Credit balance in cents (granted by the platform, unused time from a plan switch, card checks; minus what renewals used). */
export async function creditBalance(workspaceId: number): Promise<number> {
    const { rows: [r] } = await asSystem(() => db().query<{ n: string }>('SELECT coalesce(sum(amount), 0)::text AS n FROM billing_credits WHERE workspace_id = $1', [workspaceId]));
    return Number(r.n);
}
/** Add (or use, when negative) credit. A reference is counted once. */
export async function addCredit(workspaceId: number, amount: number, kind: 'grant' | 'renewal' | 'proration' | 'card_check' | 'adjust', note: string, by: string, reference: string | null = null): Promise<boolean> {
    if (!Number.isInteger(amount) || amount === 0) return false;
    const { rowCount } = await asSystem(() => db().query(
        `INSERT INTO billing_credits (workspace_id, amount, kind, note, reference, created_by) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (reference) DO NOTHING`,
        [workspaceId, amount, kind, note.slice(0, 200), reference, by]));
    return (rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------------------------- subscriptions run by the console
/*
 * Paystack keeps the customer's card (a reusable "authorization"); the console starts each period itself:
 * credit first, then the rest is charged to the saved card (POST /transaction/charge_authorization). That makes credits,
 * free extensions and fair plan switches possible (Paystack subscriptions can't change their amount or date).
 * Workspaces still on a Paystack subscription from before keep it until it ends (subscription_code set).
 */
const price = (p: PlanId) => PLANS[p].amount;
const addMonth = (d: Date) => { const x = new Date(d); x.setMonth(x.getMonth() + 1); return x; };
type Meta = { workspace_id?: number | string; console?: string; plan?: PlanId; kind?: 'subscribe' | 'renewal' | 'switch' | 'card'; credit?: number; period_start?: string; proration?: number };
interface PaystackAuth { authorization_code?: string; reusable?: boolean; brand?: string; last4?: string; card_type?: string; exp_month?: string; exp_year?: string }
const cardLabel = (a?: PaystackAuth) => (a?.last4 ? `${(a.brand ?? a.card_type ?? 'Card').trim().replace(/^./, (x) => x.toUpperCase())} •••• ${a.last4}` : null);

async function saveCard(workspaceId: number, a: PaystackAuth | undefined, email: string | null) {
    if (!a?.authorization_code || !a.reusable) return;
    await asSystem(() => db().query(`UPDATE workspaces SET paystack_authorization = $2, card_label = $3, billing_email = coalesce($4, billing_email) WHERE id = $1`,
        [workspaceId, a.authorization_code, cardLabel(a), email]));
}

/**
 * Start a paid period (idempotent on the reference: the invoice is written once). `paid` was charged, `credit` came from
 * the balance; together they are the plan's price.
 */
async function startPeriod(workspaceId: number, plan: PlanId, from: Date, reference: string, paid: number, credit: number, t: PaystackTx | null, extraCredit?: { amount: number; note: string }) {
    const end = addMonth(from);
    const fresh = await writeInvoice(workspaceId, plan, reference, paid, credit, from, end, t);
    if (!fresh) return false;
    if (extraCredit?.amount) await addCredit(workspaceId, extraCredit.amount, 'proration', extraCredit.note, 'system', `proration:${reference}`);
    if (credit > 0) await addCredit(workspaceId, -credit, 'renewal', `Used for ${PLANS[plan].name}, ${from.toISOString().slice(0, 10)}`, 'system', `use:${reference}`);
    await asSystem(() => db().query(
        `UPDATE workspaces SET plan = $2, billing_status = 'active', grace_until = NULL, current_period_end = $3, complimentary = false, comp_until = NULL,
                last_charge_at = now(), last_charge_error = NULL, next_retry_at = NULL, charge_reference = NULL WHERE id = $1`, [workspaceId, plan, end.toISOString()]));
    return true;
}

/** Choose (or switch to) a plan. Returns where the browser goes next: Paystack's checkout, or straight back when nothing needs paying there. */
export async function checkout(workspaceId: number, plan: PlanId, email: string): Promise<{ url: string; reference: string }> {
    if (!PLANS[plan]) throw new DeployError('Choose a plan.');
    const w = await ws(workspaceId);
    if (w.plan === 'internal') throw new DeployError('This workspace is not billed.', 409);
    const paying = (w.plan === 'starter' || w.plan === 'pro') && ['active', 'past_due', 'cancelling'].includes(w.billing_status) && !w.complimentary;
    if (paying && w.plan === plan && w.billing_status === 'active') throw new DeployError(`You are already on ${PLANS[plan].name}.`, 409);
    const back = (reference: string) => ({ url: `${config.publicUrl}/billing/return?reference=${encodeURIComponent(reference)}`, reference });
    const balance = await creditBalance(workspaceId);

    // switching with a saved card: unused time of the current plan becomes credit, the new plan starts today, no redirect
    if (paying && w.paystack_authorization && !w.subscription_code && w.plan !== plan) {
        const end = w.current_period_end ? Date.parse(w.current_period_end) : 0;
        const start = end ? (() => { const x = new Date(end); x.setMonth(x.getMonth() - 1); return x.getTime(); })() : 0;   // the current period's start
        const left = Math.max(0, end - Date.now()), length = Math.max(1, end - start);
        const proration = w.billing_status === 'active' ? Math.floor(price(w.plan as PlanId) * Math.min(1, left / length)) : 0;
        const credit = Math.min(balance + proration, price(plan));
        const reference = `oc-${workspaceId}-sw-${Date.now()}`;
        const due = price(plan) - credit;
        let t: PaystackTx | null = null;
        if (due > 0) {
            t = await chargeCard(w, due, reference, tagged({ workspace_id: workspaceId, plan, kind: 'switch', credit, proration, period_start: new Date().toISOString() }));
            if (t.status !== 'success') throw new DeployError(`The card ${w.card_label ?? 'on file'} was declined${t.gateway_response ? ` (${t.gateway_response})` : ''}. Update the card and try again.`, 409);
        }
        await startPeriod(workspaceId, plan, new Date(), reference, due, credit, t, { amount: proration, note: `Unused ${PLANS[w.plan as PlanId].name} time` });
        return back(reference);
    }
    // credit covers the first month: nothing to pay now (a card is asked for at the next renewal)
    const credit = Math.min(balance, price(plan));
    if (credit === price(plan)) {
        const reference = `oc-${workspaceId}-credit-${Date.now()}`;
        await startPeriod(workspaceId, plan, new Date(), reference, 0, credit, null);
        return back(reference);
    }
    const d = await paystack<{ authorization_url: string; reference: string }>('/transaction/initialize', {
        method: 'POST',
        body: { email, amount: price(plan) - credit, currency: 'ZAR', channels: ['card'], callback_url: `${config.publicUrl}/billing/return`,
            metadata: { ...tagged({ workspace_id: workspaceId, plan, kind: 'subscribe', credit }), cancel_action: `${config.publicUrl}/billing` } },
    });
    return { url: d.authorization_url, reference: d.reference };
}

interface PaystackTx { status: string; reference: string; amount: number; currency: string; metadata?: Meta | string;
    customer?: { id?: number; customer_code?: string; email?: string }; paid_at?: string | null; created_at?: string; gateway_response?: string;
    authorization?: PaystackAuth; plan?: string | null; plan_object?: { plan_code?: string } }
const metaOf = (t: PaystackTx): Meta => (typeof t.metadata === 'object' && t.metadata ? t.metadata : {});
/**
 * Which console started a payment. Workspace ids restart in every console's database (production, staging, a local
 * copy), and several consoles may share one Paystack account, so a payment is ours only when it carries our tag
 * as well as the workspace id. Payments from before the tag existed carry none.
 */
export const consoleTag = () => new URL(config.publicUrl).host;
const tagged = (m: Meta): Meta => ({ ...m, console: consoleTag() });
const ours = (m: Meta) => m.console === consoleTag();
const foreign = (m: Meta) => !!m.console && m.console !== consoleTag();

/** Charge the saved card (never twice for one reference: Paystack rejects a reused reference). */
async function chargeCard(w: WorkspaceBilling, amount: number, reference: string, metadata: Meta): Promise<PaystackTx> {
    if (!w.paystack_authorization) throw new DeployError('There is no card on file.', 409);
    try {
        return await paystack<PaystackTx>('/transaction/charge_authorization', { method: 'POST', body: {
            authorization_code: w.paystack_authorization, email: w.billing_email, amount, currency: 'ZAR', reference, metadata } });
    } catch (err) {
        return { status: 'failed', reference, amount, currency: 'ZAR', gateway_response: (err as Error).message.slice(0, 160) };
    }
}

/** After Paystack's checkout (or a direct charge): confirm with Paystack itself (never trust the redirect), then apply it once. */
export async function confirmCheckout(workspaceId: number, reference: string): Promise<WorkspaceBilling> {
    if (!/^[A-Za-z0-9_.=-]{6,100}$/.test(reference)) throw new DeployError('Invalid payment reference.');
    const done = await asSystem(() => db().query('SELECT workspace_id FROM invoices WHERE reference = $1', [reference]));
    if (done.rows.length) {
        if (done.rows[0].workspace_id !== workspaceId) throw new DeployError('That payment belongs to another workspace.', 403);
        return ws(workspaceId);   // already applied (credit-only start, plan switch, or a second visit)
    }
    const t = await paystack<PaystackTx>(`/transaction/verify/${encodeURIComponent(reference)}`);
    const meta = metaOf(t);
    if (foreign(meta) || Number(meta.workspace_id) !== workspaceId) throw new DeployError('That payment belongs to another workspace.', 403);
    if (t.status !== 'success') throw new DeployError(`The payment was not completed (${t.status}).`, 409);
    await applyPayment(workspaceId, t);
    return ws(workspaceId);
}

/** Apply a successful Paystack transaction of ours (checkout, card check, renewal, switch). Idempotent. */
async function applyPayment(workspaceId: number, t: PaystackTx): Promise<void> {
    const meta = metaOf(t);
    if (t.currency !== 'ZAR') throw new DeployError('The payment is not in Rand.', 409);
    const before = await ws(workspaceId);
    if (meta.kind === 'card') {
        await saveCard(workspaceId, t.authorization, t.customer?.email ?? null);
        await addCredit(workspaceId, t.amount, 'card_check', 'Card check, kept as credit', 'system', `card:${t.reference}`);
        if (before.billing_status === 'past_due') await renew(await ws(workspaceId)).catch((err) => console.error('renewal after card update failed:', (err as Error).message));
        return;
    }
    const plan = meta.plan;
    const credit = Math.max(0, Math.floor(Number(meta.credit ?? 0)));
    if (!plan || !PLANS[plan] || t.amount + credit !== price(plan)) throw new DeployError('The payment does not match a plan.', 409);
    if (credit > (await creditBalance(workspaceId)) + Math.max(0, Number(meta.proration ?? 0))) throw new DeployError('The credit used for this payment is no longer available.', 409);
    await saveCard(workspaceId, t.authorization, t.customer?.email ?? null);
    if (t.customer?.customer_code) await asSystem(() => db().query('UPDATE workspaces SET paystack_customer = coalesce(paystack_customer, $2) WHERE id = $1', [workspaceId, t.customer!.customer_code]));
    const from = meta.period_start && meta.kind === 'renewal' ? new Date(meta.period_start) : new Date(t.paid_at ?? Date.now());
    await startPeriod(workspaceId, plan, from, t.reference, t.amount, credit, t,
        meta.kind === 'switch' && meta.proration ? { amount: Number(meta.proration), note: `Unused ${PLANS[before.plan as PlanId]?.name ?? ''} time` } : undefined);
    // moving off a Paystack subscription from before: it must not renew as well
    if (before.subscription_code && before.subscription_token) {
        await paystack('/subscription/disable', { method: 'POST', body: { code: before.subscription_code, token: before.subscription_token } })
            .catch((err) => console.error('could not stop the previous subscription:', (err as Error).message));
        await asSystem(() => db().query('UPDATE workspaces SET subscription_code = NULL, subscription_token = NULL WHERE id = $1', [workspaceId]));
    }
}

/** Renew one workspace whose period has ended: credit first, then the saved card. Failures start (or continue) the grace period. */
export async function renew(w: WorkspaceBilling): Promise<'renewed' | 'failed' | 'pending' | 'skipped'> {
    if ((w.plan !== 'starter' && w.plan !== 'pro') || w.complimentary || w.suspended_at || w.subscription_code) return 'skipped';
    const plan = w.plan as PlanId;
    const from = w.current_period_end ? new Date(w.current_period_end) : new Date();
    // a charge still in progress from the last run: ask Paystack how it ended before trying again
    if (w.charge_reference) {
        const prev = await paystack<PaystackTx>(`/transaction/verify/${encodeURIComponent(w.charge_reference)}`).catch(() => null);
        if (prev?.status === 'success') { await applyPayment(w.id, prev); return 'renewed'; }
        if (prev && !['failed', 'abandoned', 'reversed'].includes(prev.status)) return 'pending';
    }
    const credit = Math.min(await creditBalance(w.id), price(plan));
    const reference = `oc-${w.id}-${from.toISOString().slice(0, 10).replace(/-/g, '')}-${Date.now().toString(36)}`;
    if (credit === price(plan)) { await startPeriod(w.id, plan, from, reference, 0, credit, null); return 'renewed'; }
    const fail = async (why: string) => {
        await asSystem(() => db().query(
            `UPDATE workspaces SET billing_status = 'past_due', grace_until = coalesce(grace_until, now() + make_interval(days => $2)),
                    last_charge_at = now(), last_charge_error = $3, next_retry_at = now() + interval '1 day', charge_reference = NULL WHERE id = $1`, [w.id, GRACE_DAYS, why.slice(0, 200)]));
        return 'failed' as const;
    };
    if (!w.paystack_authorization) return fail('No card on file.');
    const t = await chargeCard(w, price(plan) - credit, reference, tagged({ workspace_id: w.id, plan, kind: 'renewal', credit, period_start: from.toISOString() }));
    if (t.status === 'success') { await applyPayment(w.id, t); return 'renewed'; }
    if (t.status === 'failed' || t.status === 'abandoned' || t.status === 'reversed') return fail(t.gateway_response || 'The card was declined.');
    await asSystem(() => db().query(`UPDATE workspaces SET charge_reference = $2, next_retry_at = now() + interval '1 hour', last_charge_at = now() WHERE id = $1`, [w.id, reference]));
    return 'pending';
}

/** Background job: renew every period that ended; close cancelled ones; stop retrying long-lapsed ones. */
export async function renewDue(): Promise<{ renewed: number; failed: number }> {
    await asSystem(() => db().query(`UPDATE workspaces SET billing_status = 'cancelled' WHERE billing_status = 'cancelling' AND subscription_code IS NULL AND current_period_end <= now()`));
    await asSystem(() => db().query(`UPDATE workspaces SET billing_status = 'expired', next_retry_at = NULL
        WHERE billing_status = 'past_due' AND subscription_code IS NULL AND current_period_end < now() - interval '30 days'`));
    const { rows } = await asSystem(() => db().query<WorkspaceBilling>(
        `SELECT * FROM workspaces WHERE plan IN ('starter', 'pro') AND NOT complimentary AND suspended_at IS NULL AND subscription_code IS NULL
            AND billing_status IN ('active', 'past_due') AND current_period_end <= now() AND (next_retry_at IS NULL OR next_retry_at <= now())
          ORDER BY current_period_end LIMIT 50`));
    let renewed = 0, failed = 0;
    for (const w of rows) {
        const r = await renew(w).catch((err) => { console.error(`renewal of workspace ${w.id} failed:`, (err as Error).message); return 'failed' as const; });
        if (r === 'renewed') renewed++; else if (r === 'failed') failed++;
    }
    return { renewed, failed };
}

/** A payment of a Paystack subscription from before: keep the plan active for another month. */
async function activate(workspaceId: number, plan: PlanId, customer: string | null, email: string | null) {
    await asSystem(() => db().query(
        `UPDATE workspaces SET plan = $2, billing_status = 'active', grace_until = NULL, paystack_customer = coalesce($3, paystack_customer),
                billing_email = coalesce($4, billing_email), current_period_end = greatest(coalesce(current_period_end, now()), now() + interval '1 month')
          WHERE id = $1`, [workspaceId, plan, customer, email]));
}

/** Cancel at the end of the paid period. */
export async function cancel(workspaceId: number): Promise<void> {
    const w = await ws(workspaceId);
    if (w.subscription_code && w.subscription_token) {   // a Paystack subscription from before
        await paystack('/subscription/disable', { method: 'POST', body: { code: w.subscription_code, token: w.subscription_token } });
    } else if (!['active', 'past_due'].includes(w.billing_status) || w.complimentary) throw new DeployError('There is no subscription to cancel.', 409);
    await db().query(`UPDATE workspaces SET billing_status = 'cancelling', next_retry_at = NULL WHERE id = $1`, [workspaceId]);
}
/** Undo a cancellation before the period ends. */
export async function resume(workspaceId: number): Promise<void> {
    const w = await ws(workspaceId);
    if (w.billing_status !== 'cancelling' || w.subscription_code || !w.current_period_end || Date.parse(w.current_period_end) <= Date.now()) throw new DeployError('There is no cancellation to undo.', 409);
    await db().query(`UPDATE workspaces SET billing_status = 'active' WHERE id = $1`, [workspaceId]);
}

export const CARD_CHECK = 500;   // R5, kept as credit
/** Change the card: a R5 card check on Paystack's page (kept as credit). A failed renewal is retried right after. */
export async function cardLink(workspaceId: number, email: string): Promise<string> {
    const w = await ws(workspaceId);
    if (w.subscription_code) return manageLink(workspaceId);
    const d = await paystack<{ authorization_url: string }>('/transaction/initialize', { method: 'POST', body: {
        email, amount: CARD_CHECK, currency: 'ZAR', channels: ['card'], callback_url: `${config.publicUrl}/billing/return`,
        metadata: { ...tagged({ workspace_id: workspaceId, kind: 'card' }), cancel_action: `${config.publicUrl}/billing` } } });
    return d.authorization_url;
}

/** Paystack's own page to change the card of a Paystack subscription from before. */
export async function manageLink(workspaceId: number): Promise<string> {
    const w = await ws(workspaceId);
    if (!w.subscription_code) throw new DeployError('There is no subscription yet.', 409);
    return (await paystack<{ link: string }>(`/subscription/${encodeURIComponent(w.subscription_code)}/manage/link`)).link;
}

// ---------------------------------------------------------------------------------------------- webhook
export function verifyPaystackSignature(body: string, header: string | undefined): boolean {
    if (!config.paystackSecret || !header || !/^[0-9a-f]{128}$/.test(header)) return false;
    const want = createHmac('sha512', config.paystackSecret).update(body).digest();
    return timingSafeEqual(want, Buffer.from(header, 'hex'));
}

interface PaystackEvent { event: string; data: Record<string, any> }   // eslint-disable-line @typescript-eslint/no-explicit-any

/** Apply one webhook event (signature already checked). Returns false when it was seen before. */
export async function handlePaystackEvent(e: PaystackEvent): Promise<boolean> {
    const d = e.data ?? {};
    const id = `${e.event}:${d.id ?? d.subscription_code ?? d.reference ?? d.invoice_code ?? JSON.stringify(d).length}`;
    return asSystem(async () => {
        const customer = d.customer?.customer_code ?? null;
        const meta = metaOf(d as PaystackTx);
        let wsId: number | null = null;
        if (foreign(meta)) {
            // started by another console sharing this Paystack account: recorded, never applied here
        } else if (meta.workspace_id) {
            wsId = ours(meta)
                ? Number(meta.workspace_id) || null
                // from before payments were tagged: trust the workspace id only when the Paystack customer is that workspace's too
                : customer ? (await db().query<{ id: number }>('SELECT id FROM workspaces WHERE id = $1 AND paystack_customer = $2', [Number(meta.workspace_id) || 0, customer])).rows[0]?.id ?? null : null;
        } else {
            // no workspace in the metadata: Paystack subscription events from before the console ran renewals itself
            if (customer) wsId = (await db().query<{ id: number }>('SELECT id FROM workspaces WHERE paystack_customer = $1', [customer])).rows[0]?.id ?? null;
            if (!wsId && d.subscription_code) wsId = (await db().query<{ id: number }>('SELECT id FROM workspaces WHERE subscription_code = $1', [d.subscription_code])).rows[0]?.id ?? null;
        }
        const { rowCount } = await db().query(`INSERT INTO billing_events (id, workspace_id, event, summary) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
            [id, wsId, e.event, JSON.stringify({ status: d.status, reference: d.reference, plan: d.plan?.plan_code ?? d.plan, amount: d.amount })]);
        if (!rowCount) return false;
        if (!wsId) return true;
        const plan = (Object.keys(PLANS) as PlanId[]).find((p) => d.plan?.amount === PLANS[p].amount || d.amount === PLANS[p].amount);
        switch (e.event) {
            case 'charge.success':
                if (d.status !== 'success' || d.currency !== 'ZAR') break;
                if (metaOf(d as PaystackTx).kind) {   // started by the console (checkout, renewal, plan switch, card check)
                    await applyPayment(wsId, d as PaystackTx).catch((err) => console.error('payment from webhook not applied:', (err as Error).message));
                } else if (plan && (await db().query('SELECT 1 FROM workspaces WHERE id = $1 AND subscription_code IS NOT NULL', [wsId])).rows.length) {
                    // a renewal of an Ops Console Paystack subscription from before; other products on a shared Paystack
                    // account (same customer, same price) never had one with this workspace, so they don't count
                    await activate(wsId, plan, customer, d.customer?.email ?? null);
                    await recordInvoice(wsId, d as PaystackTx);
                }
                break;
            case 'subscription.create':
                await db().query(`UPDATE workspaces SET subscription_code = $2, subscription_token = $3, paystack_customer = coalesce($4, paystack_customer),
                                  current_period_end = coalesce($5::timestamptz, current_period_end), billing_status = 'active' WHERE id = $1`,
                    [wsId, d.subscription_code, d.email_token, customer, d.next_payment_date ?? null]);
                break;
            case 'invoice.payment_failed':
                await db().query(`UPDATE workspaces SET billing_status = 'past_due', grace_until = coalesce(grace_until, now() + make_interval(days => $2)) WHERE id = $1`, [wsId, GRACE_DAYS]);
                break;
            case 'subscription.not_renew':
                await db().query(`UPDATE workspaces SET billing_status = 'cancelling', current_period_end = coalesce($2::timestamptz, current_period_end) WHERE id = $1`, [wsId, d.next_payment_date ?? null]);
                break;
            case 'subscription.disable':
                await db().query(`UPDATE workspaces SET billing_status = 'cancelled' WHERE id = $1`, [wsId]);
                break;
            default: break;
        }
        return true;
    });
}

// ---------------------------------------------------------------------------------------------- invoices
export interface InvoiceRow {
    id: number; workspace_id: number; number: string; reference: string; issued_at: string; plan: string; description: string;
    amount: number; currency: string; period_start: string | null; period_end: string | null; billed_to: string; billed_email: string | null;
    card: string | null; status: string; credit_applied: number;
}
export const invoiceView = (i: InvoiceRow) => ({
    id: i.id, number: i.number, reference: i.reference, issuedAt: i.issued_at, plan: i.plan, description: i.description, amount: i.amount / 100,
    currency: i.currency, periodStart: i.period_start, periodEnd: i.period_end, billedTo: i.billed_to, billedEmail: i.billed_email, card: i.card, status: i.status,
    creditApplied: (i.credit_applied ?? 0) / 100,
});

/** One invoice per period started (idempotent on the reference). Returns false when it already existed. */
async function writeInvoice(workspaceId: number, plan: PlanId, reference: string, paid: number, credit: number, from: Date, end: Date, t: PaystackTx | null): Promise<boolean> {
    return asSystem(async () => {
        const { rows: [w] } = await db().query<{ name: string; billing_email: string | null; card_label: string | null }>('SELECT name, billing_email, card_label FROM workspaces WHERE id = $1', [workspaceId]);
        const card = cardLabel(t?.authorization) ?? (paid > 0 ? w?.card_label ?? null : null);
        const { rowCount } = await db().query(
            `INSERT INTO invoices (workspace_id, number, reference, issued_at, plan, description, amount, currency, period_start, period_end, billed_to, billed_email, card, credit_applied)
             VALUES ($1, 'INV-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('invoice_number_seq')::text, 5, '0'), $2, now(), $3, $4, $5, 'ZAR', $6, $7, $8, $9, $10, $11)
             ON CONFLICT (reference) DO NOTHING`,
            [workspaceId, reference, plan, `${config.productName} ${PLANS[plan].name} plan, monthly`, paid, from.toISOString().slice(0, 10), end.toISOString().slice(0, 10),
                w?.name ?? 'Workspace', t?.customer?.email ?? w?.billing_email ?? null, card, credit]);
        return (rowCount ?? 0) > 0;
    });
}

/** One invoice per successful payment of a Paystack subscription from before (idempotent on the Paystack reference). */
export async function recordInvoice(workspaceId: number, t: PaystackTx): Promise<void> {
    if (t.status !== 'success' || !t.reference) return;
    const plan = (Object.keys(PLANS) as PlanId[]).find((p) => PLANS[p].amount === t.amount) ?? (metaOf(t).plan as PlanId | undefined);
    if (!plan || !PLANS[plan]) return;
    await asSystem(async () => {
        if ((await db().query('SELECT 1 FROM invoices WHERE reference = $1', [t.reference])).rows.length) return;
        const { rows: [w] } = await db().query<{ name: string; billing_email: string | null }>('SELECT name, billing_email FROM workspaces WHERE id = $1', [workspaceId]);
        const issued = new Date(t.paid_at ?? t.created_at ?? Date.now());
        const end = new Date(issued); end.setMonth(end.getMonth() + 1);
        const a = t.authorization;
        const card = a?.last4 ? `${(a.brand ?? a.card_type ?? 'Card').replace(/^./, (x) => x.toUpperCase())} •••• ${a.last4}` : null;
        await db().query(
            `INSERT INTO invoices (workspace_id, number, reference, issued_at, plan, description, amount, currency, period_start, period_end, billed_to, billed_email, card)
             VALUES ($1, 'INV-' || to_char($2::timestamptz, 'YYYY') || '-' || lpad(nextval('invoice_number_seq')::text, 5, '0'), $3, $2, $4, $5, $6, $7, $8, $9, $10, $11, $12)
             ON CONFLICT (reference) DO NOTHING`,
            [workspaceId, issued.toISOString(), t.reference, plan, `${config.productName} ${PLANS[plan].name} plan, monthly`, t.amount, t.currency || 'ZAR',
                issued.toISOString().slice(0, 10), end.toISOString().slice(0, 10), w?.name ?? 'Workspace', t.customer?.email ?? w?.billing_email ?? null, card]);
    });
}

/** Pick up payments the webhook may have missed (renewals included), from Paystack itself. Best effort. */
export async function syncInvoices(workspaceId: number): Promise<void> {
    if (!billingEnabled()) return;
    const w = await ws(workspaceId);
    if (!w.paystack_customer) return;
    const cust = await paystack<{ id: number }>(`/customer/${encodeURIComponent(w.paystack_customer)}`).catch(() => null);
    if (!cust?.id) return;
    const txs = await paystack<PaystackTx[]>(`/transaction?customer=${cust.id}&status=success&perPage=100`).catch(() => [] as PaystackTx[]);
    for (const t of txs) {
        const meta = metaOf(t);
        // only this console's payments for this workspace: the same person (one Paystack customer) can pay for other
        // workspaces, and other consoles sharing the Paystack account number their workspaces from 1 too
        if (!ours(meta) || Number(meta.workspace_id) !== workspaceId) continue;
        await recordInvoice(workspaceId, t);
    }
}

export async function listInvoices(months?: number): Promise<InvoiceRow[]> {
    const { rows } = await db().query<InvoiceRow>(
        `SELECT * FROM invoices ${months ? 'WHERE issued_at > now() - make_interval(months => $1)' : ''} ORDER BY issued_at DESC`, months ? [months] : []);
    return rows;
}

/** One invoice as a PDF page (A4). Seller details come from INVOICE_SELLER (lines separated by "|"). */
function invoicePage(i: InvoiceRow): PdfOp[] {
    const money = (cents: number) => `R${(cents / 100).toFixed(2)}`;
    const d = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' }) : '');
    const ops: PdfOp[] = [];
    const T = (x: number, y: number, text: string, o: Partial<Extract<PdfOp, { t: 'text' }>> = {}) => ops.push({ t: 'text', x, y, text, ...o });
    T(50, 780, config.productName, { size: 20, bold: true });
    T(545, 782, 'INVOICE', { size: 14, bold: true, align: 'right' });
    T(545, 764, i.status === 'paid' ? 'PAID' : i.status.toUpperCase(), { size: 9, bold: true, gray: 0.35, align: 'right' });
    (config.invoiceSeller ? config.invoiceSeller.split('|') : []).forEach((l, n) => T(50, 760 - n * 13, l.trim(), { size: 9, gray: 0.35 }));
    ops.push({ t: 'line', x1: 50, y1: 700, x2: 545, y2: 700 });
    T(50, 676, 'Invoice number', { size: 8, gray: 0.45 }); T(50, 662, i.number, { size: 11, bold: true });
    T(220, 676, 'Date', { size: 8, gray: 0.45 }); T(220, 662, d(i.issued_at), { size: 11 });
    T(380, 676, 'Billed to', { size: 8, gray: 0.45 }); T(380, 662, i.billed_to, { size: 11, bold: true });
    if (i.billed_email) T(380, 648, i.billed_email, { size: 9, gray: 0.35 });
    ops.push({ t: 'line', x1: 50, y1: 610, x2: 545, y2: 610 });
    T(50, 596, 'Description', { size: 8, gray: 0.45 }); T(330, 596, 'Period', { size: 8, gray: 0.45 }); T(545, 596, 'Amount', { size: 8, gray: 0.45, align: 'right' });
    ops.push({ t: 'line', x1: 50, y1: 588, x2: 545, y2: 588, gray: 0.9 });
    T(50, 570, i.description, { size: 10 });
    T(330, 570, `${d(i.period_start)} \u2013 ${d(i.period_end)}`, { size: 9, gray: 0.3 });
    const credit = i.credit_applied ?? 0;
    T(545, 570, money(i.amount + credit), { size: 10, align: 'right' });
    let y = 556;
    if (credit > 0) { T(330, 548, 'Account credit applied', { size: 9, gray: 0.3 }); T(545, 548, `-${money(credit)}`, { size: 10, align: 'right' }); y = 534; }
    ops.push({ t: 'line', x1: 50, y1: y, x2: 545, y2: y, gray: 0.9 });
    T(400, y - 22, 'Total', { size: 10, bold: true }); T(545, y - 22, `${money(i.amount)} ${i.currency}`, { size: 12, bold: true, align: 'right' });
    T(400, y - 38, 'Paid', { size: 9, gray: 0.35 }); T(545, y - 38, money(i.amount), { size: 9, gray: 0.35, align: 'right' });
    T(50, 470, i.amount > 0 ? `Paid${i.card ? ` with ${i.card}` : ''} through Paystack. Payment reference: ${i.reference}.` : `Covered by account credit. Reference: ${i.reference}.`, { size: 9, gray: 0.35 });
    T(50, 456, 'Amounts in South African Rand. Thank you for your business.', { size: 9, gray: 0.35 });
    return ops;
}

export function invoicesPdf(invoices: InvoiceRow[]): Buffer {
    return makePdf(invoices.map(invoicePage), invoices.length === 1 ? `Invoice ${invoices[0].number}` : `${config.productName} invoices`);
}

export function invoicesCsv(invoices: InvoiceRow[]): string {
    const q = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const head = ['Invoice', 'Date', 'Description', 'Period start', 'Period end', 'Amount', 'Credit applied', 'Currency', 'Status', 'Billed to', 'Email', 'Card', 'Reference'];
    const rows = invoices.map((i) => [i.number, new Date(i.issued_at).toISOString().slice(0, 10), i.description, i.period_start, i.period_end,
        (i.amount / 100).toFixed(2), ((i.credit_applied ?? 0) / 100).toFixed(2), i.currency, i.status, i.billed_to, i.billed_email, i.card, i.reference]);
    return [head, ...rows].map((r) => r.map(q).join(',')).join('\r\n') + '\r\n';
}
