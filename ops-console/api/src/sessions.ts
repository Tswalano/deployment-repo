import { createHash, randomBytes } from 'crypto';
import { db } from './db';

export type Role = 'admin' | 'deployer' | 'viewer';

export interface SessionUser {
    id: number;
    username: string;
    displayName: string;
    role: Role;
    isDemo: boolean;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Create a session; returns the raw token for the cookie (only its hash is stored). */
export async function createSession(userId: number, ttlMinutes: number, ip: string | null, userAgent: string | null): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await db().query(
        `INSERT INTO sessions (token_hash, user_id, expires_at, ip, user_agent)
         VALUES ($1, $2, now() + make_interval(mins => $3), $4, $5)`,
        [sha256(token), userId, ttlMinutes, ip, (userAgent || '').slice(0, 300)]);
    return token;
}

export async function sessionUser(token: string | undefined): Promise<SessionUser | null> {
    if (!token || token.length > 100) return null;
    const { rows } = await db().query(
        `UPDATE sessions s SET last_seen_at = now()
           FROM users u
          WHERE s.token_hash = $1 AND s.expires_at > now() AND u.id = s.user_id AND NOT u.disabled
      RETURNING u.id, u.username, u.display_name, u.role, u.is_demo`,
        [sha256(token)]);
    if (!rows.length) return null;
    const r = rows[0];
    return { id: r.id, username: r.username, displayName: r.display_name, role: r.role, isDemo: r.is_demo };
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
