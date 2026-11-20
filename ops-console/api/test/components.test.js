// Integration tests for server components (OpsConsole-Components) against a real embedded PostgreSQL and a FAKE AWS.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');

const ORIGIN = 'https://ops.example.test';
const PORT = 59000 + Math.floor(Math.random() * 900);
process.env.DATABASE_URL = `postgresql://postgres:pw@127.0.0.1:${PORT}/opsconsole_test`;
process.env.ALLOWED_ORIGINS = ORIGIN;
process.env.COOKIE_SECURE = 'false';

const dist = (m) => require(path.join(__dirname, '..', 'dist', m));
let pg, app, ip = 0, instId;
const IID = 'i-0aaaaaaaaaaaaaaa1';

const inventory = (extra = {}) => ({
    ok: true, action: 'list', component: null, error: null,
    components: [
        { id: 'postgresql', name: 'PostgreSQL', category: 'database', installed: true, version: '15.14', active: true, memoryMb: 40, needMb: 150, service: 'postgresql', offered: ['15', '16', '17'], note: 'One version per server.' },
        { id: 'valkey', name: 'Valkey (Redis-compatible)', category: 'service', installed: !!extra.valkey, version: extra.valkey ? '8.0.6' : null, active: extra.valkey ? true : null, memoryMb: 0, needMb: 64, service: 'valkey', offered: ['8.0'], note: '' },
        { id: 'python', name: 'Python', category: 'runtime', installed: false, version: null, versions: [], active: null, memoryMb: 0, needMb: 0, service: null, offered: ['3.11', '3.12', '3.13'], note: '' },
    ],
    host: { memoryTotalMb: 904, memoryAvailableMb: 300, swapFreeMb: 900, consoleHost: false },
});

// ---- fake AWS
const fake = {
    hasDocument: true, lists: 0, sent: [], finished: false, valkey: false,
    async describeInstance(_region, id) { return id === IID ? { name: 'web-1', state: 'running', type: 't3.micro', az: 'af-south-1a', managedTag: true, online: true } : null; },
    async ssmOnline() { return true; },
    async documentsReady() { return true; },
    async documentExists(_region, name) { assert.equal(name, 'OpsConsole-Components'); return this.hasDocument; },
    async runDocument(_region, id, document, parameters) {
        assert.equal(document, 'OpsConsole-Components', 'only the fixed document is run');
        assert.equal(id, IID);
        assert.deepEqual(parameters, { action: ['list'], component: [''], version: [''] }, 'the inventory is read-only');
        this.lists += 1;
        return `[10:00:00] reading\n${JSON.stringify(inventory({ valkey: this.valkey }))}`;
    },
    async sendDocument(_region, id, document, parameters) {
        assert.equal(document, 'OpsConsole-Components');
        this.sent.push(parameters);
        return `cmd-${this.sent.length}`;
    },
    async getInvocation() {
        return this.finished ? { status: 'success', detail: 'Success', stdout: '✔ Valkey\n{"ok":true}', stderr: '' } : { status: 'running', detail: 'InProgress', stdout: '', stderr: '' };
    },
};

function client() {
    const myIp = `10.2.0.${++ip}`;
    let cookie = '';
    const call = async (method, url, body) => {
        const headers = { 'content-type': 'application/json', 'x-forwarded-for': myIp, origin: ORIGIN };
        if (cookie) headers.cookie = cookie;
        const res = await app.request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        const set = res.headers.get('set-cookie');
        if (set) cookie = set.split(';')[0];
        return { status: res.status, json: await res.json().catch(() => null) };
    };
    return { get: (u) => call('GET', u), post: (u, b) => call('POST', u, b ?? {}) };
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
    instId = (await dist('db').db().query("INSERT INTO instances (name, aws_instance_id, region, ec2_state) VALUES ('web-1', $1, 'af-south-1', 'running') RETURNING id", [IID])).rows[0].id;
});
after(async () => { await dist('db').closeDb(); await pg.stop(); });

test('components: anyone signed in sees the inventory (read-only, cached); only admins change it, one job at a time; the server is re-read after a job', async () => {
    const viewer = await signedIn('viewer');
    const r = await viewer.get(`/api/instances/${instId}/components`);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.available, true);
    assert.deepEqual(r.json.components.map((x) => [x.id, x.installed]), [['postgresql', true], ['valkey', false], ['python', false]]);
    assert.deepEqual(r.json.changeable, {}, 'viewers get no actions');
    assert.equal(fake.lists, 1);
    await viewer.get(`/api/instances/${instId}/components`);
    assert.equal(fake.lists, 1, 'cached');
    await viewer.get(`/api/instances/${instId}/components?fresh=1`);
    assert.equal(fake.lists, 2, 'read again when asked');

    // only admins change components (and never the demo)
    for (const role of ['viewer', 'deployer', 'demo']) {
        assert.equal((await (await signedIn(role)).post(`/api/instances/${instId}/components`, { action: 'install', component: 'valkey' })).status, 403, role);
    }
    const admin = await signedIn('admin');
    const st = (await admin.get(`/api/instances/${instId}/components`)).json;
    assert.deepEqual(st.changeable.postgresql, ['install', 'start', 'stop'], 'PostgreSQL is never removed from the console');

    // refused before anything runs: unknown, not offered, no Python version
    assert.equal((await admin.post(`/api/instances/${instId}/components`, { action: 'remove', component: 'postgresql' })).status, 400);
    assert.equal((await admin.post(`/api/instances/${instId}/components`, { action: 'install', component: 'mongodb' })).status, 400);
    assert.equal((await admin.post(`/api/instances/${instId}/components`, { action: 'install', component: 'python' })).status, 400);
    assert.equal(fake.sent.length, 0);

    // install Valkey: a background job with exactly these parameters, audited; a second change waits
    const job = await admin.post(`/api/instances/${instId}/components`, { action: 'install', component: 'valkey' });
    assert.equal(job.status, 202, JSON.stringify(job.json));
    assert.deepEqual(fake.sent[0], { action: ['install'], component: ['valkey'], version: [''] });
    assert.equal((await admin.post(`/api/instances/${instId}/components`, { action: 'install', component: 'python', version: '3.12' })).status, 409, 'one job at a time');
    const { rows: [a] } = await dist('db').db().query("SELECT target FROM audit_log WHERE action = 'component.install' ORDER BY id DESC LIMIT 1");
    assert.equal(a.target, 'valkey on web-1');
    let running = (await admin.get(`/api/instances/${instId}/components`)).json;
    assert.equal(running.job.status, 'running');
    const listsBefore = fake.lists;

    // the job finishes: the inventory is read again and shows Valkey
    fake.finished = true; fake.valkey = true;
    const done = (await admin.get(`/api/instances/${instId}/components`)).json;
    assert.equal(done.job.status, 'success');
    assert.equal(fake.lists, listsBefore + 1);
    assert.equal(done.components.find((x) => x.id === 'valkey').installed, true);
    // and the next change can start; Python needs its version
    assert.equal((await admin.post(`/api/instances/${instId}/components`, { action: 'install', component: 'python', version: '3.12' })).status, 202);
    assert.deepEqual(fake.sent[1], { action: ['install'], component: ['python'], version: ['3.12'] });
});

test('components: an account connected before the components document existed is told to update the connection; nothing runs', async () => {
    fake.hasDocument = false;
    const sent = fake.sent.length, lists = fake.lists;
    await dist('db').db().query("UPDATE deployments SET status = 'success', finished_at = now() WHERE status = 'running'");
    const admin = await signedIn('admin');
    const r = (await admin.get(`/api/instances/${instId}/components?fresh=1`)).json;
    assert.equal(r.available, false);
    assert.equal(fake.lists, lists, 'no command is sent');
    const ch = await admin.post(`/api/instances/${instId}/components`, { action: 'install', component: 'sqlite' });
    assert.equal(ch.status, 409);
    assert.equal(ch.json.code, 'connection_update_needed');
    assert.equal(fake.sent.length, sent);
    fake.hasDocument = true;
});
