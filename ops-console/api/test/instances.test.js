// Integration tests for Phase 2 (instances) against a real embedded PostgreSQL and a FAKE AWS.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const zlib = require('zlib');

const ORIGIN = 'https://ops.example.test';
const PORT = 55000 + Math.floor(Math.random() * 1000);
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
    async documentsReady(region) { return region !== 'eu-west-1'; },
    async runDocument(_region, _id, document) {
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
    return { get: (u) => call('GET', u), post: (u, b) => call('POST', u, b ?? {}), patch: (u, b) => call('PATCH', u, b), del: (u) => call('DELETE', u) };
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

test('only admins can add instances (viewer, deployer and demo get 403)', async () => {
    for (const r of ['viewer', 'deployer', 'demo']) {
        const c = await signedIn(r);
        assert.equal((await c.post('/api/instances', { awsInstanceId: 'i-0aaaaaaaaaaaaaaa1', region: 'af-south-1' })).status, 403, r);
    }
    assert.equal((await client().get('/api/instances')).status, 401, 'anonymous');
});

test('adding validates format, existence, tag, state and SSM reachability', async () => {
    const a = await signedIn('admin');
    const add = (awsInstanceId, region = 'af-south-1') => a.post('/api/instances', { awsInstanceId, region });
    assert.equal((await add('not-an-id')).status, 400);
    assert.equal((await add('i-0aaaaaaaaaaaaaaa1', 'mars')).status, 400);
    assert.match((await add('i-0eeeeeeeeeeeeeee5')).json.error, /No instance/);
    assert.match((await add('i-0bbbbbbbbbbbbbbb2')).json.error, /ops-console = managed/);
    assert.match((await add('i-0ccccccccccccccc3')).json.error, /stopped/);
    assert.match((await add('i-0ddddddddddddddd4')).json.error, /SSM/);
    assert.match((await add('i-0aaaaaaaaaaaaaaa1', 'eu-west-1')).json.error, /isn't set up in eu-west-1.*deploy\.sh eu-west-1/, 'documents are regional');
});

test('adding a valid instance fetches a normalised snapshot without log lines', async () => {
    const a = await signedIn('admin');
    const r = await a.post('/api/instances', { awsInstanceId: 'i-0aaaaaaaaaaaaaaa1', region: 'af-south-1' });
    assert.equal(r.status, 201);
    const i = r.json.instance;
    assert.equal(i.name, 'web-1', 'name taken from the Name tag');
    assert.equal(i.status.source, 'agent');
    assert.equal(i.status.apps.length, 2);
    assert.deepEqual(i.status.apps.map((x) => x.healthy), [true, true]);
    assert.equal(i.status.databases.length, 1, "the 'postgres' maintenance DB is hidden");
    assert.ok(!JSON.stringify(i.status).includes('SECRET LOG LINE'), 'log lines are never stored or served');
    assert.equal((await a.post('/api/instances', { awsInstanceId: 'i-0aaaaaaaaaaaaaaa1', region: 'af-south-1' })).status, 409);
});

test('overview: KPIs, samples and activity', async () => {
    const v = await signedIn('viewer');
    const o = (await v.get('/api/instances/overview')).json;
    assert.equal(o.kpis.instances, 1);
    assert.equal(o.kpis.appsTotal, 2);
    assert.equal(o.kpis.appsHealthy, 2);
    assert.equal(o.kpis.warnings24h, 2);
    assert.equal(o.kpis.errors24h, 1);
    assert.equal(o.kpis.memPct, 60);
    assert.equal(o.kpis.certificatesExpiringSoon, 1);
    assert.equal(o.samples.length, 1);
    assert.equal(o.activity[0].instance, 'web-1');
});

test('cache: viewers get the 30s snapshot; deployers/admins can force a refresh', async () => {
    const id = (await (await signedIn('viewer')).get('/api/instances')).json.instances[0].id;
    const before = fake.runs;
    const v = await signedIn('viewer');
    await v.get(`/api/instances/${id}`); await v.get(`/api/instances/${id}?refresh=1`); await v.get('/api/instances/overview');
    assert.equal(fake.runs, before, 'no SSM calls while fresh, even with refresh=1 as a viewer');
    const d = await signedIn('deployer');
    await d.get(`/api/instances/${id}?refresh=1`);
    assert.equal(fake.runs, before + 1);
});

test('an SSM failure keeps the last good snapshot and records the error', async () => {
    const a = await signedIn('admin');
    const id = (await a.get('/api/instances')).json.instances[0].id;
    fake.failNext = true;
    const r = (await a.get(`/api/instances/${id}?refresh=1`)).json.instance;
    assert.match(r.lastError, /TimedOut/);
    assert.equal(r.status.apps.length, 2, 'stale data still served');
    fake.healthy = 1;
    const ok = (await a.get(`/api/instances/${id}?refresh=1`)).json.instance;
    assert.equal(ok.lastError, null);
    assert.deepEqual(ok.status.apps.map((x) => x.healthy), [true, false]);
});

test('rename and remove (admin) are audited; samples go with the instance', async () => {
    const a = await signedIn('admin');
    const id = (await a.get('/api/instances')).json.instances[0].id;
    assert.equal((await a.patch(`/api/instances/${id}`, { name: 'web-primary', environment: 'staging' })).json.instance.name, 'web-primary');
    assert.equal((await a.patch(`/api/instances/${id}`, { environment: 'moon' })).status, 400);
    assert.equal((await a.del(`/api/instances/${id}`)).status, 200);
    assert.equal((await a.get('/api/instances')).json.instances.length, 0);
    const { rows } = await dist('db').db().query('SELECT count(*)::int AS n FROM instance_samples');
    assert.equal(rows[0].n, 0);
    const actions = (await a.get('/api/audit')).json.entries.map((e) => e.action);
    for (const x of ['instance.add', 'instance.update', 'instance.remove']) assert.ok(actions.includes(x), x);
});
