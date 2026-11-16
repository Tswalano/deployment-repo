// Integration tests for Phase 5 (alerts, notifications, uptime) against a real embedded PostgreSQL, a FAKE AWS,
// a fake notification transport and a fake HTTP probe.
process.env.NODE_ENV = 'test';
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
          health_url: 'http://127.0.0.1:3000/health', health: { code: 200, ms: 3 }, git: { sha: 'abc12345', subject: 'feat: x' }, warnings_24h: { count: 3, errors: 1, last: 'SECRET LOG LINE' },
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
    disk: 5000, backupOk: true, events: null,
    async runDocument(_region, _id, document) {
        assert.equal(document, 'OpsConsole-CollectStatus', 'only the fixed document is ever run');
        this.runs += 1;
        if (this.failNext) { this.failNext = false; throw new Error('SSM command TimedOut'); }
        const d = agentStatus(this.healthy);
        d.host.disk.used = this.disk;
        d.backups.ok = this.backupOk;
        d.backups.at = new Date(Date.now() - 3600e3).toISOString();
        if (this.events) d.deploy_events = this.events;
        return encode({ source: 'agent', data: d });
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
    return { get: (u) => call('GET', u), post: (u, b) => call('POST', u, b ?? {}), patch: (u, b) => call('PATCH', u, b), del: (u) => call('DELETE', u), get cookie() { return cookie; } };
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
const transport = {
    failEmail: false,
    async email(to, subject, text) { if (this.failEmail) throw new Error('MessageRejected: Email address is not verified'); sent.push({ ch: 'email', to, subject, text }); },
    async webhook(url, text) { sent.push({ ch: 'webhook', url, text }); },
};
const probeState = { ok: true, ms: 40, urls: [] };
const fakeProbe = async (url) => { probeState.urls.push(url); return probeState.ok ? { ok: true, status: 200, ms: probeState.ms, error: null } : { ok: false, status: 502, ms: 12, error: null }; };

let instId, inst;
const reload = async () => (await dist('db').db().query('SELECT * FROM instances WHERE id = $1', [instId])).rows[0];
const openAlerts = async () => (await dist('db').db().query('SELECT * FROM alerts WHERE resolved_at IS NULL ORDER BY id')).rows;

test('setup', async () => {
    dist('notify').setTransport(transport);
    dist('uptime').setProbe(fakeProbe);
    const a = await signedIn('admin');
    instId = (await a.post('/api/instances', { awsInstanceId: 'i-0aaaaaaaaaaaaaaa1', region: 'af-south-1' })).json.instance.id;
    inst = await reload();
    assert.equal(inst.last_status.apps[0].healthPath, '/health');
});

test('settings: admin only, validated, webhook restricted to Slack/Discord and never returned in full', async () => {
    for (const r of ['viewer', 'deployer', 'demo']) {
        assert.equal((await (await signedIn(r)).get('/api/alerts/settings')).status, 403, r);
    }
    const a = await signedIn('admin');
    const put = (b) => a.put ? a.put('/api/alerts/settings', b) : null;
    const req = async (b) => {
        const res = await app.request('/api/alerts/settings', { method: 'PUT', headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: a.cookie }, body: JSON.stringify(b) });
        return { status: res.status, json: await res.json() };
    };
    void put;
    for (const bad of ['http://hooks.slack.com/services/T000/B000/xxxxxxxxxx', 'https://evil.example/hook', 'https://hooks.slack.com.evil.io/services/T0000000000/B00/xyz', 'https://169.254.169.254/latest']) {
        assert.equal((await req({ webhookUrl: bad })).status, 400, bad);
    }
    assert.equal((await req({ recipients: ['not-an-email'] })).status, 400);
    const ok = await req({ recipients: ['Ops@Example.com', 'ops@example.com'], webhookUrl: 'https://hooks.slack.com/services/T0000/B0000/abcdefghijklmnop', minSeverity: 'warning',
                           thresholds: { downChecks: 2, diskPct: 85, latencyMs: 999999 } });
    assert.equal(ok.status, 200);
    const s = ok.json.settings;
    assert.deepEqual(s.recipients, ['ops@example.com'], 'lower-cased and de-duplicated');
    assert.equal(s.webhookUrl, 'https://hooks.slack.com/…mnop');
    assert.equal(s.thresholds.latencyMs, 60000, 'clamped');
    assert.equal(s.thresholds.downChecks, 2);
    assert.equal((await req({ webhookUrl: s.webhookUrl, repeatHours: 1 })).json.settings.webhookSet, true, 'masked value keeps the stored URL');
});

test('uptime: probes the public https URL; app down after N failures, notified, then resolved', async () => {
    const { probeAll } = dist('uptime');
    probeState.ok = true;
    await probeAll();
    assert.ok(probeState.urls.includes('https://alpha.example/health'));
    assert.equal(probeState.urls.filter((u) => u.includes('beta')).length, 0, 'apps without a domain are not probed');
    probeState.ok = false;
    await probeAll();
    assert.equal((await openAlerts()).filter((x) => x.rule === 'app_down').length, 0, 'one failure is not an outage');
    sent.length = 0;
    await probeAll();
    const down = (await openAlerts()).find((x) => x.rule === 'app_down');
    assert.ok(down, 'down after 2 consecutive failures');
    assert.equal(down.severity, 'critical');
    assert.ok(sent.some((m) => m.ch === 'email' && m.subject === '[CRITICAL] alpha is down'), 'email sent');
    assert.ok(sent.some((m) => m.ch === 'webhook'), 'webhook sent');
    await probeAll();
    assert.equal(sent.filter((m) => m.ch === 'email').length, 1, 'no repeat before repeatHours');
    probeState.ok = true;
    sent.length = 0;
    await probeAll();
    assert.equal((await openAlerts()).filter((x) => x.rule === 'app_down').length, 0);
    assert.ok(sent.some((m) => m.subject === '[RESOLVED] alpha is down'), 'resolution sent');
});

test('uptime summary and series', async () => {
    await dist('uptime').rollup();
    const v = await signedIn('viewer');
    const r = (await v.get('/api/uptime')).json.apps.find((x) => x.project === 'alpha');
    assert.equal(r.url, 'https://alpha.example/health');
    assert.equal(r.uptime.h24, 40, '2 ok of 5 checks');
    assert.equal(r.days.length, 1);
    assert.equal(r.last.ok, true);
    const one = (await v.get(`/api/uptime/${instId}/alpha`)).json;
    assert.ok(one.series.length >= 1);
    assert.equal(one.incidents[0].rule, 'app_down');
});

test('instance rules: disk, backup, failed deploy, then recovery', async () => {
    const { evaluateInstance } = dist('alerts');
    fake.disk = 7200;  // 90%
    fake.backupOk = false;
    fake.events = [{ project: 'alpha', action: 'deploy', status: 'rolled_back', finished_at: new Date(Date.now() - 600e3).toISOString(), duration_s: 30, actor: 'ci', from_sha: 'a', to_sha: 'b' }];
    const a = await signedIn('admin');
    await a.get(`/api/instances/${instId}?refresh=1`);
    await evaluateInstance(await reload());
    const rules = (await openAlerts()).map((x) => x.rule).sort();
    assert.deepEqual(rules.filter((r) => ['backup', 'deploy_failed', 'disk_high'].includes(r)), ['backup', 'deploy_failed', 'disk_high']);
    assert.ok(rules.includes('cert_expiring'), 'fixture cert has 12 days left');

    fake.disk = 5000; fake.backupOk = true;
    fake.events = [{ project: 'alpha', action: 'deploy', status: 'success', finished_at: new Date().toISOString(), duration_s: 30, actor: 'ci', from_sha: 'b', to_sha: 'c' }, ...fake.events];
    await a.get(`/api/instances/${instId}?refresh=1`);
    await evaluateInstance(await reload());
    const left = (await openAlerts()).map((x) => x.rule);
    for (const r of ['backup', 'deploy_failed', 'disk_high']) assert.ok(!left.includes(r), `${r} resolved`);
});

test('alerts API: viewers read, deployers acknowledge (not the demo); ack stops reminders', async () => {
    const v = await signedIn('viewer');
    const list = (await v.get('/api/alerts?state=open')).json;
    assert.ok(list.counts.open >= 1);
    const id = list.alerts[0].id;
    assert.equal((await v.post(`/api/alerts/${id}/ack`)).status, 403);
    assert.equal((await (await signedIn('demo')).post(`/api/alerts/${id}/ack`)).status, 403);
    const d = await signedIn('deployer');
    const r = await d.post(`/api/alerts/${id}/ack`);
    assert.equal(r.status, 200);
    assert.equal(r.json.alert.ackedBy, 'deployer');
    assert.equal((await d.post(`/api/alerts/${id}/ack`)).status, 404, 'only once');
    const overview = (await v.get('/api/instances/overview')).json;
    assert.ok(overview.alerts.open >= 1);
});

test('test notification reports per-channel failures (e.g. SES sandbox) and is audited', async () => {
    const a = await signedIn('admin');
    transport.failEmail = true;
    const r = await a.post('/api/alerts/test');
    transport.failEmail = false;
    assert.equal(r.status, 200);
    const email = r.json.results.find((x) => x.channel === 'email');
    assert.equal(email.ok, false);
    assert.match(email.error, /not verified/);
    assert.equal(r.json.results.find((x) => x.channel === 'webhook').ok, true);
    const actions = (await a.get('/api/audit')).json.entries.map((e) => e.action);
    for (const x of ['alert.settings', 'alert.ack', 'alert.test']) assert.ok(actions.includes(x), x);
});
