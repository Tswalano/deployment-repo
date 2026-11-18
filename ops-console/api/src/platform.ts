import { cleanEmail, sendVerification } from './accounts';
import { audit } from './audit';
import { addCredit, effectiveLimits, LimitOverrides, PLANS, renew, standing, WorkspaceBilling } from './billing';
import { config } from './config';
import { asSystem, db, withWorkspace } from './db';
import { DeployError } from './deploys';
import { SessionUser } from './sessions';

/**
 * Platform owner portal (multi-customer mode): the business side of the platform. Who is on which plan, who pays,
 * failed payments, credits and extensions, usage against limits (and limits above the plan), suspensions, and the
 * health of the console itself (consolehealth.ts). Customers' servers are theirs: not shown here.
 * Access is an explicit flag on the user (users.platform_admin) or PLATFORM_ADMINS; every route checks it first.
 */
export async function isPlatformAdmin(u: SessionUser | null | undefined): Promise<boolean> {
    if (!config.multiTenant || !u || u.isDemo) return false;
    if (u.email && config.platformAdmins.includes(u.email.toLowerCase())) return true;
    const { rows } = await asSystem(() => db().query('SELECT 1 FROM users WHERE id = $1 AND platform_admin AND NOT disabled', [u.id]));
    return rows.length > 0;
}

type Row = WorkspaceBilling & {
    slug: string; created_at: string; members: number; servers: number; apps: number; credit: string;
    last_activity: string | null; owner_email: string | null; owner_name: string | null; aws: string | null;
};

/** One word for where a workspace stands (for the platform owner, not the customer). */
export function statusOf(w: WorkspaceBilling, now = Date.now()): { status: string; active: boolean } {
    const s = standing(w, now);
    if (w.plan === 'internal') return { status: 'platform', active: true };
    if (w.suspended_at) return { status: 'suspended', active: false };
    if (w.complimentary && w.plan !== 'trial' && (!w.comp_until || Date.parse(w.comp_until) > now)) return { status: 'complimentary', active: true };
    if (w.plan === 'trial') return { status: s.active ? 'trial' : 'trial ended', active: s.active };
    const map: Record<string, string> = { active: 'paying', past_due: 'payment failed', cancelling: 'cancelling', cancelled: 'cancelled', expired: 'ended', trialing: 'no plan' };
    return { status: s.active ? (map[w.billing_status] ?? w.billing_status) : (w.billing_status === 'past_due' ? 'payment failed' : 'ended'), active: s.active };
}

const LIST_SQL = `
SELECT w.*,
  (SELECT count(*) FROM workspace_members m WHERE m.workspace_id = w.id)::int AS members,
  (SELECT count(*) FROM instances i WHERE i.workspace_id = w.id)::int AS servers,
  (SELECT coalesce(sum(jsonb_array_length(coalesce(i.last_status->'apps', '[]'::jsonb))), 0) FROM instances i WHERE i.workspace_id = w.id)::int AS apps,
  (SELECT coalesce(sum(c.amount), 0) FROM billing_credits c WHERE c.workspace_id = w.id)::text AS credit,
  (SELECT max(l.at) FROM audit_log l WHERE l.workspace_id = w.id) AS last_activity,
  coalesce(o.email, (SELECT u.email FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = w.id AND m.role = 'admin' ORDER BY m.created_at LIMIT 1)) AS owner_email,
  coalesce(o.display_name, o.username) AS owner_name,
  (SELECT c.status FROM aws_connections c WHERE c.workspace_id = w.id) AS aws
FROM workspaces w LEFT JOIN users o ON o.id = w.created_by`;

const NEAR = 0.8;
const view = (r: Row) => {
    const s = statusOf(r);
    const lim = effectiveLimits(r);
    const planPrice = r.plan === 'starter' || r.plan === 'pro' ? PLANS[r.plan].amount / 100 : 0;
    const use = (used: number, max: number) => ({ used, max: Number.isFinite(max) ? max : null, near: Number.isFinite(max) && max > 0 && used / max >= NEAR, over: Number.isFinite(max) && used > max });
    const usage = { servers: use(r.servers, lim.servers), apps: use(r.apps, lim.apps), members: use(r.members, lim.members) };
    const billed = ['paying', 'payment failed', 'cancelling'].includes(s.status);
    return {
        id: r.id, name: r.name, slug: r.slug, plan: r.plan, status: s.status, active: s.active, createdAt: r.created_at,
        trialEndsAt: r.trial_ends_at, currentPeriodEnd: r.current_period_end, graceUntil: r.grace_until, billingEmail: r.billing_email,
        card: r.card_label ?? null, legacySubscription: !!r.subscription_code, lastChargeError: r.last_charge_error ?? null, lastChargeAt: r.last_charge_at ?? null,
        suspendedAt: r.suspended_at ?? null, suspendedReason: r.suspended_reason ?? null, complimentary: !!r.complimentary, compUntil: r.comp_until ?? null,
        monthly: billed ? planPrice : 0, amountDue: s.status === 'payment failed' ? planPrice : 0, credit: Number(r.credit) / 100,
        usage, nearLimit: Object.values(usage).some((u) => u.near), limitOverrides: r.limit_overrides ?? null,
        lastActivity: r.last_activity, owner: { email: r.owner_email, name: r.owner_name }, aws: r.aws,
    };
};

export async function listWorkspaces() {
    const { rows } = await asSystem(() => db().query<Row>(`${LIST_SQL} WHERE w.plan <> 'internal' ORDER BY w.created_at DESC`));
    return rows.map(view);
}

export async function overview() {
    const list = await listWorkspaces();
    const count = (s: string) => list.filter((w) => w.status === s).length;
    const { rows: [n] } = await asSystem(() => db().query<{ signups: number }>(
        `SELECT count(*)::int AS signups FROM workspaces WHERE plan <> 'internal' AND created_at > now() - interval '30 days'`));
    return {
        customers: list.length, signups30d: n.signups,
        byStatus: { trial: count('trial'), paying: count('paying'), complimentary: count('complimentary'), paymentFailed: count('payment failed'),
            cancelling: count('cancelling'), ended: count('ended') + count('trial ended') + count('cancelled') + count('no plan'), suspended: count('suspended') },
        byPlan: { starter: list.filter((w) => w.plan === 'starter').length, pro: list.filter((w) => w.plan === 'pro').length, trial: list.filter((w) => w.plan === 'trial').length },
        mrr: list.reduce((a, w) => a + w.monthly, 0), amountDue: list.reduce((a, w) => a + w.amountDue, 0), currency: 'ZAR',
        nearLimit: list.filter((w) => w.nearLimit).length, creditOutstanding: Math.round(list.reduce((a, w) => a + Math.max(0, w.credit), 0) * 100) / 100,
    };
}

export async function workspaceDetail(id: number) {
    const { rows: [r] } = await asSystem(() => db().query<Row>(`${LIST_SQL} WHERE w.id = $1`, [id]));
    if (!r) throw new DeployError('Workspace not found.', 404);
    return asSystem(async () => {
        const members = (await db().query(
            `SELECT u.id, u.username, u.display_name AS name, u.email, u.email_verified_at IS NOT NULL AS verified, m.role, u.last_login_at AS "lastLogin", u.disabled
               FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 ORDER BY m.role, u.username`, [id])).rows;
        const credits = (await db().query(
            `SELECT amount::float / 100 AS amount, kind, note, created_by AS "by", created_at AS at FROM billing_credits WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 50`, [id])).rows;
        const invoices = (await db().query(
            `SELECT number, issued_at AS "issuedAt", plan, amount::float / 100 AS amount, credit_applied::float / 100 AS credit, period_start AS "periodStart", period_end AS "periodEnd", status
               FROM invoices WHERE workspace_id = $1 ORDER BY issued_at DESC LIMIT 24`, [id])).rows;
        const events = (await db().query(`SELECT event, summary, at FROM billing_events WHERE workspace_id = $1 ORDER BY at DESC LIMIT 20`, [id])).rows;
        return { workspace: view(r), members, credits, invoices, events };
    });
}

// ------------------------------------------------------------------ actions on customer accounts
export interface PlatformActor { id: number; username: string; ip: string | null }
async function platformWorkspace(): Promise<number | null> {
    const { rows } = await asSystem(() => db().query<{ id: number }>("SELECT id FROM workspaces WHERE plan = 'internal' ORDER BY id LIMIT 1"));
    return rows[0]?.id ?? null;
}
/** Recorded twice: in the customer's audit log (they see what the platform did) and in the platform's own. */
async function record(actor: PlatformActor, workspaceId: number, action: string, target: string, detail: Record<string, unknown>) {
    await withWorkspace(workspaceId, () => audit({ id: null, username: `platform:${actor.username}` }, action, target, detail, null));
    const own = await platformWorkspace();
    if (own != null && own !== workspaceId) await withWorkspace(own, () => audit({ id: actor.id, username: actor.username }, action, target, { workspaceId, ...detail }, actor.ip));
}
async function customer(id: number): Promise<WorkspaceBilling & { name: string }> {
    const { rows: [w] } = await asSystem(() => db().query<WorkspaceBilling>('SELECT * FROM workspaces WHERE id = $1', [id]));
    if (!w) throw new DeployError('Workspace not found.', 404);
    if (w.plan === 'internal') throw new DeployError("The platform's own workspace can't be changed here.", 409);
    return w;
}

export async function suspend(id: number, reason: string, actor: PlatformActor) {
    const w = await customer(id);
    const why = reason.trim().slice(0, 200);
    if (why.length < 5) throw new DeployError('Give a reason (it is shown to the customer).');
    await asSystem(() => db().query('UPDATE workspaces SET suspended_at = now(), suspended_reason = $2 WHERE id = $1', [id, why]));
    await record(actor, id, 'platform.suspend', w.name, { reason: why });
}
export async function reactivate(id: number, actor: PlatformActor) {
    const w = await customer(id);
    await asSystem(() => db().query('UPDATE workspaces SET suspended_at = NULL, suspended_reason = NULL WHERE id = $1', [id]));
    await record(actor, id, 'platform.reactivate', w.name, {});
}

/** Free time: a trial gets longer; a paid plan's next renewal moves out (a failed payment is forgiven when the new date is ahead). */
export async function extend(id: number, days: number, actor: PlatformActor): Promise<string> {
    const w = await customer(id);
    if (!Number.isInteger(days) || days < 1 || days > 365) throw new DeployError('Extend by 1 to 365 days.');
    if (w.complimentary) throw new DeployError('This workspace is on a complimentary plan: change its end date there instead.', 409);
    let until: string;
    if (w.plan === 'trial') {
        ({ rows: [{ until }] } = await asSystem(() => db().query<{ until: string }>(
            `UPDATE workspaces SET trial_ends_at = greatest(now(), coalesce(trial_ends_at, now())) + make_interval(days => $2) WHERE id = $1 RETURNING trial_ends_at AS until`, [id, days])));
    } else {
        if (w.subscription_code) throw new DeployError('This workspace still pays through a Paystack subscription from before, whose dates Paystack controls. Give credit instead: it is used at the next renewal once they move to the new billing (any plan change does that).', 409);
        if (!['active', 'past_due', 'cancelling'].includes(w.billing_status)) throw new DeployError('Only a trial or a running subscription can be extended. Give a complimentary plan instead.', 409);
        ({ rows: [{ until }] } = await asSystem(() => db().query<{ until: string }>(
            `UPDATE workspaces SET current_period_end = greatest(now(), coalesce(current_period_end, now())) + make_interval(days => $2),
                    billing_status = CASE WHEN billing_status = 'past_due' THEN 'active' ELSE billing_status END, grace_until = NULL, next_retry_at = NULL, last_charge_error = NULL
              WHERE id = $1 RETURNING current_period_end AS until`, [id, days])));
    }
    await record(actor, id, 'platform.extend', w.name, { days, until });
    return until;
}

/** Credit in Rand, used before the card at the next renewals (or taken back with a negative amount). */
export async function grantCredit(id: number, rand: number, note: string, actor: PlatformActor) {
    const w = await customer(id);
    const cents = Math.round(rand * 100);
    if (!Number.isFinite(rand) || cents === 0 || Math.abs(cents) > 1_000_000) throw new DeployError('Enter an amount between R0.01 and R10 000 (negative to take credit back).');
    const why = note.trim().slice(0, 200);
    if (why.length < 3) throw new DeployError('Add a note (why the credit is given).');
    await addCredit(id, cents, cents > 0 ? 'grant' : 'adjust', why, `platform:${actor.username}`);
    await record(actor, id, 'platform.credit', w.name, { amount: cents / 100, note: why });
}

/** Limits above the plan (only raise), optionally until a date; null clears them. */
export async function setLimits(id: number, o: LimitOverrides | null, actor: PlatformActor) {
    const w = await customer(id);
    let clean: LimitOverrides | null = null;
    if (o) {
        const n = (v: unknown, max: number) => (v === undefined || v === null || v === '' ? undefined : Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= max ? Number(v) : NaN);
        clean = { servers: n(o.servers, 100), apps: n(o.apps, 500), members: n(o.members, 500), approvals: o.approvals === true ? true : undefined, until: null };
        if ([clean.servers, clean.apps, clean.members].some((x) => Number.isNaN(x))) throw new DeployError('Limits must be whole numbers (servers up to 100, apps and members up to 500).');
        if (clean.servers === undefined && clean.apps === undefined && clean.members === undefined && !clean.approvals) throw new DeployError('Set at least one limit.');
        if (o.until) {
            const t = Date.parse(o.until);
            if (!Number.isFinite(t) || t < Date.now() + 86400e3) throw new DeployError('The end date must be after tomorrow.');
            clean.until = new Date(t).toISOString();
        }
    }
    await asSystem(() => db().query('UPDATE workspaces SET limit_overrides = $2 WHERE id = $1', [id, clean ? JSON.stringify(clean) : null]));
    await record(actor, id, clean ? 'platform.limits' : 'platform.limits_clear', w.name, clean ? { ...clean } : {});
}

/** Try a failed renewal again now (after the customer said they fixed their card, for example). */
export async function retryCharge(id: number, actor: PlatformActor): Promise<string> {
    const w = await customer(id);
    if (w.billing_status !== 'past_due') throw new DeployError('There is no failed payment to retry.', 409);
    const r = await renew(w);
    await record(actor, id, 'platform.retry', w.name, { result: r });
    return r;
}

/** Give a plan without payment (until a date, or open-ended), or take it back (plan = null). */
export async function setComplimentary(id: number, plan: 'starter' | 'pro' | null, until: string | null, actor: PlatformActor) {
    const w = await customer(id);
    const paying = !!(w.subscription_code || w.paystack_authorization) && ['active', 'past_due', 'cancelling'].includes(w.billing_status) && !w.complimentary;
    if (plan && paying) throw new DeployError('This workspace pays for a subscription: give credit or extend it instead (or cancel it first).', 409);
    if (plan !== null && plan !== 'starter' && plan !== 'pro') throw new DeployError('Choose Starter or Pro.');
    let untilIso: string | null = null;
    if (until) {
        const t = Date.parse(until);
        if (!Number.isFinite(t) || t < Date.now() + 86400e3 || t > Date.now() + 3 * 365 * 86400e3) throw new DeployError('The end date must be between tomorrow and three years from now.');
        untilIso = new Date(t).toISOString();
    }
    if (plan) {
        await asSystem(() => db().query(`UPDATE workspaces SET plan = $2, complimentary = true, comp_until = $3, billing_status = 'active' WHERE id = $1`, [id, plan, untilIso]));
    } else {
        if (!w.complimentary) throw new DeployError('This workspace has no complimentary plan.', 409);
        await asSystem(() => db().query(
            `UPDATE workspaces SET complimentary = false, comp_until = NULL, billing_status = CASE WHEN subscription_code IS NOT NULL OR paystack_authorization IS NOT NULL THEN billing_status ELSE 'expired' END WHERE id = $1`, [id]));
    }
    await record(actor, id, plan ? 'platform.complimentary' : 'platform.complimentary_end', w.name, { plan, until: untilIso });
}

/** Change a customer's sign-in email (they confirm the new address; their username keeps working). */
export async function changeEmail(userId: number, emailInput: string, actor: PlatformActor) {
    const email = cleanEmail(emailInput);
    const { rows: [u] } = await asSystem(() => db().query<{ id: number; username: string; email: string | null; is_demo: boolean }>('SELECT id, username, email, is_demo FROM users WHERE id = $1', [userId]));
    if (!u || u.is_demo) throw new DeployError('User not found.', 404);
    const taken = await asSystem(() => db().query('SELECT 1 FROM users WHERE (lower(email) = $1 OR lower(username) = $1) AND id <> $2', [email, userId]));
    if (taken.rows.length) throw new DeployError('Another account already uses that email.', 409);
    await asSystem(() => db().query('UPDATE users SET email = $2, email_verified_at = NULL WHERE id = $1', [userId, email]));
    await sendVerification(userId, email).catch((err) => console.error('verification email failed:', (err as Error).message));
    const { rows: wss } = await asSystem(() => db().query<{ workspace_id: number }>('SELECT workspace_id FROM workspace_members WHERE user_id = $1', [userId]));
    for (const m of wss) await record(actor, m.workspace_id, 'platform.email', u.username, { from: u.email, to: email });
}

/** The platform's own record of what its admins did to customer accounts. */
export async function platformAudit() {
    const own = await platformWorkspace();
    if (own == null) return [];
    const { rows } = await withWorkspace(own, () => db().query(
        `SELECT at, username, action, target, detail FROM audit_log WHERE action LIKE 'platform.%' ORDER BY at DESC LIMIT 200`));
    return rows;
}
