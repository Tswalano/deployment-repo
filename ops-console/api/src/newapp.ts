import { announce } from './alerts';
import { config } from './config';
import { resolve4 } from 'dns/promises';
import { aws, AwsProvider, dryRun, hostAws } from './aws';
import { InstanceRow } from './collector';
import { currentWorkspace, db } from './db';
import { actorFor, DeployError, DeploymentRow, Requester } from './deploys';
import { dropToken, stashToken } from './gittoken';
import { BRANCH_RE, REPO_RE, repoFile, repoToken } from './github';
import { activeFreeze, deployPolicy } from './policy';

export const CREATE_DOCUMENT = 'OpsConsole-CreateApp';
export const HTTPS_DOCUMENT = 'OpsConsole-EnableHttps';
/** Apps get a subdomain of this zone; the console manages its A records. */
export const APPS_DOMAIN = process.env.APPS_DOMAIN || 'glenify.studio';
let zoneCache: string | null = process.env.APPS_HOSTED_ZONE_ID || null;

/**
 * Multi-customer: how a workspace's apps get their addresses (Settings → App addresses):
 *   route53  - a domain whose DNS is a Route 53 zone in the workspace's own AWS account; the console manages the records
 *   external - a domain at any other DNS provider; the workspace adds one A record per app, then HTTPS is enabled
 *   platform - (default when the platform offers it) shop.<workspace slug>.<PLATFORM_APPS_DOMAIN>, managed by the platform
 */
export type AppsDomain = { mode?: 'route53'; domain: string; zoneId: string } | { mode: 'external'; domain: string } | { mode: 'platform' };
export async function workspaceAppsDomain(): Promise<AppsDomain | null> {
    const { rows } = await db().query<{ value: AppsDomain }>("SELECT value FROM settings WHERE key = 'apps_domain'");
    return rows[0]?.value ?? null;
}
export const platformDomainAvailable = () => !!(config.platformAppsDomain && config.platformAppsZoneId);
/** The platform address base of the current workspace, e.g. acme.apps.example.com (null when not offered). */
export async function platformBase(): Promise<string | null> {
    if (!platformDomainAvailable()) return null;
    const { rows: [w] } = await db().query<{ slug: string }>('SELECT slug FROM workspaces WHERE id = $1', [currentWorkspace()]);
    return w ? `${w.slug}.${config.platformAppsDomain}` : null;
}

/** Where an app's address comes from: its base domain and, when the console manages the DNS, the zone and the account it's in. */
export interface Target { kind: 'workspace' | 'platform' | 'external'; base: string; zoneId: string | null; provider: AwsProvider | null }
export async function addressTarget(): Promise<Target | null> {
    if (!config.multiTenant) {
        if (!zoneCache && aws().hostedZoneId) zoneCache = await aws().hostedZoneId!(APPS_DOMAIN).catch(() => null);
        return { kind: 'workspace', base: APPS_DOMAIN, zoneId: zoneCache, provider: aws() };
    }
    const s = await workspaceAppsDomain();
    if (s?.mode === 'external') return { kind: 'external', base: s.domain, zoneId: null, provider: null };
    if (s && s.mode !== 'platform') return { kind: 'workspace', base: s.domain, zoneId: s.zoneId, provider: aws() };
    const base = await platformBase();
    return base ? { kind: 'platform', base, zoneId: config.platformAppsZoneId, provider: hostAws() } : null;
}
/** The domain apps get subdomains of (null until the workspace has chosen). */
export async function appsDomain(): Promise<string | null> {
    return (await addressTarget())?.base ?? null;
}
const providerFor = (kind: string | null): AwsProvider | null => (kind === 'platform' ? hostAws() : kind === 'external' ? null : aws());

export const PROJECT_NEW_RE = /^[a-z][a-z0-9-]{1,30}$/;
const SCRIPT_RE = /^[a-z0-9:_-]{1,40}$/;
const SUBDIR_RE = /^[A-Za-z0-9_][A-Za-z0-9_./-]{0,99}$/;
const HEALTH_RE = /^\/[A-Za-z0-9._~/-]{0,100}$/;
const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const RESERVED = new Set(['ops-console', 'ops-dashboard', 'postgres', 'postgresql', 'nginx', 'app1', 'app2', 'www', 'ops', 'mail', 'api', 'admin', 'root', 'deploy']);
const LOW_MEMORY_MB = 120, WARN_MEMORY_MB = 250;

// ------------------------------------------------------------------ detect from package.json
export interface Detection {
    found: boolean; name: string | null; scripts: string[]; start: string | null; build: boolean; migrate: string | null;
    healthPath: string; node: string | null; warnings: string[];
    /** Builds static files only (Vite/CRA/…) with no server framework: nothing would answer the health check. */
    frontend: boolean;
}
export async function detect(repo: string, branch: string, subdir = ''): Promise<Detection> {
    if (!REPO_RE.test(repo) || !BRANCH_RE.test(branch) || (subdir && (!SUBDIR_RE.test(subdir) || subdir.includes('..')))) throw new DeployError('Invalid repository, branch or folder.');
    const raw = await repoFile(repo, `${subdir ? `${subdir.replace(/\/+$/, '')}/` : ''}package.json`, branch);
    if (!raw) return { found: false, name: null, scripts: [], start: null, build: false, migrate: null, healthPath: '/', node: null, frontend: false, warnings: [`No package.json in ${subdir || 'the repository root'} on ${branch}. Only Node.js apps are supported for now; if the app lives in a folder (e.g. backend), set the folder.`] };
    let pkg: { name?: string; scripts?: Record<string, string>; engines?: { node?: string }; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    try { pkg = JSON.parse(raw); } catch { throw new DeployError('package.json is not valid JSON.'); }
    const scripts = Object.keys(pkg.scripts ?? {}).filter((s) => SCRIPT_RE.test(s));
    const pick = (cands: string[]) => cands.find((c) => scripts.includes(c)) ?? null;
    const start = pick(['start', 'start:prod', 'serve', 'prod']);
    const warnings: string[] = [];
    if (!start) warnings.push('No start script found: add "start" (e.g. "node dist/server.js") to package.json, or pick another script.');
    const node = pkg.engines?.node ?? null;
    const minMajor = node ? Number(/(\d+)/.exec(node)?.[1] ?? 0) : 0;
    if (minMajor > 18 && !/\b18\b/.test(node!)) warnings.push(`package.json asks for Node ${node}; the instance runs Node 18.`);
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    if (deps.prisma && !scripts.includes('build') && !pick(['db:migrate', 'migrate', 'migrate:deploy', 'prisma:deploy'])) warnings.push('Uses Prisma: you may want a migrate script (e.g. "prisma migrate deploy").');
    const FRONTEND = ['vite', 'react-scripts', '@angular/cli', '@vue/cli-service', 'parcel', 'gatsby'];
    const SERVER = ['express', 'fastify', 'hono', '@hono/node-server', 'koa', '@nestjs/core', 'next', 'nuxt', '@remix-run/serve', '@sveltejs/adapter-node', 'h3', 'restify', '@hapi/hapi', 'polka', 'http-server', 'serve'];
    const frontend = FRONTEND.some((d) => d in deps) && !SERVER.some((d) => d in deps);
    if (frontend) {
        warnings.unshift(`This looks like a front-end app (${FRONTEND.filter((d) => d in deps).join(', ')}): its build makes static files and it has no server to start, so the first deploy's health check would fail. The console runs Node.js servers; hosting static front-ends isn't supported yet.`);
    }
    return { found: true, name: pkg.name ?? null, scripts, start, build: scripts.includes('build'), migrate: pick(['db:migrate', 'migrate:deploy', 'migrate', 'prisma:deploy']),
        healthPath: '/', node, warnings, frontend };
}

// ------------------------------------------------------------------ pre-flight checks
export interface Check { project: { ok: boolean; reason?: string }; domain: { status: 'free' | 'ours' | 'taken' | 'invalid' | 'external'; name: string; reason?: string }; memoryMb: number | null; memoryWarning: string | null; publicIp: string | null }

export async function check(inst: InstanceRow, project: string, subdomain: string): Promise<Check> {
    const apps = inst.last_status?.apps ?? [];
    let p: Check['project'] = { ok: true };
    if (!PROJECT_NEW_RE.test(project)) p = { ok: false, reason: 'Use 2–31 lowercase letters, digits or dashes, starting with a letter.' };
    else if (RESERVED.has(project)) p = { ok: false, reason: 'That name is reserved.' };
    else if (apps.some((a) => a.project === project || a.service === project)) p = { ok: false, reason: `${project} already exists on ${inst.name}.` };
    else {
        const { rows } = await db().query("SELECT 1 FROM app_creations WHERE instance_id = $1 AND project = $2 AND status IN ('running', 'success')", [inst.id, project]);
        if (rows.length) p = { ok: false, reason: `${project} was already created here.` };
    }
    const t = await addressTarget();
    const name = `${subdomain}.${t?.base ?? 'your-domain'}`;
    const info = await aws().describeInstance(inst.region, inst.aws_instance_id).catch(() => null);
    const ip = info?.publicIp ?? null;
    let d: Check['domain'];
    if (!LABEL_RE.test(subdomain)) d = { status: 'invalid', name, reason: 'Use lowercase letters, digits and dashes.' };
    else if (RESERVED.has(subdomain)) d = { status: 'taken', name, reason: 'That subdomain is reserved.' };
    else if (!t) d = { status: 'invalid', name, reason: 'Choose how apps get their addresses first: Settings → App addresses.' };
    else if (t.kind === 'external') {
        // DNS at another provider: the record is added by the workspace; HTTPS follows once it points here
        const now = await resolve4(name).catch(() => [] as string[]);
        if (ip && now.length && now.every((x) => x === ip)) d = { status: 'ours', name, reason: 'Already points at this server.' };
        else d = { status: 'external', name, reason: now.length
            ? `${name} points at ${now.join(', ')} today. After creating the app, change its A record to ${ip ?? 'the server address'}; HTTPS is enabled once it points here.`
            : `After creating the app, add an A record for ${name} pointing at ${ip ?? 'the server address'}; HTTPS is enabled once it resolves.` };
    }
    else if (!t.zoneId || !t.provider?.dnsRecords) d = { status: 'invalid', name, reason: `No Route 53 hosted zone for ${t.base} is reachable.` };
    else {
        const recs = await t.provider.dnsRecords!(t.zoneId, name);
        if (!recs.length) d = { status: 'free', name };
        else if (recs.every((r) => r.type === 'A' && ip && r.values.length === 1 && r.values[0] === ip)) d = { status: 'ours', name, reason: 'Already points at this instance.' };
        else d = { status: 'taken', name, reason: `${name} already has a ${recs.map((r) => r.type).join('/')} record pointing elsewhere.` };
    }
    const mem = inst.last_status?.host.memory;
    const memoryMb = mem ? Math.round(mem.available / 1048576) : null;
    const memoryWarning = memoryMb == null ? null : memoryMb < LOW_MEMORY_MB
        ? `Only ${memoryMb} MB of memory is free on ${inst.name}. Another app may make the others crash; consider a bigger instance.`
        : memoryMb < WARN_MEMORY_MB ? `${memoryMb} MB of memory is free on ${inst.name}; a small Node app needs about 80–150 MB.` : null;
    return { project: p, domain: d, memoryMb, memoryWarning, publicIp: ip };
}

// ------------------------------------------------------------------ create
export interface NewApp {
    project: string; repo: string; branch: string; subdir: string; start: string; build: boolean; migrate: string;
    healthPath: string; subdomain: string; db: boolean; memoryMb: number; confirmLowMemory?: boolean; override?: string;
}

export function validate(b: Record<string, unknown>): NewApp {
    const s = (k: string, d = '') => (typeof b[k] === 'string' ? (b[k] as string).trim() : d);
    const v: NewApp = {
        project: s('project'), repo: s('repo'), branch: s('branch', 'main'), subdir: s('subdir').replace(/^\/+|\/+$/g, ''), start: s('start', 'start'),
        build: b.build === true, migrate: s('migrate'), healthPath: s('healthPath', '/') || '/', subdomain: s('subdomain').toLowerCase(),
        db: b.db === true, memoryMb: Math.round(Number(b.memoryMb ?? 256)), confirmLowMemory: b.confirmLowMemory === true,
        override: typeof b.override === 'string' ? b.override.trim().slice(0, 300) : undefined,
    };
    if (!PROJECT_NEW_RE.test(v.project)) throw new DeployError('Invalid app name.');
    if (!REPO_RE.test(v.repo)) throw new DeployError('Invalid repository.');
    if (!BRANCH_RE.test(v.branch) || v.branch.includes('..')) throw new DeployError('Invalid branch.');
    if (v.subdir && (!SUBDIR_RE.test(v.subdir) || v.subdir.includes('..'))) throw new DeployError('Invalid app folder.');
    if (!SCRIPT_RE.test(v.start)) throw new DeployError('Invalid start script.');
    if (v.migrate && !SCRIPT_RE.test(v.migrate)) throw new DeployError('Invalid migrate script.');
    if (!HEALTH_RE.test(v.healthPath)) throw new DeployError('Invalid health path.');
    if (!LABEL_RE.test(v.subdomain)) throw new DeployError('Invalid subdomain.');
    if (!Number.isFinite(v.memoryMb) || v.memoryMb < 64 || v.memoryMb > 2048) throw new DeployError('Memory limit must be 64–2048 MB.');
    return v;
}

export async function createApp(inst: InstanceRow, v: NewApp, user: Requester): Promise<DeploymentRow> {
    const c = await check(inst, v.project, v.subdomain);
    if (!c.project.ok) throw new DeployError(c.project.reason!, 409);
    if (c.domain.status === 'taken' || c.domain.status === 'invalid') throw new DeployError(c.domain.reason ?? 'That domain cannot be used.', 409);
    if (c.memoryMb != null && c.memoryMb < LOW_MEMORY_MB && !v.confirmLowMemory) throw new DeployError(c.memoryWarning!, 409, 'low_memory');
    if (!c.publicIp) throw new DeployError(`${inst.name} has no public IP address, so the app can't get a domain.`, 409);
    const policy = await deployPolicy();
    const freeze = activeFreeze(policy, inst.environment);
    if (freeze && (!v.override || v.override.length < 10)) {
        throw new DeployError(`Deploys to ${inst.environment} are frozen (“${freeze.name}”). Give an override reason to create the app anyway.`, 409, 'frozen');
    }
    await repoToken(v.repo);   // throws a clear error if the GitHub App can't see the repository
    // DNS first, and wait until Route 53 reports it live (capped so the request stays well under proxy timeouts)
    const t = (await addressTarget())!;
    const dnsCreated = c.domain.status === 'free' && t.kind !== 'external';
    if (dnsCreated) {
        const change = await t.provider!.upsertARecord!(t.zoneId!, c.domain.name, c.publicIp);
        if (change && t.provider!.waitDnsChange) await t.provider!.waitDnsChange!(change, 60_000);
    }
    const undoDns = async () => { if (dnsCreated) await removeDns(t.kind, t.zoneId, c.domain.name, c.publicIp!).catch((e) => console.error('DNS cleanup failed:', (e as Error).message)); };

    const token = await stashToken(inst.region, v.project, v.repo);
    let row: DeploymentRow;
    try {
        ({ rows: [row] } = await db().query<DeploymentRow>(
            `INSERT INTO deployments (instance_id, project, action, ref, requested_by, requested_by_name, trigger, token_param, override_reason)
             VALUES ($1, $2, 'create', $3, $4, $5, 'console', $6, $7) RETURNING *`,
            [inst.id, v.project, v.branch, user.id, user.username, token, freeze ? v.override : null]));
        await db().query(
            `INSERT INTO app_creations (deployment_id, instance_id, project, repo, branch, domain, with_db, created_by, dns_created, dns_provider, dns_zone)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [row.id, inst.id, v.project, v.repo, v.branch, c.domain.name, v.db, user.username, dnsCreated, t.kind, t.zoneId]);
    } catch (err) {
        await dropToken(inst.region, token);
        await undoDns();
        if ((err as { code?: string }).code === '23505') throw new DeployError(`${v.project} is already being created.`, 409);
        throw err;
    }
    try {
        const commandId = await aws().sendDocument(inst.region, inst.aws_instance_id, CREATE_DOCUMENT, {
            project: [v.project], repo: [v.repo], branch: [v.branch], appSubdir: [v.subdir], startScript: [v.start], build: [v.build ? 'yes' : 'no'],
            migrateScript: [v.migrate], healthPath: [v.healthPath], domain: [c.domain.name], db: [v.db ? 'yes' : 'no'], memoryMb: [String(v.memoryMb)],
            actor: [actorFor(user.username)],
        });
        const { rows } = await db().query<DeploymentRow>('UPDATE deployments SET command_id = $2 WHERE id = $1 RETURNING *', [row.id, commandId]);
        await announce(`[NEW APP] ${user.username} is creating ${v.project} on ${inst.name}`,
            `${v.repo}@${v.branch} → https://${c.domain.name}${v.db ? ' with a Postgres database' : ''}${dryRun ? ' (dry run)' : ''}.`, 'new-app');
        return rows[0];
    } catch (err) {
        const msg = `Couldn't start via SSM: ${(err as Error).message.slice(0, 200)}`;
        await db().query(`UPDATE deployments SET status = 'failed', ssm_status = 'NotSent', output = $2, finished_at = now() WHERE id = $1`, [row.id, msg]);
        await db().query(`UPDATE app_creations SET status = 'failed', finished_at = now() WHERE deployment_id = $1`, [row.id]);
        await dropToken(inst.region, token);
        await undoDns();
        throw new DeployError(msg);
    }
}

/** Remove an app's A record (only while it still points at this IP: never a record someone changed since). */
async function removeDns(kind: string | null, zone: string | null, name: string, ip: string): Promise<void> {
    const p = providerFor(kind);
    const z = zone ?? (await addressTarget())?.zoneId ?? null;   // rows from before migration 023: the workspace's zone
    if (p && z && p.deleteARecord) await p.deleteARecord!(z, name, ip);
}

/** Called when a create run finishes: record the result and, on success, link the repo with auto-deploy on. */
export async function creationFinished(d: DeploymentRow): Promise<void> {
    const line = (d.output ?? '').trim().split('\n').reverse().find((l) => l.startsWith('{') && l.includes('"step"'));
    let r: { ok?: boolean; port?: number | null; tls?: boolean } = {};
    try { r = line ? JSON.parse(line) : {}; } catch { /* keep defaults */ }
    const ok = d.status === 'success' && r.ok !== false;
    const { rows: [c] } = await db().query<{ repo: string; branch: string; domain: string; created_by: string; dns_created: boolean; dns_provider: string | null; dns_zone: string | null }>(
        `UPDATE app_creations SET status = $2, port = $3, tls = $4, finished_at = now() WHERE deployment_id = $1
         RETURNING repo, branch, domain, created_by, dns_created, dns_provider, dns_zone`,
        [d.id, ok ? 'success' : 'failed', r.port ?? null, r.tls ?? null]);
    if (!c) return;
    if (ok) {
        await db().query(
            `INSERT INTO app_repos (instance_id, project, repo, branch, auto_deploy, linked_by) VALUES ($1, $2, $3, $4, true, $5)
             ON CONFLICT (instance_id, project) DO NOTHING`, [d.instance_id, d.project, c.repo, c.branch, c.created_by]);
        await db().query('UPDATE instances SET last_fetched_at = NULL WHERE id = $1', [d.instance_id]);
    }
    if (!ok && c.dns_created) {
        // the run removed everything it made on the instance; the DNS record is the console's to remove
        const { rows: [inst] } = await db().query<InstanceRow>('SELECT * FROM instances WHERE id = $1', [d.instance_id]);
        const ip = inst ? (await aws().describeInstance(inst.region, inst.aws_instance_id).catch(() => null))?.publicIp : null;
        if (ip) await removeDns(c.dns_provider, c.dns_zone, c.domain, ip).catch((e) => console.error('DNS cleanup failed:', (e as Error).message));
    }
    await announce(ok ? `[NEW APP] ${d.project} is live` : `[NEW APP] Creating ${d.project} failed`,
        ok ? `http${r.tls ? "s" : ""}://${c.domain} (${c.repo}@${c.branch}). Pushes to ${c.branch} now deploy automatically.` : `Everything the run created was rolled back. Open the console for the output.`, 'new-app');
}

// ------------------------------------------------------------------ an app's address and HTTPS (DNS at another provider)
export interface Address { domain: string; kind: string | null; tls: boolean; expected: string | null; resolves: string[] }
/** The address of an app the console created: where its DNS is, whether it has HTTPS, and where its name points today. */
export async function appAddress(inst: InstanceRow, project: string): Promise<Address | null> {
    const { rows: [c] } = await db().query<{ domain: string; tls: boolean | null; dns_provider: string | null }>(
        `SELECT domain, tls, dns_provider FROM app_creations WHERE instance_id = $1 AND project = $2 AND status = 'success' ORDER BY finished_at DESC LIMIT 1`,
        [inst.id, project]);
    if (!c) return null;
    const [info, resolves] = await Promise.all([
        aws().describeInstance(inst.region, inst.aws_instance_id).catch(() => null),
        resolve4(c.domain).catch(() => [] as string[]),
    ]);
    return { domain: c.domain, kind: c.dns_provider, tls: !!c.tls, expected: info?.publicIp ?? null, resolves };
}

/** Issue the app's certificate once its name points at the server (the server re-checks DNS and reads the domain itself). */
export async function enableHttps(inst: InstanceRow, project: string): Promise<{ ok: boolean; tls: boolean; reason: string }> {
    if (!PROJECT_NEW_RE.test(project)) throw new DeployError('Invalid app.');
    const out = await aws().runDocument(inst.region, inst.aws_instance_id, HTTPS_DOCUMENT, { project: [project] }, 240_000);
    const line = out.trim().split('\n').reverse().find((l) => l.startsWith('{'));
    let r: { ok?: boolean; tls?: boolean; reason?: string } = {};
    try { r = line ? JSON.parse(line) : {}; } catch { /* below */ }
    if (r.tls) await db().query(`UPDATE app_creations SET tls = true WHERE instance_id = $1 AND project = $2 AND status = 'success'`, [inst.id, project]);
    return { ok: !!r.ok, tls: !!r.tls, reason: r.reason ?? 'The server did not report a result.' };
}
