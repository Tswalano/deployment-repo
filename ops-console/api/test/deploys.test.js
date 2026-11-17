// Integration tests for Phase 3 (deploy, rollback, logs) against a real embedded PostgreSQL and a FAKE AWS.
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
const logsBlob = zlib.gzipSync(JSON.stringify({ entries: [
    { ts: 1, level: 'info', source: 'node', message: 'started' }, { ts: 2, level: 'info', source: 'node', message: 'listening' }],
    by_level: { info: 2 }, source: 'agent', truncated: false })).toString('base64');
const detailFixture = {
    branch: 'main', deploy_summary: { deploys_7d: 3, success_rate_7d: 100, median_duration_s: 40 },
    unit: { active: 'active', restarts: 0, memory: 5e7, cpu_seconds: 12.5, user: 'ec2-user', unit_file: '/etc/systemd/system/alpha.service', env: [{ name: 'PORT', value: '3000' }] },
    health: { url: 'http://127.0.0.1:3000/health', code: 200, ms: 4, body: '{"db":"ok"}' },
    git: { sha: 'abc12345', behind: 2, upstream_commits: [{ sha: 'fff11111', subject: 'feat: new', author: 'dev', date: '2026-11-16' }], commits: [], dirty_files: ['src/x.ts'] },
    config: { SOURCE_DIR: '/opt/apps/alpha' },
    database: { ok: true, name: 'alpha', size: 9e6, stats: { cache_hit_pct: 99.5 }, blocked: 0,
        tables: [{ table: 'public.loans', rows: 40, dead: 2 }, { table: 'public.users', rows: 10, dead: 0 }],
        connections: [{ state: 'idle', user: 'alpha', app: 'node' }], active_queries: [{ pid: 9, state: 'active', seconds: 3, user: 'alpha', app: 'node' }],
        unused_indexes: [{ index: 'ix', table: 'loans', size: 8192 }] },
};
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
        assert.ok(['OpsConsole-CollectStatus', 'OpsConsole-AppLogs', 'OpsConsole-AppDetail'].includes(document), 'only fixed documents are run');
        this.runs += 1;
        if (document === 'OpsConsole-AppLogs') return logsBlob;
        if (document === 'OpsConsole-AppDetail') { this.detailCalls.push(arguments[3]); return zlib.gzipSync(JSON.stringify(detailFixture)).toString('base64'); }
        if (this.failNext) { this.failNext = false; throw new Error('SSM command TimedOut'); }
        return encode({ source: 'agent', data: agentStatus(this.healthy) });
    },
    commands: {}, nextId: 0, sendFails: false, detailCalls: [],
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

test('logs: deployer/admin only, filters validated, audited', async () => {
    const d = await signedIn('deployer');
    const r = await d.get(`/api/instances/${instId}/apps/alpha/logs?lines=50&level=error&since=1h&q=GET%20%2Fapi`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.entries.map((e) => e.message), ['started', 'listening']);
    for (const bad of ['level=fatal', 'since=99y', "q=%27%3Bid", 'q=%24(id)', 'q=a%22b']) {
        assert.equal((await d.get(`/api/instances/${instId}/apps/alpha/logs?${bad}`)).status, 400, bad);
    }
    const actions = (await (await signedIn('admin')).get('/api/audit')).json.entries.map((e) => e.action);
    for (const x of ['app.deploy', 'app.rollback', 'app.logs']) assert.ok(actions.includes(x), x);
});

test('app detail: viewers get metrics only; operators get tables, config and git fetch', async () => {
    const v = await signedIn('viewer');
    const rv = await v.get(`/api/instances/${instId}/apps/alpha/detail?fetch=1`);
    assert.equal(rv.status, 200);
    const dv = rv.json.detail;
    assert.equal(dv.git.behind, 2);
    assert.equal(dv.database.tableCount, 2);
    assert.equal(dv.database.rows, 50);
    assert.equal(dv.database.tables, undefined, 'no table names for viewers');
    assert.equal(dv.database.activeQueries[0].user, undefined);
    assert.equal(dv.config, null);
    assert.equal(dv.health.body, undefined);
    assert.equal(dv.unit.env, undefined);
    assert.equal(dv.git.dirty, 1, 'viewers see a count, not file names');
    assert.deepEqual(fake.detailCalls.at(-1), { project: ['alpha'], fetch: ['no'] }, 'viewer cannot trigger git fetch');

    const a = await signedIn('admin');
    const calls = fake.detailCalls.length;
    const da = (await a.get(`/api/instances/${instId}/apps/alpha/detail`)).json.detail;
    assert.equal(fake.detailCalls.length, calls, 'served from the 30s cache');
    assert.equal(da.database.tables[0].table, 'public.loans');
    assert.equal(da.config.SOURCE_DIR, '/opt/apps/alpha');
    await a.get(`/api/instances/${instId}/apps/alpha/detail?fetch=1`);
    assert.deepEqual(fake.detailCalls.at(-1), { project: ['alpha'], fetch: ['yes'] });
});

test('database series: rates from counters, resets ignored', async () => {
    const q = (sql, args) => dist('db').db().query(sql, args);
    await q('DELETE FROM db_samples');
    const ins = (mins, commit, hit, read) => q(`INSERT INTO db_samples (instance_id, db, at, size, connections, xact_commit, xact_rollback, blks_hit, blks_read, deadlocks)
        VALUES ($1, 'alpha', now() - make_interval(mins => $2), 100, 2, $3, 0, $4, $5, 0)`, [instId, mins, commit, hit, read]);
    await ins(15, 1000, 900, 100); await ins(10, 1600, 1890, 110); await ins(5, 10, 10, 0);
    const pts = (await dist('insights').dbSeries(instId, 24, 'alpha')).alpha;
    assert.equal(pts.length, 3);
    assert.equal(pts[0].tps, null);
    assert.equal(pts[1].tps, 2);              // 600 commits / 300 s
    assert.equal(pts[1].cacheHitPct, 99);     // 990 hits / 1000 blocks
    assert.equal(pts[2].tps, null, 'counter reset is not a negative rate');
});
