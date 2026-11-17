/**
 * Phase 12a: accounts and workspaces for the multi-customer console.
 * Sign-up creates a user, a workspace (14-day trial) and an admin membership. Email verification, password reset
 * and invitations use single-use random tokens; only their SHA-256 is stored.
 */
import { createHash, randomBytes } from 'crypto';
import { config } from './config';
import { db } from './db';
import { DeployError } from './deploys';
import { notifier } from './notify';
import { hashPassword, passwordProblem } from './password';
import { Role } from './sessions';

/** Usernames: 3-30 of a-z 0-9 . _ - , starting with a letter or digit; never an email (no @). */
export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,29}$/;

export async function usernameTaken(u: string, exceptUserId?: number): Promise<boolean> {
    const { rows } = await db().query('SELECT 1 FROM users WHERE (lower(username) = $1 OR lower(email) = $1) AND id <> $2', [u.toLowerCase(), exceptUserId ?? 0]);
    return rows.length > 0;
}

/** Check a chosen username (lower-cased); throws a friendly error. */
export async function cleanUsername(v: unknown, exceptUserId?: number): Promise<string> {
    const u = String(v ?? '').trim().toLowerCase();
    if (!USERNAME_RE.test(u)) throw new DeployError('Usernames are 3 to 30 characters: letters, numbers, dots, dashes and underscores, starting with a letter or number.', 400, 'bad_username');
    if (await usernameTaken(u, exceptUserId)) throw new DeployError('That username is taken: try another.', 409, 'username_taken');
    return u;
}

/** A free username made from the email's first part (e.g. moganegb@… → moganegb, then moganegb-2 …). */
export async function suggestUsername(email: string): Promise<string> {
    let base = email.split('@')[0].toLowerCase().replace(/\+.*$/, '').replace(/[^a-z0-9._-]/g, '').replace(/^[._-]+/, '').slice(0, 24);
    if (base.length < 3) base = `${base}user`.slice(0, 24);
    for (let i = 1; i < 200; i++) {
        const u = i === 1 ? base : `${base}-${i}`;
        if (!(await usernameTaken(u))) return u;
    }
    return `${base}-${randomBytes(3).toString('hex')}`;
}

export const EMAIL_RE = /^[^\s@<>()",;:]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');
const ROLES: Role[] = ['admin', 'deployer', 'viewer'];

export function cleanEmail(v: unknown): string {
    const e = String(v ?? '').trim().toLowerCase();
    if (e.length > 254 || !EMAIL_RE.test(e)) throw new DeployError('Enter a valid email address.');
    return e;
}
const cleanName = (v: unknown, what: string, max = 60) => {
    const n = String(v ?? '').trim().replace(/\s+/g, ' ').replace(/[<>]/g, '');
    if (n.length < 2 || n.length > max) throw new DeployError(`${what} must be 2 to ${max} characters.`);
    return n;
};

async function uniqueSlug(name: string): Promise<string> {
    const base = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'team';
    const root = /^[a-z0-9]/.test(base) && base.length >= 2 ? base : `ws-${base}`.slice(0, 30);
    for (let i = 0; i < 50; i++) {
        const slug = i === 0 ? root : `${root}-${randomBytes(2).toString('hex')}`;
        const { rows } = await db().query('SELECT 1 FROM workspaces WHERE slug = $1', [slug]);
        if (!rows.length) return slug;
    }
    throw new DeployError('Could not pick a workspace address; try another name.');
}

async function sendMail(to: string, subject: string, text: string) {
    await notifier().email([to], subject, text).catch((err) => console.error('account email failed:', (err as Error).message));
}

async function issueToken(userId: number, purpose: 'verify_email' | 'reset_password', hours: number): Promise<string> {
    const t = newToken();
    // one live token per purpose: a new one replaces older ones
    await db().query('UPDATE user_tokens SET used_at = now() WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL', [userId, purpose]);
    await db().query(`INSERT INTO user_tokens (token_hash, user_id, purpose, expires_at) VALUES ($1, $2, $3, now() + make_interval(hours => $4))`,
        [sha256(t), userId, purpose, hours]);
    return t;
}

async function useToken(token: string, purpose: string): Promise<number> {
    if (!token || token.length > 100) throw new DeployError('This link is invalid or has expired.');
    const { rows: [r] } = await db().query<{ user_id: number }>(
        `UPDATE user_tokens SET used_at = now() WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now() RETURNING user_id`,
        [sha256(token), purpose]);
    if (!r) throw new DeployError('This link is invalid or has expired.');
    return r.user_id;
}

export async function sendVerification(userId: number, email: string): Promise<void> {
    const t = await issueToken(userId, 'verify_email', 48);
    await sendMail(email, `Confirm your email for ${config.productName}`,
        `Welcome to ${config.productName}.\n\nConfirm your email address (the link works for 48 hours):\n${config.publicUrl}/verify?token=${t}\n\nIf you didn't sign up, ignore this email.`);
}

/** Sign-up: user + workspace (trial) + admin membership, then the verification email. */
export async function signUp(input: { name: unknown; email: unknown; password: unknown; workspace: unknown; username?: unknown }) {
    const email = cleanEmail(input.email);
    const name = cleanName(input.name, 'Your name');
    const wsName = cleanName(input.workspace ?? `${name}'s team`, 'The workspace name');
    const problem = passwordProblem(input.password);
    if (problem) throw new DeployError(problem);
    const exists = await db().query('SELECT 1 FROM users WHERE lower(email) = $1 OR lower(username) = $1', [email]);
    if (exists.rows.length) throw new DeployError('An account with this email already exists: sign in, or reset your password.', 409, 'exists');
    const username = String(input.username ?? '').trim() ? await cleanUsername(input.username) : await suggestUsername(email);
    const hash = await hashPassword(String(input.password));
    const { rows: [u] } = await db().query<{ id: number; username: string }>(
        `INSERT INTO users (username, display_name, role, password_hash, password_changed_at, email)
         VALUES ($1, $2, 'viewer', $3, now(), $4) RETURNING id, username`, [username, name, hash, email]);
    const ws = await createWorkspace(u.id, wsName);
    await sendVerification(u.id, email);
    return { user: u, workspace: ws };
}

export async function createWorkspace(userId: number, name: string) {
    const slug = await uniqueSlug(name);
    const { rows: [w] } = await db().query<{ id: number; name: string; slug: string }>(
        `INSERT INTO workspaces (name, slug, plan, trial_ends_at, created_by) VALUES ($1, $2, 'trial', now() + make_interval(days => $3), $4) RETURNING id, name, slug`,
        [name, slug, config.trialDays, userId]);
    await db().query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'admin')`, [w.id, userId]);
    return w;
}

export async function verifyEmail(token: string): Promise<number> {
    const userId = await useToken(token, 'verify_email');
    await db().query('UPDATE users SET email_verified_at = coalesce(email_verified_at, now()) WHERE id = $1', [userId]);
    return userId;
}

/** Always looks the same to the caller, whether or not the email has an account. */
export async function forgotPassword(emailInput: unknown): Promise<void> {
    let email: string;
    try { email = cleanEmail(emailInput); } catch { return; }
    const { rows: [u] } = await db().query<{ id: number }>('SELECT id FROM users WHERE lower(email) = $1 AND NOT disabled AND NOT is_demo', [email]);
    if (!u) return;
    const t = await issueToken(u.id, 'reset_password', 1);
    await sendMail(email, `Reset your ${config.productName} password`,
        `Someone (hopefully you) asked to reset the password for ${email}.\n\nChoose a new one (the link works for 1 hour, once):\n${config.publicUrl}/reset-password?token=${t}\n\nIf it wasn't you, ignore this email: your password stays as it is.`);
}

export async function resetPassword(token: string, password: unknown): Promise<number> {
    const problem = passwordProblem(password);
    if (problem) throw new DeployError(problem);
    const userId = await useToken(token, 'reset_password');
    await db().query(`UPDATE users SET password_hash = $2, password_changed_at = now(), failed_logins = 0, locked_until = NULL,
                      email_verified_at = coalesce(email_verified_at, now()) WHERE id = $1`, [userId, await hashPassword(String(password))]);
    await db().query('DELETE FROM sessions WHERE user_id = $1', [userId]);   // signed out everywhere
    return userId;
}

// ---------------------------------------------------------------------------------------------- workspaces

export async function myWorkspaces(userId: number) {
    const { rows } = await db().query(
        `SELECT w.id, w.name, w.slug, w.plan, w.trial_ends_at AS "trialEndsAt", m.role
           FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = $1 ORDER BY m.created_at`, [userId]);
    return rows;
}

export async function renameWorkspace(workspaceId: number, name: unknown) {
    const n = cleanName(name, 'The workspace name');
    await db().query('UPDATE workspaces SET name = $2 WHERE id = $1', [workspaceId, n]);
    return n;
}

// ---------------------------------------------------------------------------------------------- team

export async function team(workspaceId: number) {
    const { rows: members } = await db().query(
        `SELECT u.id, u.username, u.display_name AS "displayName", u.email, m.role, m.created_at AS "joinedAt", u.last_login_at AS "lastLoginAt",
                u.email_verified_at IS NOT NULL AS "emailVerified"
           FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 ORDER BY m.created_at`, [workspaceId]);
    const { rows: invites } = await db().query(
        `SELECT id, email, role, created_at AS "createdAt", expires_at AS "expiresAt" FROM workspace_invites
          WHERE workspace_id = $1 AND accepted_at IS NULL AND expires_at > now() ORDER BY created_at DESC`, [workspaceId]);
    return { members, invites };
}

export async function invite(workspaceId: number, by: { id: number; name: string }, emailInput: unknown, role: unknown) {
    const email = cleanEmail(emailInput);
    if (!ROLES.includes(role as Role)) throw new DeployError('Choose a role.');
    const member = await db().query(
        `SELECT 1 FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 AND lower(u.email) = $2`, [workspaceId, email]);
    if (member.rows.length) throw new DeployError(`${email} is already in this workspace.`, 409);
    const t = newToken();
    await db().query('DELETE FROM workspace_invites WHERE workspace_id = $1 AND lower(email) = $2 AND accepted_at IS NULL', [workspaceId, email]);
    await db().query(`INSERT INTO workspace_invites (workspace_id, email, role, token_hash, invited_by, expires_at) VALUES ($1, $2, $3, $4, $5, now() + interval '7 days')`,
        [workspaceId, email, role, sha256(t), by.id]);
    const { rows: [w] } = await db().query<{ name: string }>('SELECT name FROM workspaces WHERE id = $1', [workspaceId]);
    await sendMail(email, `${by.name} invited you to ${w.name} on ${config.productName}`,
        `${by.name} invited you to join the workspace "${w.name}" on ${config.productName} as ${role}.\n\nAccept (the link works for 7 days):\n${config.publicUrl}/invite?token=${t}\n\nIf you weren't expecting this, ignore it.`);
    return { email, role };
}

export async function inviteInfo(token: string) {
    const { rows: [i] } = await db().query(
        `SELECT i.email, i.role, w.name AS workspace, EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = lower(i.email)) AS "hasAccount"
           FROM workspace_invites i JOIN workspaces w ON w.id = i.workspace_id
          WHERE i.token_hash = $1 AND i.accepted_at IS NULL AND i.expires_at > now()`, [sha256(token)]);
    if (!i) throw new DeployError('This invitation is invalid, already used, or expired.', 404);
    return i;
}

/**
 * Accept an invitation. Signed in: the invite must be for the signed-in email. Signed out: creates the account
 * (the invite proves the email) unless one exists, in which case the person must sign in first.
 */
export async function acceptInvite(token: string, signedIn: { id: number; email: string | null } | null, account?: { name: unknown; password: unknown; username?: unknown }) {
    const { rows: [i] } = await db().query<{ id: number; workspace_id: number; email: string; role: Role }>(
        `SELECT id, workspace_id, email, role FROM workspace_invites WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > now()`, [sha256(token)]);
    if (!i) throw new DeployError('This invitation is invalid, already used, or expired.', 404);
    let userId: number;
    if (signedIn) {
        if ((signedIn.email ?? '').toLowerCase() !== i.email.toLowerCase()) throw new DeployError(`This invitation is for ${i.email}. Sign in with that account to accept it.`, 403);
        userId = signedIn.id;
    } else {
        const ex = await db().query('SELECT 1 FROM users WHERE lower(email) = $1 OR lower(username) = $1', [i.email.toLowerCase()]);
        if (ex.rows.length) throw new DeployError(`${i.email} already has an account: sign in first, then open the invitation again.`, 409, 'sign_in');
        const name = cleanName(account?.name, 'Your name');
        const problem = passwordProblem(account?.password);
        if (problem) throw new DeployError(problem);
        const username = String(account?.username ?? '').trim() ? await cleanUsername(account?.username) : await suggestUsername(i.email);
        const { rows: [u] } = await db().query<{ id: number }>(
            `INSERT INTO users (username, display_name, role, password_hash, password_changed_at, email, email_verified_at)
             VALUES ($1, $2, 'viewer', $3, now(), $4, now()) RETURNING id`, [username, name, await hashPassword(String(account?.password)), i.email.toLowerCase()]);
        userId = u.id;
    }
    await db().query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (workspace_id, user_id) DO NOTHING`, [i.workspace_id, userId, i.role]);
    await db().query('UPDATE workspace_invites SET accepted_at = now() WHERE id = $1', [i.id]);
    return { userId, workspaceId: i.workspace_id };
}

async function adminCount(workspaceId: number, exceptUser: number) {
    const { rows: [r] } = await db().query<{ n: number }>(`SELECT count(*)::int AS n FROM workspace_members WHERE workspace_id = $1 AND role = 'admin' AND user_id <> $2`, [workspaceId, exceptUser]);
    return r.n;
}

export async function setMemberRole(workspaceId: number, userId: number, role: unknown) {
    if (!ROLES.includes(role as Role)) throw new DeployError('Choose a role.');
    if (role !== 'admin' && (await adminCount(workspaceId, userId)) === 0) throw new DeployError('A workspace needs at least one admin.', 409);
    const { rowCount } = await db().query('UPDATE workspace_members SET role = $3 WHERE workspace_id = $1 AND user_id = $2', [workspaceId, userId, role]);
    if (!rowCount) throw new DeployError('Not a member of this workspace.', 404);
}

export async function removeMember(workspaceId: number, userId: number) {
    if ((await adminCount(workspaceId, userId)) === 0) {
        const { rows } = await db().query(`SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`, [workspaceId, userId]);
        if (rows[0]?.role === 'admin') throw new DeployError('A workspace needs at least one admin: make someone else admin first.', 409);
    }
    const { rowCount } = await db().query('DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [workspaceId, userId]);
    if (!rowCount) throw new DeployError('Not a member of this workspace.', 404);
    // their sessions in this workspace lose access at once
    await db().query('UPDATE sessions SET workspace_id = NULL WHERE user_id = $1 AND workspace_id = $2', [userId, workspaceId]);
}
