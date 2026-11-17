import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { audit } from '../audit';
import { config } from '../config';
import { db } from '../db';
import { denyDemo, Env, rateLimit } from '../middleware';
import { dummyPasswordHash, hashPassword, passwordProblem, verifyPassword } from '../password';
import { cleanEmail, cleanUsername, sendVerification } from '../accounts';
import { DeployError } from '../deploys';
import { createSession, destroySession, destroyUserSessions } from '../sessions';

const auth = new Hono<Env>();

const loginLimiter = rateLimit(config.loginRateLimit, config.loginRateWindowMs, (c) => `login:${c.get('ip') ?? 'unknown'}`);

export function startSession(c: Parameters<typeof setCookie>[0], token: string, minutes: number) {
    setCookie(c, config.cookieName, token, {
        httpOnly: true, secure: config.cookieSecure, sameSite: 'Strict', path: '/', maxAge: minutes * 60,
    });
}

const GENERIC = 'Invalid username or password';

auth.post('/login', loginLimiter, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!username || !password) return c.json({ error: GENERIC }, 401);

    const { rows } = await db().query(
        `SELECT id, username, password_hash, disabled, is_demo, failed_logins, locked_until > now() AS locked
           FROM users WHERE lower(username) = lower($1) OR lower(email) = lower($1)
          ORDER BY lower(username) = lower($1) DESC LIMIT 1`, [username]);   // username or email
    const u = rows[0];
    const ip = c.get('ip');

    if (!u || u.disabled || u.is_demo || !u.password_hash) {
        await verifyPassword(password, await dummyPasswordHash());   // equalise timing
        await audit(null, 'auth.login_failed', username.slice(0, 64), { reason: 'unknown_or_disabled' }, ip);
        return c.json({ error: GENERIC }, 401);
    }
    if (u.locked) {
        await audit({ id: u.id, username: u.username }, 'auth.login_locked', u.username, {}, ip);
        return c.json({ error: `Account temporarily locked after too many failed attempts. Try again in ${config.lockMinutes} minutes.` }, 423);
    }
    if (!(await verifyPassword(password, u.password_hash))) {
        const failed = u.failed_logins + 1;
        const lock = failed >= config.maxFailedLogins;
        await db().query(
            `UPDATE users SET failed_logins = $2, locked_until = CASE WHEN $3 THEN now() + make_interval(mins => $4) END WHERE id = $1`,
            [u.id, lock ? 0 : failed, lock, config.lockMinutes]);
        await audit({ id: u.id, username: u.username }, lock ? 'auth.account_locked' : 'auth.login_failed', u.username, { failed }, ip);
        return c.json({ error: GENERIC }, 401);
    }

    await db().query('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [u.id]);
    const token = await createSession(u.id, config.sessionHours * 60, ip, c.req.header('user-agent') ?? null);
    startSession(c, token, config.sessionHours * 60);
    await audit({ id: u.id, username: u.username }, 'auth.login', u.username, {}, ip);
    return c.json({ ok: true });
});

/** "Try the demo": a read-only viewer session without a password. */
auth.post('/demo', loginLimiter, async (c) => {
    if (!config.demoEnabled || config.multiTenant) return c.json({ error: 'Demo is disabled' }, 404);
    const { rows } = await db().query('SELECT id, username FROM users WHERE is_demo AND NOT disabled AND role = \'viewer\'');
    if (!rows.length) return c.json({ error: 'Demo is not available' }, 404);
    const ip = c.get('ip');
    const token = await createSession(rows[0].id, config.demoSessionMinutes, ip, c.req.header('user-agent') ?? null);
    startSession(c, token, config.demoSessionMinutes);
    await audit({ id: rows[0].id, username: rows[0].username }, 'auth.demo', null, {}, ip);
    return c.json({ ok: true });
});

auth.post('/logout', async (c) => {
    const user = c.get('user');
    await destroySession(getCookie(c, config.cookieName));
    deleteCookie(c, config.cookieName, { path: '/', secure: config.cookieSecure });
    if (user) await audit({ id: user.id, username: user.username }, 'auth.logout', null, {}, c.get('ip'));
    return c.json({ ok: true });
});

auth.get('/me', (c) => {
    const user = c.get('user');
    return user ? c.json({ user }) : c.json({ error: 'Not signed in' }, 401);
});

auth.post('/password', denyDemo, async (c) => {
    const user = c.get('user');
    if (!user) return c.json({ error: 'Not signed in' }, 401);
    const body = await c.req.json().catch(() => ({}));
    const problem = passwordProblem(body.newPassword);
    if (problem) return c.json({ error: problem }, 400);
    const { rows } = await db().query('SELECT password_hash FROM users WHERE id = $1', [user.id]);
    if (!(await verifyPassword(String(body.currentPassword ?? ''), rows[0]?.password_hash ?? null))) {
        return c.json({ error: 'Current password is incorrect' }, 400);
    }
    await db().query('UPDATE users SET password_hash = $2, password_changed_at = now() WHERE id = $1', [user.id, await hashPassword(body.newPassword)]);
    await destroyUserSessions(user.id, getCookie(c, config.cookieName));   // sign out everywhere else
    await audit({ id: user.id, username: user.username }, 'auth.password_change', user.username, {}, c.get('ip'));
    return c.json({ ok: true });
});

/** Add an email to an account that has none (e.g. accounts from the single-team console). Needs your password.
 *  The email an account signed up with can't be changed here (a platform-owner action, later). */
auth.post('/email', denyDemo, rateLimit(5, 60 * 60_000, (c) => `email:${c.get('user')?.id ?? c.get('ip')}`), async (c) => {
    const user = c.get('user');
    if (!user) return c.json({ error: 'Not signed in' }, 401);
    if (user.email) return c.json({ error: "Your sign-in email can't be changed here. Contact support if it needs to change." }, 409);
    const b = await c.req.json().catch(() => ({}));
    const { rows: [u] } = await db().query('SELECT password_hash FROM users WHERE id = $1', [user.id]);
    if (!(await verifyPassword(String(b.currentPassword ?? ''), u?.password_hash ?? null))) return c.json({ error: 'Current password is incorrect' }, 400);
    let email: string;
    try { email = cleanEmail(b.email); } catch (err) { return c.json({ error: (err as Error).message }, 400); }
    if (email === (user.email ?? '').toLowerCase()) return c.json({ ok: true });
    const taken = await db().query('SELECT 1 FROM users WHERE (lower(email) = $1 OR lower(username) = $1) AND id <> $2', [email, user.id]);
    if (taken.rows.length) return c.json({ error: 'Another account already uses that email.' }, 409);
    await db().query('UPDATE users SET email = $2, email_verified_at = NULL WHERE id = $1', [user.id, email]);
    await sendVerification(user.id, email);
    await audit({ id: user.id, username: user.username }, 'account.email', user.username, { email }, c.get('ip'));
    return c.json({ ok: true });
});

/** Your own details (the Account page). */
auth.get('/profile', async (c) => {
    const user = c.get('user');
    if (!user) return c.json({ error: 'Not signed in' }, 401);
    const { rows: [u] } = await db().query(
        `SELECT username, display_name AS "displayName", email, email_verified_at AS "emailVerifiedAt", created_at AS "createdAt",
                last_login_at AS "lastLoginAt", password_changed_at AS "passwordChangedAt", is_demo AS "isDemo" FROM users WHERE id = $1`, [user.id]);
    const { rows: ws } = await db().query(
        `SELECT w.name, m.role, w.id = $2 AS current FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = $1 ORDER BY m.created_at`,
        [user.id, user.workspaceId]);
    return c.json({ profile: { ...u, role: user.role, workspaces: config.multiTenant ? ws : [] } });
});

/** Change your display name and/or username (sign in with either the username or the email). */
auth.patch('/profile', denyDemo, async (c) => {
    const user = c.get('user');
    if (!user) return c.json({ error: 'Not signed in' }, 401);
    const b = await c.req.json().catch(() => ({}));
    const sets: string[] = []; const vals: unknown[] = [user.id];
    try {
        if (b.displayName !== undefined) {
            const n = String(b.displayName).trim().replace(/\s+/g, ' ').replace(/[<>]/g, '');
            if (n.length < 1 || n.length > 60) return c.json({ error: 'Your name must be 1 to 60 characters.' }, 400);
            vals.push(n); sets.push(`display_name = $${vals.length}`);
        }
        if (b.username !== undefined && String(b.username).trim().toLowerCase() !== user.username.toLowerCase()) {
            vals.push(await cleanUsername(b.username, user.id)); sets.push(`username = $${vals.length}`);
        }
    } catch (err) {
        if (err instanceof DeployError) return c.json({ error: err.message, code: err.code }, err.status);
        throw err;
    }
    if (!sets.length) return c.json({ ok: true });
    await db().query(`UPDATE users SET ${sets.join(', ')} WHERE id = $1`, vals);
    await audit({ id: user.id, username: user.username }, 'account.profile', user.username, { username: b.username, displayName: b.displayName }, c.get('ip'));
    return c.json({ ok: true });
});

export default auth;
