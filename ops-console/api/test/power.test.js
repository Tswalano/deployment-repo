// Integration tests for EC2 power actions (start/reboot/stop/terminate) with a FAKE AWS.
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
        'i-0eeeeeeeeeeeeeee5': { name: 'worker', state: 'running', type: 't3.micro', az: 'af-south-1a', managedTag: true, online: true },
        'i-0ddddddddddddddd4': { name: 'no-ssm', state: 'running', type: 't3.micro', az: 'af-south-1a', managedTag: true, online: false },
    },
    runs: 0, failNext: false, healthy: 2,
    async describeInstance(_region, id) { const i = this.instances[id]; return i ? { ...i } : null; },
    async ssmOnline(_region, id) { return !!this.instances[id]?.online; },
    power: [],
    async powerAction(_region, id, action, dryRun) {
        if (this.instances[id].protected && action === 'terminate') throw new Error('AWS refused: termination protection is on for this instance (disable it in the EC2 console first).');
        this.power.push([id, action, dryRun]);
        if (action === 'stop') this.instances[id].state = 'stopped';
    },
    async selfInstanceId() { return 'i-0aaaaaaaaaaaaaaa1'; },
    async documentsReady(region) { return region !== 'eu-west-1'; },
    async runDocument(_region, _id, document) {
        assert.equal(document, 'OpsConsole-CollectStatus', 'only the fixed document is ever run');
        this.runs += 1;
        if (this.instances[_id]?.state === 'stopped') throw new Error('InvalidInstanceId: not connected');
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


const sent = [];
let host, worker;
test('setup', async () => {
    dist('notify').setTransport({ async email(to, subject) { sent.push(subject); }, async webhook() {} });
    await dist('settings').saveAlertSettings({ ...dist('settings').DEFAULT_ALERT_SETTINGS, recipients: ['ops@example.com'] }, 'test');
    const a = await signedIn('admin');
    host = (await a.post('/api/instances', { awsInstanceId: 'i-0aaaaaaaaaaaaaaa1', region: 'af-south-1' })).json.instance.id;
    worker = (await a.post('/api/instances', { awsInstanceId: 'i-0eeeeeeeeeeeeeee5', region: 'af-south-1' })).json.instance.id;
    assert.equal((await a.get(`/api/instances/${host}`)).json.instance.isConsoleHost, true);
    assert.equal((await a.get(`/api/instances/${worker}`)).json.instance.isConsoleHost, false);
});

test('roles: viewers/demo nothing; deployers start/reboot only', async () => {
    for (const r of ['viewer', 'demo']) assert.equal((await (await signedIn(r)).post(`/api/instances/${worker}/power`, { action: 'reboot' })).status, 403, r);
    const d = await signedIn('deployer');
    assert.equal((await d.post(`/api/instances/${worker}/power`, { action: 'stop', confirm: 'worker' })).status, 403);
    assert.equal((await d.post(`/api/instances/${worker}/power`, { action: 'terminate', confirm: 'worker', reason: 'cleanup of old box' })).status, 403);
    assert.equal((await d.post(`/api/instances/${worker}/power`, { action: 'reboot' })).status, 200);
    assert.deepEqual(fake.power.at(-1), ['i-0eeeeeeeeeeeeeee5', 'reboot', false]);
    assert.equal((await d.post(`/api/instances/${worker}/power`, { action: 'explode' })).status, 400);
});

test('stop/terminate need the typed name; terminate needs a reason; the console host is protected', async () => {
    const a = await signedIn('admin');
    const n = fake.power.length;
    assert.equal((await a.post(`/api/instances/${worker}/power`, { action: 'stop', confirm: 'wrong' })).status, 400);
    assert.equal((await a.post(`/api/instances/${worker}/power`, { action: 'terminate', confirm: 'worker', reason: 'short' })).status, 400);
    const self = await a.post(`/api/instances/${host}/power`, { action: 'stop', confirm: 'web-1' });
    assert.equal(self.status, 409);
    assert.match(self.json.error, /Ops Console runs on web-1/);
    assert.equal((await a.post(`/api/instances/${host}/power`, { action: 'terminate', confirm: 'web-1', reason: 'should never work' })).status, 409);
    assert.equal(fake.power.length, n, 'nothing reached EC2');
    assert.equal((await a.post(`/api/instances/${host}/power`, { action: 'reboot' })).status, 200, 'rebooting the console host is allowed');
});

test('stop: announced, audited, then shown as stopped (not unreachable) with no alert', async () => {
    const a = await signedIn('admin');
    sent.length = 0;
    const r = await a.post(`/api/instances/${worker}/power`, { action: 'stop', confirm: 'worker' });
    assert.equal(r.status, 200);
    assert.ok(sent.some((s) => s.startsWith('[POWER] worker stopped by admin')));
    const i = (await a.get(`/api/instances/${worker}?refresh=1`)).json.instance;
    assert.equal(i.lastError, 'Instance is stopped');
    assert.equal(i.ec2State, 'stopped');
    const row = (await dist('db').db().query('SELECT * FROM instances WHERE id = $1', [worker])).rows[0];
    await dist('alerts').evaluateInstance(row);
    const { rows } = await dist('db').db().query("SELECT 1 FROM alerts WHERE rule = 'instance_unreachable' AND resolved_at IS NULL");
    assert.equal(rows.length, 0, 'a stopped instance is not an outage');
    const actions = (await a.get('/api/audit')).json.entries.map((e) => e.action);
    for (const x of ['instance.reboot', 'instance.stop']) assert.ok(actions.includes(x), x);
});

test('terminate: AWS termination protection is reported clearly', async () => {
    fake.instances['i-0eeeeeeeeeeeeeee5'].protected = true;
    const r = await (await signedIn('admin')).post(`/api/instances/${worker}/power`, { action: 'terminate', confirm: 'worker', reason: 'decommissioning the worker' });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /termination protection/);
});
