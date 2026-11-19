import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { Context, Hono } from 'hono';
import { config } from './config';
import { asSystem, db } from './db';
import { clientIp, denyDemo, Env, requireRole } from './middleware';

/**
 * OAuth 2.1 authorisation server for the workspace MCP server (MCP authorization spec): connectors such as ChatGPT
 * and claude.ai discover it (RFC 9728 protected-resource metadata, RFC 8414 server metadata), register themselves
 * (RFC 7591), send the person to /oauth/authorize (the console's approval page, PKCE S256 required), and swap the code
 * for a 1-hour access token plus a 30-day refresh token that rotates on every use (a reused one revokes the grant).
 * Access tokens are ordinary mcp_tokens rows (kind 'oauth'), so /mcp checks them exactly like personal tokens.
 */
export const SCOPE = 'mcp:read';
const ACCESS_TTL_S = 3600;
const REFRESH_TTL_DAYS = 30;
const CODE_TTL_S = 300;
const MAX_GRANTS_PER_USER = 20;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const b64url = (buf: Buffer) => buf.toString('base64url');
const base = () => config.publicUrl.replace(/\/$/, '');
export const mcpResource = () => `${base()}/mcp`;
export const resourceMetadataUrl = () => `${base()}/.well-known/oauth-protected-resource/mcp`;

// ------------------------------------------------------------------ discovery
const protectedResource = () => ({
    resource: mcpResource(),
    authorization_servers: [base()],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: config.productName,
    resource_documentation: `${base()}/docs/mcp`,
});
const serverMetadata = () => ({
    issuer: base(),
    authorization_endpoint: `${base()}/oauth/authorize`,
    token_endpoint: `${base()}/oauth/token`,
    registration_endpoint: `${base()}/oauth/register`,
    revocation_endpoint: `${base()}/oauth/revoke`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    scopes_supported: [SCOPE],
    service_documentation: `${base()}/docs/mcp`,
});

// ------------------------------------------------------------------ clients
export interface OAuthClient { client_id: string; client_secret_hash: string | null; client_name: string; client_uri: string | null; redirect_uris: string[]; auth_method: string }
/** Redirect URIs a client may register: https anywhere, or http only to this machine (desktop apps, CLIs). */
export function redirectAllowed(uri: string): boolean {
    let u: URL;
    try { u = new URL(uri); } catch { return false; }
    if (u.hash || u.username || u.password) return false;
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
}
export async function getClient(id: string): Promise<OAuthClient | null> {
    if (!/^ocl_[A-Za-z0-9_-]{20,40}$/.test(id)) return null;
    const { rows: [c] } = await asSystem(() => db().query<OAuthClient>('SELECT * FROM oauth_clients WHERE client_id = $1', [id]));
    return c ?? null;
}

// ------------------------------------------------------------------ approval (called by /api/oauth with the signed-in person)
export interface AuthorizeRequest { client_id: string; redirect_uri: string; response_type: string; code_challenge: string; code_challenge_method: string; scope?: string; state?: string; resource?: string }
export class OAuthRequestError extends Error {
    constructor(message: string, public redirectable = false, public error = 'invalid_request') { super(message); }
}
/** Check an authorisation request. Errors about the client or redirect URI are shown on the page, never redirected. */
export async function checkAuthorize(q: Partial<AuthorizeRequest>): Promise<{ client: OAuthClient; req: AuthorizeRequest }> {
    const client = q.client_id ? await getClient(q.client_id) : null;
    if (!client) throw new OAuthRequestError('This app is not registered with the console (unknown client). Start the connection again from the app.');
    if (!q.redirect_uri || !client.redirect_uris.includes(q.redirect_uri)) throw new OAuthRequestError('The app asked to return to an address it did not register. For safety the connection was stopped.');
    if (q.response_type !== 'code') throw new OAuthRequestError('Only the authorization code flow is supported.', true, 'unsupported_response_type');
    if (!q.code_challenge || q.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(q.code_challenge)) throw new OAuthRequestError('PKCE (S256) is required.', true);
    if (q.resource && q.resource.replace(/\/$/, '') !== mcpResource()) throw new OAuthRequestError('This console only issues access to its MCP server.', true, 'invalid_target');
    const scopes = (q.scope ?? SCOPE).split(/\s+/).filter(Boolean);
    if (scopes.some((s) => s !== SCOPE)) throw new OAuthRequestError(`Only the "${SCOPE}" scope is offered (read-only).`, true, 'invalid_scope');
    return { client, req: { ...(q as AuthorizeRequest), scope: SCOPE, resource: mcpResource() } };
}
/** The person approved: a single-use code, valid five minutes, bound to the client, redirect URI, PKCE challenge and workspace. */
export async function issueCode(req: AuthorizeRequest, userId: number, workspaceId: number): Promise<string> {
    const code = `occ_${b64url(randomBytes(32))}`;
    await asSystem(() => db().query(
        `INSERT INTO oauth_codes (code_hash, client_id, user_id, workspace_id, redirect_uri, code_challenge, scope, resource, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + make_interval(secs => $9))`,
        [sha256(code), req.client_id, userId, workspaceId, req.redirect_uri, req.code_challenge, req.scope ?? SCOPE, req.resource ?? mcpResource(), CODE_TTL_S]));
    return code;
}
export function redirectWith(uri: string, params: Record<string, string | undefined>): string {
    const u = new URL(uri);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
    return u.toString();
}

// ------------------------------------------------------------------ tokens
const newPair = () => ({ access: `opc_${b64url(randomBytes(30))}`, refresh: `ocr_${b64url(randomBytes(32))}` });
const tokenResponse = (p: { access: string; refresh: string }) => ({ access_token: p.access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: p.refresh, scope: SCOPE });

function oauthError(c: Context, status: 400 | 401, error: string, description: string) {
    c.header('Cache-Control', 'no-store');
    if (status === 401) c.header('WWW-Authenticate', 'Basic realm="oauth"');
    return c.json({ error, error_description: description }, status);
}
/** Client authentication at the token and revocation endpoints (public clients: just the client_id). */
async function authClient(c: Context, form: Record<string, string>): Promise<OAuthClient | null> {
    let id = form.client_id ?? '';
    let secret = form.client_secret ?? '';
    const basic = /^Basic\s+(.+)$/i.exec(c.req.header('authorization') ?? '')?.[1];
    if (basic) {
        const [u, p] = Buffer.from(basic, 'base64').toString('utf8').split(':');
        id = decodeURIComponent(u ?? ''); secret = decodeURIComponent(p ?? '');
    }
    const client = await getClient(id);
    if (!client) return null;
    if (client.client_secret_hash) {
        const a = Buffer.from(sha256(secret)); const b = Buffer.from(client.client_secret_hash);
        if (!secret || a.length !== b.length || !timingSafeEqual(a, b)) return null;
    }
    return client;
}
async function readForm(c: Context): Promise<Record<string, string>> {
    const type = c.req.header('content-type') ?? '';
    if (type.includes('application/json')) {
        const j = await c.req.json().catch(() => ({})) as Record<string, unknown>;
        return Object.fromEntries(Object.entries(j).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
    }
    const body = await c.req.parseBody().catch(() => ({}));
    return Object.fromEntries(Object.entries(body).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
}

/** Who still may hold a grant: an enabled real user who is still a member. */
async function stillMember(userId: number, workspaceId: number): Promise<boolean> {
    const { rows: [r] } = await db().query(
        `SELECT 1 FROM users u WHERE u.id = $1 AND NOT u.disabled AND NOT u.is_demo
            AND (NOT $3::boolean OR EXISTS (SELECT 1 FROM workspace_members m WHERE m.user_id = u.id AND m.workspace_id = $2))`,
        [userId, workspaceId, config.multiTenant]);
    return !!r;
}

// per-IP limits for the unauthenticated endpoints
const hits = new Map<string, { n: number; reset: number }>();
function tooMany(key: string, limit: number, windowMs: number): boolean {
    const now = Date.now();
    const h = hits.get(key);
    if (!h || h.reset < now) { hits.set(key, { n: 1, reset: now + windowMs }); return false; }
    return ++h.n > limit;
}

export const wellKnown = new Hono();
const cors = (c: Context) => { c.header('Access-Control-Allow-Origin', '*'); c.header('Access-Control-Allow-Headers', 'authorization, content-type, mcp-protocol-version'); c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS'); };
wellKnown.use('*', async (c, next) => { cors(c); if (c.req.method === 'OPTIONS') return c.body(null, 204); await next(); });
wellKnown.get('/oauth-protected-resource', (c) => c.json(protectedResource()));
wellKnown.get('/oauth-protected-resource/mcp', (c) => c.json(protectedResource()));
wellKnown.get('/oauth-authorization-server', (c) => c.json(serverMetadata()));

export const oauth = new Hono();
oauth.use('*', async (c, next) => { cors(c); if (c.req.method === 'OPTIONS') return c.body(null, 204); await next(); });

/** RFC 7591 dynamic client registration (open, as MCP clients expect; rate-limited, stale unused clients pruned). */
oauth.post('/register', async (c) => {
    const ip = clientIp(c);
    if (tooMany(`reg:${ip}`, 20, 60 * 60_000)) return c.json({ error: 'invalid_client_metadata', error_description: 'Too many registrations; try again later.' }, 429);
    const m = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    if (!m || typeof m !== 'object') return c.json({ error: 'invalid_client_metadata', error_description: 'Send the client metadata as JSON.' }, 400);
    const uris = Array.isArray(m.redirect_uris) ? m.redirect_uris.filter((u): u is string => typeof u === 'string') : [];
    if (!uris.length || uris.length > 10 || !uris.every((u) => u.length <= 500 && redirectAllowed(u))) {
        return c.json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris must be https URLs (or http://localhost for local apps).' }, 400);
    }
    const grants = Array.isArray(m.grant_types) ? m.grant_types : ['authorization_code'];
    if (!grants.every((g) => g === 'authorization_code' || g === 'refresh_token')) return c.json({ error: 'invalid_client_metadata', error_description: 'Only authorization_code and refresh_token grants are supported.' }, 400);
    const method = typeof m.token_endpoint_auth_method === 'string' ? m.token_endpoint_auth_method : 'none';
    if (!['none', 'client_secret_post', 'client_secret_basic'].includes(method)) return c.json({ error: 'invalid_client_metadata', error_description: `token_endpoint_auth_method ${method} is not supported.` }, 400);
    const name = (typeof m.client_name === 'string' ? m.client_name : 'An MCP client').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 80) || 'An MCP client';
    const clientUri = typeof m.client_uri === 'string' && /^https:\/\//.test(m.client_uri) ? m.client_uri.slice(0, 300) : null;
    const id = `ocl_${b64url(randomBytes(18))}`;
    const secret = method === 'none' ? null : `ocs_${b64url(randomBytes(32))}`;
    await asSystem(async () => {
        await db().query(`DELETE FROM oauth_clients c WHERE c.created_at < now() - interval '7 days' AND c.last_used_at IS NULL
                            AND NOT EXISTS (SELECT 1 FROM mcp_tokens t WHERE t.client_id = c.client_id)`);
        await db().query('INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, client_uri, redirect_uris, auth_method, created_ip) VALUES ($1, $2, $3, $4, $5, $6, $7)',
            [id, secret ? sha256(secret) : null, name, clientUri, uris, method, ip]);
    });
    return c.json({
        client_id: id, ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}), client_id_issued_at: Math.floor(Date.now() / 1000),
        client_name: name, ...(clientUri ? { client_uri: clientUri } : {}), redirect_uris: uris, grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'], token_endpoint_auth_method: method, scope: SCOPE,
    }, 201);
});

oauth.post('/token', async (c) => {
    const ip = clientIp(c);
    if (tooMany(`tok:${ip}`, 60, 60_000)) return c.json({ error: 'invalid_request', error_description: 'Too many requests.' }, 429);
    const f = await readForm(c);
    const client = await authClient(c, f);
    if (!client) return oauthError(c, 401, 'invalid_client', 'Unknown client or wrong client secret.');
    c.header('Cache-Control', 'no-store');
    return asSystem(async () => {
        if (f.grant_type === 'authorization_code') {
            if (!f.code || !f.code_verifier || !/^[A-Za-z0-9._~-]{43,128}$/.test(f.code_verifier)) return oauthError(c, 400, 'invalid_request', 'code and code_verifier are required.');
            // single use: mark it used in the same statement that reads it
            const { rows: [code] } = await db().query<{ client_id: string; user_id: number; workspace_id: number; redirect_uri: string; code_challenge: string; resource: string; expired: boolean; was_used: boolean }>(
                `UPDATE oauth_codes o SET used_at = now() FROM (SELECT code_hash, used_at AS prev_used FROM oauth_codes WHERE code_hash = $1 FOR UPDATE) p
                  WHERE o.code_hash = p.code_hash
                  RETURNING o.client_id, o.user_id, o.workspace_id, o.redirect_uri, o.code_challenge, o.resource, (o.expires_at < now()) AS expired, (p.prev_used IS NOT NULL) AS was_used`,
                [sha256(f.code)]);
            if (!code || code.was_used || code.expired || code.client_id !== client.client_id) {
                if (code?.was_used) await db().query("UPDATE mcp_tokens SET revoked_at = now() WHERE client_id = $1 AND user_id = $2 AND revoked_at IS NULL AND created_at > now() - interval '10 minutes'", [code.client_id, code.user_id]);
                return oauthError(c, 400, 'invalid_grant', 'The code is invalid, expired or already used.');
            }
            if (f.redirect_uri && f.redirect_uri !== code.redirect_uri) return oauthError(c, 400, 'invalid_grant', 'redirect_uri does not match.');
            if (f.resource && f.resource.replace(/\/$/, '') !== code.resource) return oauthError(c, 400, 'invalid_target', 'This console only issues access to its MCP server.');
            if (b64url(createHash('sha256').update(f.code_verifier).digest()) !== code.code_challenge) return oauthError(c, 400, 'invalid_grant', 'PKCE verification failed.');
            if (!(await stillMember(code.user_id, code.workspace_id))) return oauthError(c, 400, 'invalid_grant', 'The account no longer has access to that workspace.');
            // keep the newest grants per person
            await db().query(`UPDATE mcp_tokens SET revoked_at = now() WHERE id IN (
                                SELECT id FROM mcp_tokens WHERE user_id = $1 AND kind = 'oauth' AND revoked_at IS NULL ORDER BY created_at DESC OFFSET $2)`, [code.user_id, MAX_GRANTS_PER_USER - 1]);
            const p = newPair();
            const { rows: [t] } = await db().query<{ id: number }>(
                `INSERT INTO mcp_tokens (workspace_id, user_id, name, token_hash, prefix, expires_at, kind, client_id, refresh_hash, refresh_expires_at)
                 VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6), 'oauth', $7, $8, now() + make_interval(days => $9)) RETURNING id`,
                [code.workspace_id, code.user_id, client.client_name, sha256(p.access), p.access.slice(0, 10), ACCESS_TTL_S, client.client_id, sha256(p.refresh), REFRESH_TTL_DAYS]);
            await db().query('UPDATE oauth_clients SET last_used_at = now() WHERE client_id = $1', [client.client_id]);
            const { rows: [u] } = await db().query<{ username: string }>('SELECT username FROM users WHERE id = $1', [code.user_id]);
            await db().query('INSERT INTO audit_log (workspace_id, user_id, username, action, target, detail, ip) VALUES ($1, $2, $3, $4, $5, $6, $7)',
                [code.workspace_id, code.user_id, u?.username ?? '?', 'mcp.oauth_connected', client.client_name, JSON.stringify({ id: t.id, client: client.client_id }), ip]).catch(() => undefined);
            return c.json(tokenResponse(p));
        }
        if (f.grant_type === 'refresh_token') {
            if (!f.refresh_token) return oauthError(c, 400, 'invalid_request', 'refresh_token is required.');
            const h = sha256(f.refresh_token);
            const { rows: [t] } = await db().query<{ id: number; user_id: number; workspace_id: number; client_id: string; live: boolean }>(
                `SELECT id, user_id, workspace_id, client_id, (revoked_at IS NULL AND refresh_expires_at > now()) AS live FROM mcp_tokens WHERE refresh_hash = $1 AND kind = 'oauth' FOR UPDATE`, [h]);
            if (!t) {
                // a refresh token that was already rotated away: treat as stolen and end that grant
                await db().query("UPDATE mcp_tokens SET revoked_at = now() WHERE prev_refresh_hash = $1 AND kind = 'oauth' AND revoked_at IS NULL", [h]);
                return oauthError(c, 400, 'invalid_grant', 'The refresh token is invalid or was already used.');
            }
            if (!t.live || t.client_id !== client.client_id) return oauthError(c, 400, 'invalid_grant', 'The refresh token is invalid, expired or revoked.');
            if (!(await stillMember(t.user_id, t.workspace_id))) {
                await db().query('UPDATE mcp_tokens SET revoked_at = now() WHERE id = $1', [t.id]);
                return oauthError(c, 400, 'invalid_grant', 'The account no longer has access to that workspace.');
            }
            const p = newPair();
            await db().query(
                `UPDATE mcp_tokens SET token_hash = $2, prefix = $3, expires_at = now() + make_interval(secs => $4), prev_refresh_hash = refresh_hash, refresh_hash = $5,
                        refresh_expires_at = now() + make_interval(days => $6) WHERE id = $1`,
                [t.id, sha256(p.access), p.access.slice(0, 10), ACCESS_TTL_S, sha256(p.refresh), REFRESH_TTL_DAYS]);
            return c.json(tokenResponse(p));
        }
        return oauthError(c, 400, 'unsupported_grant_type', 'Use authorization_code or refresh_token.');
    });
});

/** RFC 7009: revoke an access or refresh token (always 200, even for unknown tokens). */
oauth.post('/revoke', async (c) => {
    const f = await readForm(c);
    const client = await authClient(c, f);
    if (!client) return oauthError(c, 401, 'invalid_client', 'Unknown client or wrong client secret.');
    if (f.token) {
        const h = sha256(f.token);
        await asSystem(() => db().query("UPDATE mcp_tokens SET revoked_at = now() WHERE kind = 'oauth' AND client_id = $2 AND (token_hash = $1 OR refresh_hash = $1) AND revoked_at IS NULL", [h, client.client_id]));
    }
    return c.body(null, 200);
});

// ------------------------------------------------------------------ /api/oauth: the approval page (signed-in person; session + CSRF checks apply)
export const oauthConsent = new Hono<Env>();
oauthConsent.use('*', requireRole('viewer'), denyDemo);
const pick = (q: Record<string, unknown>): Partial<AuthorizeRequest> => Object.fromEntries(
    ['client_id', 'redirect_uri', 'response_type', 'code_challenge', 'code_challenge_method', 'scope', 'state', 'resource']
        .map((k) => [k, typeof q[k] === 'string' ? (q[k] as string).slice(0, 600) : undefined])) as Partial<AuthorizeRequest>;

oauthConsent.post('/check', async (c) => {
    const user = c.get('user')!;
    const q = pick(await c.req.json().catch(() => ({})));
    try {
        const { client } = await checkAuthorize(q);
        const { rows: workspaces } = config.multiTenant
            ? await asSystem(() => db().query<{ id: number; name: string; role: string }>(
                'SELECT w.id, w.name, m.role FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = $1 AND w.suspended_at IS NULL ORDER BY w.name', [user.id]))
            : { rows: [{ id: 1, name: config.productName, role: user.role }] };
        let host = '';
        try { host = new URL(q.redirect_uri!).host; } catch { /* checked above */ }
        return c.json({ client: { name: client.client_name, uri: client.client_uri, redirectHost: host }, workspaces, current: user.workspaceId, scope: SCOPE });
    } catch (err) {
        if (err instanceof OAuthRequestError) {
            // client and redirect URI were valid (checked first), so the app can be told what went wrong
            if (err.redirectable) return c.json({ error: err.message, redirect: redirectWith(q.redirect_uri!, { error: err.error, error_description: err.message, state: q.state }) }, 400);
            return c.json({ error: err.message }, 400);
        }
        throw err;
    }
});
oauthConsent.post('/decide', async (c) => {
    const user = c.get('user')!;
    const b = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const q = pick(b);
    try {
        const { req, client } = await checkAuthorize(q);
        if (b.approve !== true) return c.json({ redirect: redirectWith(req.redirect_uri, { error: 'access_denied', error_description: 'The person declined.', state: req.state }) });
        const ws = config.multiTenant ? Number(b.workspaceId) : 1;
        if (!Number.isInteger(ws) || !(await asSystem(() => stillMember(user.id, ws)))) return c.json({ error: 'Choose one of your workspaces.' }, 400);
        const { rows: [w] } = await asSystem(() => db().query<{ suspended: boolean }>('SELECT suspended_at IS NOT NULL AS suspended FROM workspaces WHERE id = $1', [ws]));
        if (config.multiTenant && (!w || w.suspended)) return c.json({ error: 'That workspace is suspended.' }, 400);
        const code = await issueCode(req, user.id, ws);
        await asSystem(() => db().query('INSERT INTO audit_log (workspace_id, user_id, username, action, target, detail, ip) VALUES ($1, $2, $3, $4, $5, $6, $7)',
            [ws, user.id, user.username, 'mcp.oauth_approved', client.client_name, JSON.stringify({ client: client.client_id }), c.get('ip')])).catch(() => undefined);
        return c.json({ redirect: redirectWith(req.redirect_uri, { code, state: req.state, iss: base() }) });
    } catch (err) {
        if (err instanceof OAuthRequestError) return c.json({ error: err.message }, 400);
        throw err;
    }
});
