// Integration tests for Phase 7 (deploy approvals, freeze windows, overrides) with a FAKE AWS and transport.
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
let instId;
const D = (c, act = 'deploy', body = {}) => c.post(`/api/instances/${instId}/apps/alpha/${act}`, body);
const setPolicy = async (b) => (await (await signedIn('admin')).put('/api/policy', b));
const finishAll = () => { for (const k of Object.keys(fake.commands)) if (fake.commands[k].inv.status === 'running') fake.finish(k, true); };
const settle = async () => { finishAll(); await (await signedIn('viewer')).get('/api/deployments'); };

test('setup', async () => {
    dist('notify').setTransport({ async email(to, subject, text) { sent.push({ subject, text }); }, async webhook() {} });
    await dist('settings').saveAlertSettings({ ...dist('settings').DEFAULT_ALERT_SETTINGS, recipients: ['ops@example.com'] }, 'test');
    const a = await signedIn('admin');
    instId = (await a.post('/api/instances', { awsInstanceId: 'i-0aaaaaaaaaaaaaaa1', region: 'af-south-1' })).json.instance.id;
});

test('freeze maths: weekly windows wrap the week and use the policy timezone', () => {
    const { activeFreeze, DEFAULT_POLICY } = dist('policy');
    const p = { ...DEFAULT_POLICY, timezone: 'Africa/Johannesburg', freezes: [
        { id: 'weekend1', name: 'Weekend', environments: ['production'], kind: 'weekly', startDay: 5, startTime: '15:00', endDay: 1, endTime: '06:00' },
        { id: 'launch01', name: 'Launch', environments: ['staging'], kind: 'once', startAt: '2026-12-01T00:00:00Z', endAt: '2026-12-03T00:00:00Z' }] };
    // 2026-11-20 is a Friday. 13:30 UTC = 15:30 SAST → frozen; 12:30 UTC = 14:30 SAST → not
    assert.equal(activeFreeze(p, 'production', new Date('2026-11-20T13:30:00Z')).name, 'Weekend');
    assert.equal(activeFreeze(p, 'production', new Date('2026-11-20T12:30:00Z')), null);
    assert.equal(activeFreeze(p, 'production', new Date('2026-11-22T10:00:00Z')).endsAt, '2026-11-23T04:00:00.000Z', 'Sunday: ends Monday 06:00 SAST');
    assert.equal(activeFreeze(p, 'production', new Date('2026-11-23T04:00:00Z')), null, 'end is exclusive');
    assert.equal(activeFreeze(p, 'staging', new Date('2026-11-21T10:00:00Z')), null, 'environment filter');
    assert.equal(activeFreeze(p, 'staging', new Date('2026-12-02T10:00:00Z')).name, 'Launch');
});

test('policy: everyone reads, only admins change; validation', async () => {
    assert.equal((await (await signedIn('demo')).get('/api/policy')).status, 200);
    assert.equal((await (await signedIn('deployer')).put('/api/policy', { approvals: { production: true } })).status, 403);
    for (const bad of [{ timezone: 'Mars/Olympus' }, { freezes: [{ name: 'x', environments: ['production'], kind: 'weekly', startDay: 9, startTime: '10:00', endDay: 1, endTime: '10:00' }] },
                       { freezes: [{ name: 'x', environments: [], kind: 'once', startAt: '2026-12-01', endAt: '2026-12-02' }] },
                       { freezes: [{ name: 'x', environments: ['staging'], kind: 'once', startAt: '2026-12-01', endAt: '2026-11-02' }] }]) {
        assert.equal((await setPolicy(bad)).status, 400, JSON.stringify(bad));
    }
    assert.equal((await setPolicy({ approvals: { production: false } })).status, 200);
});

test('freeze: deploys refused with code "frozen", rollbacks allowed, admin break-glass needs a reason', async () => {
    const now = new Date();
    await setPolicy({ freezes: [{ name: 'Incident freeze', environments: ['production'], kind: 'once', startAt: new Date(now - 60e3).toISOString(), endAt: new Date(+now + 3600e3).toISOString() }] });
    const d = await signedIn('deployer');
    const r = await D(d);
    assert.equal(r.status, 409);
    assert.equal(r.json.code, 'frozen');
    assert.match(r.json.error, /Incident freeze/);
    assert.equal((await D(d, 'deploy', { override: 'deployer wants it badly' })).status, 403, 'deployers cannot override');
    assert.equal((await D(d, 'rollback')).status, 202, 'rollback allowed during a freeze');
    await settle();
    const a = await signedIn('admin');
    assert.equal((await D(a, 'deploy', { override: 'short' })).status, 400);
    sent.length = 0;
    const o = await D(a, 'deploy', { override: 'hotfix for payment outage' });
    assert.equal(o.status, 202);
    assert.equal(o.json.deployment.status, 'running');
    assert.equal(o.json.deployment.overrideReason, 'hotfix for payment outage');
    assert.ok(sent.some((m) => m.subject.startsWith('[OVERRIDE]') && m.text.includes('Incident freeze')));
    await settle();
    await setPolicy({ freezes: [] });
});

test('approvals: request → pending (announced) → not self-approvable → approved by someone else → runs', async () => {
    await setPolicy({ approvals: { production: true } });
    const d = await signedIn('deployer');
    sent.length = 0;
    const before = fake.nextId;
    const r = await D(d, 'deploy', { ref: 'main' });
    assert.equal(r.status, 202);
    const dep = r.json.deployment;
    assert.equal(dep.status, 'pending_approval');
    assert.ok(dep.expiresAt);
    assert.equal(fake.nextId, before, 'nothing sent to SSM yet');
    assert.ok(sent.some((m) => m.subject.startsWith('[APPROVAL NEEDED]')));
    assert.equal((await D(d, 'deploy')).status, 409, 'one open request per app');
    assert.equal((await d.post(`/api/deployments/${dep.id}/approve`)).status, 403, 'not your own');
    assert.equal((await (await signedIn('viewer')).post(`/api/deployments/${dep.id}/approve`)).status, 403);
    assert.equal((await (await signedIn('demo')).post(`/api/deployments/${dep.id}/approve`)).status, 403);
    const pend = (await (await signedIn('viewer')).get('/api/deployments?status=pending')).json.deployments;
    assert.equal(pend.length, 1);
    const ok = await (await signedIn('admin')).post(`/api/deployments/${dep.id}/approve`);
    assert.equal(ok.status, 200);
    assert.equal(ok.json.deployment.status, 'running');
    assert.equal(ok.json.deployment.approvedBy, 'admin');
    assert.equal(fake.nextId, before + 1);
    assert.deepEqual(fake.commands[`cmd-${fake.nextId}`].parameters.actor, ['deployer@ops-console'], 'pipeline records the requester');
    await settle();
});

test('approvals: reject, cancel own, expiry, and a freeze that starts before approval', async () => {
    const d = await signedIn('deployer');
    const a = await signedIn('admin');
    let id = (await D(d)).json.deployment.id;
    const rej = await a.post(`/api/deployments/${id}/reject`, { reason: 'not during demo day' });
    assert.equal(rej.json.deployment.status, 'rejected');
    assert.equal(rej.json.deployment.decisionReason, 'not during demo day');

    id = (await D(d)).json.deployment.id;
    assert.equal((await d.post(`/api/deployments/${id}/reject`, {})).json.deployment.status, 'cancelled', 'requester cancels');

    id = (await D(d)).json.deployment.id;
    await dist('db').db().query("UPDATE deployments SET expires_at = now() - interval '1 minute' WHERE id = $1", [id]);
    const late = await a.post(`/api/deployments/${id}/approve`);
    assert.equal(late.status, 409);
    assert.match(late.json.error, /expired/);

    id = (await D(d)).json.deployment.id;
    const now = Date.now();
    await setPolicy({ freezes: [{ name: 'Late freeze', environments: ['production'], kind: 'once', startAt: new Date(now - 1000).toISOString(), endAt: new Date(now + 3600e3).toISOString() }] });
    const blocked = await a.post(`/api/deployments/${id}/approve`);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.json.code, 'frozen');
    await setPolicy({ freezes: [], approvals: { production: false } });
});

test('admin override skips approval; rollbacks skip approval by default; audit trail', async () => {
    await setPolicy({ approvals: { production: true } });
    const a = await signedIn('admin');
    const d = await signedIn('deployer');
    const rb = await D(d, 'rollback');
    assert.equal(rb.json.deployment.status, 'running', 'rollbacks need no approval by default');
    await settle();
    const ov = await D(a, 'deploy', { override: 'solo admin, no second approver' });
    assert.equal(ov.json.deployment.status, 'running');
    await settle();
    await setPolicy({ approvals: { production: false } });
    const actions = (await a.get('/api/audit')).json.entries.map((e) => e.action);
    for (const x of ['policy.update', 'app.deploy_requested', 'app.deploy_approved', 'app.deploy_rejected', 'app.deploy_cancelled', 'app.deploy_override', 'app.rollback']) {
        assert.ok(actions.includes(x), x);
    }
});

test('app view explains the policy', async () => {
    await setPolicy({ approvals: { production: true } });
    const v = (await (await signedIn('viewer')).get(`/api/instances/${instId}/apps/alpha`)).json;
    assert.deepEqual(v.policy.needsApproval, { deploy: true, rollback: false });
    assert.equal(v.policy.freeze, null);
    await setPolicy({ approvals: { production: false } });
});
