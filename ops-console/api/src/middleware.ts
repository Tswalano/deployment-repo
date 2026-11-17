import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { config } from './config';
import { Role, SessionUser, sessionUser } from './sessions';

export type Env = { Variables: { user: SessionUser | null; ip: string | null } };

const RANK: Record<Role, number> = { viewer: 1, deployer: 2, admin: 3 };

export function clientIp(c: Context): string | null {
    if (config.trustProxy) {
        const fwd = c.req.header('x-forwarded-for');
        if (fwd) return fwd.split(',')[0].trim().slice(0, 64);
    }
    const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
    return env?.incoming?.socket?.remoteAddress ?? null;
}

/** Attach the session user (or null) and client IP to every request. */
export const loadSession: MiddlewareHandler<Env> = async (c, next) => {
    c.set('ip', clientIp(c));
    c.set('user', await sessionUser(getCookie(c, config.cookieName)));
    await next();
};

/** Whether a browser Origin may make state-changing requests (also checked on terminal WebSocket upgrades). */
export function originAllowed(origin: string | undefined | null): boolean {
    if (!origin) return false;
    const loopback = config.allowLoopbackOrigins && /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/.test(origin);
    return config.allowedOrigins.includes(origin) || loopback;
}

/** CSRF: state-changing requests must come from an allowed Origin (cookies are SameSite=Strict too). */
export const checkOrigin: MiddlewareHandler<Env> = async (c, next) => {
    // GitHub webhooks carry no Origin; they are authenticated by their HMAC signature instead.
    if (c.req.path === '/api/github/webhook') return next();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
        if (!originAllowed(c.req.header('origin'))) {
            return c.json({ error: 'Origin not allowed' }, 403);
        }
    }
    await next();
};

export function requireRole(min: Role): MiddlewareHandler<Env> {
    return async (c, next) => {
        const user = c.get('user');
        if (!user) return c.json({ error: 'Not signed in' }, 401);
        if (RANK[user.role] < RANK[min]) return c.json({ error: 'Not allowed for your role' }, 403);
        await next();
    };
}

/** Demo sessions are read-only showcases: never allowed to change anything. */
export const denyDemo: MiddlewareHandler<Env> = async (c, next) => {
    if (c.get('user')?.isDemo) return c.json({ error: 'The demo account is read-only' }, 403);
    await next();
};

/** Small in-memory fixed-window limiter (single process). */
export function rateLimit(limit: number, windowMs: number, key: (c: Context<Env>) => string): MiddlewareHandler<Env> {
    const hits = new Map<string, { count: number; reset: number }>();
    return async (c, next) => {
        const now = Date.now();
        const k = key(c);
        let h = hits.get(k);
        if (!h || h.reset <= now) {
            h = { count: 0, reset: now + windowMs };
            hits.set(k, h);
        }
        h.count += 1;
        if (hits.size > 10_000) for (const [kk, v] of hits) if (v.reset <= now) hits.delete(kk);
        if (h.count > limit) {
            c.header('Retry-After', String(Math.ceil((h.reset - now) / 1000)));
            return c.json({ error: 'Too many attempts. Try again later.' }, 429);
        }
        await next();
    };
}
