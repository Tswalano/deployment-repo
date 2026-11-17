import { config } from '../config';
import { Hono } from 'hono';
import { audit } from '../audit';
import { db } from '../db';
import { denyDemo, Env, requireRole } from '../middleware';
import { hashPassword, passwordProblem } from '../password';
import { destroyUserSessions, Role } from '../sessions';

const users = new Hono<Env>();
// The global user list is the single-team console's: with many customers it would show every account, so it is off
// there (workspaces use /api/team: members and invitations of their own workspace only).
users.use('*', async (c, next) => (config.multiTenant ? c.json({ error: 'Not found' }, 404) : next()));
users.use('*', requireRole('admin'), denyDemo);

const ROLES: Role[] = ['admin', 'deployer', 'viewer'];
const USERNAME_RE = /^[A-Za-z0-9._-]{3,32}$/;

const PUBLIC_COLS = `id, username, display_name AS "displayName", role, is_demo AS "isDemo", disabled,
    created_at AS "createdAt", last_login_at AS "lastLoginAt", (locked_until > now()) AS locked`;

const actor = (c: { get: (k: 'user') => { id: number; username: string } | null }) => {
    const u = c.get('user');
    return u ? { id: u.id, username: u.username } : null;
};

/** Would this change leave the system without an active admin? */
async function wouldRemoveLastAdmin(userId: number): Promise<boolean> {
    const { rows } = await db().query(
        `SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND NOT disabled AND NOT is_demo AND id <> $1`, [userId]);
    return rows[0].n === 0;
}

users.get('/', async (c) => {
    const { rows } = await db().query(`SELECT ${PUBLIC_COLS} FROM users ORDER BY is_demo, lower(username)`);
    return c.json({ users: rows });
});

users.post('/', async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const username = typeof b.username === 'string' ? b.username.trim() : '';
    if (!USERNAME_RE.test(username)) return c.json({ error: 'Username: 3–32 letters, digits, dot, dash or underscore.' }, 400);
    if (!ROLES.includes(b.role)) return c.json({ error: 'Role must be admin, deployer or viewer.' }, 400);
    const problem = passwordProblem(b.password);
    if (problem) return c.json({ error: problem }, 400);
    try {
        const { rows } = await db().query(
            `INSERT INTO users (username, display_name, role, password_hash, password_changed_at)
             VALUES ($1, $2, $3, $4, now()) RETURNING ${PUBLIC_COLS}`,
            [username, String(b.displayName ?? '').slice(0, 80), b.role, await hashPassword(b.password)]);
        await audit(actor(c), 'user.create', username, { role: b.role }, c.get('ip'));
        return c.json({ user: rows[0] }, 201);
    } catch (err) {
        if ((err as { code?: string }).code === '23505') return c.json({ error: 'That username is taken.' }, 409);
        throw err;
    }
});

users.patch('/:id', async (c) => {
    const id = Number(c.req.param('id'));
    const me = c.get('user')!;
    const b = await c.req.json().catch(() => ({}));
    const { rows: found } = await db().query('SELECT id, username, role, disabled, is_demo FROM users WHERE id = $1', [id]);
    const target = found[0];
    if (!target) return c.json({ error: 'User not found' }, 404);

    const changes: Record<string, unknown> = {};
    if (b.role !== undefined && b.role !== target.role) {
        if (!ROLES.includes(b.role)) return c.json({ error: 'Invalid role' }, 400);
        if (target.is_demo) return c.json({ error: 'The demo account is always a viewer.' }, 400);
        if (id === me.id) return c.json({ error: "You can't change your own role." }, 400);
        if (target.role === 'admin' && (await wouldRemoveLastAdmin(id))) return c.json({ error: 'At least one admin must remain.' }, 400);
        changes.role = b.role;
    }
    if (b.disabled !== undefined && Boolean(b.disabled) !== target.disabled) {
        if (id === me.id) return c.json({ error: "You can't disable yourself." }, 400);
        if (b.disabled && target.role === 'admin' && (await wouldRemoveLastAdmin(id))) return c.json({ error: 'At least one admin must remain.' }, 400);
        changes.disabled = Boolean(b.disabled);
    }
    if (b.displayName !== undefined) changes.display_name = String(b.displayName).slice(0, 80);
    if (!Object.keys(changes).length) return c.json({ error: 'Nothing to change' }, 400);

    const keys = Object.keys(changes);
    const { rows } = await db().query(
        `UPDATE users SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING ${PUBLIC_COLS}`,
        [id, ...keys.map((k) => changes[k])]);
    if ('role' in changes || changes.disabled === true) await destroyUserSessions(id);   // take effect immediately
    await audit(actor(c), 'user.update', target.username, changes, c.get('ip'));
    return c.json({ user: rows[0] });
});

users.post('/:id/password', async (c) => {
    const id = Number(c.req.param('id'));
    const b = await c.req.json().catch(() => ({}));
    const problem = passwordProblem(b.password);
    if (problem) return c.json({ error: problem }, 400);
    const { rows } = await db().query(
        `UPDATE users SET password_hash = $2, password_changed_at = now(), failed_logins = 0, locked_until = NULL
          WHERE id = $1 AND NOT is_demo RETURNING username`, [id, await hashPassword(b.password)]);
    if (!rows.length) return c.json({ error: 'User not found' }, 404);
    await destroyUserSessions(id);
    await audit(actor(c), 'user.password_reset', rows[0].username, {}, c.get('ip'));
    return c.json({ ok: true });
});

users.delete('/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (id === c.get('user')!.id) return c.json({ error: "You can't delete yourself." }, 400);
    const { rows: found } = await db().query('SELECT username, role, is_demo FROM users WHERE id = $1', [id]);
    const target = found[0];
    if (!target) return c.json({ error: 'User not found' }, 404);
    if (target.is_demo) return c.json({ error: 'Disable the demo account instead of deleting it.' }, 400);
    if (target.role === 'admin' && (await wouldRemoveLastAdmin(id))) return c.json({ error: 'At least one admin must remain.' }, 400);
    await db().query('DELETE FROM users WHERE id = $1', [id]);
    await audit(actor(c), 'user.delete', target.username, { role: target.role }, c.get('ip'));
    return c.json({ ok: true });
});

export default users;
