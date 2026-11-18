import { cleanEmail, sendVerification } from './accounts';
import { audit } from './audit';
import { PLANS, standing, WorkspaceBilling } from './billing';
import { config } from './config';
import { asSystem, db, withWorkspace } from './db';
import { DeployError } from './deploys';
import { SessionUser } from './sessions';

/**
 * Platform owner portal (multi-customer mode): the people who run the platform see every workspace and can act on
 * customer accounts. A platform admin is listed in PLATFORM_ADMINS, or is an admin of a workspace on the 'internal'
 * plan (the platform's own). Everything here reads across workspaces (asSystem), so every route checks this first,
 * and every action is recorded in the customer's audit log and in the platform's own.
 */
export async function isPlatformAdmin(u: SessionUser | null | undefined): Promise<boolean> {
    if (!config.multiTenant || !u || u.isDemo) return false;
    if (u.email && config.platformAdmins.includes(u.email.toLowerCase())) return true;
    const { rows } = await asSystem(() => db().query(
        `SELECT 1 FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = $1 AND m.role = 'admin' AND w.plan = 'internal' LIMIT 1`, [u.id]));
    return rows.length > 0;
}

type Row = WorkspaceBilling & {
    slug: string; created_at: string; has_sub: boolean; members: number; servers: number; apps: number; servers_down: number;
    open_alerts: number; last_activity: string | null; owner_email: string | null; owner_name: string | null; aws: string | null;
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
SELECT w.*, w.subscription_code IS NOT NULL AS has_sub,
  (SELECT count(*) FROM workspace_members m WHERE m.workspace_id = w.id)::int AS members,
  (SELECT count(*) FROM instances i WHERE i.workspace_id = w.id)::int AS servers,
  (SELECT coalesce(sum(jsonb_array_length(coalesce(i.last_status->'apps', '[]'::jsonb))), 0) FROM instances i WHERE i.workspace_id = w.id)::int AS apps,
  (SELECT count(*) FROM instances i WHERE i.workspace_id = w.id AND (i.last_error IS NOT NULL OR coalesce(i.ec2_state, 'running') <> 'running'))::int AS servers_down,
  (SELECT count(*) FROM alerts a WHERE a.workspace_id = w.id AND a.resolved_at IS NULL AND a.acked_at IS NULL)::int AS open_alerts,
  (SELECT max(l.at) FROM audit_log l WHERE l.workspace_id = w.id) AS last_activity,
  coalesce(o.email, (SELECT u.email FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = w.id AND m.role = 'admin' ORDER BY m.created_at LIMIT 1)) AS owner_email,
  coalesce(o.display_name, o.username) AS owner_name,
  (SELECT c.status FROM aws_connections c WHERE c.workspace_id = w.id) AS aws
FROM workspaces w LEFT JOIN users o ON o.id = w.created_by`;

const view = (r: Row) => {
    const s = statusOf(r);
    const price = r.plan === 'starter' || r.plan === 'pro' ? PLANS[r.plan].amount / 100 : 0;
    return {
        id: r.id, name: r.name, slug: r.slug, plan: r.plan, status: s.status, active: s.active, createdAt: r.created_at,
        trialEndsAt: r.trial_ends_at, currentPeriodEnd: r.current_period_end, billingEmail: r.billing_email, hasSubscription: r.has_sub,
        suspendedAt: r.suspended_at ?? null, suspendedReason: r.suspended_reason ?? null, complimentary: !!r.complimentary, compUntil: r.comp_until ?? null,
        monthly: s.status === 'paying' || s.status === 'payment failed' || s.status === 'cancelling' ? price : 0,
        members: r.members, servers: r.servers, apps: r.apps, serversDown: r.servers_down, openAlerts: r.open_alerts,
        lastActivity: r.last_activity, owner: { email: r.owner_email, name: r.owner_name }, aws: r.aws,
    };
};

export async function listWorkspaces() {
    const { rows } = await asSystem(() => db().query<Row>(`${LIST_SQL} ORDER BY w.created_at DESC`));
    return rows.map(view);
}

export async function overview() {
    const list = await listWorkspaces();
    const customers = list.filter((w) => w.plan !== 'internal');
    const count = (s: string) => customers.filter((w) => w.status === s).length;
    const { rows: [n] } = await asSystem(() => db().query<{ signups: number; users: number }>(
        `SELECT (SELECT count(*) FROM workspaces WHERE plan <> 'internal' AND created_at > now() - interval '30 days')::int AS signups,
                (SELECT count(*) FROM users WHERE NOT is_demo)::int AS users`));
    return {
        workspaces: customers.length, signups30d: n.signups, users: n.users,
        byStatus: { trial: count('trial'), paying: count('paying'), complimentary: count('complimentary'), paymentFailed: count('payment failed'),
            ended: count('ended') + count('trial ended') + count('cancelled') + count('no plan'), cancelling: count('cancelling'), suspended: count('suspended') },
        mrr: customers.reduce((a, w) => a + w.monthly, 0), currency: 'ZAR',
        servers: list.reduce((a, w) => a + w.servers, 0), serversDown: list.reduce((a, w) => a + w.serversDown, 0),
        apps: list.reduce((a, w) => a + w.apps, 0), openAlerts: list.reduce((a, w) => a + w.openAlerts, 0),
    };
}

export async function workspaceDetail(id: number) {
    const { rows: [r] } = await asSystem(() => db().query<Row>(`${LIST_SQL} WHERE w.id = $1`, [id]));
    if (!r) throw new DeployError('Workspace not found.', 404);
    return asSystem(async () => {
        const members = (await db().query(
            `SELECT u.id, u.username, u.display_name AS name, u.email, u.email_verified_at IS NOT NULL AS verified, m.role, u.last_login_at AS "lastLogin", u.disabled
               FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 ORDER BY m.role, u.username`, [id])).rows;
        const servers = (await db().query<{ id: number; name: string; region: string; ec2_state: string | null; last_ok_at: string | null; last_error: string | null; apps: { project: string; healthy: boolean }[] | null }>(
            `SELECT id, name, region, ec2_state, last_ok_at, last_error, last_status->'apps' AS apps FROM instances WHERE workspace_id = $1 ORDER BY lower(name)`, [id])).rows
            .map((s) => ({ id: s.id, name: s.name, region: s.region, state: s.ec2_state ?? 'running', lastOkAt: s.last_ok_at, error: s.last_error,
                apps: (s.apps ?? []).map((a) => ({ project: a.project, healthy: !!a.healthy })) }));
        const conn = (await db().query(`SELECT status, account_id AS "accountId", region FROM aws_connections WHERE workspace_id = $1`, [id])).rows[0] ?? null;
        const github = (await db().query(`SELECT slug, owner FROM github_apps WHERE workspace_id = $1`, [id])).rows[0] ?? null;
        const invoices = (await db().query<{ n: number; total: number }>(`SELECT count(*)::int AS n, coalesce(sum(amount), 0)::int AS total FROM invoices WHERE workspace_id = $1`, [id])).rows[0];
        const activity = (await db().query(`SELECT at, username, action, target FROM audit_log WHERE workspace_id = $1 ORDER BY at DESC LIMIT 25`, [id])).rows;
        return { workspace: view(r), members, servers, aws: conn, github, invoices: { count: invoices.n, total: invoices.total / 100 }, activity };
    });
}

/** Cross-customer health: servers down, failed deploys (last 7 days, not fixed since), failing backups, critical alerts. */
export async function health() {
    return asSystem(async () => {
        const servers = (await db().query(
            `SELECT i.id, i.name, i.region, coalesce(i.ec2_state, 'running') AS state, i.last_ok_at AS "lastOkAt", i.last_error AS error, w.id AS "workspaceId", w.name AS workspace
               FROM instances i JOIN workspaces w ON w.id = i.workspace_id
              WHERE i.last_error IS NOT NULL OR coalesce(i.ec2_state, 'running') <> 'running' ORDER BY w.name, i.name`)).rows;
        const deploys = (await db().query(
            `SELECT d.id, d.project, d.action, d.finished_at AS at, i.name AS server, w.id AS "workspaceId", w.name AS workspace
               FROM deployments d JOIN instances i ON i.id = d.instance_id JOIN workspaces w ON w.id = d.workspace_id
              WHERE d.status = 'failed' AND d.created_at > now() - interval '7 days'
                AND NOT EXISTS (SELECT 1 FROM deployments s WHERE s.instance_id = d.instance_id AND s.project = d.project AND s.status = 'success' AND s.created_at > d.created_at)
              ORDER BY d.created_at DESC LIMIT 50`)).rows;
        const backups = (await db().query(
            `SELECT i.id, i.name, w.id AS "workspaceId", w.name AS workspace, i.last_status->'backups'->>'at' AS at
               FROM instances i JOIN workspaces w ON w.id = i.workspace_id WHERE (i.last_status->'backups'->>'ok') = 'false' ORDER BY w.name`)).rows;
        const alerts = (await db().query(
            `SELECT a.id, a.title, a.opened_at AS "openedAt", w.id AS "workspaceId", w.name AS workspace
               FROM alerts a JOIN workspaces w ON w.id = a.workspace_id WHERE a.resolved_at IS NULL AND a.acked_at IS NULL AND a.severity = 'critical'
              ORDER BY a.opened_at DESC LIMIT 50`)).rows;
        return { servers, deploys, backups, alerts };
    });
}

// ------------------------------------------------------------------ actions on customer accounts
export interface PlatformActor { id: number; username: string; workspaceId: number | null; ip: string | null }
/** The platform's own workspace (plan 'internal'), where its record of admin actions is kept. */
async function platformWorkspace(): Promise<number | null> {
    const { rows } = await asSystem(() => db().query<{ id: number }>("SELECT id FROM workspaces WHERE plan = 'internal' ORDER BY id LIMIT 1"));
    return rows[0]?.id ?? null;
}
/** Recorded twice: in the customer's audit log (they see what the platform did) and in the platform's own. */
async function record(actor: PlatformActor, workspaceId: number, action: string, target: string, detail: Record<string, unknown>) {
    const who = { id: null, username: `platform:${actor.username}` };
    await withWorkspace(workspaceId, () => audit(who, action, target, detail, null));
    const own = await platformWorkspace();
    if (own != null && own !== workspaceId) {
        await withWorkspace(own, () => audit({ id: actor.id, username: actor.username }, action, target, { workspaceId, ...detail }, actor.ip));
    }
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
export async function extendTrial(id: number, days: number, actor: PlatformActor) {
    const w = await customer(id);
    if (w.plan !== 'trial') throw new DeployError('Only workspaces on a trial can have it extended.', 409);
    if (!Number.isInteger(days) || days < 1 || days > 90) throw new DeployError('Extend by 1 to 90 days.');
    const { rows: [r] } = await asSystem(() => db().query<{ trial_ends_at: string }>(
        `UPDATE workspaces SET trial_ends_at = greatest(now(), coalesce(trial_ends_at, now())) + make_interval(days => $2) WHERE id = $1 RETURNING trial_ends_at`, [id, days]));
    await record(actor, id, 'platform.trial', w.name, { days, until: r.trial_ends_at });
    return r.trial_ends_at;
}
/** Give a plan without payment (until a date, or open-ended), or take it back (plan = null). */
export async function setComplimentary(id: number, plan: 'starter' | 'pro' | null, until: string | null, actor: PlatformActor) {
    const w = await customer(id);
    const paying = !!w.subscription_code && ['active', 'past_due', 'cancelling'].includes(w.billing_status) && !w.complimentary;
    if (plan && paying) throw new DeployError('This workspace pays for a subscription: it has to be cancelled first (Billing).', 409);
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
        // back to "choose a plan" (read-only until they subscribe), unless they pay for one
        await asSystem(() => db().query(
            `UPDATE workspaces SET complimentary = false, comp_until = NULL, billing_status = CASE WHEN subscription_code IS NOT NULL THEN billing_status ELSE 'expired' END WHERE id = $1`, [id]));
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
        `SELECT at, username, action, target, detail FROM audit_log WHERE action LIKE 'platform.%' ORDER BY at DESC LIMIT 100`));
    return rows;
}
