import { Context, Hono } from 'hono';
import { checkLimit } from '../billing';
import { getCookie } from 'hono/cookie';
import { cleanEmail, suggestUsername, usernameTaken, USERNAME_RE, acceptInvite, createWorkspace, forgotPassword, invite, inviteInfo, myWorkspaces, removeMember, renameWorkspace, resetPassword,
    sendVerification, setMemberRole, signUp, team, verifyEmail } from '../accounts';
import { audit } from '../audit';
import { config } from '../config';
import { db, withWorkspace } from '../db';
import { DeployError } from '../deploys';
import { denyDemo, Env, rateLimit, requireRole } from '../middleware';
import { createSession, switchWorkspace } from '../sessions';
import { startSession } from './auth';

const fail = (c: Context<Env>, err: unknown) => {
    if (err instanceof DeployError) return c.json({ error: err.message, code: err.code }, err.status);
    throw err;
};
const ip = (c: Context<Env>) => c.get('ip') ?? 'unknown';
/** Signed in, workspace or not (listing, switching and creating workspaces must work without a current one). */
const signedIn = async (c: Context<Env>, next: () => Promise<void>) => (c.get('user') ? next() : c.json({ error: 'Not signed in' }, 401));
const multiOnly = async (c: Context<Env>, next: () => Promise<void>) => (config.multiTenant ? next() : c.json({ error: 'Not found' }, 404));

/** Public: sign-up, email verification, password reset, invitations. Mounted at /api/account. */
export const account = new Hono<Env>();

/** Live check for the sign-up form. */
account.get('/username-available', rateLimit(60, 60_000, (c) => `uname:${ip(c)}`), async (c) => {
    const u = String(c.req.query('u') ?? '').trim().toLowerCase();
    if (!USERNAME_RE.test(u)) return c.json({ available: false, reason: 'format' });
    return c.json({ available: !(await usernameTaken(u)) });
});
account.get('/username-suggestion', rateLimit(60, 60_000, (c) => `usugg:${ip(c)}`), async (c) => {
    try { return c.json({ username: await suggestUsername(cleanEmail(c.req.query('email'))) }); } catch { return c.json({ username: null }); }
});

account.get('/config', (c) => c.json({ multiTenant: config.multiTenant, productName: config.productName, trialDays: config.trialDays,
    legalEntity: config.legalEntity || config.productName, supportEmail: config.supportEmail || null }));

account.post('/signup', multiOnly, rateLimit(5, 60 * 60_000, (c) => `signup:${ip(c)}`), async (c) => {
    const b = await c.req.json().catch(() => ({}));
    try {
        const r = await signUp(b);
        const token = await createSession(r.user.id, config.sessionHours * 60, c.get('ip'), c.req.header('user-agent') ?? null, r.workspace.id);
        startSession(c, token, config.sessionHours * 60);
        await withWorkspace(r.workspace.id, () => audit({ id: r.user.id, username: r.user.username }, 'account.signup', r.workspace.name, { workspace: r.workspace.slug }, c.get('ip')));
        return c.json({ ok: true, workspace: r.workspace });
    } catch (err) { return fail(c, err); }
});

account.post('/verify', rateLimit(20, 60 * 60_000, (c) => `verify:${ip(c)}`), async (c) => {
    const b = await c.req.json().catch(() => ({}));
    try { await verifyEmail(String(b.token ?? '')); return c.json({ ok: true }); } catch (err) { return fail(c, err); }
});

account.post('/resend-verification', rateLimit(3, 60 * 60_000, (c) => `resend:${c.get('user')?.id ?? ip(c)}`), async (c) => {
    const u = c.get('user');
    if (!u) return c.json({ error: 'Not signed in' }, 401);
    if (!u.email || u.emailVerified) return c.json({ ok: true });
    const r = await sendVerification(u.id, u.email);
    return r.ok ? c.json({ ok: true }) : c.json({ error: "The email couldn't be sent right now. Try again in a few minutes." }, 502);
});

account.post('/forgot', multiOnly, rateLimit(5, 60 * 60_000, (c) => `forgot:${ip(c)}`), async (c) => {
    const b = await c.req.json().catch(() => ({}));
    await forgotPassword(b.email);
    return c.json({ ok: true });   // the same answer whether or not the address has an account
});

account.post('/reset', rateLimit(10, 60 * 60_000, (c) => `reset:${ip(c)}`), async (c) => {
    const b = await c.req.json().catch(() => ({}));
    try { await resetPassword(String(b.token ?? ''), b.password); return c.json({ ok: true }); } catch (err) { return fail(c, err); }
});

account.get('/invites/:token', multiOnly, rateLimit(30, 60 * 60_000, (c) => `invinfo:${ip(c)}`), async (c) => {
    try { return c.json({ invite: await inviteInfo(c.req.param('token')) }); } catch (err) { return fail(c, err); }
});

account.post('/invites/:token/accept', multiOnly, rateLimit(10, 60 * 60_000, (c) => `invaccept:${ip(c)}`), async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const u = c.get('user');
    try {
        const r = await acceptInvite(c.req.param('token'), u && !u.isDemo ? { id: u.id, email: u.email } : null, { name: b.name, password: b.password, username: b.username });
        const raw = getCookie(c, config.cookieName);
        if (u && raw) await switchWorkspace(raw, u.id, r.workspaceId);
        else {
            const token = await createSession(r.userId, config.sessionHours * 60, c.get('ip'), c.req.header('user-agent') ?? null, r.workspaceId);
            startSession(c, token, config.sessionHours * 60);
        }
        await withWorkspace(r.workspaceId, () => audit({ id: r.userId, username: u?.username ?? null }, 'team.join', null, {}, c.get('ip')));
        return c.json({ ok: true, workspaceId: r.workspaceId });
    } catch (err) { return fail(c, err); }
});

/** Signed in: your workspaces. Mounted at /api/workspaces. */
export const workspaces = new Hono<Env>();
workspaces.get('/', signedIn, async (c) => {
    const u = c.get('user')!;
    const list = config.multiTenant ? await myWorkspaces(u.id)
        : (await db().query(`SELECT id, name, slug, plan, trial_ends_at AS "trialEndsAt" FROM workspaces WHERE id = 1`)).rows.map((w) => ({ ...w, role: u.role }));
    return c.json({ workspaces: list, current: u.workspaceId });
});
workspaces.post('/', multiOnly, signedIn, denyDemo, rateLimit(5, 60 * 60_000, (c) => `wsnew:${c.get('user')!.id}`), async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const u = c.get('user')!;
    try {
        const name = String(b.name ?? '').trim();
        if (name.length < 2 || name.length > 60) throw new DeployError('The workspace name must be 2 to 60 characters.');
        const w = await createWorkspace(u.id, name);
        await switchWorkspace(getCookie(c, config.cookieName)!, u.id, w.id);
        return c.json({ workspace: w });
    } catch (err) { return fail(c, err); }
});
workspaces.post('/switch', multiOnly, signedIn, async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const ok = await switchWorkspace(getCookie(c, config.cookieName) ?? '', c.get('user')!.id, Number(b.id));
    return ok ? c.json({ ok: true }) : c.json({ error: 'Not a member of that workspace' }, 403);
});
workspaces.patch('/current', requireRole('admin'), denyDemo, async (c) => {
    const u = c.get('user')!;
    if (u.workspaceId == null) return c.json({ error: 'No workspace' }, 409);
    const b = await c.req.json().catch(() => ({}));
    try {
        const name = await renameWorkspace(u.workspaceId, b.name);
        await audit({ id: u.id, username: u.username }, 'workspace.rename', name, {}, c.get('ip'));
        return c.json({ ok: true, name });
    } catch (err) { return fail(c, err); }
});

/** The current workspace's members and invitations (multi-tenant; the single-team console keeps its Users page). */
export const teamRoutes = new Hono<Env>();
teamRoutes.use('*', multiOnly);
teamRoutes.get('/', requireRole('viewer'), denyDemo, async (c) => c.json(await team(c.get('user')!.workspaceId!)));
teamRoutes.post('/invites', requireRole('admin'), denyDemo, rateLimit(30, 60 * 60_000, (c) => `invite:${c.get('user')!.id}`), async (c) => {
    const u = c.get('user')!;
    const b = await c.req.json().catch(() => ({}));
    try {
        // sending a pending invitation again doesn't take another seat
        const pending = await db().query('SELECT 1 FROM workspace_invites WHERE workspace_id = $1 AND lower(email) = lower($2) AND accepted_at IS NULL AND expires_at > now()', [u.workspaceId, String(b.email ?? '').trim()]);
        if (!pending.rows.length) await checkLimit(u.workspaceId!, 'members');
        const r = await invite(u.workspaceId!, { id: u.id, name: u.displayName || u.username }, b.email, b.role);
        await audit({ id: u.id, username: u.username }, 'team.invite', r.email, { role: r.role }, c.get('ip'));
        return c.json({ ok: true, ...r });
    } catch (err) { return fail(c, err); }
});
teamRoutes.delete('/invites/:id', requireRole('admin'), denyDemo, async (c) => {
    const { rowCount } = await db().query('DELETE FROM workspace_invites WHERE id = $1 AND workspace_id = $2 AND accepted_at IS NULL',
        [Number(c.req.param('id')), c.get('user')!.workspaceId]);
    return rowCount ? c.json({ ok: true }) : c.json({ error: 'Invitation not found' }, 404);
});
teamRoutes.patch('/members/:userId', requireRole('admin'), denyDemo, async (c) => {
    const u = c.get('user')!;
    const b = await c.req.json().catch(() => ({}));
    try {
        await setMemberRole(u.workspaceId!, Number(c.req.param('userId')), b.role);
        await audit({ id: u.id, username: u.username }, 'team.role', c.req.param('userId'), { role: b.role }, c.get('ip'));
        return c.json({ ok: true });
    } catch (err) { return fail(c, err); }
});
teamRoutes.delete('/members/:userId', requireRole('viewer'), denyDemo, async (c) => {
    const u = c.get('user')!;
    const target = Number(c.req.param('userId'));
    if (target !== u.id && u.role !== 'admin') return c.json({ error: 'Not allowed for your role' }, 403);   // anyone may leave
    try {
        await removeMember(u.workspaceId!, target);
        await audit({ id: u.id, username: u.username }, target === u.id ? 'team.leave' : 'team.remove', String(target), {}, c.get('ip'));
        return c.json({ ok: true });
    } catch (err) { return fail(c, err); }
});
