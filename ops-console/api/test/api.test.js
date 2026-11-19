// Integration tests: the real API against a real (embedded) PostgreSQL.
// Run: npm test   (compiles to dist/ first)
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');

const ORIGIN = 'https://ops.example.test';
const PORT = 54000 + Math.floor(Math.random() * 1000);
process.env.DATABASE_URL = `postgresql://postgres:pw@127.0.0.1:${PORT}/opsconsole_test`;
process.env.ALLOWED_ORIGINS = ORIGIN;
process.env.COOKIE_SECURE = 'false';
process.env.MAX_FAILED_LOGINS = '3';
process.env.LOGIN_RATE_LIMIT = '20';

const dist = (m) => require(path.join(__dirname, '..', 'dist', m));
let pg, app, ip = 0;

// Each test client gets its own IP so the per-IP login limiter doesn't interfere.
function client() {
    const myIp = `10.0.0.${++ip}`;
    let cookie = '';
    const call = async (method, url, body, { origin = ORIGIN } = {}) => {
        const headers = { 'content-type': 'application/json', 'x-forwarded-for': myIp };
        if (origin) headers.origin = origin;
        if (cookie) headers.cookie = cookie;
        const res = await app.request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        const set = res.headers.get('set-cookie');
        if (set) cookie = /Max-Age=0/i.test(set) ? '' : set.split(';')[0];
        let json = null;
        try { json = await res.json(); } catch { /* empty */ }
        return { status: res.status, json, setCookie: set };
    };
    return { call, get: (u) => call('GET', u), post: (u, b, o) => call('POST', u, b ?? {}, o), patch: (u, b) => call('PATCH', u, b), del: (u) => call('DELETE', u) };
}

async function makeUser(username, role, password) {
    const { hashPassword } = dist('password');
    await dist('db').db().query('INSERT INTO users (username, role, password_hash) VALUES ($1, $2, $3)', [username, role, await hashPassword(password)]);
}

before(async () => {
    const EmbeddedPostgres = (await import('embedded-postgres')).default;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opsconsole-pg-'));
    pg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'pw', port: PORT, persistent: false, onLog: () => {} });
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('opsconsole_test');
    assert.deepEqual(await dist('migrate').migrate(), ['001_init.sql', '002_instances.sql', '003_deployments.sql', '004_db_samples.sql', '005_alerts_uptime.sql', '006_backups.sql', '007_deploy_policy.sql', '008_power.sql', '009_costs.sql', '010_github.sql', '011_new_apps.sql', '012_new_app_dns.sql', '013_access.sql', '014_laptop_access.sql', '015_workspaces.sql', '016_dismissed_failures.sql', '017_aws_connections.sql', '018_prepare_server.sql', '019_github_installations.sql', '020_billing.sql', '021_invoices.sql', '022_github_apps.sql', '023_app_addresses.sql', '024_platform_admin.sql', '025_business_portal.sql', '026_email_log.sql', '027_profile_attached.sql', '028_assistant.sql', '029_assistant_provider.sql', '030_mcp_tokens.sql', '031_oauth.sql', '032_assistant_actions.sql']);
    assert.deepEqual(await dist('migrate').migrate(), [], 'migrations are applied once');
    app = dist('app').createApp();
    await makeUser('admin', 'admin', 'Correct-Horse-1');
    await dist('db').db().query(`INSERT INTO users (username, display_name, role, is_demo) VALUES ('demo', 'Demo', 'viewer', true)`);
});

after(async () => {
    await dist('db').closeDb();
    await pg.stop();
});

test('health', async () => {
    assert.equal((await client().get('/api/health')).status, 200);
});

test('login: success sets an HttpOnly SameSite=Lax cookie; /me returns the user', async () => {
    const c = client();
    const r = await c.post('/api/auth/login', { username: 'ADMIN', password: 'Correct-Horse-1' });   // case-insensitive username
    assert.equal(r.status, 200);
    assert.match(r.setCookie, /HttpOnly/i);
    assert.match(r.setCookie, /SameSite=Lax/i);   // survives the return from Paystack / GitHub; changes are Origin-checked
    const me = await c.get('/api/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.json.user.role, 'admin');
});

test('login: wrong password and unknown user give the same generic error', async () => {
    const a = await client().post('/api/auth/login', { username: 'admin', password: 'nope-nope' });
    const b = await client().post('/api/auth/login', { username: 'ghost', password: 'nope-nope' });
    assert.equal(a.status, 401);
    assert.equal(b.status, 401);
    assert.equal(a.json.error, b.json.error);
});

test('CSRF: state-changing requests need an allowed Origin', async () => {
    assert.equal((await client().post('/api/auth/login', { username: 'admin', password: 'Correct-Horse-1' }, { origin: null })).status, 403);
    assert.equal((await client().post('/api/auth/login', { username: 'admin', password: 'Correct-Horse-1' }, { origin: 'https://evil.example' })).status, 403);
});

test('lockout: after MAX_FAILED_LOGINS failures even the right password is refused', async () => {
    await makeUser('locky', 'viewer', 'Right-Password-1');
    const c = client();
    for (let i = 0; i < 3; i++) assert.equal((await c.post('/api/auth/login', { username: 'locky', password: 'wrong-wrong' })).status, 401);
    assert.equal((await c.post('/api/auth/login', { username: 'locky', password: 'Right-Password-1' })).status, 423);
});

test('rate limit: too many login attempts from one IP → 429', async () => {
    const c = client();
    let last;
    for (let i = 0; i < 21; i++) last = await c.post('/api/auth/login', { username: 'ghost', password: 'whatever1' });
    assert.equal(last.status, 429);
});

test('demo: read-only viewer; cannot manage users or change password; cannot log in with a password', async () => {
    const c = client();
    assert.equal((await c.post('/api/auth/demo')).status, 200);
    const me = await c.get('/api/auth/me');
    assert.equal(me.json.user.role, 'viewer');
    assert.equal(me.json.user.isDemo, true);
    assert.equal((await c.get('/api/users')).status, 403);
    assert.equal((await c.get('/api/audit')).status, 403);
    assert.equal((await c.post('/api/auth/password', { currentPassword: '', newPassword: 'whatever123' })).status, 403);
    assert.equal((await client().post('/api/auth/login', { username: 'demo', password: '' })).status, 401);
});

test('users: admin creates, validates, and duplicates are rejected', async () => {
    const c = client();
    await c.post('/api/auth/login', { username: 'admin', password: 'Correct-Horse-1' });
    assert.equal((await c.post('/api/users', { username: 'bad name!', role: 'viewer', password: 'long-enough-1' })).status, 400);
    assert.equal((await c.post('/api/users', { username: 'weak', role: 'viewer', password: 'short' })).status, 400);
    assert.equal((await c.post('/api/users', { username: 'x-role', role: 'superuser', password: 'long-enough-1' })).status, 400);
    const ok = await c.post('/api/users', { username: 'dana', displayName: 'Dana', role: 'deployer', password: 'long-enough-1' });
    assert.equal(ok.status, 201);
    assert.equal(ok.json.user.role, 'deployer');
    assert.equal(ok.json.user.password_hash, undefined, 'hashes never leave the server');
    assert.equal((await c.post('/api/users', { username: 'DANA', role: 'viewer', password: 'long-enough-1' })).status, 409);
    const list = await c.get('/api/users');
    assert.ok(list.json.users.some((u) => u.username === 'dana'));
});

test('users: non-admins are refused', async () => {
    await makeUser('vic', 'viewer', 'viewer-pass-1');
    const v = client();
    await v.post('/api/auth/login', { username: 'vic', password: 'viewer-pass-1' });
    assert.equal((await v.get('/api/users')).status, 403);
    assert.equal((await v.post('/api/users', { username: 'sneaky', role: 'admin', password: 'long-enough-1' })).status, 403);
    assert.equal((await client().get('/api/users')).status, 401, 'anonymous');
});

test('role change and password reset sign the user out everywhere', async () => {
    const admin = client();
    await admin.post('/api/auth/login', { username: 'admin', password: 'Correct-Horse-1' });
    const created = await admin.post('/api/users', { username: 'temp', role: 'viewer', password: 'temp-pass-1' });
    const t = client();
    await t.post('/api/auth/login', { username: 'temp', password: 'temp-pass-1' });
    assert.equal((await t.get('/api/auth/me')).status, 200);
    assert.equal((await admin.patch(`/api/users/${created.json.user.id}`, { role: 'deployer' })).status, 200);
    assert.equal((await t.get('/api/auth/me')).status, 401, 'old session revoked after role change');
    await t.post('/api/auth/login', { username: 'temp', password: 'temp-pass-1' });
    assert.equal((await admin.post(`/api/users/${created.json.user.id}/password`, { password: 'new-temp-pass-1' })).status, 200);
    assert.equal((await t.get('/api/auth/me')).status, 401, 'old session revoked after reset');
    assert.equal((await client().post('/api/auth/login', { username: 'temp', password: 'new-temp-pass-1' })).status, 200);
});

test('guards: admin cannot demote/disable/delete self; demo stays a viewer', async () => {
    const admin = client();
    await admin.post('/api/auth/login', { username: 'admin', password: 'Correct-Horse-1' });
    const me = (await admin.get('/api/auth/me')).json.user;
    assert.equal((await admin.patch(`/api/users/${me.id}`, { role: 'viewer' })).status, 400);
    assert.equal((await admin.patch(`/api/users/${me.id}`, { disabled: true })).status, 400);
    assert.equal((await admin.del(`/api/users/${me.id}`)).status, 400);
    const demo = (await admin.get('/api/users')).json.users.find((u) => u.isDemo);
    assert.equal((await admin.patch(`/api/users/${demo.id}`, { role: 'admin' })).status, 400);
    assert.equal((await admin.del(`/api/users/${demo.id}`)).status, 400);
});

test('own password change: needs the current password; other sessions are signed out', async () => {
    await makeUser('pat', 'deployer', 'pat-pass-old1');
    const a = client(), b = client();
    await a.post('/api/auth/login', { username: 'pat', password: 'pat-pass-old1' });
    await b.post('/api/auth/login', { username: 'pat', password: 'pat-pass-old1' });
    assert.equal((await a.post('/api/auth/password', { currentPassword: 'wrong', newPassword: 'pat-pass-new1' })).status, 400);
    assert.equal((await a.post('/api/auth/password', { currentPassword: 'pat-pass-old1', newPassword: 'pat-pass-new1' })).status, 200);
    assert.equal((await a.get('/api/auth/me')).status, 200, 'current session kept');
    assert.equal((await b.get('/api/auth/me')).status, 401, 'other session revoked');
});

test('logout ends the session', async () => {
    const c = client();
    await c.post('/api/auth/login', { username: 'admin', password: 'Correct-Horse-1' });
    assert.equal((await c.post('/api/auth/logout')).status, 200);
    assert.equal((await c.get('/api/auth/me')).status, 401);
});

test('audit log records logins and user changes (admin only)', async () => {
    const c = client();
    await c.post('/api/auth/login', { username: 'admin', password: 'Correct-Horse-1' });
    const r = await c.get('/api/audit?limit=200');
    assert.equal(r.status, 200);
    const actions = new Set(r.json.entries.map((e) => e.action));
    for (const a of ['auth.login', 'auth.login_failed', 'auth.account_locked', 'auth.demo', 'user.create', 'user.update', 'user.password_reset']) {
        assert.ok(actions.has(a), `missing audit action ${a}`);
    }
});
