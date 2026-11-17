// Integration tests for Phase 10a (GitHub App connection, push webhooks, environment variables) with FAKE AWS and GitHub.
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
    async describeInstance(_region, id) { const i = this.instances[id]; return i ? { ...i } : null; },
    async ssmOnline(_region, id) { return !!this.instances[id]?.online; },
    params: {
        '/apps/alpha/DATABASE_URL': { v: 'postgresql://alpha_user:S3CRETpw@localhost:5432/alpha', mod: 30 },
        '/apps/alpha/JWT_SECRET': { v: 'jwt-SECRET-value', mod: 400 },
        '/apps/alpha/PAYSTACK_SECRET_KEY': { v: 'sk_live_OLDKEY', mod: 200 },
        '/apps/alpha/BASE_URL': { v: 'https://alpha.example', mod: 900 },
        '/apps/beta/DATABASE_URL': { v: 'postgresql://alpha_user:S3CRETpw@localhost:5432/beta', mod: 30 },
    },
    consoleSecrets: {}, deletes: [],
    sent: [], async sendDocument(_r, _id, doc, params) { this.sent.push([doc, params]); return 'cmd-' + this.sent.length; },
    async getInvocation() { return { status: 'running', detail: 'InProgress', stdout: '', stderr: '' }; },
    async getConsoleSecret(_r, name) { return this.consoleSecrets[name] ?? null; },
    async putConsoleSecret(_r, name, value) { this.consoleSecrets[name] = value; },
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
        return encode({ source: 'agent', data: agentStatus(this.healthy) });
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
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' });
const realFetch = global.fetch;
const ghCalls = [];
global.fetch = async (url, init = {}) => {
    const u = String(url);
    if (!u.startsWith('https://api.github.com')) return realFetch(url, init);
    ghCalls.push([init.method ?? 'GET', u.replace('https://api.github.com', '')]);
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (u.includes('/app-manifests/good-code-123/conversions')) return json({ id: 4242, slug: 'ops-console-test', pem: PEM, webhook_secret: 'whsec', html_url: 'https://github.com/apps/ops-console-test', owner: { login: 'Tswalano' } });
    if (u.includes('/app-manifests/')) return json({ message: 'Not Found' }, 404);
    if (u.endsWith('/app/installations')) return json([{ id: 77, account: { login: 'Tswalano' }, repository_selection: 'selected' }]);
    if (u.includes('/app/installations/77/access_tokens')) return json({ token: 'ghs_installation_token' });
    if (u.includes('/installation/repositories')) return json({ total_count: 1, repositories: [{ full_name: 'Tswalano/alpha', private: true, default_branch: 'main', pushed_at: '2026-11-16T10:00:00Z', description: null }] });
    if (u.includes('/repos/Tswalano/alpha/branches')) return json([{ name: 'main' }, { name: 'develop' }]);
    return json({ message: 'unexpected' }, 500);
};

let id;
const sign = (body) => 'sha256=' + crypto.createHmac('sha256', 'whsec').update(body).digest('hex');
async function hook(body, { event = 'push', delivery = crypto.randomUUID(), sig } = {}) {
    const raw = JSON.stringify(body);
    const res = await app.request('/api/github/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': event, 'x-github-delivery': delivery, 'x-hub-signature-256': sig ?? sign(raw) }, body: raw });
    return { status: res.status, json: await res.json() };
}

test('setup', async () => {
    dist('notify').setTransport({ async email() {}, async webhook() {} });
    id = (await (await signedIn('admin')).post('/api/instances', { awsInstanceId: 'i-0aaaaaaaaaaaaaaa1', region: 'af-south-1' })).json.instance.id;
});

test('JWT for the app is RS256 and verifiable; webhook signatures are checked in constant time', () => {
    const { appJwt, verifySignature } = dist('github');
    const jwt = appJwt({ appId: '4242', privateKey: PEM });
    const [h, b, s] = jwt.split('.');
    assert.ok(crypto.createVerify('RSA-SHA256').update(`${h}.${b}`).verify(publicKey, Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')));
    assert.equal(JSON.parse(Buffer.from(b, 'base64').toString()).iss, '4242');
    assert.equal(verifySignature('whsec', 'body', sign('body')), true);
    assert.equal(verifySignature('whsec', 'body', sign('other')), false);
    assert.equal(verifySignature('whsec', 'body', undefined), false);
});

test('connect: admin only; manifest + state; the code is exchanged once and stored in SSM, never returned', async () => {
    assert.equal((await (await signedIn('deployer')).post('/api/github/manifest', {})).status, 403);
    const a = await signedIn('admin');
    const m = await a.post('/api/github/manifest', {});
    assert.equal(m.status, 200);
    const state = new URL(m.json.action).searchParams.get('state');
    assert.equal(m.json.manifest.hook_attributes.url, 'https://ops.glenify.studio/api/github/webhook');
    assert.deepEqual(m.json.manifest.default_permissions, { contents: 'read', metadata: 'read' });
    assert.equal(m.json.manifest.public, false);
    assert.equal((await a.post('/api/github/exchange', { code: 'good-code-123', state: 'forged' })).status, 400, 'state must match');
    assert.equal((await a.post('/api/github/exchange', { code: 'bad-code-999', state })).status, 502);
    const ok = await a.post('/api/github/exchange', { code: 'good-code-123', state });
    assert.equal(ok.status, 200);
    assert.ok(!JSON.stringify(ok.json).includes('PRIVATE KEY'));
    assert.ok(fake.consoleSecrets['/ops-console/github/app'].includes('whsec'), 'credentials stored in SSM');
    const st = (await a.get('/api/github')).json;
    assert.equal(st.connected, true);
    assert.deepEqual(st.installations, [{ id: 77, account: 'Tswalano', selection: 'selected' }]);
    assert.ok(!JSON.stringify(st).includes('whsec'));
    assert.equal((await a.post('/api/github/manifest', {})).status, 409, 'already connected');
});

test('repos and branches for deployers; linking a repo is admin-only and shows on the app', async () => {
    const d = await signedIn('deployer');
    assert.deepEqual((await d.get('/api/github/repos')).json.repos.map((r) => r.fullName), ['Tswalano/alpha']);
    assert.deepEqual((await d.get('/api/github/branches?repo=Tswalano/alpha')).json.branches, ['main', 'develop']);
    assert.equal((await d.get('/api/github/branches?repo=../../etc')).status, 400);
    assert.equal((await (await signedIn('demo')).get('/api/github/repos')).status, 403);
    assert.equal((await d.put(`/api/instances/${id}/apps/alpha/repo`, { repo: 'Tswalano/alpha', branch: 'main', autoDeploy: true })).status, 403);
    const a = await signedIn('admin');
    assert.equal((await a.put(`/api/instances/${id}/apps/alpha/repo`, { repo: 'Tswalano/alpha', branch: 'main', autoDeploy: true })).status, 200);
    assert.deepEqual((await (await signedIn('viewer')).get(`/api/instances/${id}/apps/alpha`)).json.repo, { repo: 'Tswalano/alpha', branch: 'main', autoDeploy: true, linkedBy: 'admin' });
});

test('webhook: unsigned refused; push to the linked branch deploys that commit as "github"; duplicates and other branches ignored', async () => {
    const push = (branch, after = 'a'.repeat(40)) => ({ ref: `refs/heads/${branch}`, after, repository: { full_name: 'Tswalano/alpha' } });
    assert.equal((await hook(push('main'), { sig: 'sha256=00' })).status, 401);
    assert.deepEqual((await hook(push('develop'))).json.results, []);
    const delivery = crypto.randomUUID();
    const r = await hook(push('main'), { delivery });
    assert.equal(r.status, 200);
    assert.match(r.json.results[0], /alpha: running/);
    const { rows: [d] } = await dist('db').db().query("SELECT * FROM deployments ORDER BY id DESC LIMIT 1");
    assert.deepEqual([d.requested_by, d.requested_by_name, d.trigger, d.ref], [null, 'github', 'github', 'a'.repeat(40)]);
    assert.equal((await hook(push('main'), { delivery })).json.duplicate, true);
    assert.equal((await hook({ zen: 'hi' }, { event: 'ping' })).json.ignored, 'ping');
});

test('environment: deployers see names; admins reveal (audited), add, change and remove with automatic undo', async () => {
    const d = await signedIn('deployer');
    const list = (await d.get(`/api/instances/${id}/apps/alpha/env`)).json;
    assert.deepEqual(list.vars.map((v) => v.key), ['BASE_URL', 'DATABASE_URL', 'JWT_SECRET', 'PAYSTACK_SECRET_KEY']);
    assert.ok(!JSON.stringify(list).includes('S3CRETpw'), 'no values in the list');
    assert.equal((await (await signedIn('viewer')).get(`/api/instances/${id}/apps/alpha/env`)).status, 403);
    assert.equal((await d.post(`/api/instances/${id}/apps/alpha/env/reveal`, { key: 'BASE_URL' })).status, 403);
    const a = await signedIn('admin');
    assert.equal((await a.post(`/api/instances/${id}/apps/alpha/env/reveal`, { key: 'BASE_URL' })).json.value, 'https://alpha.example');

    fake.reloadOk = true;
    assert.equal((await a.put(`/api/instances/${id}/apps/alpha/env`, { key: 'stripe key', value: 'x' })).status, 400, 'name format');
    assert.equal((await a.put(`/api/instances/${id}/apps/alpha/env`, { key: 'JWT_SECRET', value: 'mine' })).status, 400, 'generated: use Rotate');
    const add = await a.put(`/api/instances/${id}/apps/alpha/env`, { key: 'STRIPE_KEY', value: 'sk_test_1' });
    assert.equal(add.json.verb, 'added');
    assert.deepEqual(fake.rotateCalls.at(-1), ['reload', 'alpha']);

    fake.reloadOk = false;
    const bad = await a.put(`/api/instances/${id}/apps/alpha/env`, { key: 'FEATURE_FLAG', value: 'on' });
    assert.equal(bad.status, 409);
    assert.ok(fake.deletes.includes('/apps/alpha/FEATURE_FLAG'), 'a new variable that broke the app is removed again');
    fake.reloadOk = true;
    assert.equal((await a.del(`/api/instances/${id}/apps/alpha/env/STRIPE_KEY`)).json.verb, 'removed');
    assert.equal((await a.del(`/api/instances/${id}/apps/alpha/env/NOPE`)).status, 404);
    const actions = (await a.get('/api/audit')).json.entries.map((e) => e.action);
    for (const x of ['github.connect', 'app.repo', 'env.reveal', 'env.add', 'env.remove']) assert.ok(actions.includes(x), x);
});

test('disconnect removes the stored credentials', async () => {
    const a = await signedIn('admin');
    assert.equal((await a.del('/api/github')).status, 200);
    assert.equal(fake.consoleSecrets['/ops-console/github/app'], undefined);
    assert.equal((await a.get('/api/github')).json.connected, false);
});
