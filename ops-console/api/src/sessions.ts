import { createHash, randomBytes } from 'crypto';
import { config } from './config';
import { db } from './db';

export type Role = 'admin' | 'deployer' | 'viewer';

export interface SessionUser {
    id: number;
    username: string;
    displayName: string;
    /** Role in the current workspace. */
    role: Role;
    isDemo: boolean;
    email: string | null;
    emailVerified: boolean;
    /** The workspace this session works in (null in multi-tenant mode when the user belongs to none). */
    workspaceId: number | null;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Create a session; returns the raw token for the cookie (only its hash is stored). */
export async function createSession(userId: number, ttlMinutes: number, ip: string | null, userAgent: string | null, workspaceId?: number | null): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    // default workspace: the one the user joined first (the single-team console: workspace 1)
    const ws = workspaceId !== undefined ? workspaceId : config.multiTenant
        ? (await db().query('SELECT workspace_id FROM workspace_members WHERE user_id = $1 ORDER BY created_at LIMIT 1', [userId])).rows[0]?.workspace_id ?? null
        : 1;
    await db().query(
        `INSERT INTO sessions (token_hash, user_id, expires_at, ip, user_agent, workspace_id)
         VALUES ($1, $2, now() + make_interval(mins => $3), $4, $5, $6)`,
        [sha256(token), userId, ttlMinutes, ip, (userAgent || '').slice(0, 300), ws]);
    return token;
}

export async function sessionUser(token: string | undefined): Promise<SessionUser | null> {
    if (!token || token.length > 100) return null;
    const { rows } = await db().query(
        `UPDATE sessions s SET last_seen_at = now()
           FROM users u
          WHERE s.token_hash = $1 AND s.expires_at > now() AND u.id = s.user_id AND NOT u.disabled
      RETURNING u.id, u.username, u.display_name, u.role, u.is_demo, u.email, u.email_verified_at, s.workspace_id,
                (SELECT m.role FROM workspace_members m WHERE m.workspace_id = s.workspace_id AND m.user_id = u.id) AS ws_role`,
        [sha256(token)]);
    if (!rows.length) return null;
    const r = rows[0];
    const base = { id: r.id, username: r.username, displayName: r.display_name, isDemo: r.is_demo, email: r.email ?? null, emailVerified: !!r.email_verified_at };
    if (!config.multiTenant) return { ...base, role: r.role, workspaceId: r.workspace_id ?? 1 };   // single team: users.role (Users page) decides
    // multi-tenant: only a real membership gives access to a workspace
    return r.ws_role ? { ...base, role: r.ws_role, workspaceId: r.workspace_id } : { ...base, role: 'viewer', workspaceId: null };
}

export async function destroySession(token: string | undefined): Promise<void> {
    if (token) await db().query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
}

/** Log a user out everywhere (password change/reset, disable, role change). */
export async function destroyUserSessions(userId: number, exceptToken?: string): Promise<void> {
    if (exceptToken) {
        await db().query('DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2', [userId, sha256(exceptToken)]);
    } else {
        await db().query('DELETE FROM sessions WHERE user_id = $1', [userId]);
    }
}

export async function purgeExpiredSessions(): Promise<number> {
    const { rowCount } = await db().query('DELETE FROM sessions WHERE expires_at < now()');
    return rowCount ?? 0;
}

/** Switch a session to another workspace the user is a member of. */
export async function switchWorkspace(token: string, userId: number, workspaceId: number): Promise<boolean> {
    const { rowCount } = await db().query(
        `UPDATE sessions SET workspace_id = $3 WHERE token_hash = $1 AND user_id = $2
            AND EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = $3 AND user_id = $2)`, [sha256(token), userId, workspaceId]);
    return (rowCount ?? 0) > 0;
}
