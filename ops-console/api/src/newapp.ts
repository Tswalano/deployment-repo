import { announce } from './alerts';
import { aws, dryRun } from './aws';
import { InstanceRow } from './collector';
import { db } from './db';
import { actorFor, DeployError, DeploymentRow, Requester } from './deploys';
import { dropToken, stashToken } from './gittoken';
import { BRANCH_RE, REPO_RE, repoFile, repoToken } from './github';
import { activeFreeze, deployPolicy } from './policy';

export const CREATE_DOCUMENT = 'OpsConsole-CreateApp';
/** Apps get a subdomain of this zone; the console manages its A records. */
export const APPS_DOMAIN = process.env.APPS_DOMAIN || 'glenify.studio';
let zoneCache: string | null = process.env.APPS_HOSTED_ZONE_ID || null;
async function zoneId(): Promise<string | null> {
    if (!zoneCache && aws().hostedZoneId) zoneCache = await aws().hostedZoneId!(APPS_DOMAIN).catch(() => null);
    return zoneCache;
}

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
}
export async function detect(repo: string, branch: string, subdir = ''): Promise<Detection> {
    if (!REPO_RE.test(repo) || !BRANCH_RE.test(branch) || (subdir && (!SUBDIR_RE.test(subdir) || subdir.includes('..')))) throw new DeployError('Invalid repository, branch or folder.');
    const raw = await repoFile(repo, `${subdir ? `${subdir.replace(/\/+$/, '')}/` : ''}package.json`, branch);
    if (!raw) return { found: false, name: null, scripts: [], start: null, build: false, migrate: null, healthPath: '/', node: null, warnings: [`No package.json in ${subdir || 'the repository root'} on ${branch}. Only Node.js apps are supported for now; if the app lives in a folder (e.g. backend), set the folder.`] };
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
    return { found: true, name: pkg.name ?? null, scripts, start, build: scripts.includes('build'), migrate: pick(['db:migrate', 'migrate:deploy', 'migrate', 'prisma:deploy']),
        healthPath: '/', node, warnings };
}

// ------------------------------------------------------------------ pre-flight checks
export interface Check { project: { ok: boolean; reason?: string }; domain: { status: 'free' | 'ours' | 'taken' | 'invalid'; name: string; reason?: string }; memoryMb: number | null; memoryWarning: string | null; publicIp: string | null }

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
    const name = `${subdomain}.${APPS_DOMAIN}`;
    const info = await aws().describeInstance(inst.region, inst.aws_instance_id).catch(() => null);
    const ip = info?.publicIp ?? null;
    let d: Check['domain'];
    if (!LABEL_RE.test(subdomain)) d = { status: 'invalid', name, reason: 'Use lowercase letters, digits and dashes.' };
    else if (RESERVED.has(subdomain)) d = { status: 'taken', name, reason: 'That subdomain is reserved.' };
    else if (!(await zoneId()) || !aws().dnsRecords) d = { status: 'invalid', name, reason: `No Route 53 hosted zone for ${APPS_DOMAIN} is reachable.` };
    else {
        const recs = await aws().dnsRecords!((await zoneId())!, name);
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
    if (c.domain.status === 'free') await aws().upsertARecord!((await zoneId())!, c.domain.name, c.publicIp);

    const token = await stashToken(inst.region, v.project, v.repo);
    let row: DeploymentRow;
    try {
        ({ rows: [row] } = await db().query<DeploymentRow>(
            `INSERT INTO deployments (instance_id, project, action, ref, requested_by, requested_by_name, trigger, token_param, override_reason)
             VALUES ($1, $2, 'create', $3, $4, $5, 'console', $6, $7) RETURNING *`,
            [inst.id, v.project, v.branch, user.id, user.username, token, freeze ? v.override : null]));
        await db().query(
            `INSERT INTO app_creations (deployment_id, instance_id, project, repo, branch, domain, with_db, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [row.id, inst.id, v.project, v.repo, v.branch, c.domain.name, v.db, user.username]);
    } catch (err) {
        await dropToken(inst.region, token);
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
        throw new DeployError(msg);
    }
}

/** Called when a create run finishes: record the result and, on success, link the repo with auto-deploy on. */
export async function creationFinished(d: DeploymentRow): Promise<void> {
    const line = (d.output ?? '').trim().split('\n').reverse().find((l) => l.startsWith('{') && l.includes('"step"'));
    let r: { ok?: boolean; port?: number | null; tls?: boolean } = {};
    try { r = line ? JSON.parse(line) : {}; } catch { /* keep defaults */ }
    const ok = d.status === 'success' && r.ok !== false;
    const { rows: [c] } = await db().query<{ repo: string; branch: string; domain: string; created_by: string }>(
        `UPDATE app_creations SET status = $2, port = $3, tls = $4, finished_at = now() WHERE deployment_id = $1 RETURNING repo, branch, domain, created_by`,
        [d.id, ok ? 'success' : 'failed', r.port ?? null, r.tls ?? null]);
    if (!c) return;
    if (ok) {
        await db().query(
            `INSERT INTO app_repos (instance_id, project, repo, branch, auto_deploy, linked_by) VALUES ($1, $2, $3, $4, true, $5)
             ON CONFLICT (instance_id, project) DO NOTHING`, [d.instance_id, d.project, c.repo, c.branch, c.created_by]);
        await db().query('UPDATE instances SET last_fetched_at = NULL WHERE id = $1', [d.instance_id]);
    }
    await announce(ok ? `[NEW APP] ${d.project} is live` : `[NEW APP] Creating ${d.project} failed`,
        ok ? `https://${c.domain} (${c.repo}@${c.branch}). Pushes to ${c.branch} now deploy automatically.` : `Everything the run created was rolled back. Open the console for the output.`, 'new-app');
}
