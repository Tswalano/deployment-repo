// Integration tests for Phase 8 (secrets inventory, rotation, provider-key updates) with a FAKE AWS.
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
    puts: [], rotateResult: { ok: true, updated: ['/apps/alpha/JWT_SECRET'], restarted: ['alpha'], health: { alpha: 200 } }, reloadOk: true, rotateCalls: [],
    async listParameters(_r, path) {
        return Object.entries(this.params).filter(([n]) => n.startsWith(path + '/')).map(([name, p]) => ({ name, type: 'SecureString', version: 2,
            lastModified: new Date(Date.now() - p.mod * 86400e3).toISOString(), lastModifiedBy: 'cli_admin_user' }));
    },
    async getParameter(_r, name) { return this.params[name]?.v ?? null; },
    async putParameter(_r, name, value) { this.puts.push([name, value]); if (this.params[name]) this.params[name].v = value; },
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


const sent = [];
let id;
test('setup', async () => {
    dist('notify').setTransport({ async email(to, subject) { sent.push(subject); }, async webhook() {} });
    await dist('settings').saveAlertSettings({ ...dist('settings').DEFAULT_ALERT_SETTINGS, recipients: ['ops@example.com'] }, 'test');
    id = (await (await signedIn('admin')).post('/api/instances', { awsInstanceId: 'i-0aaaaaaaaaaaaaaa1', region: 'af-south-1' })).json.instance.id;
});

test('regression: viewers still reach the instance routes', async () => {
    const v = await signedIn('viewer');
    assert.equal((await v.get('/api/instances')).status, 200);
    assert.equal((await v.get(`/api/instances/${id}`)).status, 200);
    assert.equal((await v.get(`/api/instances/${id}/apps/alpha`)).status, 200);
});

test('inventory: deployers/admins only; names, ages and roles but never values', async () => {
    for (const r of ['viewer', 'demo']) assert.equal((await (await signedIn(r)).get(`/api/instances/${id}/secrets`)).status, 403, r);
    const r = await (await signedIn('deployer')).get(`/api/instances/${id}/secrets`);
    assert.equal(r.status, 200);
    const body = JSON.stringify(r.json);
    for (const secret of ['S3CRETpw', 'jwt-SECRET-value', 'sk_live_OLDKEY', 'https://alpha.example']) assert.ok(!body.includes(secret), `leaked ${secret}`);
    const alpha = r.json.apps.find((a) => a.service === 'alpha');
    const by = Object.fromEntries(alpha.secrets.map((s) => [s.key, s]));
    assert.deepEqual([by.DATABASE_URL.kind, by.JWT_SECRET.kind, by.PAYSTACK_SECRET_KEY.kind, by.BASE_URL.kind], ['db', 'jwt', 'provider', 'config']);
    assert.equal(by.JWT_SECRET.stale, true, '400 days old');
    assert.equal(by.BASE_URL.stale, false, 'config is never "stale"');
    assert.equal(alpha.dbRole, 'alpha_user');
    assert.deepEqual(r.json.dbRoles, [{ role: 'alpha_user', usedBy: ['alpha', 'beta'] }]);
});

test('rotate: admin only, typed confirmation, console roles refused, announced and audited', async () => {
    assert.equal((await (await signedIn('deployer')).post(`/api/instances/${id}/secrets/rotate`, { kind: 'jwt', target: 'alpha', confirm: 'alpha' })).status, 403);
    const a = await signedIn('admin');
    assert.equal((await a.post(`/api/instances/${id}/secrets/rotate`, { kind: 'jwt', target: 'alpha', confirm: 'nope' })).status, 400);
    assert.equal((await a.post(`/api/instances/${id}/secrets/rotate`, { kind: 'db-password', target: 'opsconsole', confirm: 'opsconsole' })).status, 400);
    assert.equal((await a.post(`/api/instances/${id}/secrets/rotate`, { kind: 'shell', target: 'x', confirm: 'x' })).status, 400);
    assert.equal(fake.rotateCalls.length, 0);
    sent.length = 0;
    const ok = await a.post(`/api/instances/${id}/secrets/rotate`, { kind: 'jwt', target: 'alpha', confirm: 'alpha' });
    assert.equal(ok.status, 200);
    assert.deepEqual(fake.rotateCalls.at(-1), ['jwt', 'alpha']);
    assert.ok(sent.some((s) => s.startsWith('[SECRETS] Rotated the JWT secret of alpha')));
    fake.rotateResult = { ok: false, error: 'beta unhealthy (502)', restored: true, updated: ['/apps/alpha/DATABASE_URL'], restarted: ['alpha', 'beta'] };
    const bad = await a.post(`/api/instances/${id}/secrets/rotate`, { kind: 'db-password', target: 'alpha_user', confirm: 'alpha_user' });
    assert.equal(bad.status, 409);
    assert.equal(bad.json.restored, true);
    assert.ok(sent.some((s) => s.includes('FAILED')));
});

test('provider key update: saved, app reloaded; unhealthy → previous value restored', async () => {
    const a = await signedIn('admin');
    const put = (b) => a.put(`/api/instances/${id}/secrets/value`, b);
    assert.equal((await (await signedIn('deployer')).put(`/api/instances/${id}/secrets/value`, { service: 'alpha', key: 'PAYSTACK_SECRET_KEY', value: 'x' })).status, 403);
    assert.equal((await put({ service: 'alpha', key: 'JWT_SECRET', value: 'mine' })).status, 400, 'generated secrets are rotated, not typed');
    assert.equal((await put({ service: 'alpha', key: 'DATABASE_URL', value: 'postgresql://x' })).status, 400);
    assert.equal((await put({ service: 'ops-console', key: 'TRANSFER_BUCKET', value: 'x' })).status, 403);
    assert.equal((await put({ service: 'alpha', key: 'NEW_THING', value: 'x' })).status, 400, 'only existing parameters');
    assert.equal((await put({ service: 'alpha', key: 'PAYSTACK_SECRET_KEY', value: 'two\nlines' })).status, 400);

    fake.puts.length = 0;
    const ok = await put({ service: 'alpha', key: 'PAYSTACK_SECRET_KEY', value: 'sk_live_NEWKEY' });
    assert.equal(ok.status, 200);
    assert.ok(!JSON.stringify(ok.json).includes('sk_live_NEWKEY'), 'value never echoed');
    assert.deepEqual(fake.puts, [['/apps/alpha/PAYSTACK_SECRET_KEY', 'sk_live_NEWKEY']]);
    assert.deepEqual(fake.rotateCalls.at(-1), ['reload', 'alpha']);

    fake.reloadOk = false; fake.puts.length = 0;
    const bad = await put({ service: 'alpha', key: 'PAYSTACK_SECRET_KEY', value: 'sk_live_BROKEN' });
    assert.equal(bad.status, 409);
    assert.match(bad.json.error, /previous value was restored/);
    assert.deepEqual(fake.puts, [['/apps/alpha/PAYSTACK_SECRET_KEY', 'sk_live_BROKEN'], ['/apps/alpha/PAYSTACK_SECRET_KEY', 'sk_live_NEWKEY']]);
    const audit = (await a.get('/api/audit')).json.entries.filter((e) => e.action.startsWith('secret.'));
    assert.ok(audit.length >= 4);
    assert.ok(!JSON.stringify(audit).includes('sk_live_'), 'values never in the audit log');
});
