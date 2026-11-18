import { createHmac, createSign, randomBytes, timingSafeEqual } from 'crypto';
import { config } from './config';
import { aws, hostAws } from './aws';
import { currentWorkspace, db } from './db';

/**
 * GitHub App integration. The app is created from a manifest (one click), its credentials live in SSM under
 * /ops-console/github/* (SecureString), and every GitHub call uses a short-lived installation token.
 * Multi-customer: every workspace creates its OWN private app in its GitHub account (/ops-console/github/ws/<id>/app),
 * so its repositories are only ever reachable with its own credentials. Workspace 1 keeps the original app.
 */
const API = 'https://api.github.com';
const PARAM = '/ops-console/github';
const REGION = process.env.CONSOLE_REGION || process.env.AWS_REGION || 'af-south-1';
export const WEBHOOK_URL = process.env.GITHUB_WEBHOOK_URL || 'https://ops.glenify.studio/api/github/webhook';
export const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
export const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;

export interface GitHubConfig { appId: string; slug: string; privateKey: string; webhookSecret: string; htmlUrl: string; owner: string; clientId?: string; clientSecret?: string }

/** Where a workspace's app credentials live: the original path for workspace 1 (single-team), one path per workspace otherwise. */
export function configParam(workspaceId: number | null): string | null {
    if (!config.multiTenant || workspaceId === 1) return `${PARAM}/app`;
    return workspaceId == null ? null : `${PARAM}/ws/${workspaceId}/app`;
}
const cfgCache = new Map<string, { at: number; cfg: GitHubConfig | null }>();
/** Tests: forget cached app credentials. */
export const forgetGithubConfigs = () => cfgCache.clear();
/** The GitHub App of the current workspace (or of the given one), or null when it hasn't connected GitHub. */
export async function githubConfig(workspaceId: number | null = currentWorkspace()): Promise<GitHubConfig | null> {
    const name = configParam(workspaceId);
    if (!name) return null;
    const hit = cfgCache.get(name);
    if (hit && Date.now() - hit.at < 60_000) return hit.cfg;
    const a = hostAws();   // credentials live in the console host's account, never a customer's
    const raw = a.getConsoleSecret ? await a.getConsoleSecret(REGION, name).catch(() => null) : null;
    const cfg = raw ? JSON.parse(raw) as GitHubConfig : null;
    cfgCache.set(name, { at: Date.now(), cfg });
    return cfg;
}
export async function saveGithubConfig(cfg: GitHubConfig | null, by = 'system'): Promise<void> {
    const ws = currentWorkspace();
    const name = configParam(ws);
    if (!name) throw new Error('No workspace selected.');
    const a = hostAws();
    if (!a.putConsoleSecret || !a.deleteConsoleSecret) throw new Error('Secret storage is not available.');
    if (cfg) await a.putConsoleSecret(REGION, name, JSON.stringify(cfg));
    else await a.deleteConsoleSecret(REGION, name);
    cfgCache.delete(name);
    if (config.multiTenant && ws != null) {
        // the app id -> workspace map used to route webhook deliveries
        await db().query('DELETE FROM github_apps');
        if (cfg) await db().query('INSERT INTO github_apps (app_id, slug, owner, created_by) VALUES ($1, $2, $3, $4)', [Number(cfg.appId), cfg.slug, cfg.owner, by]);
    }
}

// ------------------------------------------------------------------ app manifest flow
export function manifest(origin: string, name: string) {
    return {
        name, url: origin.startsWith('http://localhost') || origin.startsWith('http://127.') ? 'https://ops.glenify.studio' : origin,
        hook_attributes: { url: WEBHOOK_URL, active: true },
        redirect_url: `${origin}/github/callback`,
        setup_url: `${origin}/github/callback?installed=1`,
        setup_on_update: true,
        public: false,
        default_permissions: { contents: 'read', metadata: 'read' },
        default_events: ['push'],
    };
}
export const newState = () => randomBytes(16).toString('hex');

export async function exchangeManifestCode(code: string): Promise<GitHubConfig> {
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(code)) throw new Error('Invalid code.');
    const r = await fetch(`${API}/app-manifests/${code}/conversions`, { method: 'POST', headers: hdr() });
    if (!r.ok) throw new Error(`GitHub refused the app setup (HTTP ${r.status}). The link is single-use and expires after an hour; start again.`);
    const j = await r.json() as { id: number; slug: string; pem: string; webhook_secret: string; html_url: string; owner: { login: string }; client_id: string; client_secret: string };
    return { appId: String(j.id), slug: j.slug, privateKey: j.pem, webhookSecret: j.webhook_secret, htmlUrl: j.html_url, owner: j.owner.login, clientId: j.client_id, clientSecret: j.client_secret };
}

// ------------------------------------------------------------------ authentication
function hdr(token?: string, bearer = false): Record<string, string> {
    return { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'ops-console',
        ...(token ? { authorization: `${bearer ? 'Bearer' : 'token'} ${token}` } : {}) };
}
const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
export function appJwt(cfg: GitHubConfig, now = Math.floor(Date.now() / 1000)): string {
    const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const body = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: cfg.appId }));
    const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(cfg.privateKey);
    return `${head}.${body}.${b64url(sig)}`;
}

async function gh<T>(path: string, token: string, bearer = false, init: RequestInit = {}): Promise<T> {
    const r = await fetch(`${API}${path}`, { ...init, headers: { ...hdr(token, bearer), ...(init.headers ?? {}) }, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`GitHub ${path.split('?')[0]}: HTTP ${r.status}`);
    return r.status === 204 ? (undefined as T) : r.json() as Promise<T>;
}

export interface Installation { id: number; account: string; selection: 'all' | 'selected' }
export async function installations(cfg: GitHubConfig): Promise<Installation[]> {
    const list = await gh<{ id: number; account: { login: string }; repository_selection: 'all' | 'selected' }[]>('/app/installations', appJwt(cfg), true);
    return list.map((i) => ({ id: i.id, account: i.account.login, selection: i.repository_selection }));
}

/** Short-lived token (1h) for one installation, optionally narrowed to some repositories and read-only contents. */
export async function installationToken(cfg: GitHubConfig, installationId: number, repos?: string[]): Promise<string> {
    const body = repos ? { repositories: repos.map((r) => r.split('/')[1]), permissions: { contents: 'read', metadata: 'read' } } : undefined;
    const r = await gh<{ token: string }>(`/app/installations/${installationId}/access_tokens`, appJwt(cfg), true,
        { method: 'POST', body: body ? JSON.stringify(body) : undefined, headers: body ? { 'content-type': 'application/json' } : {} });
    return r.token;
}

export interface Repo { fullName: string; private: boolean; defaultBranch: string; pushedAt: string | null; installationId: number; description: string | null }
export async function allRepos(cfg: GitHubConfig): Promise<Repo[]> {
    const out: Repo[] = [];
    for (const inst of await installations(cfg)) {
        const token = await installationToken(cfg, inst.id);
        for (let page = 1; page <= 10; page++) {
            const r = await gh<{ repositories: { full_name: string; private: boolean; default_branch: string; pushed_at: string | null; description: string | null }[]; total_count: number }>(
                `/installation/repositories?per_page=100&page=${page}`, token);
            out.push(...r.repositories.map((x) => ({ fullName: x.full_name, private: x.private, defaultBranch: x.default_branch, pushedAt: x.pushed_at, installationId: inst.id, description: x.description })));
            if (out.length >= r.total_count || !r.repositories.length) break;
        }
    }
    return out.sort((a, b) => (b.pushedAt ?? '').localeCompare(a.pushedAt ?? ''));
}

export async function repoToken(repo: string): Promise<{ token: string; cfg: GitHubConfig }> {
    const cfg = await githubConfig();
    if (!cfg) throw new Error('GitHub is not connected.');
    const r = (await allRepos(cfg)).find((x) => x.fullName.toLowerCase() === repo.toLowerCase());
    if (!r) throw new Error(`The GitHub App can't see ${repo}. Add it to the app's repository access on GitHub.`);
    return { token: await installationToken(cfg, r.installationId, [r.fullName]), cfg };
}

export async function branches(repo: string): Promise<string[]> {
    const { token } = await repoToken(repo);
    const r = await gh<{ name: string }[]>(`/repos/${repo}/branches?per_page=100`, token);
    return r.map((b) => b.name);
}

/** Read one file from a repo (e.g. package.json) at a ref; null when missing. */
export async function repoFile(repo: string, path: string, ref: string): Promise<string | null> {
    const { token } = await repoToken(repo);
    const r = await fetch(`${API}/repos/${repo}/contents/${encodeURI(path)}?ref=${encodeURIComponent(ref)}`, { headers: hdr(token), signal: AbortSignal.timeout(15_000) });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`GitHub contents: HTTP ${r.status}`);
    const j = await r.json() as { content?: string; encoding?: string };
    return j.content ? Buffer.from(j.content, 'base64').toString('utf8') : null;
}

// ------------------------------------------------------------------ webhooks
export function verifySignature(secret: string, body: string, header: string | undefined): boolean {
    if (!header?.startsWith('sha256=')) return false;
    const want = Buffer.from(`sha256=${createHmac('sha256', secret).update(body).digest('hex')}`);
    const got = Buffer.from(header);
    return want.length === got.length && timingSafeEqual(want, got);
}

export async function recordDelivery(id: string, event: string, repo: string | null, ref: string | null, sha: string | null, result: string): Promise<boolean> {
    const r = await db().query(
        `INSERT INTO github_deliveries (id, event, repo, ref, sha, result) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`,
        [id.slice(0, 100), event.slice(0, 50), repo, ref, sha, result.slice(0, 300)]);
    await db().query("DELETE FROM github_deliveries WHERE at < now() - interval '60 days'");
    return (r.rowCount ?? 0) > 0;
}
