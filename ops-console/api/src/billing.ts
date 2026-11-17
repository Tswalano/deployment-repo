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
    if (w.plan === 'trial') {
        return t(w.trial_ends_at) > now ? { active: true, reason: null, limits: PLANS.pro.limits }
            : { active: false, reason: 'Your free trial has ended. Choose a plan to keep making changes.', limits: PLANS.pro.limits };
    }
    const limits = PLANS[w.plan].limits;
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

const planName = (id: PlanId) => `${config.productName} ${PLANS[id].name} (monthly)`;
/** The Paystack plan codes, created on first use (and found again by name later). */
export async function ensurePlans(): Promise<Record<PlanId, string>> {
    const { rows } = await asSystem(() => db().query<{ value: Record<PlanId, string> }>("SELECT value FROM platform_settings WHERE key = 'paystack_plans'"));
    if (rows[0]?.value?.starter && rows[0].value.pro) return rows[0].value;
    const existing = await paystack<{ name: string; plan_code: string; amount: number; interval: string; currency: string }[]>('/plan?perPage=100');
    const codes = {} as Record<PlanId, string>;
    for (const id of ['starter', 'pro'] as PlanId[]) {
        const found = existing.find((p) => p.name === planName(id) && p.amount === PLANS[id].amount && p.interval === 'monthly' && p.currency === 'ZAR');
        codes[id] = found ? found.plan_code
            : (await paystack<{ plan_code: string }>('/plan', { method: 'POST', body: { name: planName(id), interval: 'monthly', amount: PLANS[id].amount, currency: 'ZAR' } })).plan_code;
    }
    await asSystem(() => db().query(`INSERT INTO platform_settings (key, value) VALUES ('paystack_plans', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [JSON.stringify(codes)]));
    return codes;
}

/** Start a checkout on Paystack's hosted page. */
export async function checkout(workspaceId: number, plan: PlanId, email: string): Promise<{ url: string; reference: string }> {
    if (!PLANS[plan]) throw new DeployError('Choose a plan.');
    const w = await ws(workspaceId);
    if (w.plan === 'internal') throw new DeployError('This workspace is not billed.', 409);
    if (w.billing_status === 'active' && w.plan === plan) throw new DeployError(`You are already on ${PLANS[plan].name}.`, 409);
    const codes = await ensurePlans();
    const d = await paystack<{ authorization_url: string; reference: string }>('/transaction/initialize', {
        method: 'POST',
        body: { email, amount: PLANS[plan].amount, currency: 'ZAR', plan: codes[plan], callback_url: `${config.publicUrl}/billing/return`,
            metadata: { workspace_id: workspaceId, plan, cancel_action: `${config.publicUrl}/billing` } },
    });
    return { url: d.authorization_url, reference: d.reference };
}

interface PaystackTx { status: string; reference: string; amount: number; currency: string; metadata?: { workspace_id?: number | string; plan?: PlanId } | string;
    customer?: { id?: number; customer_code?: string; email?: string }; plan?: string | null; plan_object?: { plan_code?: string } }
const metaOf = (t: PaystackTx) => (typeof t.metadata === 'object' && t.metadata ? t.metadata : {});

/** After checkout: confirm the payment with Paystack itself (never trust the redirect) and switch the plan. */
export async function confirmCheckout(workspaceId: number, reference: string): Promise<WorkspaceBilling> {
    if (!/^[A-Za-z0-9_.=-]{6,100}$/.test(reference)) throw new DeployError('Invalid payment reference.');
    const t = await paystack<PaystackTx>(`/transaction/verify/${encodeURIComponent(reference)}`);
    const meta = metaOf(t);
    if (Number(meta.workspace_id) !== workspaceId) throw new DeployError('That payment belongs to another workspace.', 403);
    if (t.status !== 'success') throw new DeployError(`The payment was not completed (${t.status}).`, 409);
    if (!meta.plan || !PLANS[meta.plan] || t.amount !== PLANS[meta.plan].amount || t.currency !== 'ZAR') throw new DeployError('The payment does not match a plan.', 409);
    await activate(workspaceId, meta.plan, t.customer?.customer_code ?? null, t.customer?.email ?? null);
    // link the subscription now (Cancel / Update card need it) instead of waiting for the subscription.create webhook
    if (t.customer?.id) {
        const codes = await ensurePlans();
        const subs = await paystack<{ subscription_code: string; email_token: string; status: string; next_payment_date: string | null; plan?: { plan_code?: string } }[]>(
            `/subscription?customer=${t.customer.id}&perPage=50`).catch(() => []);
        const sub = subs.find((x) => x.plan?.plan_code === codes[meta.plan!] && ['active', 'non-renewing', 'attention'].includes(x.status));
        if (sub) {
            await asSystem(() => db().query(`UPDATE workspaces SET subscription_code = $2, subscription_token = $3, current_period_end = coalesce($4::timestamptz, current_period_end) WHERE id = $1`,
                [workspaceId, sub.subscription_code, sub.email_token, sub.next_payment_date]));
        }
    }
    return ws(workspaceId);
}

async function activate(workspaceId: number, plan: PlanId, customer: string | null, email: string | null) {
    await asSystem(() => db().query(
        `UPDATE workspaces SET plan = $2, billing_status = 'active', grace_until = NULL, paystack_customer = coalesce($3, paystack_customer),
                billing_email = coalesce($4, billing_email), current_period_end = greatest(coalesce(current_period_end, now()), now() + interval '1 month')
          WHERE id = $1`, [workspaceId, plan, customer, email]));
}

/** Cancel at the end of the paid period (Paystack stops renewing). */
export async function cancel(workspaceId: number): Promise<void> {
    const w = await ws(workspaceId);
    if (!w.subscription_code || !w.subscription_token) throw new DeployError('There is no subscription to cancel.', 409);
    await paystack('/subscription/disable', { method: 'POST', body: { code: w.subscription_code, token: w.subscription_token } });
    await db().query(`UPDATE workspaces SET billing_status = 'cancelling' WHERE id = $1`, [workspaceId]);
}

/** Paystack's own page to change the card. */
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
        let wsId: number | null = Number((typeof d.metadata === 'object' && d.metadata?.workspace_id) || 0) || null;
        if (!wsId && customer) wsId = (await db().query<{ id: number }>('SELECT id FROM workspaces WHERE paystack_customer = $1', [customer])).rows[0]?.id ?? null;
        if (!wsId && d.subscription_code) wsId = (await db().query<{ id: number }>('SELECT id FROM workspaces WHERE subscription_code = $1', [d.subscription_code])).rows[0]?.id ?? null;
        const { rowCount } = await db().query(`INSERT INTO billing_events (id, workspace_id, event, summary) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
            [id, wsId, e.event, JSON.stringify({ status: d.status, reference: d.reference, plan: d.plan?.plan_code ?? d.plan, amount: d.amount })]);
        if (!rowCount) return false;
        if (!wsId) return true;
        const plan = (Object.keys(PLANS) as PlanId[]).find((p) => d.plan?.amount === PLANS[p].amount || d.amount === PLANS[p].amount);
        switch (e.event) {
            case 'charge.success':
                if (d.status === 'success' && plan && d.currency === 'ZAR') await activate(wsId, plan, customer, d.customer?.email ?? null);
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
