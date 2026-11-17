import { createHmac, createSign, randomBytes, timingSafeEqual } from 'crypto';
import { config } from './config';
import { aws, hostAws } from './aws';
import { db } from './db';

/**
 * GitHub App integration. The app is created from a manifest (one click), its credentials live in SSM under
 * /ops-console/github/* (SecureString), and every GitHub call uses a short-lived installation token.
 */
const API = 'https://api.github.com';
const PARAM = '/ops-console/github';
const REGION = process.env.CONSOLE_REGION || process.env.AWS_REGION || 'af-south-1';
export const WEBHOOK_URL = process.env.GITHUB_WEBHOOK_URL || 'https://ops.glenify.studio/api/github/webhook';
export const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
export const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;

export interface GitHubConfig { appId: string; slug: string; privateKey: string; webhookSecret: string; htmlUrl: string; owner: string; clientId?: string; clientSecret?: string }

let cfgCache: { at: number; cfg: GitHubConfig | null } | null = null;
export async function githubConfig(): Promise<GitHubConfig | null> {
    if (cfgCache && Date.now() - cfgCache.at < 60_000) return cfgCache.cfg;
    const a = hostAws();   // the platform's app lives in the console host's account, never a customer's
    const raw = a.getConsoleSecret ? await a.getConsoleSecret(REGION, `${PARAM}/app`).catch(() => null) : null;
    const cfg = raw ? JSON.parse(raw) as GitHubConfig : null;
    cfgCache = { at: Date.now(), cfg };
    return cfg;
}
export async function saveGithubConfig(cfg: GitHubConfig | null): Promise<void> {
    const a = hostAws();
    if (!a.putConsoleSecret || !a.deleteConsoleSecret) throw new Error('Secret storage is not available.');
    if (cfg) await a.putConsoleSecret(REGION, `${PARAM}/app`, JSON.stringify(cfg));
    else await a.deleteConsoleSecret(REGION, `${PARAM}/app`);
    cfgCache = null;
}

// ------------------------------------------------------------------ app manifest flow
export function manifest(origin: string, name: string) {
    return {
        name, url: origin.startsWith('http://localhost') || origin.startsWith('http://127.') ? 'https://ops.glenify.studio' : origin,
        hook_attributes: { url: WEBHOOK_URL, active: true },
        redirect_url: `${origin}/github/callback`,
        // multi-customer: GitHub asks the installer to authorise the app, so the console can confirm which
        // installations that person can access before linking one to their workspace
        ...(config.multiTenant
            ? { setup_url: `${origin}/github/installed`, callback_urls: [`${origin}/github/installed`], request_oauth_on_install: true }
            : { setup_url: `${origin}/github/callback?installed=1` }),
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
/** The installations this workspace may use: its own linked ones (multi-customer), or all of the app's. */
export async function workspaceInstallations(cfg: GitHubConfig): Promise<Installation[]> {
    if (!config.multiTenant) return installations(cfg);
    const { rows } = await db().query<{ installation_id: string; account_login: string }>('SELECT installation_id, account_login FROM github_installations ORDER BY linked_at');
    return rows.map((r) => ({ id: Number(r.installation_id), account: r.account_login, selection: 'selected' as const }));
}

export async function allRepos(cfg: GitHubConfig): Promise<Repo[]> {
    const out: Repo[] = [];
    for (const inst of await workspaceInstallations(cfg)) {
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

// ------------------------------------------------------------------ linking an installation to a workspace
/**
 * After "install the app" GitHub returns ?code&installation_id. Exchange the code for the installing user's token
 * and link the installation ONLY if GitHub lists it among the installations that user can access. (An installation
 * id alone proves nothing: it's a small number anyone could guess.)
 */
export async function linkInstallation(code: string, installationId: number | null, by: string): Promise<{ account: string }> {
    const cfg = await githubConfig();
    if (!cfg?.clientId || !cfg.clientSecret) throw new Error('The GitHub App is not set up for installations yet.');
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(code) || (installationId !== null && (!Number.isInteger(installationId) || installationId <= 0))) throw new Error('Invalid GitHub response.');
    const t = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'ops-console' },
        body: JSON.stringify({ client_id: cfg.clientId, client_secret: cfg.clientSecret, code }), signal: AbortSignal.timeout(15_000),
    }).then((r) => r.json() as Promise<{ access_token?: string; error_description?: string }>);
    if (!t.access_token) throw new Error(`GitHub didn't confirm the installation (${t.error_description ?? 'no token'}). Install the app again from the console.`);
    // the installations of THIS app that the signed-in GitHub user can access
    const mine: { id: number; account: { login: string; type: string } }[] = [];
    for (let page = 1; page <= 10; page++) {
        const r = await gh<{ installations: { id: number; account: { login: string; type: string } }[]; total_count: number }>(`/user/installations?per_page=100&page=${page}`, t.access_token, true);
        mine.push(...r.installations);
        if (r.installations.length < 100) break;
    }
    // a fresh install links that installation; "Link with GitHub" (no id) links every one this person can access
    const pick = installationId === null ? mine : mine.filter((i) => i.id === installationId);
    if (!pick.length) throw new Error(installationId === null ? "Your GitHub account can't access any installation of the app yet: install it first." : "You don't have access to that GitHub installation.");
    for (const f of pick) {
        await db().query(`INSERT INTO github_installations (installation_id, account_login, account_type, linked_by) VALUES ($1, $2, $3, $4)
                          ON CONFLICT (workspace_id, installation_id) DO UPDATE SET account_login = EXCLUDED.account_login`, [f.id, f.account.login, f.account.type, by]);
    }
    return { account: pick.map((f) => f.account.login).join(', ') };
}
