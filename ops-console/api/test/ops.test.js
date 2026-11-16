// Integration tests for Phase 9 (instance schedules, costs) with a FAKE AWS.
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
    schedules: [
        { name: 'EC2_Stop_Instance_Daily', group: 'default', expression: 'cron(0 18 * * ? *)', timezone: 'Africa/Johannesburg', state: 'ENABLED',
          targetArn: 'arn:aws:lambda:af-south-1:000000000000:function:AutoStartStop', input: '{"INSTANCE_IDS": "i-0aaaaaaaaaaaaaaa1", "ACTION": "stop"}' },
        { name: 'EC2_Start_Instance_Daily', group: 'default', expression: 'cron(0 6 * * ? *)', timezone: 'Africa/Johannesburg', state: 'ENABLED',
          targetArn: 'arn:aws:lambda:af-south-1:000000000000:function:AutoStartStop', input: '{"INSTANCE_IDS": "i-0aaaaaaaaaaaaaaa1", "ACTION": "start"}' },
        { name: 'other-box', group: 'default', expression: 'cron(0 1 * * ? *)', timezone: 'UTC', state: 'ENABLED',
          targetArn: 'arn:aws:scheduler:::aws-sdk:ec2:stopInstances', input: '{"InstanceIds": ["i-0fffffffffffffff9"]}' },
    ],
    updates: [], ceCalls: 0,
    async listSchedules() { return this.schedules.map((s) => ({ ...s })); },
    async updateSchedule(_r, group, name, patch) {
        this.updates.push([name, patch]);
        const s = this.schedules.find((x) => x.name === name);
        if (patch.expression) s.expression = patch.expression;
        if (patch.state) s.state = patch.state;
    },
    async costRows(start, end) {
        this.ceCalls++;
        const rows = [];
        for (let d = new Date(start + 'T00:00:00Z'); d.toISOString().slice(0, 10) < end; d = new Date(d.getTime() + 86400e3)) {
            const day = d.toISOString().slice(0, 10);
            rows.push({ day, service: 'Amazon Elastic Compute Cloud - Compute', amount: 0.2, unit: 'USD' }, { day, service: 'EC2 - Other', amount: 0.05, unit: 'USD' });
        }
        return rows;
    },
    async costForecast() { this.ceCalls++; return 3.5; },
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


let id;
test('setup', async () => {
    id = (await (await signedIn('admin')).post('/api/instances', { awsInstanceId: 'i-0aaaaaaaaaaaaaaa1', region: 'af-south-1' })).json.instance.id;
});

test('cron maths: Johannesburg times, weekdays, building and at()', () => {
    const { nextRun, buildCron, interpret } = dist('schedule');
    assert.equal(nextRun('cron(0 18 * * ? *)', 'Africa/Johannesburg', new Date('2026-11-16T12:00:00Z')).toISOString(), '2026-11-16T16:00:00.000Z');
    assert.equal(nextRun('cron(0 18 * * ? *)', 'Africa/Johannesburg', new Date('2026-11-16T16:00:00Z')).toISOString(), '2026-11-17T16:00:00.000Z', 'strictly after');
    // 2026-11-20 is a Friday: next weekday 06:00 SAST after Friday noon is Monday 04:00 UTC
    assert.equal(nextRun('cron(0 6 ? * MON-FRI *)', 'Africa/Johannesburg', new Date('2026-11-20T10:00:00Z')).toISOString(), '2026-11-23T04:00:00.000Z');
    assert.equal(buildCron('06:30', [1, 2, 3, 4, 5]), 'cron(30 6 ? * MON,TUE,WED,THU,FRI *)');
    assert.equal(buildCron('18:00', [0, 1, 2, 3, 4, 5, 6]), 'cron(0 18 * * ? *)');
    assert.equal(nextRun('at(2026-12-01T09:00:00)', 'Africa/Johannesburg', new Date('2026-11-16T00:00:00Z')).toISOString(), '2026-12-01T07:00:00.000Z');
    assert.deepEqual(interpret({ targetArn: 'arn:aws:scheduler:::aws-sdk:ec2:startInstances', input: '{"InstanceIds":["i-0abc1234"]}' }), { action: 'start', instanceIds: ['i-0abc1234'] });
});

test('schedule view: every role reads; only this instance\'s schedules', async () => {
    const r = await (await signedIn('demo')).get(`/api/instances/${id}/schedule`);
    assert.equal(r.status, 200);
    const s = r.json.schedules;
    assert.deepEqual(s.map((x) => [x.action, x.name, x.time, x.days.length, x.editable]), [['start', 'EC2_Start_Instance_Daily', '06:00', 7, true], ['stop', 'EC2_Stop_Instance_Daily', '18:00', 7, true]]);
    assert.ok(s[1].next);
});

test('edit: admin only, validated, keeps everything else', async () => {
    assert.equal((await (await signedIn('deployer')).put(`/api/instances/${id}/schedule/EC2_Stop_Instance_Daily`, { time: '20:00' })).status, 403);
    const a = await signedIn('admin');
    assert.equal((await a.put(`/api/instances/${id}/schedule/EC2_Stop_Instance_Daily`, { time: '25:00' })).status, 400);
    assert.equal((await a.put(`/api/instances/${id}/schedule/EC2_Stop_Instance_Daily`, { days: [] })).status, 400);
    assert.equal((await a.put(`/api/instances/${id}/schedule/other-box`, { time: '02:00' })).status, 404, 'targets another instance');
    const r = await a.put(`/api/instances/${id}/schedule/EC2_Stop_Instance_Daily`, { time: '20:30', days: [1, 2, 3, 4, 5] });
    assert.equal(r.status, 200);
    assert.deepEqual(fake.updates.at(-1), ['EC2_Stop_Instance_Daily', { expression: 'cron(30 20 ? * MON,TUE,WED,THU,FRI *)' }]);
    await a.put(`/api/instances/${id}/schedule/EC2_Stop_Instance_Daily`, { time: '18:00', days: [0, 1, 2, 3, 4, 5, 6] });
});

test('keep running tonight: pauses the stop, re-enables it after the skipped time', async () => {
    const v = await signedIn('viewer');
    assert.equal((await v.post(`/api/instances/${id}/schedule/EC2_Stop_Instance_Daily/skip`)).status, 403);
    const d = await signedIn('deployer');
    assert.equal((await d.post(`/api/instances/${id}/schedule/EC2_Start_Instance_Daily/skip`)).status, 400, 'only stop schedules');
    const r = await d.post(`/api/instances/${id}/schedule/EC2_Stop_Instance_Daily/skip`);
    assert.equal(r.status, 200);
    assert.deepEqual(fake.updates.at(-1), ['EC2_Stop_Instance_Daily', { state: 'DISABLED' }]);
    const stop = r.json.schedules.find((x) => x.action === 'stop');
    assert.equal(stop.enabled, false);
    assert.equal(stop.skip.by, 'deployer');
    const { reenableExpiredSkips } = dist('schedule');
    await reenableExpiredSkips();
    assert.notDeepEqual(fake.updates.at(-1)[1], { state: 'ENABLED' }, 'not yet');
    await dist('db').db().query(`UPDATE settings SET value = jsonb_set(value, '{0,until}', to_jsonb((now() - interval '1 minute')::text)) WHERE key = 'schedule_skips'`);
    await reenableExpiredSkips();
    assert.deepEqual(fake.updates.at(-1), ['EC2_Stop_Instance_Daily', { state: 'ENABLED' }]);
    const after = (await v.get(`/api/instances/${id}/schedule`)).json.schedules.find((x) => x.action === 'stop');
    assert.equal(after.enabled, true);
    assert.equal(after.skip, null);
});

test('cost summary maths', () => {
    const { summarise } = dist('costs');
    const now = new Date('2026-11-16T12:00:00Z');
    const rows = [
        { day: '2026-10-01', service: 'EC2', amount: 1, unit: 'USD' }, { day: '2026-10-20', service: 'EC2', amount: 2, unit: 'USD' },
        { day: '2026-11-01', service: 'EC2', amount: 3, unit: 'USD' }, { day: '2026-11-10', service: 'S3', amount: 1, unit: 'USD' },
    ];
    const s = summarise(rows, 4, now);
    assert.deepEqual([s.monthToDate, s.lastMonth, s.lastMonthSamePeriod, s.forecast, s.forecastSource], [4, 3, 1, 8, 'aws']);
    assert.equal(summarise(rows, null, now).forecast, 7.5, 'linear: 4 over 16 days of 30');
    assert.equal(s.services[0].name, 'EC2');
});

test('costs: deployers/admins only; cached so Cost Explorer is called sparingly; budget alerts', async () => {
    for (const r of ['viewer', 'demo']) assert.equal((await (await signedIn(r)).get('/api/costs')).status, 403, r);
    const d = await signedIn('deployer');
    const r1 = await d.get('/api/costs');
    assert.equal(r1.status, 200);
    assert.equal(fake.ceCalls, 2, 'one usage + one forecast request');
    assert.ok(r1.json.summary.monthToDate > 0);
    await d.get('/api/costs');
    assert.equal(fake.ceCalls, 2, 'served from the cache');
    assert.equal((await d.post('/api/costs/refresh')).status, 403, 'manual refresh is admin only');
    const a = await signedIn('admin');
    const r2 = await a.post('/api/costs/refresh');
    assert.equal(r2.json.fetched, false, 'manual refresh limited to once an hour');
    assert.equal(fake.ceCalls, 2);

    assert.equal((await a.put('/api/costs/settings', { monthlyBudget: -5 })).status, 400);
    const forecast = r1.json.summary.forecast;
    await a.put('/api/costs/settings', { monthlyBudget: Math.max(0.01, Math.floor(forecast) - 1), zarRate: 18.5 });
    let open = (await dist('db').db().query("SELECT severity FROM alerts WHERE rule = 'cost_budget' AND resolved_at IS NULL")).rows;
    assert.equal(open.length, 1);
    await a.put('/api/costs/settings', { monthlyBudget: forecast + 100, zarRate: 18.5 });
    open = (await dist('db').db().query("SELECT 1 FROM alerts WHERE rule = 'cost_budget' AND resolved_at IS NULL")).rows;
    assert.equal(open.length, 0, 'resolved once the budget is raised');
    assert.equal((await a.get('/api/costs')).json.settings.zarRate, 18.5);
});
