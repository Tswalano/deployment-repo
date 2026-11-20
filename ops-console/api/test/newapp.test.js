// Integration tests for Phase 10b (new app from GitHub) with FAKE AWS (EC2, SSM, Route 53) and a fetch-intercepted GitHub.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const zlib = require('zlib');

const ORIGIN = 'https://ops.example.test';
const PORT = 57000 + Math.floor(Math.random() * 1000);
process.env.DATABASE_URL = `postgresql://postgres:pw@127.0.0.1:${PORT}/opsconsole_test`;
process.env.ALLOWED_ORIGINS = ORIGIN;
process.env.COOKIE_SECURE = 'false';

const dist = (m) => require(path.join(__dirname, '..', 'dist', m));
let pg, app, ip = 0;

// ---- synthetic agent snapshot (same shape as the per-instance agent's /api/status)
const agentStatus = (healthyApps = 2) => ({
    instance: { instance_id: 'i-0aaaaaaaaaaaaaaa1', instance_type: 't3.micro', az: 'af-south-1a' },
    host: { hostname: 'ip-10-0-0-1', uptime_seconds: 3600, cpus: 2, load: [0.2, 0.1, 0.1],
            memory: { total: 1000, used: 600, available: 400 }, swap: { total: 1000, used: 100 }, disk: { total: 8000, used: 5000, free: 3000 } },
    projects: [
        { project: 'alpha', service: 'alpha', domain: 'alpha.example', db: 'alpha', unit: { active: 'active', memory: 50e6, restarts: 0, uptime_seconds: 100 },
          health: { code: 200, ms: 3 }, git: { sha: 'abc12345', subject: 'feat: x' }, warnings_24h: { count: 3, errors: 1, last: 'SECRET LOG LINE' },
          deploy_summary: { last_success: { finished_at: '2026-11-16T10:00:00Z', status: 'success', duration_s: 20, actor: 'ci' } } },
        { project: 'beta', service: 'beta', domain: null, db: null, unit: { active: healthyApps > 1 ? 'active' : 'failed' },
          health: { code: healthyApps > 1 ? 200 : 502, ms: 9 }, git: {}, warnings_24h: { count: 0 } },
    ],
    services: [{ unit: 'nginx', active: 'active', memory: 7e6 }],
    database: { ok: true, databases: [{ name: 'postgres', size: 1 }, { name: 'alpha', size: 9e6, tables: 10, connections: 1 }] },
    certificates: [{ domain: 'alpha.example', days_left: 12 }],
    backups: { at: '2026-11-16T03:30:00Z', ok: true },
    deploying: null,
    deploy_events: [{ project: 'alpha', action: 'deploy', status: 'success', finished_at: '2026-11-16T10:00:00Z', duration_s: 20, actor: 'ci', from_sha: '1111111111', to_sha: '2222222222' }],
});
const encode = (obj) => zlib.gzipSync(Buffer.from(JSON.stringify(obj))).toString('base64');

// ---- fake AWS
const fake = {
    instances: {
        'i-0aaaaaaaaaaaaaaa1': { name: 'web-1', state: 'running', type: 't3.micro', az: 'af-south-1a', managedTag: true, online: true },
        'i-0bbbbbbbbbbbbbbb2': { name: 'untagged', state: 'running', type: 't3.micro', az: 'af-south-1a', managedTag: false, online: true },
        'i-0ccccccccccccccc3': { name: 'stopped', state: 'stopped', type: 't3.micro', az: 'af-south-1a', managedTag: true, online: false },
        'i-0ddddddddddddddd4': { name: 'no-ssm', state: 'running', type: 't3.micro', az: 'af-south-1a', managedTag: true, online: false },
    },
    runs: 0, failNext: false, healthy: 2,
    async describeInstance(_region, id) { const i = this.instances[id]; return i ? { ...i, publicIp: '203.0.113.10' } : null; },
    async ssmOnline(_region, id) { return !!this.instances[id]?.online; },
    params: {
        '/apps/alpha/DATABASE_URL': { v: 'postgresql://alpha_user:S3CRETpw@localhost:5432/alpha', mod: 30 },
        '/apps/alpha/JWT_SECRET': { v: 'jwt-SECRET-value', mod: 400 },
        '/apps/alpha/PAYSTACK_SECRET_KEY': { v: 'sk_live_OLDKEY', mod: 200 },
        '/apps/alpha/BASE_URL': { v: 'https://alpha.example', mod: 900 },
        '/apps/beta/DATABASE_URL': { v: 'postgresql://alpha_user:S3CRETpw@localhost:5432/beta', mod: 30 },
    },
    consoleSecrets: {}, deletes: [], tokenWrites: [],
    dns: { 'taken.glenify.studio.': [{ type: 'CNAME', values: ['elsewhere.example.'] }], 'ours.glenify.studio.': [{ type: 'A', values: ['203.0.113.10'] }] },
    upserts: [], invs: {}, memAvailable: 600 * 1048576,
    async hostedZoneId(domain) { return domain === 'glenify.studio' ? 'ZTESTZONE' : null; },
    async dnsRecords(zone, name) { assert.equal(zone, 'ZTESTZONE'); return (this.dns[name + '.'] ?? []).map((r) => ({ name, ...r })); },
    async upsertARecord(zone, name, ip) { this.upserts.push([zone, name, ip]); this.dns[name + '.'] = [{ type: 'A', values: [ip] }]; return 'C123'; },
    waits: [], deletes: [],
    async waitDnsChange(id, ms) { this.waits.push([id, ms]); return true; },
    async deleteARecord(zone, name, ip) { this.deletes.push([zone, name, ip]); delete this.dns[name + '.']; },
    sent: [], async sendDocument(_r, _id, doc, params) { this.sent.push([doc, params]); return 'cmd-' + this.sent.length; },
    async getInvocation(_r, _id, cid) { return this.invs[cid] ?? { status: 'running', detail: 'InProgress', stdout: '', stderr: '' }; },
    async getConsoleSecret(_r, name) { return this.consoleSecrets[name] ?? null; },
    async putConsoleSecret(_r, name, value) { this.consoleSecrets[name] = value; if (name.includes('git-tokens')) this.tokenWrites.push(name); },
    async deleteConsoleSecret(_r, name) { delete this.consoleSecrets[name]; },
    async deleteParameter(_r, name) { this.deletes.push(name); delete this.params[name]; },
    puts: [], rotateResult: { ok: true, updated: ['/apps/alpha/JWT_SECRET'], restarted: ['alpha'], health: { alpha: 200 } }, reloadOk: true, rotateCalls: [],
    async listParameters(_r, path) {
        return Object.entries(this.params).filter(([n]) => n.startsWith(path + '/')).map(([name, p]) => ({ name, type: 'SecureString', version: 2,
            lastModified: new Date(Date.now() - p.mod * 86400e3).toISOString(), lastModifiedBy: 'cli_admin_user' }));
    },
    async getParameter(_r, name) { return this.params[name]?.v ?? null; },
    async putParameter(_r, name, value) { this.puts.push([name, value]); if (this.params[name]) this.params[name].v = value; else this.params[name] = { v: value, mod: 0 }; },
    async documentsReady(region) { return region !== 'eu-west-1'; },
    async runDocument(_region, _id, document, params) {
        if (document === 'OpsConsole-RotateSecret') {
            this.rotateCalls.push([params.kind[0], params.target[0]]);
            if (params.kind[0] === 'reload') return JSON.stringify(this.reloadOk ? { ok: true, health: { alpha: 200 } } : { ok: false, error: 'alpha unhealthy (502)' });
            return JSON.stringify(this.rotateResult);
        }
        assert.equal(document, 'OpsConsole-CollectStatus', 'only the fixed document is ever run');
        this.runs += 1;
        if (this.failNext) { this.failNext = false; throw new Error('SSM command TimedOut'); }
        const st = agentStatus(this.healthy); st.host.memory.available = this.memAvailable; return encode({ source: 'agent', data: st });
    },
};

function client() {
    const myIp = `10.1.0.${++ip}`;
    let cookie = '';
    const call = async (method, url, body) => {
        const headers = { 'content-type': 'application/json', 'x-forwarded-for': myIp, origin: ORIGIN };
        if (cookie) headers.cookie = cookie;
        const res = await app.request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        const set = res.headers.get('set-cookie');
        if (set) cookie = set.split(';')[0];
        return { status: res.status, json: await res.json().catch(() => null) };
    };
    return { get: (u) => call('GET', u), post: (u, b) => call('POST', u, b ?? {}), patch: (u, b) => call('PATCH', u, b), del: (u) => call('DELETE', u), put: (u, b) => call('PUT', u, b) };
}
async function signedIn(role) {
    const c = client();
    if (role === 'demo') await c.post('/api/auth/demo');
    else await c.post('/api/auth/login', { username: role, password: `${role}-password-1` });
    return c;
}

before(async () => {
    const EmbeddedPostgres = (await import('embedded-postgres')).default;
    pg = new EmbeddedPostgres({ databaseDir: fs.mkdtempSync(path.join(os.tmpdir(), 'oc-pg-')), user: 'postgres', password: 'pw', port: PORT, persistent: false, onLog: () => {} });
    await pg.initialise(); await pg.start(); await pg.createDatabase('opsconsole_test');
    await dist('migrate').migrate();
    dist('aws').setAwsProvider(fake);
    app = dist('app').createApp();
    const { hashPassword } = dist('password');
    for (const role of ['admin', 'deployer', 'viewer']) {
        await dist('db').db().query('INSERT INTO users (username, role, password_hash) VALUES ($1, $1, $2)', [role, await hashPassword(`${role}-password-1`)]);
    }
    await dist('db').db().query(`INSERT INTO users (username, role, is_demo) VALUES ('demo', 'viewer', true)`);
});
after(async () => { await dist('db').closeDb(); await pg.stop(); });



const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' });
const realFetch = global.fetch;
const PKG = { name: 'shop-api', scripts: { start: 'node dist/server.js', build: 'tsc', 'db:migrate': 'prisma migrate deploy', test: 'jest' }, engines: { node: '>=18' }, dependencies: { prisma: '5' } };
global.fetch = async (url, init = {}) => {
    const u = String(url);
    if (!u.startsWith('https://api.github.com')) return realFetch(url, init);
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (u.endsWith('/app/installations')) return json([{ id: 77, account: { login: 'Tswalano' }, repository_selection: 'selected' }]);
    if (u.includes('/app/installations/77/access_tokens')) return json({ token: 'ghs_SECRET_installation_token' });
    if (u.includes('/installation/repositories')) return json({ total_count: 5, repositories: [
        { full_name: 'Tswalano/shop', private: true, default_branch: 'main', pushed_at: null, description: null },
        { full_name: 'Tswalano/alpha', private: true, default_branch: 'main', pushed_at: null, description: null },
        ...['pyapi', 'site', 'flasky'].map((n) => ({ full_name: `Tswalano/${n}`, private: true, default_branch: 'main', pushed_at: null, description: null }))] });
    if (u.includes('/repos/Tswalano/shop/contents/package.json')) return json({ content: Buffer.from(JSON.stringify(PKG)).toString('base64'), encoding: 'base64' });
    if (u.includes('/repos/Tswalano/shop/contents/backend/package.json')) return json({ message: 'Not Found' }, 404);
    if (u.includes('/repos/Tswalano/shop/contents/spa/package.json')) return json({ content: Buffer.from(JSON.stringify({ name: 'spa', scripts: { dev: 'vite', build: 'tsc && vite build', preview: 'vite preview' }, devDependencies: { vite: '^5', typescript: '^5' }, dependencies: { react: '^18' } })).toString('base64'), encoding: 'base64' });
    const py = PY_FILES[decodeURI(u.replace(/^https:\/\/api\.github\.com\/repos\//, '').replace(/\?.*$/, '')).replace('/contents/', ':')];
    if (py !== undefined) return py === null ? json({ message: 'Not Found' }, 404) : json({ content: Buffer.from(py).toString('base64'), encoding: 'base64' });
    if (/\/repos\/Tswalano\/(pyapi|site|flasky)\/contents\//.test(u) || /\/contents\/(backend|spa)\/(requirements\.txt|pyproject\.toml|manage\.py|alembic\.ini|\.python-version)/.test(u)
        || /\/repos\/Tswalano\/shop\/contents\/(requirements\.txt|pyproject\.toml|manage\.py|alembic\.ini|\.python-version)/.test(u)) return json({ message: 'Not Found' }, 404);
    return json({ message: 'unexpected ' + u }, 500);
};
// Python repositories: FastAPI with Alembic, Django, and a Flask app factory
const PY_FILES = {
    'Tswalano/pyapi:requirements.txt': 'fastapi==0.115.0\nsqlalchemy>=2\nalembic\npsycopg2-binary\n',
    'Tswalano/pyapi:alembic.ini': '[alembic]\nscript_location = migrations\n',
    'Tswalano/pyapi:.python-version': '3.11\n',
    'Tswalano/pyapi:app/main.py': 'from fastapi import FastAPI\n\napp = FastAPI(title="api")\n',
    'Tswalano/site:requirements.txt': 'Django>=5.0\ngunicorn\n',
    'Tswalano/site:manage.py': "import os\nos.environ.setdefault('DJANGO_SETTINGS_MODULE', 'mysite.settings')\n",
    'Tswalano/flasky:pyproject.toml': '[project]\nname = "flasky"\nrequires-python = ">=3.12"\ndependencies = ["flask>=3"]\n',
    'Tswalano/flasky:app/__init__.py': 'from flask import Flask\n\ndef create_app():\n    return Flask(__name__)\n',
};

let id;
const base = { project: 'shop', repo: 'Tswalano/shop', branch: 'main', subdir: '', start: 'start', build: true, migrate: 'db:migrate', healthPath: '/health', subdomain: 'shop', db: true, memoryMb: 256 };
const finish = (cid, ok, extra = {}) => { fake.invs[cid] = { status: ok ? 'success' : 'failed', detail: ok ? 'Success' : 'Failed', stderr: '',
    stdout: `[10:00:00] cloned\n${JSON.stringify({ ok, step: ok ? 'done' : 'deploy', error: ok ? null : 'the first deploy failed', port: 5001, tls: true, database: 'shop', domain: 'shop.glenify.studio', ...extra })}` }; };

test('setup: an instance and a connected GitHub App', async () => {
    dist('notify').setTransport({ async email() {}, async webhook() {} });
    fake.consoleSecrets['/ops-console/github/app'] = JSON.stringify({ appId: '4242', slug: 'ops-console-test', privateKey: PEM, webhookSecret: 'whsec', htmlUrl: 'https://github.com/apps/x', owner: 'Tswalano' });
    id = (await (await signedIn('admin')).post('/api/instances', { awsInstanceId: 'i-0aaaaaaaaaaaaaaa1', region: 'af-south-1' })).json.instance.id;
});

test('detect: scripts and guesses from package.json; a missing package.json explains itself', async () => {
    const a = await signedIn('admin');
    const d = (await a.get('/api/github/detect?repo=Tswalano/shop&branch=main')).json;
    assert.deepEqual([d.found, d.start, d.build, d.migrate, d.node], [true, 'start', true, 'db:migrate', '>=18']);
    assert.deepEqual(d.scripts.sort(), ['build', 'db:migrate', 'start', 'test']);
    const none = (await a.get('/api/github/detect?repo=Tswalano/shop&branch=main&subdir=backend')).json;
    assert.equal(none.found, false);
    assert.match(none.warnings[0], /No package\.json/);
    assert.equal((await a.get('/api/github/detect?repo=Tswalano/shop&branch=main&subdir=../../etc')).status, 400);
    assert.equal(d.frontend, false, 'a server app is not flagged');
    const spa = (await a.get('/api/github/detect?repo=Tswalano/shop&branch=main&subdir=spa')).json;
    assert.equal(spa.frontend, true, 'Vite + React with no server framework');
    assert.match(spa.warnings[0], /front-end app \(vite\)/);
    assert.equal(spa.start, null, 'no start script: the person has to choose');
    assert.equal((await (await signedIn('deployer')).get('/api/github/detect?repo=Tswalano/shop&branch=main')).status, 403);
});

test('check: name rules, existing apps, reserved names, DNS free / ours / taken, memory warning', async () => {
    const a = await signedIn('admin');
    const chk = (p, s) => a.get(`/api/instances/${id}/new-app/check?project=${p}&subdomain=${s}`);
    let c = (await chk('shop', 'shop')).json;
    assert.equal(c.project.ok, true);
    assert.equal(c.domain.status, 'free');
    assert.equal(c.domain.name, 'shop.glenify.studio');
    assert.equal((await chk('alpha', 'x')).json.project.ok, false, 'alpha already runs there');
    assert.equal((await chk('ops-console', 'x')).json.project.ok, false, 'reserved');
    assert.equal((await chk('Bad_Name', 'x')).json.project.ok, false);
    assert.equal((await chk('shop', 'taken')).json.domain.status, 'taken');
    assert.equal((await chk('shop', 'ours')).json.domain.status, 'ours', 'already points at this instance');
    assert.equal((await chk('shop', 'a.b')).json.domain.status, 'invalid');
    fake.memAvailable = 200 * 1048576;
    await a.get(`/api/instances/${id}?refresh=1`);
    c = (await chk('shop', 'shop')).json;
    assert.equal(c.memoryMb, 200);
    assert.match(c.memoryWarning, /200 MB/);
});

test('create: admin only; injection attempts and conflicts are refused before anything reaches AWS', async () => {
    const n = fake.sent.length, u = fake.upserts.length;
    for (const r of ['deployer', 'viewer', 'demo']) assert.equal((await (await signedIn(r)).post(`/api/instances/${id}/new-app`, base)).status, 403, r);
    const a = await signedIn('admin');
    const post = (o) => a.post(`/api/instances/${id}/new-app`, { ...base, ...o });
    for (const bad of [{ project: 'x;rm -rf /' }, { project: 'A' }, { repo: '../../etc' }, { repo: 'a/b c' }, { branch: 'main;id' }, { branch: 'a..b' },
                       { subdir: '../etc' }, { start: 'start && curl evil' }, { migrate: '$(id)' }, { healthPath: 'http://x' }, { subdomain: 'a.b' },
                       { subdomain: 'x;y' }, { memoryMb: 10 }, { memoryMb: 99999 }]) {
        assert.equal((await post(bad)).status, 400, JSON.stringify(bad));
    }
    assert.equal((await post({ project: 'alpha', subdomain: 'alpha2' })).status, 409, 'existing app');
    assert.equal((await post({ subdomain: 'taken' })).status, 409, 'DNS taken');
    fake.memAvailable = 80 * 1048576;
    await a.get(`/api/instances/${id}?refresh=1`);
    const low = await post({});
    assert.equal(low.status, 409);
    assert.equal(low.json.code, 'low_memory');
    assert.equal(fake.sent.length, n, 'nothing sent to SSM');
    assert.equal(fake.upserts.length, u, 'no DNS change');
    fake.memAvailable = 600 * 1048576;
    await a.get(`/api/instances/${id}?refresh=1`);
});

test('create: DNS record, repo-scoped token left in SSM, fixed document with validated parameters; success links the repo and removes the token', async () => {
    const a = await signedIn('admin');
    const r = await a.post(`/api/instances/${id}/new-app`, base);
    assert.equal(r.status, 202);
    const dep = r.json.deployment;
    assert.deepEqual([dep.action, dep.status, dep.ref], ['create', 'running', 'main']);
    assert.deepEqual(fake.upserts.at(-1), ['ZTESTZONE', 'shop.glenify.studio', '203.0.113.10']);
    assert.equal(fake.consoleSecrets['/ops-console/git-tokens/shop'], 'ghs_SECRET_installation_token');
    const [doc, params] = fake.sent.at(-1);
    assert.equal(doc, 'OpsConsole-CreateApp');
    assert.deepEqual(params, { project: ['shop'], repo: ['Tswalano/shop'], branch: ['main'], appSubdir: [''], startScript: ['start'], build: ['yes'],
        migrateScript: ['db:migrate'], healthPath: ['/health'], domain: ['shop.glenify.studio'], db: ['yes'], memoryMb: ['256'], actor: ['admin@ops-console'],
        runtime: ['node'], pythonVersion: [''], framework: [''], appModule: [''] });
    assert.ok(!JSON.stringify(params).includes('ghs_'), 'the token never travels in the command');
    assert.equal((await a.post(`/api/instances/${id}/new-app`, base)).status, 409, 'one creation at a time');

    finish(`cmd-${fake.sent.length}`, true);
    const done = (await a.get(`/api/deployments/${dep.id}`)).json.deployment;
    assert.equal(done.status, 'success');
    assert.equal(fake.consoleSecrets['/ops-console/git-tokens/shop'], undefined, 'token deleted when the run finished');
    const { rows: [c] } = await dist('db').db().query('SELECT status, port, tls FROM app_creations WHERE deployment_id = $1', [dep.id]);
    assert.deepEqual(c, { status: 'success', port: 5001, tls: true });
    const { rows: [link] } = await dist('db').db().query("SELECT repo, branch, auto_deploy FROM app_repos WHERE project = 'shop'");
    assert.deepEqual(link, { repo: 'Tswalano/shop', branch: 'main', auto_deploy: true });
    const list = (await a.get(`/api/instances/${id}/new-app`)).json.creations;
    assert.equal(list[0].status, 'success');
    const actions = (await a.get('/api/audit')).json.entries.map((e) => e.action);
    assert.ok(actions.includes('app.create'));
});

test('a failed creation is recorded, its token removed, and nothing is linked', async () => {
    const a = await signedIn('admin');
    const r = await a.post(`/api/instances/${id}/new-app`, { ...base, project: 'blog', subdomain: 'blog', db: false, migrate: '' });
    assert.equal(r.status, 202);
    finish(`cmd-${fake.sent.length}`, false);
    assert.equal((await a.get(`/api/deployments/${r.json.deployment.id}`)).json.deployment.status, 'failed');
    assert.equal(fake.consoleSecrets['/ops-console/git-tokens/blog'], undefined);
    const { rows } = await dist('db').db().query("SELECT status FROM app_creations WHERE project = 'blog'");
    assert.equal(rows[0].status, 'failed');
    assert.equal((await dist('db').db().query("SELECT 1 FROM app_repos WHERE project = 'blog'")).rows.length, 0);
    assert.ok(fake.waits.some(([id, ms]) => id === 'C123' && ms <= 60000), 'waited for the DNS change (capped)');
    assert.ok(fake.deletes.some(([, name]) => name === 'blog.glenify.studio'), 'the DNS record the console created is removed again');
});

test('deploys of GitHub-linked apps get a token for the run, removed afterwards', async () => {
    const a = await signedIn('admin');
    await a.put(`/api/instances/${id}/apps/alpha/repo`, { repo: 'Tswalano/alpha', branch: 'main', autoDeploy: false });
    const before = fake.tokenWrites.length;
    const r = await a.post(`/api/instances/${id}/apps/alpha/deploy`, {});
    assert.equal(r.status, 202);
    assert.equal(fake.tokenWrites.length, before + 1);
    assert.ok(fake.consoleSecrets['/ops-console/git-tokens/alpha']);
    finish(`cmd-${fake.sent.length}`, true);
    await a.get(`/api/deployments/${r.json.deployment.id}`);
    assert.equal(fake.consoleSecrets['/ops-console/git-tokens/alpha'], undefined);
});

test('local test mode simulates CreateApp and DNS without touching AWS', () => {
    const out = execFileSync(process.execPath, ['-e', `
        const { aws } = require(${JSON.stringify(path.join(__dirname, '..', 'dist', 'aws'))});
        (async () => {
            await aws().upsertARecord('Z', 'x.glenify.studio', '203.0.113.1');
            await aws().putParameter('af-south-1', '/apps/x/PORT', '1');
            const cid = await aws().sendDocument('af-south-1', 'i-0abc', 'OpsConsole-CreateApp', { project: ['x'], repo: ['o/r'], branch: ['main'], db: ['yes'], domain: ['x.glenify.studio'] });
            console.log(cid.startsWith('dryrun-') ? 'simulated' : 'REAL');
        })().catch((e) => { console.log('ERR', e.message); process.exit(1); });`], { env: { ...process.env, OPS_DRY_RUN: '1', AWS_ACCESS_KEY_ID: 'none', AWS_SECRET_ACCESS_KEY: 'none', AWS_EC2_METADATA_DISABLED: 'true' }, encoding: 'utf8' });
    assert.equal(out.trim(), 'simulated');
});

test('python: detection of FastAPI, Django and Flask projects (framework, module, version, migrations)', async () => {
    const a = await signedIn('admin');
    const d = async (repo) => (await a.get(`/api/github/detect?repo=Tswalano/${repo}&branch=main`)).json;
    const api = await d('pyapi');
    assert.equal(api.runtime, 'python');
    assert.deepEqual([api.python.framework, api.python.module, api.python.version, api.python.migrate, api.python.deps], ['fastapi', 'app.main:app', '3.11', 'alembic', 'requirements.txt']);
    assert.ok(api.warnings.some((w) => /uvicorn isn't in the dependencies/.test(w)), 'uvicorn will be added');
    const site = await d('site');
    assert.deepEqual([site.python.framework, site.python.module, site.python.migrate, site.python.hasServer], ['django', 'mysite.wsgi:application', 'django', true]);
    assert.ok(site.warnings.some((w) => /ALLOWED_HOSTS/.test(w)));
    const flask = await d('flasky');
    assert.deepEqual([flask.python.framework, flask.python.module, flask.python.version, flask.python.deps], ['flask', 'app:create_app()', '3.12', 'pyproject.toml']);
    // a Node project is still Node
    assert.equal((await d('shop')).runtime, 'node');
});

test('python: create validates the framework, module, version and migrations, and sends exactly the Python parameters', async () => {
    const a = await signedIn('admin');
    fake.memAvailable = 600 * 1048576;
    await a.get(`/api/instances/${id}?refresh=1`);
    const py = { project: 'pyapi', repo: 'Tswalano/pyapi', branch: 'main', subdir: '', healthPath: '/health', subdomain: 'pyapi', db: true, memoryMb: 256,
        runtime: 'python', pythonVersion: '3.11', framework: 'fastapi', appModule: 'app.main:app', migrate: 'alembic' };
    const n = fake.sent.length;
    for (const bad of [{ appModule: 'app.main:app; curl evil' }, { appModule: 'x' }, { pythonVersion: '3.9' }, { framework: 'rails' }, { migrate: 'django' }, { migrate: 'npm run x' }]) {
        assert.equal((await a.post(`/api/instances/${id}/new-app`, { ...py, ...bad })).status, 400, JSON.stringify(bad));
    }
    assert.equal(fake.sent.length, n, 'nothing reached SSM');
    const r = await a.post(`/api/instances/${id}/new-app`, py);
    assert.equal(r.status, 202, JSON.stringify(r.json));
    const [doc, params] = fake.sent.at(-1);
    assert.equal(doc, 'OpsConsole-CreateApp');
    assert.deepEqual([params.runtime, params.pythonVersion, params.framework, params.appModule, params.migrateScript, params.startScript, params.build],
        [['python'], ['3.11'], ['fastapi'], ['app.main:app'], ['alembic'], ['start'], ['no']]);
    finish(`cmd-${fake.sent.length}`, true, { database: 'pyapi', domain: 'pyapi.glenify.studio' });
    assert.equal((await a.get(`/api/deployments/${r.json.deployment.id}`)).json.deployment.status, 'success');
});
