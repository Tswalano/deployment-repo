import { Context, Hono } from 'hono';
import { audit } from '../audit';
import { InstanceRow } from '../collector';
import { asSystem, db, withWorkspace } from '../db';
import { config } from '../config';
import { DeployError, requestDeployment } from '../deploys';
import {
    allRepos, branches, BRANCH_RE, exchangeManifestCode, githubConfig, installations, manifest, newState, recordDelivery, REPO_RE,
    saveGithubConfig, verifySignature, WEBHOOK_URL,
} from '../github';
import { denyDemo, Env, rateLimit, requireRole } from '../middleware';

const github = new Hono<Env>();
const fail = (c: Context<Env>, err: unknown) => c.json({ error: (err as Error).message.slice(0, 300) }, err instanceof DeployError ? err.status : 502);

/** Connection status (no secrets). Each workspace sees only its own app and that app's installations. */
github.get('/', requireRole('deployer'), denyDemo, async (c) => {
    const cfg = await githubConfig();
    if (!cfg) return c.json({ connected: false, webhookUrl: WEBHOOK_URL });
    const base = { connected: true, app: { slug: cfg.slug, owner: cfg.owner, htmlUrl: cfg.htmlUrl }, webhookUrl: WEBHOOK_URL,
        installUrl: `https://github.com/apps/${cfg.slug}/installations/new` };
    try { return c.json({ ...base, installations: await installations(cfg) }); }
    catch (err) { return c.json({ ...base, installations: [], error: (err as Error).message }); }
});

/** Step 1: the browser posts this manifest to GitHub, which creates a private app and redirects back with a code. */
github.post('/manifest', requireRole('admin'), denyDemo, async (c) => {
    if (await githubConfig()) return c.json({ error: 'GitHub is already connected. Disconnect it first.' }, 409);
    const b = await c.req.json().catch(() => ({}));
    const org = typeof b.org === 'string' && /^[A-Za-z0-9-]{1,39}$/.test(b.org) ? b.org : null;
    const origin = c.req.header('origin') || 'https://ops.glenify.studio';
    const state = newState();
    await db().query(`INSERT INTO settings (key, value, updated_by) VALUES ('github_state', $1, $2)
                      ON CONFLICT (workspace_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
        [JSON.stringify({ state, at: Date.now() }), c.get('user')!.username]);
    return c.json({
        action: org ? `https://github.com/organizations/${org}/settings/apps/new?state=${state}` : `https://github.com/settings/apps/new?state=${state}`,
        manifest: manifest(origin, `Ops Console ${Math.random().toString(36).slice(2, 6)}`),
    });
});

/** Step 2: GitHub redirected back with ?code&state; swap the code for the app's credentials (stored in SSM). */
github.post('/exchange', requireRole('admin'), denyDemo, async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const { rows } = await db().query("SELECT value FROM settings WHERE key = 'github_state'");
    const st = rows[0]?.value as { state: string; at: number } | undefined;
    if (!st || st.state !== b.state || Date.now() - st.at > 3_600_000) return c.json({ error: 'This setup link has expired or was not started here. Start again.' }, 400);
    try {
        if (await githubConfig()) return c.json({ error: 'GitHub is already connected.' }, 409);
        const user = c.get('user')!;
        const cfg = await exchangeManifestCode(String(b.code ?? ''));
        await saveGithubConfig(cfg, user.username);
        await db().query("DELETE FROM settings WHERE key = 'github_state'");
        repoCache.delete(user.workspaceId ?? 0);
        await audit({ id: user.id, username: user.username }, 'github.connect', `${cfg.slug} (${cfg.owner})`, {}, c.get('ip'));
        return c.json({ connected: true, installUrl: `https://github.com/apps/${cfg.slug}/installations/new` });
    } catch (err) { return fail(c, err); }
});

github.delete('/', requireRole('admin'), denyDemo, async (c) => {
    const cfg = await githubConfig();
    const user = c.get('user')!;
    await saveGithubConfig(null, user.username);
    repoCache.delete(user.workspaceId ?? 0);
    await audit({ id: user.id, username: user.username }, 'github.disconnect', cfg?.slug ?? 'github', {}, c.get('ip'));
    return c.json({ ok: true, deleteAppUrl: cfg ? `${cfg.htmlUrl.replace(/\/apps\//, '/settings/apps/')}/advanced` : null });
});

/** Repositories this workspace may use (per workspace: never another workspace's installations). */
const repoCache = new Map<number, { at: number; data: Awaited<ReturnType<typeof allRepos>> }>();
github.get('/repos', requireRole('deployer'), denyDemo, async (c) => {
    const cfg = await githubConfig();
    if (!cfg) return c.json({ error: 'GitHub is not connected.' }, 409);
    const ws = c.get('user')!.workspaceId ?? 0;
    try {
        const hit = repoCache.get(ws);
        if (!hit || Date.now() - hit.at > 60_000 || c.req.query('refresh') === '1') repoCache.set(ws, { at: Date.now(), data: await allRepos(cfg) });
        return c.json({ repos: repoCache.get(ws)!.data });
    } catch (err) { return fail(c, err); }
});

github.get('/branches', requireRole('deployer'), denyDemo, async (c) => {
    const repo = c.req.query('repo') ?? '';
    if (!REPO_RE.test(repo)) return c.json({ error: 'Invalid repository.' }, 400);
    try { return c.json({ branches: await branches(repo) }); } catch (err) { return fail(c, err); }
});

/** GitHub → console. Public, authenticated by the HMAC signature; each delivery is handled once. */
github.post('/webhook', rateLimit(120, 60_000, () => 'github-webhook'), async (c) => {
    const body = await c.req.text();
    // multi-customer: the delivery names the app it's for; find that app's workspace, then check the signature with ITS secret
    let workspaceId: number | null = null;
    if (config.multiTenant) {
        const appId = Number(c.req.header('x-github-hook-installation-target-id') ?? 0);
        const { rows } = await asSystem(() => db().query<{ workspace_id: number }>('SELECT workspace_id FROM github_apps WHERE app_id = $1', [appId]));
        workspaceId = rows[0]?.workspace_id ?? ((await githubConfig(1))?.appId === String(appId) ? 1 : null);
        if (workspaceId == null) return c.json({ error: 'unknown app' }, 401);
    }
    const cfg = await githubConfig(config.multiTenant ? workspaceId : undefined);
    if (!cfg || !verifySignature(cfg.webhookSecret, body, c.req.header('x-hub-signature-256'))) return c.json({ error: 'bad signature' }, 401);
    const event = c.req.header('x-github-event') ?? 'unknown';
    const delivery = c.req.header('x-github-delivery') ?? `${Date.now()}`;
    let p: { ref?: string; after?: string; deleted?: boolean; repository?: { full_name?: string } };
    try { p = JSON.parse(body); } catch { return c.json({ error: 'bad json' }, 400); }
    const repo = p.repository?.full_name ?? null;
    const branch = p.ref?.startsWith('refs/heads/') ? p.ref.slice(11) : null;
    const sha = p.after && /^[0-9a-f]{40}$/.test(p.after) && !p.deleted ? p.after : null;
    const run = async () => {
        if (event !== 'push') {
            await recordDelivery(delivery, event, repo, null, null, 'ignored');
            return { ok: true, ignored: event };
        }
        return handlePush(delivery, event, repo, branch, sha, p.ref ?? null);
    };
    return c.json(config.multiTenant ? await withWorkspace(workspaceId, run) : await run());
});

async function handlePush(delivery: string, event: string, repo: string | null, branch: string | null, sha: string | null, ref: string | null) {
    if (!repo || !branch || !sha) {
        await recordDelivery(delivery, event, repo, ref, null, 'ignored: not a branch push');
        return { ok: true };
    }
    const { rows } = await db().query<{ instance_id: number; project: string }>(
        'SELECT instance_id, project FROM app_repos WHERE lower(repo) = lower($1) AND branch = $2 AND auto_deploy', [repo, branch]);
    const results: string[] = [];
    for (const r of rows) {
        const { rows: [inst] } = await db().query<InstanceRow>('SELECT * FROM instances WHERE id = $1', [r.instance_id]);
        if (!inst) continue;
        try {
            const d = await requestDeployment(inst, r.project, 'deploy', sha, { id: null, username: 'github', role: 'deployer' }, undefined, 'github');
            results.push(`${r.project}: ${d.status}`);
            await audit({ id: null, username: 'github' }, d.status === 'pending_approval' ? 'app.deploy_requested' : 'app.deploy',
                `${r.project} on ${inst.name}`, { ref: sha.slice(0, 8), trigger: 'github push', repo, branch }, null);
        } catch (err) {
            results.push(`${r.project}: ${(err as Error).message.slice(0, 120)}`);
        }
    }
    const fresh = await recordDelivery(delivery, event, repo, branch, sha.slice(0, 12), results.join('; ') || 'no auto-deploy app for this branch');
    if (!fresh) return { ok: true, duplicate: true };
    return { ok: true, results };
}

/** Linking a repo to an app (and auto-deploy) lives on the app: /api/instances/:id/apps/:project/repo */
export const appRepo = new Hono<Env>();
appRepo.put('/:id/apps/:project/repo', requireRole('admin'), denyDemo, async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const repo = String(b.repo ?? ''), branch = String(b.branch ?? 'main');
    if (!REPO_RE.test(repo) || !BRANCH_RE.test(branch)) return c.json({ error: 'Pick a repository and branch.' }, 400);
    const { rows: [inst] } = await db().query<InstanceRow>('SELECT * FROM instances WHERE id = $1', [Number(c.req.param('id'))]);
    const project = c.req.param('project');
    if (!inst || !inst.last_status?.apps.some((a) => a.project === project)) return c.json({ error: 'App not found' }, 404);
    const user = c.get('user')!;
    await db().query(
        `INSERT INTO app_repos (instance_id, project, repo, branch, auto_deploy, linked_by) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (instance_id, project) DO UPDATE SET repo = EXCLUDED.repo, branch = EXCLUDED.branch, auto_deploy = EXCLUDED.auto_deploy, linked_by = EXCLUDED.linked_by`,
        [inst.id, project, repo, branch, !!b.autoDeploy, user.username]);
    await audit({ id: user.id, username: user.username }, 'app.repo', `${project} on ${inst.name}`, { repo, branch, autoDeploy: !!b.autoDeploy }, c.get('ip'));
    return c.json({ repo: { repo, branch, autoDeploy: !!b.autoDeploy } });
});
appRepo.delete('/:id/apps/:project/repo', requireRole('admin'), denyDemo, async (c) => {
    await db().query('DELETE FROM app_repos WHERE instance_id = $1 AND project = $2', [Number(c.req.param('id')), c.req.param('project')]);
    const user = c.get('user')!;
    await audit({ id: user.id, username: user.username }, 'app.repo', `${c.req.param('project')}`, { unlinked: true }, c.get('ip'));
    return c.json({ ok: true });
});

export default github;
