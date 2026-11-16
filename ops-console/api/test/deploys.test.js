// Integration tests for Phase 3 (deploy, rollback, logs) against a real embedded PostgreSQL and a FAKE AWS.
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
    async runDocument(_region, _id, document) {
        assert.ok(['OpsConsole-CollectStatus', 'OpsConsole-AppLogs'].includes(document), 'only fixed documents are run');
        this.runs += 1;
        if (document === 'OpsConsole-AppLogs') return zlib.gzipSync('2026-11-16T10:00:00 started\n2026-11-16T10:00:01 listening\n').toString('base64');
        if (this.failNext) { this.failNext = false; throw new Error('SSM command TimedOut'); }
        return encode({ source: 'agent', data: agentStatus(this.healthy) });
    },
    commands: {}, nextId: 0, sendFails: false,
    async sendDocument(_region, id, document, parameters) {
        if (this.sendFails) throw new Error('AccessDenied');
        const cid = `cmd-${++this.nextId}`;
        this.commands[cid] = { id, document, parameters, inv: { status: 'running', detail: 'InProgress', stdout: '', stderr: '' } };
        return cid;
    },
    async getInvocation(_region, _id, cid) { return this.commands[cid]?.inv ?? null; },
    finish(cid, ok) { this.commands[cid].inv = { status: ok ? 'success' : 'failed', detail: ok ? 'Success' : 'Failed', stdout: '[alpha] ✔ deployed abc', stderr: ok ? '' : 'health check failed' }; },
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


let instId;
const lastCmd = () => fake.commands[`cmd-${fake.nextId}`];

test('setup: admin adds an instance', async () => {
    const a = await signedIn('admin');
    instId = (await a.post('/api/instances', { awsInstanceId: 'i-0aaaaaaaaaaaaaaa1', region: 'af-south-1' })).json.instance.id;
    assert.ok(instId);
});

test('app view: any role; output and canOperate only for deployer/admin', async () => {
    const v = await signedIn('viewer');
    const r = await v.get(`/api/instances/${instId}/apps/alpha`);
    assert.equal(r.status, 200);
    assert.equal(r.json.app.project, 'alpha');
    assert.equal(r.json.canOperate, false);
    assert.equal(r.json.events.length, 1);
    assert.equal((await v.get(`/api/instances/${instId}/apps/nope`)).status, 404);
    assert.equal((await v.get(`/api/instances/${instId}/apps/..%2Fetc`)).status, 404);
    assert.equal((await (await signedIn('deployer')).get(`/api/instances/${instId}/apps/alpha`)).json.canOperate, true);
});

test('viewers and the demo cannot deploy, roll back or read logs', async () => {
    for (const r of ['viewer', 'demo']) {
        const c = await signedIn(r);
        assert.equal((await c.post(`/api/instances/${instId}/apps/alpha/deploy`, {})).status, 403, r);
        assert.equal((await c.post(`/api/instances/${instId}/apps/alpha/rollback`, {})).status, 403, r);
        assert.equal((await c.get(`/api/instances/${instId}/apps/alpha/logs`)).status, 403, r);
    }
    assert.equal(fake.nextId, 0, 'nothing was sent to SSM');
});

test('deploy input validation: refs, rollback SHAs, unknown apps', async () => {
    const d = await signedIn('deployer');
    const deploy = (p, ref, act = 'deploy') => d.post(`/api/instances/${instId}/apps/${p}/${act}`, { ref });
    for (const bad of ['main; rm -rf /', '$(id)', '-x', '../x', 'a..b', 'a b', "a'b", 'x'.repeat(101)]) {
        assert.equal((await deploy('alpha', bad)).status, 400, bad);
    }
    assert.equal((await deploy('alpha', 'main', 'rollback')).status, 400, 'rollback needs a sha');
    assert.equal((await deploy('gamma', '')).status, 400, 'not an app on this instance');
    assert.equal(fake.nextId, 0);
});

test('deployer deploys: fixed document, validated params, one at a time, completes', async () => {
    const d = await signedIn('deployer');
    const r = await d.post(`/api/instances/${instId}/apps/alpha/deploy`, { ref: 'feature/x-1.2' });
    assert.equal(r.status, 202);
    const dep = r.json.deployment;
    assert.equal(dep.status, 'running');
    const cmd = lastCmd();
    assert.equal(cmd.document, 'OpsConsole-Deploy');
    assert.deepEqual(cmd.parameters, { action: ['deploy'], project: ['alpha'], ref: ['feature/x-1.2'], actor: ['deployer@ops-console'] });

    assert.equal((await d.post(`/api/instances/${instId}/apps/beta/deploy`, {})).status, 409, 'second deploy on the same instance');

    const v = await signedIn('viewer');
    assert.equal((await v.get(`/api/deployments/${dep.id}`)).json.deployment.status, 'running');
    fake.finish(`cmd-${fake.nextId}`, true);
    const done = (await v.get(`/api/deployments/${dep.id}`)).json.deployment;
    assert.equal(done.status, 'success');
    assert.equal(done.output, undefined, 'viewers never see pipeline output');
    assert.match((await d.get(`/api/deployments/${dep.id}`)).json.deployment.output, /deployed abc/);
    assert.equal((await v.get('/api/deployments')).json.deployments[0].instance, 'web-1');
});

test('rollback to a SHA; a failed run is reported as failed', async () => {
    const a = await signedIn('admin');
    const r = await a.post(`/api/instances/${instId}/apps/alpha/rollback`, { ref: 'abc1234' });
    assert.equal(r.status, 202);
    assert.deepEqual(lastCmd().parameters.action, ['rollback']);
    fake.finish(`cmd-${fake.nextId}`, false);
    const app = (await a.get(`/api/instances/${instId}/apps/alpha`)).json;
    assert.equal(app.deployments[0].status, 'failed');
    assert.match(app.deployments[0].output, /health check failed/);
});

test('an SSM send failure does not leave a stuck running deployment', async () => {
    const a = await signedIn('admin');
    fake.sendFails = true;
    const r = await a.post(`/api/instances/${instId}/apps/alpha/deploy`, {});
    fake.sendFails = false;
    assert.equal(r.status, 400);
    assert.match(r.json.error, /AccessDenied/);
    assert.equal((await a.post(`/api/instances/${instId}/apps/alpha/deploy`, {})).status, 202, 'next deploy is allowed');
    fake.finish(`cmd-${fake.nextId}`, true);
    await a.get('/api/deployments');
});

test('logs: deployer/admin only, audited', async () => {
    const d = await signedIn('deployer');
    const r = await d.get(`/api/instances/${instId}/apps/alpha/logs?lines=50`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.lines, ['2026-11-16T10:00:00 started', '2026-11-16T10:00:01 listening']);
    const actions = (await (await signedIn('admin')).get('/api/audit')).json.entries.map((e) => e.action);
    for (const x of ['app.deploy', 'app.rollback', 'app.logs']) assert.ok(actions.includes(x), x);
});
