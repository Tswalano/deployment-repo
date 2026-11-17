// Integration tests for Phase 6 (backups: inventory, run, restore test, download) with a FAKE AWS.
process.env.TRANSFER_BUCKET = 'ops-console-transfer-000000000000-af-south-1';
process.env.NODE_ENV = 'test';
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
    calls: [], verifyOk: true,
    async presignGet(region, bucket, key, seconds, filename) { return `https://${bucket}.s3.${region}.amazonaws.com/${key}?X-Amz-Expires=${seconds}&fn=${filename}`; },
    async runDocument(_region, _id, document, params) {
        if (document === 'OpsConsole-Backups') {
            this.calls.push(['list']);
            return encode({ location: '/var/backups/app-db', disk_free: 2e9, timer: { next: 'Mon 15:34 UTC', last: 'Sun 15:35 UTC', running: false },
                status: { at: '2026-11-15T15:35:37Z', ok: true, keep_days: 14, total_bytes: 9e5, items: [] },
                files: [{ db: 'alpha', file: 'alpha-20261115T153536Z.dump', bytes: 51497, mtime: 1763220936 }, { db: '_globals', file: 'globals-20261115T153536Z.sql', bytes: 1320, mtime: 1763220936 }] });
        }
        if (document === 'OpsConsole-BackupAction') {
            this.calls.push([params.action[0], params.db?.[0], params.file?.[0], params.key?.[0]]);
            if (params.action[0] === 'run') return JSON.stringify({ ok: true, seconds: 2, status: { at: 'now', ok: true } });
            if (params.action[0] === 'export') return JSON.stringify({ ok: true, bytes: 51497, sha256: 'ab'.repeat(32) });
            return JSON.stringify({ at: 'now', db: params.db[0], file: params.file[0], ok: this.verifyOk, tables: this.verifyOk ? 17 : 0, rows: 118, live_tables: 17, live_rows: 118, seconds: 1, error: this.verifyOk ? '' : 'pg_restore: error: could not read' });
        }
        assert.equal(document, 'OpsConsole-CollectStatus', 'only the fixed document is ever run');
        this.runs += 1;
        if (this.failNext) { this.failNext = false; throw new Error('SSM command TimedOut'); }
        const d = agentStatus(this.healthy);
        d.host.disk.used = this.disk;
        d.backups.ok = this.backupOk;
        d.backups.at = this.backupAt ?? new Date(Date.now() - 3600e3).toISOString();
        d.backups.items = [{ name: 'alpha', ok: true, file: 'alpha-20261115T153536Z.dump', bytes: 51497 }, { name: '_globals', ok: true, file: 'globals-x.sql', bytes: 10 }];
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



let instId;
const reload = async () => (await dist('db').db().query('SELECT * FROM instances WHERE id = $1', [instId])).rows[0];
const F = 'alpha-20261115T153536Z.dump';

test('setup', async () => {
    const a = await signedIn('admin');
    instId = (await a.post('/api/instances', { awsInstanceId: 'i-0aaaaaaaaaaaaaaa1', region: 'af-south-1' })).json.instance.id;
});

test('inventory: every role can list (metadata only), cached', async () => {
    const r = await (await signedIn('demo')).get('/api/backups');
    assert.equal(r.status, 200);
    const i = r.json.instances[0];
    assert.equal(i.files.length, 2);
    assert.equal(i.files[0].file, F);
    assert.equal(i.timer.next, 'Mon 15:34 UTC');
    assert.equal(r.json.downloads, true);
    const n = fake.calls.length;
    await (await signedIn('viewer')).get('/api/backups?refresh=1');
    assert.equal(fake.calls.length, n, 'viewers cannot force a refresh');
});

test('permissions: viewers/demo cannot run, verify or download; deployers cannot download', async () => {
    const n = fake.calls.length;
    for (const r of ['viewer', 'demo']) {
        const c = await signedIn(r);
        assert.equal((await c.post(`/api/backups/${instId}/run`)).status, 403, r);
        assert.equal((await c.post(`/api/backups/${instId}/verify`, { db: 'alpha', file: F })).status, 403, r);
        assert.equal((await c.post(`/api/backups/${instId}/download`, { db: 'alpha', file: F })).status, 403, r);
    }
    assert.equal((await (await signedIn('deployer')).post(`/api/backups/${instId}/download`, { db: 'alpha', file: F })).status, 403);
    assert.equal(fake.calls.length, n, 'nothing reached SSM');
});

test('input validation happens before SSM', async () => {
    const a = await signedIn('admin');
    const n = fake.calls.length;
    for (const [db, file] of [['alpha', '../../etc/shadow.dump'], ['alpha', 'beta-20261115T153536Z.dump'], ['_globals', 'globals-x.dump'], ['Alpha;id', F], ['alpha', 'alpha-1.sql']]) {
        assert.equal((await a.post(`/api/backups/${instId}/verify`, { db, file })).status, 400, `${db}/${file}`);
        assert.equal((await a.post(`/api/backups/${instId}/download`, { db, file })).status, 400, `${db}/${file}`);
    }
    assert.equal(fake.calls.length, n);
});

test('restore test: recorded; a failure raises a critical alert, a later success resolves it', async () => {
    const d = await signedIn('deployer');
    fake.verifyOk = false;
    const bad = await d.post(`/api/backups/${instId}/verify`, { db: 'alpha', file: F });
    assert.equal(bad.status, 200);
    assert.equal(bad.json.verification.ok, false);
    const open = async () => (await dist('db').db().query("SELECT * FROM alerts WHERE rule = 'backup_unrestorable' AND resolved_at IS NULL")).rows;
    assert.equal((await open()).length, 1);
    assert.equal((await open())[0].severity, 'critical');
    fake.verifyOk = true;
    const good = (await d.post(`/api/backups/${instId}/verify`, { db: 'alpha', file: F })).json.verification;
    assert.deepEqual([good.ok, good.tables, good.liveTables, good.trigger, good.requestedBy], [true, 17, 17, 'manual', 'deployer']);
    assert.equal((await open()).length, 0);
    assert.equal((await d.get('/api/backups')).json.instances[0].verifications.length, 2);
});

test('download: admin gets a short-lived link to a random key; audited', async () => {
    const a = await signedIn('admin');
    const r = await a.post(`/api/backups/${instId}/download`, { db: 'alpha', file: F });
    assert.equal(r.status, 200);
    assert.match(r.json.url, /X-Amz-Expires=300/);
    const key = fake.calls.at(-1)[3];
    assert.match(key, new RegExp(`^downloads/[0-9a-f]{32}/${F}$`));
    assert.equal(r.json.sha256.length, 64);
    const audit = (await a.get('/api/audit')).json.entries.find((e) => e.action === 'backup.download');
    assert.equal(audit.detail.bytes, 51497);
});

test('run now (deployer) is audited', async () => {
    const d = await signedIn('deployer');
    const r = await d.post(`/api/backups/${instId}/run`);
    assert.equal(r.status, 200);
    assert.deepEqual(fake.calls.at(-1), ['run', undefined, undefined, undefined]);
});

test('auto-verify: each nightly run is restore-tested once, skipping _globals', async () => {
    const { autoVerify } = dist('backups');
    const a = await signedIn('admin');
    fake.backupAt = '2026-11-16T15:35:00Z';
    await a.get(`/api/instances/${instId}?refresh=1`);
    const before = fake.calls.filter((c) => c[0] === 'verify').length;
    await autoVerify(await reload());
    await autoVerify(await reload());
    const verifies = fake.calls.filter((c) => c[0] === 'verify');
    assert.equal(verifies.length - before, 1, 'once per backup run, alpha only');
    fake.backupAt = '2026-11-17T15:35:00Z';
    await a.get(`/api/instances/${instId}?refresh=1`);
    await autoVerify(await reload());
    assert.equal(fake.calls.filter((c) => c[0] === 'verify').length - before, 2, 'next run tested again');
    const { rows } = await dist('db').db().query("SELECT trigger FROM backup_verifications ORDER BY id DESC LIMIT 1");
    assert.equal(rows[0].trigger, 'auto');
});
