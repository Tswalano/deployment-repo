// Phase 12a: multi-tenant mode. Runs as a NON-superuser role that owns the tables (like production), so Postgres
// row-level security is really in force. Checks that workspaces can't see or write each other's data, sign-up,
// invitations, email verification, password reset, and that no AWS call is ever made for a customer workspace.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');

const ORIGIN = 'https://app.example.test';
const PORT = 57000 + Math.floor(Math.random() * 1000);
process.env.DATABASE_URL = `postgresql://app:app-pw@127.0.0.1:${PORT}/saas_test`;
process.env.ALLOWED_ORIGINS = ORIGIN;
process.env.COOKIE_SECURE = 'false';
process.env.OPS_MULTI_TENANT = '1';
process.env.PUBLIC_URL = ORIGIN;
process.env.CONSOLE_PRINCIPAL_ARN = 'arn:aws:iam::111111111111:role/console-host';
process.env.PAYSTACK_SECRET_KEY = 'sk_test_' + 'f'.repeat(40);
process.env.PLATFORM_ADMINS = 'dee@example.com';
process.env.SERVER_BUNDLE_URL = 'https://ops-console-public-111111111111-af-south-1.s3.af-south-1.amazonaws.com/bundles/' + 'a'.repeat(64) + '.tar.gz';
process.env.SERVER_BUNDLE_SHA256 = 'a'.repeat(64);
process.env.PLATFORM_APPS_DOMAIN = 'apps.example.test';
process.env.PLATFORM_APPS_ZONE_ID = 'ZPLAT';

const dist = (m) => require(path.join(__dirname, '..', 'dist', m));
let pg, app, ip = 0;
const mail = [];
const awsCalls = [];
const tracking = new Proxy({}, { get: (_t, prop) => (prop === 'then' ? undefined : async (...a) => { awsCalls.push(String(prop)); return null; }) });

function client() {
    const myIp = `10.9.0.${++ip}`;
    let cookie = '';
    const call = async (method, url, body) => {
        const headers = { 'content-type': 'application/json', 'x-forwarded-for': myIp, origin: ORIGIN };
        if (cookie) headers.cookie = cookie;
        const res = await app.request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        const set = res.headers.get('set-cookie');
        if (set) cookie = set.split(';')[0];
        return { status: res.status, json: await res.json().catch(() => null) };
    };
    return { cookieHeader: () => cookie, get: (u) => call('GET', u), post: (u, b) => call('POST', u, b ?? {}), patch: (u, b) => call('PATCH', u, b), del: (u) => call('DELETE', u), put: (u, b) => call('PUT', u, b) };
}
const tokenFrom = (text, route) => new RegExp(`${route}\\?token=([A-Za-z0-9_-]+)`).exec(text)?.[1];

before(async () => {
    const EmbeddedPostgres = (await import('embedded-postgres')).default;
    pg = new EmbeddedPostgres({ databaseDir: fs.mkdtempSync(path.join(os.tmpdir(), 'oc-pg-')), user: 'postgres', password: 'pw', port: PORT, persistent: false, onLog: () => {} });
    await pg.initialise(); await pg.start();
    const su = pg.getPgClient();
    await su.connect();
    await su.query("CREATE ROLE app LOGIN PASSWORD 'app-pw' NOSUPERUSER NOBYPASSRLS");
    await su.query('CREATE DATABASE saas_test OWNER app');
    await su.end();
    await dist('migrate').migrate();   // as the owner, like production
    dist('aws').setAwsProvider(tracking);
    dist('notify').setTransport({ async email(to, subject, text) { mail.push({ to: to[0], subject, text }); }, async webhook() {} });
    app = dist('app').createApp();
});
after(async () => { await dist('db').closeDb(); await pg.stop(); });

test('the console connects as a role that row-level security applies to', async () => {
    const { rows: [r] } = await dist('db').db().query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user");
    assert.deepEqual([r.rolsuper, r.rolbypassrls], [false, false]);
});

let alice, bob, A, B;
test('sign-up creates an account, a trial workspace (admin) and a verification email; duplicates and the demo are refused', async () => {
    alice = client();
    const r = await alice.post('/api/account/signup', { name: 'Alice Admin', email: 'Alice@Example.com', password: 'correct-horse-1', workspace: 'Acme Ltd' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    A = r.json.workspace.id;
    assert.equal(r.json.workspace.slug, 'acme-ltd');
    const me = (await alice.get('/api/auth/me')).json.user;
    assert.deepEqual([me.email, me.role, me.workspaceId, me.emailVerified], ['alice@example.com', 'admin', A, false]);
    const ws = (await alice.get('/api/workspaces')).json.workspaces;
    assert.equal(ws[0].plan, 'trial');
    assert.ok(Date.parse(ws[0].trialEndsAt) - Date.now() > 13 * 86400e3);
    const m = mail.find((x) => x.to === 'alice@example.com');
    assert.match(m.subject, /Confirm your email/);
    assert.equal((await client().post('/api/account/verify', { token: tokenFrom(m.text, 'verify') })).status, 200);
    assert.equal((await alice.get('/api/auth/me')).json.user.emailVerified, true);

    assert.equal((await client().post('/api/account/signup', { name: 'Again', email: 'alice@example.com', password: 'correct-horse-1', workspace: 'Other team' })).status, 409);
    assert.equal((await client().post('/api/auth/demo')).status, 404, 'no shared demo account with many customers');
    bob = client();
    B = (await bob.post('/api/account/signup', { name: 'Bob', email: 'bob@example.com', password: 'correct-horse-2', workspace: 'Bobcorp' })).json.workspace.id;
    assert.notEqual(A, B);
});

test('workspaces cannot see or write each other\'s rows, whatever the query says', async () => {
    const { db, withWorkspace } = dist('db');
    for (const [ws, name] of [[A, 'acme-web'], [B, 'bob-web']]) {
        await withWorkspace(ws, async () => {
            await db().query("INSERT INTO instances (name, aws_instance_id, region) VALUES ($1, 'i-0aaaaaaaaaaaaaaa1', 'af-south-1')", [name]);   // same EC2 id in both is fine
            await db().query("INSERT INTO alerts (key, rule, severity, title, detail) VALUES ('cost_budget', 'cost_budget', 'warning', $1, '')", [`${name} over budget`]);
            await db().query("INSERT INTO settings (key, value, updated_by) VALUES ('costs', $1, 'test')", [JSON.stringify({ monthlyBudget: ws })]);
        });
    }
    const insts = (await alice.get('/api/instances')).json.instances;
    assert.deepEqual(insts.map((i) => i.name), ['acme-web']);
    const bobId = (await bob.get('/api/instances')).json.instances[0].id;
    assert.equal((await alice.get(`/api/instances/${bobId}`)).status, 404, "another workspace's instance doesn't exist for you");
    const alerts = (await alice.get('/api/alerts')).json;
    assert.ok(JSON.stringify(alerts).includes('acme-web over budget'));
    assert.ok(!JSON.stringify(alerts).includes('bob-web'));

    // straight SQL: no workspace = nothing; a write into another workspace is rejected by the database
    assert.equal((await db().query('SELECT count(*)::int AS n FROM instances')).rows[0].n, 0, 'no context sees nothing');
    await assert.rejects(db().query("INSERT INTO instances (name, aws_instance_id, region) VALUES ('x', 'i-0bbbbbbbbbbbbbbb2', 'af-south-1')"), /null value|violates/);
    await assert.rejects(withWorkspace(A, () => db().query("INSERT INTO instances (workspace_id, name, aws_instance_id, region) VALUES ($1, 'sneaky', 'i-0ccccccccccccccc3', 'af-south-1')", [B])), /row-level security/);
    const upd = await withWorkspace(A, () => db().query("UPDATE instances SET name = 'hijacked' WHERE name = 'bob-web'"));
    assert.equal(upd.rowCount, 0, "can't update another workspace's rows");
    assert.equal((await withWorkspace(B, () => db().query("SELECT name FROM instances"))).rows[0].name, 'bob-web');
    const del = await withWorkspace(A, () => db().query('DELETE FROM settings'));
    assert.equal(del.rowCount, 1, "deletes only touch your own rows");
    assert.equal((await withWorkspace(B, () => db().query("SELECT value FROM settings WHERE key = 'costs'"))).rows.length, 1);
});

test('no AWS call is ever made for a customer workspace; the global user list is off', async () => {
    const before = awsCalls.length;
    const r = await alice.post('/api/instances', { awsInstanceId: 'i-0ddddddddddddddd4', region: 'af-south-1' });
    assert.notEqual(r.status, 200);
    assert.match(JSON.stringify(r.json), /Connect your AWS account/);
    assert.equal(awsCalls.length, before, "the host's own AWS role is never used");
    assert.equal((await alice.get('/api/users')).status, 404);
});

test('team: invite by email, accept with a new account, roles, last admin protected, removal cuts access', async () => {
    assert.equal((await alice.post('/api/team/invites', { email: 'carol@example.com', role: 'deployer' })).status, 200);
    assert.equal((await bob.post('/api/team/invites', { email: 'not-an-email', role: 'viewer' })).status, 400);
    const inv = mail.find((x) => x.to === 'carol@example.com');
    assert.match(inv.subject, /Alice Admin invited you to Acme Ltd/);
    const t = tokenFrom(inv.text, 'invite');
    const carol = client();
    assert.equal((await carol.get(`/api/account/invites/${t}`)).json.invite.workspace, 'Acme Ltd');
    const acc = await carol.post(`/api/account/invites/${t}/accept`, { name: 'Carol', password: 'correct-horse-3' });
    assert.equal(acc.status, 200, JSON.stringify(acc.json));
    assert.equal((await carol.post(`/api/account/invites/${t}/accept`, { name: 'Carol', password: 'correct-horse-3' })).status, 404, 'single use');
    const me = (await carol.get('/api/auth/me')).json.user;
    assert.deepEqual([me.role, me.workspaceId, me.emailVerified], ['deployer', A, true]);
    assert.deepEqual((await carol.get('/api/instances')).json.instances.map((i) => i.name), ['acme-web']);

    // Bob's team shows only Bob; Bob can't see or act on Acme's members
    assert.deepEqual((await bob.get('/api/team')).json.members.map((m) => m.email), ['bob@example.com']);
    const team = (await alice.get('/api/team')).json;
    assert.deepEqual(team.members.map((m) => m.email).sort(), ['alice@example.com', 'carol@example.com']);
    const carolId = team.members.find((m) => m.email === 'carol@example.com').id;
    const aliceId = team.members.find((m) => m.email === 'alice@example.com').id;
    assert.equal((await bob.patch(`/api/team/members/${carolId}`, { role: 'viewer' })).status, 404, "Bob is admin of Bobcorp only: in his workspace Carol doesn't exist");
    assert.equal((await carol.patch(`/api/team/members/${carolId}`, { role: 'admin' })).status, 403, "a deployer can't promote herself");
    assert.equal((await alice.patch(`/api/team/members/${aliceId}`, { role: 'viewer' })).status, 409, 'last admin');

    assert.equal((await alice.del(`/api/team/members/${carolId}`)).status, 200);
    const r = await carol.get('/api/instances');
    assert.equal(r.status, 403);
    assert.equal(r.json.code, 'no_workspace');
    assert.equal((await carol.get('/api/workspaces')).status, 200, 'she can still list (none) and create her own');
});

test('switching workspaces changes everything you see; you can only switch to your own', async () => {
    const w = await alice.post('/api/workspaces', { name: 'Acme Staging' });
    assert.equal(w.status, 200);
    assert.deepEqual((await alice.get('/api/instances')).json.instances, [], 'the new workspace is empty');
    assert.equal((await alice.post('/api/workspaces/switch', { id: B })).status, 403, "can't switch into Bob's");
    assert.equal((await alice.post('/api/workspaces/switch', { id: A })).status, 200);
    assert.deepEqual((await alice.get('/api/instances')).json.instances.map((i) => i.name), ['acme-web']);
});

test('password reset: same answer for unknown emails, one-time link, signs out everywhere', async () => {
    const n = mail.length;
    assert.equal((await client().post('/api/account/forgot', { email: 'nobody@example.com' })).status, 200);
    assert.equal(mail.length, n, 'nothing sent for an unknown address (and the answer is the same)');
    await client().post('/api/account/forgot', { email: 'BOB@example.com' });
    const t = tokenFrom(mail.at(-1).text, 'reset-password');
    assert.equal((await client().post('/api/account/reset', { token: t, password: 'short' })).status, 400);
    assert.equal((await client().post('/api/account/reset', { token: t, password: 'brand-new-pass-9' })).status, 200);
    assert.equal((await client().post('/api/account/reset', { token: t, password: 'brand-new-pass-9' })).status, 400, 'single use');
    assert.equal((await bob.get('/api/auth/me')).status, 401, 'old sessions are signed out');
    const b2 = client();
    assert.equal((await b2.post('/api/auth/login', { username: 'bob@example.com', password: 'brand-new-pass-9' })).status, 200, 'sign in with email');
});

test('background jobs run once per workspace, each isolated', async () => {
    const { db, forEachWorkspace } = dist('db');
    const seen = [];
    await forEachWorkspace(async (ws) => { seen.push([ws, (await db().query('SELECT name FROM instances')).rows.map((r) => r.name)]); });
    const byWs = Object.fromEntries(seen);
    assert.deepEqual(byWs[A], ['acme-web']);
    assert.deepEqual(byWs[B], ['bob-web']);
});

// ---------------------------------------------------------------- Phase 12b: connect a workspace's own AWS account
test('connect AWS: per-workspace external ID, verified by assuming the role; servers are added in the customer account only', async () => {
    const conn = dist('connections');
    // customer roles in their accounts: each trusts exactly one external ID
    const trusted = {};
    const assumed = [];
    conn.setAssumer(async (roleArn, externalId, region) => {
        assumed.push([roleArn, externalId, region]);
        if (trusted[roleArn] !== externalId) throw new Error("AWS refused: the role doesn't exist, doesn't trust this console, or the external ID doesn't match.");
        return { accessKeyId: 'AK', secretAccessKey: 'SK', sessionToken: 'ST', expiration: new Date(Date.now() + 3600e3), accountId: roleArn.split(':')[4] };
    });
    const calls = [];
    const servers = [
        { id: 'i-0aaaaaaaaaaaaaaa9', name: 'shop-1', state: 'running', type: 't4g.small', az: 'af-south-1a', publicIp: '203.0.113.9', platform: 'Linux/UNIX', managedTag: false, instanceProfile: null, ssmOnline: false, securityGroups: ['sg-0123'], launchedAt: null },
        { id: 'i-0bbbbbbbbbbbbbbb8', name: 'win', state: 'running', type: 't3.medium', az: 'af-south-1a', publicIp: null, platform: 'Windows', managedTag: false, instanceProfile: null, ssmOnline: false, securityGroups: [], launchedAt: null },
    ];
    conn.setWorkspaceProviderFactory((c, credentials) => new Proxy({}, { get: (_t, prop) => (prop === 'then' ? undefined : async (...args) => {
        const creds = await credentials();
        calls.push({ account: c.role_arn.split(':')[4], prop: String(prop), args, key: creds.accessKeyId });
        if (prop === 'documentsReady') return true;
        if (prop === 'listInstances') return servers;
        if (prop === 'describeInstance') return { name: 'shop-1', state: 'running', type: 't4g.small', az: 'af-south-1a', managedTag: true, publicIp: '203.0.113.9' };
        return null;
    }) }));
    const hostBefore = awsCalls.length;

    const a = client();
    assert.equal((await a.post('/api/auth/login', { username: 'alice@example.com', password: 'correct-horse-1' })).status, 200);
    const b = client();
    assert.equal((await b.post('/api/auth/login', { username: 'bob@example.com', password: 'brand-new-pass-9' })).status, 200);

    const ca = (await a.get('/api/aws-connection')).json;
    const cb = (await b.get('/api/aws-connection')).json;
    assert.equal(ca.connection.status, 'pending');
    assert.match(ca.connection.externalId, /^oc-[0-9a-f]{40}$/);
    assert.notEqual(ca.connection.externalId, cb.connection.externalId, 'every workspace has its own external ID');
    assert.equal(ca.principal, 'arn:aws:iam::111111111111:role/console-host');
    assert.equal((await app.request('/api/aws-connection/template', { headers: { origin: ORIGIN } })).status, 401);

    // template download carries this workspace's values
    const raw = await app.request('/api/aws-connection/template', { headers: { origin: ORIGIN, cookie: a.cookieHeader() } });
    const body = JSON.parse(await raw.text());
    assert.equal(body.Parameters.ExternalId.Default, ca.connection.externalId);
    assert.equal(body.Parameters.ConsolePrincipal.Default, 'arn:aws:iam::111111111111:role/console-host');
    assert.ok(body.Resources.AccessRole && Object.values(body.Resources).filter((r) => r.Type === 'AWS::SSM::Document').length >= 10);

    // Alice's account: the role trusts Alice's external ID only
    const aliceRole = 'arn:aws:iam::222222222222:role/OpsConsoleAccess-af-south-1';
    trusted[aliceRole] = ca.connection.externalId;
    assert.equal((await a.post('/api/aws-connection/verify', { roleArn: 'not-an-arn' })).status, 400);
    const v = await a.post('/api/aws-connection/verify', { roleArn: aliceRole });
    assert.equal(v.status, 200, JSON.stringify(v.json));
    assert.deepEqual([v.json.connection.status, v.json.connection.accountId], ['connected', '222222222222']);

    // Bob pastes Alice's role: assumed with BOB's external ID, which Alice's role doesn't trust
    const steal = await b.post('/api/aws-connection/verify', { roleArn: aliceRole });
    assert.equal(steal.status, 409);
    assert.deepEqual(assumed.at(-1).slice(0, 2), [aliceRole, cb.connection.externalId]);
    assert.equal((await b.get('/api/aws-connection/servers')).status, 409, 'Bob still has no AWS access');

    // servers in Alice's account: list, add (tag + instance profile), Windows refused
    const list = (await a.get('/api/aws-connection/servers')).json;
    assert.deepEqual(list.servers.map((x) => [x.id, x.linux, x.added]), [['i-0aaaaaaaaaaaaaaa9', true, false], ['i-0bbbbbbbbbbbbbbb8', false, false]]);
    assert.equal((await a.post('/api/aws-connection/servers', { awsInstanceId: 'i-0bbbbbbbbbbbbbbb8' })).status, 409);
    const add = await a.post('/api/aws-connection/servers', { awsInstanceId: 'i-0aaaaaaaaaaaaaaa9', environment: 'staging' });
    assert.equal(add.status, 200, JSON.stringify(add.json));
    assert.deepEqual(add.json.steps, ['tagged ops-console=managed', 'attached OpsConsoleInstance-af-south-1']);
    // it was running without a profile: it connects after a reboot, and the console says so
    assert.equal(add.json.rebootToConnect, true);
    assert.match(add.json.note, /reboot it once/);
    assert.equal((await a.get('/api/instances')).json.instances.find((i) => i.awsInstanceId === 'i-0aaaaaaaaaaaaaaa9').rebootToConnect, true);
    const tag = calls.find((x) => x.prop === 'tagManaged');
    assert.deepEqual([tag.account, tag.args], ['222222222222', ['af-south-1', 'i-0aaaaaaaaaaaaaaa9', ['sg-0123']]]);
    assert.ok(calls.every((x) => x.account === '222222222222' && x.key === 'AK'), "every call ran on Alice's assumed role");
    assert.ok((await a.get('/api/instances')).json.instances.some((i) => i.awsInstanceId === 'i-0aaaaaaaaaaaaaaa9'));
    assert.ok(!(await b.get('/api/instances')).json.instances.some((i) => i.awsInstanceId === 'i-0aaaaaaaaaaaaaaa9'));
    assert.equal(awsCalls.length, hostBefore, "the console host's own AWS identity was never used for a customer");

    // disconnect: access stops at once; the external ID changes so the old role can't be reconnected by accident
    assert.equal((await a.post('/api/aws-connection/disconnect')).status, 200);
    const after = (await a.get('/api/aws-connection')).json.connection;
    assert.equal(after.status, 'disconnected');
    assert.notEqual(after.externalId, ca.connection.externalId);
    assert.equal((await a.get('/api/aws-connection/servers')).status, 409);
});

test('usernames: generated from the email or chosen at sign-up; unique; sign in with either; change on the profile', async () => {
    const me = (await alice.get('/api/auth/me')).json.user;
    assert.equal(me.username, 'alice', 'generated from the email (Alice@Example.com → alice), never the email itself');
    assert.equal((await client().get('/api/account/username-available?u=alice')).json.available, false);
    assert.equal((await client().get('/api/account/username-suggestion?email=alice@other.test')).json.username, 'alice-2');

    const d = client();
    assert.equal((await d.post('/api/account/signup', { name: 'Dee', email: 'dee@example.com', password: 'correct-horse-4', workspace: 'Dee Co', username: 'alice' })).status, 409);
    assert.equal((await d.post('/api/account/signup', { name: 'Dee', email: 'dee@example.com', password: 'correct-horse-4', workspace: 'Dee Co', username: 'd@x' })).status, 400);
    const r = await d.post('/api/account/signup', { name: 'Dee', email: 'dee@example.com', password: 'correct-horse-4', workspace: 'Dee Co', username: 'Dee.Ops' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal((await d.get('/api/auth/me')).json.user.username, 'dee.ops');
    for (const login of ['dee.ops', 'DEE@example.com']) {
        assert.equal((await client().post('/api/auth/login', { username: login, password: 'correct-horse-4' })).status, 200, `sign in with ${login}`);
    }
    const p = (await d.get('/api/auth/profile')).json.profile;
    assert.deepEqual([p.username, p.email, p.displayName, p.workspaces[0].name], ['dee.ops', 'dee@example.com', 'Dee', 'Dee Co']);
    assert.equal((await d.patch('/api/auth/profile', { username: 'alice' })).status, 409);
    assert.equal((await d.patch('/api/auth/profile', { username: 'dee', displayName: 'Dee Dlamini' })).status, 200);
    const after = (await d.get('/api/auth/me')).json.user;
    assert.deepEqual([after.username, after.displayName], ['dee', 'Dee Dlamini']);
});

test('prepare a fresh server: only through the customer role; agent password in THEIR account; web ports; pinned bundle; one at a time', async () => {
    const conn = dist('connections');
    let trustedExt = null;
    conn.setAssumer(async (roleArn, externalId) => {
        if (externalId !== trustedExt) throw new Error('AWS refused');
        return { accessKeyId: 'AK2', secretAccessKey: 'S', sessionToken: 'T', expiration: new Date(Date.now() + 3600e3), accountId: roleArn.split(':')[4] };
    });
    const calls = [];
    const params = {};
    let online = false;
    conn.setWorkspaceProviderFactory((c) => new Proxy({}, { get: (_t, prop) => (prop === 'then' ? undefined : async (...args) => {
        calls.push({ account: c.role_arn.split(':')[4], prop: String(prop), args });
        switch (prop) {
            case 'documentsReady': return true;
            case 'listInstances': return [{ id: 'i-0ccccccccccccccc7', name: 'fresh-1', state: 'running', type: 't4g.small', az: 'af-south-1a', publicIp: '203.0.113.7', platform: 'Linux/UNIX', managedTag: false, instanceProfile: null, ssmOnline: true, securityGroups: ['sg-0aa'], launchedAt: null }];
            case 'describeInstance': return { name: 'fresh-1', state: 'running', type: 't4g.small', az: 'af-south-1a', managedTag: true, publicIp: '203.0.113.7' };
            case 'ssmOnline': return online;
            case 'getParameter': return params[args[1]] ?? null;
            case 'putParameter': params[args[1]] = args[2]; return undefined;
            case 'sshAccess': return [{ groupId: 'sg-0aa', name: 'web', managedTag: true, rules: [], prefixLists: [], openToWorld: false }, { groupId: 'sg-0bb', name: 'other', managedTag: false, rules: [], prefixLists: [], openToWorld: false }];
            case 'openWebPorts': return args[1].flatMap((g) => [`${g}:80`, `${g}:443`]);
            case 'sendDocument': return 'cmd-prep-1';
            case 'getInvocation': return { status: 'running', detail: 'InProgress', stdout: '', stderr: '' };
            default: return null;
        }
    }) }));
    const a = client();
    assert.equal((await a.post('/api/auth/login', { username: 'alice', password: 'correct-horse-1' })).status, 200);
    trustedExt = (await a.get('/api/aws-connection')).json.connection.externalId;
    assert.equal((await a.post('/api/aws-connection/verify', { roleArn: 'arn:aws:iam::333333333333:role/OpsConsoleAccess-af-south-1' })).status, 200);
    const add = await a.post('/api/aws-connection/servers', { awsInstanceId: 'i-0ccccccccccccccc7' });
    assert.equal(add.status, 200, JSON.stringify(add.json));
    const id = add.json.instance.id;

    assert.equal((await a.get(`/api/instances/${id}/prepare`)).json.deployment, null);
    // given its profile while running and not connected yet: the answer is "reboot once", not a generic error
    const early = await a.post(`/api/instances/${id}/prepare`, { openWeb: true });
    assert.deepEqual([early.status, early.json.code], [409, 'reboot_to_connect']);
    assert.match(early.json.error, /Reboot it once/);
    online = true;
    const r = await a.post(`/api/instances/${id}/prepare`, { openWeb: true });
    assert.equal(r.status, 202, JSON.stringify(r.json));
    assert.match(params['/apps/ops-dashboard/PGPASSWORD'], /^[A-Za-z0-9_-]{32}$/, 'the agent password is generated and kept in the customer account');
    assert.deepEqual(r.json.openedWeb, ['sg-0aa:80', 'sg-0aa:443'], 'web ports only on the tagged group');
    const send = calls.find((x) => x.prop === 'sendDocument');
    assert.deepEqual([send.args[2], send.args[3]], ['OpsConsole-PrepareServer', { bundleUrl: [process.env.SERVER_BUNDLE_URL], sha256: [process.env.SERVER_BUNDLE_SHA256] }]);
    assert.ok(calls.every((x) => x.account === '333333333333'), "everything ran in the customer's own account");
    assert.equal((await a.post(`/api/instances/${id}/prepare`, {})).status, 409, 'one run at a time');
    const g = (await a.get(`/api/instances/${id}/prepare`)).json;
    assert.deepEqual([g.deployment.action, g.deployment.status, g.configured], ['prepare', 'running', true]);

    const b = client();
    assert.equal((await b.post('/api/auth/login', { username: 'bob@example.com', password: 'brand-new-pass-9' })).status, 200);
    assert.equal((await b.post(`/api/instances/${id}/prepare`, {})).status, 404, "another workspace's server doesn't exist for you");
});

test('GitHub per workspace: each workspace creates its own private app, sees only its repositories, and webhooks reach only that workspace; apps domain in your Route 53', async () => {
    const crypto = require('crypto');
    const keys = { 42: crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey, 43: crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey };
    // app credentials live in the HOST account's SSM: an in-memory stand-in
    const store = new Map();
    dist('aws').setAwsProvider(new Proxy({}, { get: (_t, prop) => (prop === 'then' ? undefined : async (...args) => {
        if (prop === 'getConsoleSecret') return store.get(args[1]) ?? null;
        if (prop === 'putConsoleSecret') { store.set(args[1], args[2]); return; }
        if (prop === 'deleteConsoleSecret') { store.delete(args[1]); return; }
        return null;
    }) }));
    const realFetch = global.fetch;
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    const appOf = (init) => JSON.parse(Buffer.from(String(init.headers.authorization).split(' ')[1].split('.')[1], 'base64url').toString()).iss;
    global.fetch = async (url, init) => {
        const u = String(url);
        const conv = /\/app-manifests\/(code-0*(\d+))\/conversions/.exec(u);
        if (conv) {
            const id = Number(conv[2]);
            return json({ id, slug: `ops-console-${id}`, pem: keys[id].export({ type: 'pkcs1', format: 'pem' }), webhook_secret: `whsec-${id}`, html_url: `https://github.com/apps/ops-console-${id}`,
                owner: { login: id === 42 ? 'acme-org' : 'globex' }, client_id: `Iv1.${id}`, client_secret: 'x' }, 201);
        }
        if (u.endsWith('/app/installations')) return json(appOf(init) === '42' ? [{ id: 555, account: { login: 'acme-org' }, repository_selection: 'all' }] : [{ id: 777, account: { login: 'globex' }, repository_selection: 'all' }]);
        const m = /\/app\/installations\/(\d+)\/access_tokens/.exec(u);
        if (m) return json({ token: `inst-${m[1]}` });
        if (u.includes('/installation/repositories')) {
            const tok = init.headers.authorization ?? init.headers.Authorization;
            const repos = tok.includes('inst-555') ? [{ full_name: 'acme-org/shop', private: true, default_branch: 'main', pushed_at: null, description: null }]
                : [{ full_name: 'globex/secret', private: true, default_branch: 'main', pushed_at: null, description: null }];
            return json({ total_count: repos.length, repositories: repos });
        }
        return realFetch(url, init);
    };
    try {
        const a = client();
        assert.equal((await a.post('/api/auth/login', { username: 'alice', password: 'correct-horse-1' })).status, 200);
        const b = client();
        assert.equal((await b.post('/api/auth/login', { username: 'bob@example.com', password: 'brand-new-pass-9' })).status, 200);
        const wsA = (await a.get('/api/auth/me')).json.user.workspaceId, wsB = (await b.get('/api/auth/me')).json.user.workspaceId;
        assert.notEqual(wsA, wsB);
        assert.equal((await a.get('/api/github')).json.connected, false);

        // one click: a private app in the workspace's own GitHub account (no OAuth or platform set-up needed)
        const start = async (cl) => {
            const r = (await cl.post('/api/github/manifest', {})).json;
            assert.equal(r.manifest.public, false);
            assert.equal(r.manifest.setup_url, `${ORIGIN}/github/callback?installed=1`);
            assert.equal(r.manifest.request_oauth_on_install, undefined);
            return new URL(r.action).searchParams.get('state');
        };
        const stA = await start(a), stB = await start(b);
        assert.equal((await a.post('/api/github/exchange', { code: 'code-0042', state: 'wrong' })).status, 400);
        assert.equal((await b.post('/api/github/exchange', { code: 'code-0042', state: stA })).status, 400, "Alice's state is not Bob's");
        assert.equal((await a.post('/api/github/exchange', { code: 'code-0042', state: stA })).status, 200);
        assert.equal((await b.post('/api/github/exchange', { code: 'code-0043', state: stB })).status, 200);
        assert.ok(store.has(`/ops-console/github/ws/${wsA}/app`) && store.has(`/ops-console/github/ws/${wsB}/app`), 'credentials stored per workspace');
        assert.equal((await a.post('/api/github/manifest', {})).status, 409, 'already connected');

        const stat = (await a.get('/api/github')).json;
        assert.deepEqual([stat.connected, stat.app.slug, stat.installations.map((i) => i.account)], [true, 'ops-console-42', ['acme-org']]);
        assert.deepEqual((await a.get('/api/github/repos')).json.repos.map((r) => r.fullName), ['acme-org/shop']);
        assert.deepEqual((await b.get('/api/github/repos')).json.repos.map((r) => r.fullName), ['globex/secret'], "Bob sees only his own repositories");

        // webhook: routed by the app id GitHub sends, checked with THAT workspace's secret
        const send = async (appId, secret) => {
            const body = JSON.stringify({ ref: 'refs/heads/main', after: 'a'.repeat(40), repository: { full_name: 'acme-org/shop' } });
            const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
            return app.request('/api/github/webhook', { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-github-event': 'push',
                'x-github-delivery': `d-${appId}-${Math.random()}`, 'x-hub-signature-256': sig, 'x-github-hook-installation-target-id': String(appId) } });
        };
        const ok = await send(42, 'whsec-42');
        assert.equal(ok.status, 200);
        const { db, withWorkspace } = dist('db');
        assert.equal((await withWorkspace(wsA, () => db().query("SELECT count(*)::int AS n FROM github_deliveries WHERE repo = 'acme-org/shop'"))).rows[0].n, 1);
        assert.equal((await withWorkspace(wsB, () => db().query("SELECT count(*)::int AS n FROM github_deliveries WHERE repo = 'acme-org/shop'"))).rows[0].n, 0);
        assert.equal((await send(42, 'whsec-43')).status, 401, "another workspace's secret is refused");
        assert.equal((await send(99, 'whsec-42')).status, 401, 'unknown app');

        // disconnect: credentials and the routing entry go
        assert.equal((await b.del('/api/github')).status, 200);
        assert.equal(store.has(`/ops-console/github/ws/${wsB}/app`), false);
        assert.equal((await send(43, 'whsec-43')).status, 401);
        assert.equal((await b.get('/api/github')).json.connected, false);
        assert.equal((await a.get('/api/github')).json.connected, true);

        // apps domain: must be a hosted zone in the workspace's own account
        const conn = dist('connections');
        conn.setWorkspaceProviderFactory(() => new Proxy({}, { get: (_t, prop) => (prop === 'then' ? undefined : async (...args) => (prop === 'hostedZoneId' ? (args[0] === 'acme.com' ? 'ZACME' : null) : null)) }));
        const put = (cl, domain) => app.request('/api/aws-connection/apps-domain', { method: 'PUT', headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: cl.cookieHeader() }, body: JSON.stringify({ domain }) });
        assert.equal((await put(a, 'not a domain')).status, 400);
        assert.equal((await put(a, 'nope.com')).status, 409);
        const set = await put(a, 'Acme.com.');
        assert.equal(set.status, 200, await set.clone().text());
        assert.deepEqual((await a.get('/api/aws-connection/apps-domain')).json.appsDomain, { mode: 'route53', domain: 'acme.com', zoneId: 'ZACME' });
        assert.equal((await put(b, 'acme.com')).status, 409, 'Bob has no AWS account connected');
        assert.equal((await b.get('/api/aws-connection/apps-domain')).json.appsDomain, null);
    } finally {
        global.fetch = realFetch;
    }
});

test('billing (Paystack): trial, limits, checkout verified server-side, signed webhooks once, grace, read-only; email + GitHub linking for migration', async () => {
    const crypto = require('crypto');
    const billing = dist('billing');
    const { db } = dist('db');
    const secret = process.env.PAYSTACK_SECRET_KEY;
    const ps = { verify: {}, charge: null, charged: [] };
    billing.setPaystackFetch(async (url, init) => {
        const u = new URL(url); const body = init.body ? JSON.parse(init.body) : null;
        assert.equal(init.headers.authorization, `Bearer ${secret}`);
        const ok = (data) => new Response(JSON.stringify({ status: true, message: 'ok', data }), { status: 200 });
        if (u.pathname === '/transaction/initialize') { ps.lastInit = body; return ok({ authorization_url: 'https://checkout.paystack.com/abc123', reference: 'ref_123456' }); }
        if (u.pathname === '/transaction/charge_authorization') { ps.charged.push(body); return ok({ status: ps.charge ?? 'success', reference: body.reference, amount: body.amount, currency: 'ZAR', metadata: body.metadata, gateway_response: ps.charge === 'failed' ? 'Insufficient Funds' : 'Approved', authorization: { authorization_code: body.authorization_code, reusable: true, brand: 'visa', last4: '4081' } }); }
        const v = /^\/transaction\/verify\/(.+)$/.exec(u.pathname);
        if (v) return ok(ps.verify[v[1]]);
        if (u.pathname === '/subscription/disable') return ok({});
        return new Response(JSON.stringify({ status: false, message: 'not found' }), { status: 404 });
    });
    const a = client();
    assert.equal((await a.post('/api/auth/login', { username: 'alice', password: 'correct-horse-1' })).status, 200);
    const wsA = (await a.get('/api/auth/me')).json.user.workspaceId;

    // trial: full access with Pro limits
    let b = (await a.get('/api/billing')).json;
    assert.deepEqual([b.enabled, b.plan, b.active, b.limits.servers], [true, 'trial', true, 5]);

    // checkout: Paystack's hosted card page for the first month (no Paystack plan: the console renews), workspace in the metadata
    const co = await a.post('/api/billing/checkout', { plan: 'pro' });
    assert.equal(co.status, 200, JSON.stringify(co.json));
    assert.equal(co.json.url, 'https://checkout.paystack.com/abc123');
    assert.deepEqual([ps.lastInit.amount, ps.lastInit.currency, ps.lastInit.plan, ps.lastInit.channels, ps.lastInit.metadata.workspace_id, ps.lastInit.metadata.kind], [59900, 'ZAR', undefined, ['card'], wsA, 'subscribe']);

    // confirm: verified with Paystack; another workspace's payment / wrong amount refused; the card is kept for renewals
    const card = { authorization_code: 'AUTH_acme', reusable: true, brand: 'visa', last4: '4081' };
    ps.verify.ref_other = { status: 'success', reference: 'ref_other', amount: 59900, currency: 'ZAR', metadata: { workspace_id: 999, plan: 'pro', kind: 'subscribe' } };
    ps.verify.ref_cheap = { status: 'success', reference: 'ref_cheap', amount: 100, currency: 'ZAR', metadata: { workspace_id: wsA, plan: 'pro', kind: 'subscribe', credit: 0 } };
    ps.verify.ref_good = { status: 'success', reference: 'ref_good', amount: 59900, currency: 'ZAR', metadata: { workspace_id: wsA, plan: 'pro', kind: 'subscribe', credit: 0 }, customer: { customer_code: 'CUS_acme', email: 'alice@example.com' }, authorization: card };
    assert.equal((await a.post('/api/billing/confirm', { reference: 'ref_other' })).status, 403);
    assert.equal((await a.post('/api/billing/confirm', { reference: 'ref_cheap' })).status, 409);
    assert.equal((await a.post('/api/billing/confirm', { reference: 'ref_good' })).status, 200);
    assert.equal((await a.post('/api/billing/confirm', { reference: 'ref_good' })).status, 200, 'a second visit changes nothing');
    b = (await a.get('/api/billing')).json;
    assert.deepEqual([b.plan, b.status, b.active, b.card, b.hasSubscription], ['pro', 'active', true, 'Visa •••• 4081', true]);
    assert.ok(Date.parse(b.currentPeriodEnd) > Date.now() + 27 * 86400e3);

    // webhooks: signature checked, each event once (the same payment by webhook adds nothing)
    const hook = (e, sig) => { const body = JSON.stringify(e); return app.request('/api/billing/paystack', { method: 'POST', headers: { 'content-type': 'application/json', 'x-paystack-signature': sig ?? crypto.createHmac('sha512', secret).update(body).digest('hex') }, body }); };
    assert.equal((await hook({ event: 'charge.success', data: {} }, 'f'.repeat(128))).status, 401);
    const paid = { event: 'charge.success', data: { id: 501, ...ps.verify.ref_good } };
    assert.equal((await hook(paid)).status, 200);
    assert.equal((await (await hook(paid)).json()).duplicate, true, 'the same event is applied once');
    assert.equal((await dist('db').withWorkspace(wsA, () => db().query("SELECT count(*)::int AS n FROM invoices WHERE reference = 'ref_good'"))).rows[0].n, 1);

    // a renewal the card declines: grace period (still working), retried later
    await db().query(`UPDATE workspaces SET current_period_end = now() - interval '1 minute' WHERE id = $1`, [wsA]);
    ps.charge = 'failed';
    await billing.renewDue();
    assert.equal(ps.charged.at(-1).authorization_code, 'AUTH_acme');
    b = (await a.get('/api/billing')).json;
    assert.deepEqual([b.status, b.active], ['past_due', true], 'still working during the grace period');
    assert.equal(b.lastChargeError, 'Insufficient Funds');
    const tries = ps.charged.length;
    await billing.renewDue();
    assert.equal(ps.charged.length, tries, 'not retried before the next attempt is due');
    ps.charge = null;

    // limits on Starter: one server, two members, no approvals
    await db().query(`UPDATE workspaces SET plan = 'starter', billing_status = 'active', grace_until = NULL WHERE id = $1`, [wsA]);
    assert.equal((await a.post('/api/team/invites', { email: 'extra@example.com', role: 'viewer' })).status, 200, 'Alice + 1 invitation = the 2 Starter seats');
    const inv = await a.post('/api/team/invites', { email: 'extra2@example.com', role: 'viewer' });
    assert.equal(inv.status, 409); assert.equal(inv.json.code, 'plan_limit');
    assert.match(inv.json.error, /Starter plan includes 2 team members/);
    const pp = await app.request('/api/policy', { method: 'PUT', headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: a.cookieHeader() }, body: JSON.stringify({ approvals: { production: true } }) });
    assert.equal(pp.status, 409, 'deploy approvals are Pro');

    // read-only after the grace period / an ended trial: reads work, changes are refused, billing stays open
    await db().query(`UPDATE workspaces SET billing_status = 'past_due', grace_until = now() - interval '1 day' WHERE id = $1`, [wsA]);
    dist('routes/billing').forgetStanding(wsA);
    const blocked = await a.post('/api/team/invites', { email: 'x2@example.com', role: 'viewer' });
    assert.equal(blocked.status, 402); assert.equal(blocked.json.code, 'billing_required');
    assert.match(blocked.json.error, /servers and apps keep running/);
    assert.equal((await a.get('/api/instances')).status, 200, 'reads still work');
    assert.notEqual((await a.post('/api/billing/resume')).status, 402, 'billing stays open (nothing to resume here, but not blocked)');

    // migration items: email (needs the password), OAuth client for an existing app (platform admin), link existing installations
    await db().query(`UPDATE workspaces SET billing_status = 'active', grace_until = NULL, plan = 'pro' WHERE id = $1`, [wsA]);
    dist('routes/billing').forgetStanding(wsA);
    const d = client();
    assert.equal((await d.post('/api/auth/login', { username: 'dee', password: 'correct-horse-4' })).status, 200);
    assert.equal((await d.post('/api/auth/email', { email: 'dee2@example.com', currentPassword: 'correct-horse-4' })).status, 409, 'the sign-up email cannot be changed by the user');
    // an account without an email (from the single-team console) can add one, with its password
    await db().query("UPDATE users SET email = NULL WHERE username = 'dee'");
    assert.equal((await d.post('/api/auth/email', { email: 'dee2@example.com', currentPassword: 'wrong' })).status, 400);
    assert.equal((await d.post('/api/auth/email', { email: 'alice@example.com', currentPassword: 'correct-horse-4' })).status, 409, 'taken');
    assert.equal((await d.post('/api/auth/email', { email: 'dee2@example.com', currentPassword: 'correct-horse-4' })).status, 200);
    assert.equal((await d.get('/api/auth/me')).json.user.emailVerified, false, 'the new email must be confirmed');
});

test('invoices: one per payment (confirm + renewals via webhook, never twice), PDF per invoice, last 6 months as PDF/CSV, workspace-only', async () => {
    const crypto = require('crypto');
    const { db, asSystem } = dist('db');
    const secret = process.env.PAYSTACK_SECRET_KEY;
    const a = client();
    assert.equal((await a.post('/api/auth/login', { username: 'alice', password: 'correct-horse-1' })).status, 200);
    const wsA = (await a.get('/api/auth/me')).json.user.workspaceId;
    let list = (await a.get('/api/billing/invoices')).json.invoices;
    assert.equal(list.length, 1, 'the confirmed checkout produced an invoice');
    assert.match(list[0].number, /^INV-\d{4}-\d{5}$/);
    assert.deepEqual([list[0].amount, list[0].currency, list[0].plan, list[0].status], [599, 'ZAR', 'pro', 'paid']);

    // a renewal arrives by webhook (no workspace metadata: matched by the Paystack customer), twice
    const renewal = { event: 'charge.success', data: { id: 9001, status: 'success', reference: 'renew_001', amount: 59900, currency: 'ZAR', paid_at: new Date().toISOString(),
        customer: { customer_code: 'CUS_acme', email: 'alice@example.com' }, authorization: { brand: 'visa', last4: '4081' }, plan: { plan_code: 'PLN_59900', amount: 59900 } } };
    const hook = (e) => { const body = JSON.stringify(e); return app.request('/api/billing/paystack', { method: 'POST', headers: { 'content-type': 'application/json', 'x-paystack-signature': crypto.createHmac('sha512', secret).update(body).digest('hex') }, body }); };
    // (only a workspace that had an Ops Console Paystack subscription takes such renewals)
    await asSystem(() => db().query("UPDATE workspaces SET subscription_code = 'SUB_acme' WHERE id = $1", [wsA]));
    await hook(renewal); await hook(renewal);
    await hook({ ...renewal, data: { ...renewal.data, id: 9002 } });   // same payment reported as another event id: still one invoice
    await asSystem(() => db().query('UPDATE workspaces SET subscription_code = NULL WHERE id = $1', [wsA]));
    list = (await a.get('/api/billing/invoices')).json.invoices;
    assert.equal(list.length, 2);
    assert.equal(list[0].card, 'Visa •••• 4081');

    const pdf = await app.request(`/api/billing/invoices/${list[0].id}/pdf`, { headers: { origin: ORIGIN, cookie: a.cookieHeader() } });
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    const body = Buffer.from(await pdf.arrayBuffer()).toString('latin1');
    assert.ok(body.startsWith('%PDF-1.4') && body.trimEnd().endsWith('%%EOF'));
    assert.ok(body.includes(list[0].number) && body.includes('R599.00'));
    const xref = Number(/startxref\n(\d+)/.exec(body)[1]);
    assert.ok(body.slice(xref).startsWith('xref'), 'the cross-reference offset is right');

    const six = Buffer.from(await (await app.request('/api/billing/invoices/export?months=6', { headers: { origin: ORIGIN, cookie: a.cookieHeader() } })).arrayBuffer()).toString('latin1');
    assert.equal((six.match(/\/Type \/Page /g) ?? []).length, 2, 'one page per invoice');
    const csv = await (await app.request('/api/billing/invoices/export?months=6&format=csv', { headers: { origin: ORIGIN, cookie: a.cookieHeader() } })).text();
    assert.equal(csv.trim().split('\r\n').length, 3);
    const upd = await dist('db').withWorkspace(wsA, () => db().query("UPDATE invoices SET issued_at = now() - interval '8 months' WHERE reference = 'ref_good'"));
    assert.equal(upd.rowCount, 1);
    const recent = await (await app.request('/api/billing/invoices/export?months=6&format=csv', { headers: { origin: ORIGIN, cookie: a.cookieHeader() } })).text();
    assert.equal(recent.trim().split('\r\n').length, 2, 'only the last 6 months');

    const b = client();
    assert.equal((await b.post('/api/auth/login', { username: 'bob@example.com', password: 'brand-new-pass-9' })).status, 200);
    const other = await app.request(`/api/billing/invoices/${list[0].id}/pdf`, { headers: { origin: ORIGIN, cookie: b.cookieHeader() } });
    assert.equal(other.status, 404, "another workspace's invoice doesn't exist for you");
    assert.deepEqual((await b.get('/api/billing/invoices')).json.invoices, []);
});

test('cutover: workspace 1 connected through the role before the switch, existing GitHub installations linked, apps domain set', async () => {
    const conn = dist('connections');
    const cut = dist('cutover');
    const { db, withWorkspace } = dist('db');
    // workspace 1's original GitHub App, in the host account
    const { privateKey } = require('crypto').generateKeyPairSync('rsa', { modulusLength: 2048 });
    const legacy = JSON.stringify({ appId: '7', slug: 'ops-console', privateKey: privateKey.export({ type: 'pkcs1', format: 'pem' }), webhookSecret: 'w', htmlUrl: 'https://github.com/apps/ops-console', owner: 'platform-org' });
    dist('aws').setAwsProvider(new Proxy({}, { get: (_t, prop) => (prop === 'then' ? undefined : async (...args) => (prop === 'getConsoleSecret' && args[1] === '/ops-console/github/app' ? legacy : null)) }));
    dist('github').forgetGithubConfigs();
    conn.setAssumer(async (roleArn, externalId) => {
        const want = (await withWorkspace(1, () => db().query('SELECT external_id FROM aws_connections'))).rows[0]?.external_id;
        if (externalId !== want) throw new Error('AWS refused');
        return { accessKeyId: 'AK1', secretAccessKey: 'S', sessionToken: 'T', expiration: new Date(Date.now() + 3600e3), accountId: roleArn.split(':')[4] };
    });
    conn.setWorkspaceProviderFactory(() => new Proxy({}, { get: (_t, prop) => (prop === 'then' ? undefined : async () => (prop === 'documentsReady' ? true : null)) }));
    const realFetch = global.fetch;
    global.fetch = async (url, init) => (String(url).includes('/app/installations') && !String(url).includes('access_tokens')
        ? new Response(JSON.stringify([{ id: 4242, account: { login: 'platform-org' }, repository_selection: 'all' }]), { status: 200 }) : realFetch(url, init));
    process.env.APPS_HOSTED_ZONE_ID = 'ZPLATFORM';
    const log = console.log; const out = []; console.log = (...a) => out.push(a.join(' '));
    try {
        await cut.cutoverPrepare('af-south-1');
        assert.match(out.join('\n'), /InstallDocuments,ParameterValue=no/);
        await cut.cutoverConnect('arn:aws:iam::111111111111:role/OpsConsoleAccess-af-south-1');
    } finally { console.log = log; global.fetch = realFetch; delete process.env.APPS_HOSTED_ZONE_ID; }
    const c = (await withWorkspace(1, () => db().query("SELECT status, account_id FROM aws_connections"))).rows[0];
    assert.deepEqual([c.status, c.account_id], ['connected', '111111111111']);
    const gh = (await withWorkspace(1, () => db().query('SELECT installation_id, account_login FROM github_installations'))).rows;
    assert.deepEqual(gh.map((r) => [Number(r.installation_id), r.account_login]), [[4242, 'platform-org']]);
    const dom = (await withWorkspace(1, () => db().query("SELECT value FROM settings WHERE key = 'apps_domain'"))).rows[0].value;
    assert.deepEqual(dom, { domain: 'glenify.studio', zoneId: 'ZPLATFORM' });
    // nothing leaked into another workspace
    assert.equal((await withWorkspace(2, () => db().query('SELECT count(*)::int AS n FROM github_installations WHERE installation_id = 4242'))).rows[0].n, 0);

    // owner tool: set-email (taken emails refused)
    await assert.rejects(cut.setEmail('dee', 'alice@example.com'), /already uses/);
    await cut.setEmail('dee', 'dee3@example.com');
});

test('app addresses: provided by the platform (default), the workspace\'s own Route 53, or another DNS provider', async () => {
    const { withWorkspace } = dist('db');
    const na = dist('newapp');
    const a = client();
    assert.equal((await a.post('/api/auth/login', { username: 'alice', password: 'correct-horse-1' })).status, 200);
    const b = client();
    assert.equal((await b.post('/api/auth/login', { username: 'bob@example.com', password: 'brand-new-pass-9' })).status, 200);
    const wsA = (await a.get('/api/auth/me')).json.user.workspaceId;
    const put = (cl, body) => app.request('/api/aws-connection/apps-domain', { method: 'PUT', headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: cl.cookieHeader() }, body: JSON.stringify(body) });

    // nothing chosen: provided addresses under the workspace's slug
    const sb = (await b.get('/api/aws-connection/apps-domain')).json;
    assert.equal(sb.current.kind, 'platform');
    assert.match(sb.current.base, /^[a-z0-9-]+\.apps\.example\.test$/);
    // a Route 53 domain chosen earlier stays as it is
    assert.deepEqual((await a.get('/api/aws-connection/apps-domain')).json.current, { kind: 'workspace', base: 'acme.com' });

    assert.equal((await put(a, { mode: 'external', domain: 'shop.apps.example.test' })).status, 400, "the platform's domain can't be claimed");
    const ext = await put(a, { mode: 'external', domain: 'acme-shop.example' });
    assert.equal(ext.status, 200);
    assert.deepEqual((await ext.json()).current, { kind: 'external', base: 'acme-shop.example' });

    // pre-flight: provided names live in the platform's zone (host account); external ones are added by the workspace
    const asked = [];
    dist('aws').setAwsProvider(new Proxy({}, { get: (_t, prop) => (prop === 'then' ? undefined : async (...args) => {
        if (prop === 'dnsRecords') { asked.push(args); return []; }
        return null;
    }) }));
    dist('connections').setWorkspaceProviderFactory(() => new Proxy({}, { get: (_t, prop) => (prop === 'then' ? undefined : async () => (prop === 'describeInstance' ? { publicIp: '203.0.113.7' } : null)) }));
    const inst = { id: 999, name: 'web', region: 'af-south-1', aws_instance_id: 'i-0abc', last_status: null };
    const e = await withWorkspace(wsA, () => na.check(inst, 'shop', 'shop'));
    assert.equal(e.domain.status, 'external');
    assert.equal(e.domain.name, 'shop.acme-shop.example');
    assert.match(e.domain.reason, /add an A record for shop\.acme-shop\.example pointing at 203\.0\.113\.7/);
    assert.equal(asked.length, 0, 'no Route 53 lookups for another DNS provider');

    assert.equal((await put(a, { mode: 'platform' })).status, 200);
    const p = await withWorkspace(wsA, () => na.check(inst, 'shop', 'shop'));
    assert.deepEqual([p.domain.status, p.domain.name], ['free', 'shop.acme-ltd.apps.example.test']);
    assert.deepEqual(asked[0], ['ZPLAT', 'shop.acme-ltd.apps.example.test'], "looked up in the platform's zone, with the host account");
});


test("off-site backup copies and server snapshots: the workspace's own bucket, this server's copies only", async () => {
    const zlib = require('zlib');
    const { db, withWorkspace } = dist('db');
    const a = client();
    assert.equal((await a.post('/api/auth/login', { username: 'alice', password: 'correct-horse-1' })).status, 200);
    const b = client();
    assert.equal((await b.post('/api/auth/login', { username: 'bob@example.com', password: 'brand-new-pass-9' })).status, 200);
    const wsA = (await a.get('/api/auth/me')).json.user.workspaceId;
    const conn = (await withWorkspace(wsA, () => db().query('SELECT account_id, region, status FROM aws_connections'))).rows[0];
    assert.equal(conn.status, 'connected');
    const bucket = `ops-console-backups-${conn.account_id}-${conn.region}`;
    const iid = 'i-0f0f0f0f0f0f0f0f1';
    const { rows: [inst] } = await withWorkspace(wsA, () => db().query("INSERT INTO instances (name, aws_instance_id, region) VALUES ('backup-box', $1, 'af-south-1') RETURNING id", [iid]));

    const sent = [], policies = {};
    let offsite = null, bucketExists = true, snapshotRole = null;
    const listing = () => zlib.gzipSync(JSON.stringify({
        status: { at: '2026-11-18T15:30:00Z', ok: true, keep_days: 14, total_bytes: 10, items: [] }, verifications: [], timer: {}, disk_free: 1, location: '/var/backups/app-db',
        files: [{ db: 'shop', file: 'shop-20261118T153000Z.dump', bytes: 10, mtime: 1763479800, offsite: !!offsite?.configured }], offsite,
    })).toString('base64');
    dist('connections').setWorkspaceProviderFactory(() => new Proxy({}, { get: (_t, prop) => (prop === 'then' ? undefined : async (...args) => {
        if (prop === 'runDocument') {
            const [, , doc, params] = args;
            sent.push([doc, params]);
            if (doc === 'OpsConsole-Backups') return listing();
            const action = params.action[0];
            if (action === 'offsite') {
                offsite = params.bucket[0] ? { configured: true, ok: true, at: '2026-11-18T15:31:00Z', copied: 3, pending: 0, error: null, keep_local_days: 3 } : { configured: false, ok: false, copied: 0, pending: 1 };
                return JSON.stringify({ ok: true, offsite });
            }
            if (action === 'fetch') return JSON.stringify({ ok: true, db: 'shop', file: 'shop-20261101T153000Z.dump', bytes: 9 });
            if (action === 'verify') return JSON.stringify({ ok: true, tables: 3, rows: 10, live_tables: 3, live_rows: 12, seconds: 1 });
        }
        if (prop === 'listBackupCopies') {
            if (args[1] !== bucket || !bucketExists) return null;
            return [{ key: `${iid}/shop/shop-20261101T153000Z.dump`, bytes: 9, at: '2026-11-01T15:31:00Z', storageClass: 'STANDARD_IA' },
                { key: 'i-0aaaaaaaaaaaaaaa9/shop/shop-20261101T153000Z.dump', bytes: 9, at: '2026-11-01T15:31:00Z', storageClass: 'STANDARD' }];   // filtered by prefix in AWS; never shown here anyway
        }
        if (prop === 'presignGet') return `https://s3.example/${args[1]}/${args[2]}`;
        if (prop === 'snapshotPolicy') return policies[args[0]] ?? null;
        if (prop === 'setSnapshotPolicy') { policies[args[0]] = { id: 'policy-1', enabled: args[1], retain: args[3] }; snapshotRole = args[2]; return; }
        return null;
    }) }));
    const box = (r) => r.json.instances.find((x) => x.instanceId === inst.id);

    // not copying yet: the workspace's bucket is known, this server's copies are listed (and only this server's)
    let r = await a.get('/api/backups?refresh=1');
    assert.equal(r.status, 200);
    assert.equal(r.json.offsite.bucket, bucket);
    assert.equal(box(r).offsite, null);
    assert.deepEqual(box(r).copies.map((c) => c.key), [`${iid}/shop/shop-20261101T153000Z.dump`]);

    // the bucket must exist (created by the connect template) before copying starts
    bucketExists = false;
    assert.equal((await a.post(`/api/backups/${inst.id}/offsite`, { enabled: true })).status, 409);
    bucketExists = true;
    const on = await a.post(`/api/backups/${inst.id}/offsite`, { enabled: true });
    assert.equal(on.status, 200, JSON.stringify(on.json));
    assert.deepEqual(sent.at(-1)[1], { action: ['offsite'], bucket: [bucket], region: [conn.region] });
    assert.equal(box(await a.get('/api/backups?refresh=1')).offsite.configured, true);

    // downloads and restore tests: only this server's copies
    assert.equal((await a.post(`/api/backups/${inst.id}/copies/download`, { key: 'i-0aaaaaaaaaaaaaaa9/shop/shop-20261101T153000Z.dump' })).status, 400);
    const dl = await a.post(`/api/backups/${inst.id}/copies/download`, { key: `${iid}/shop/shop-20261101T153000Z.dump` });
    assert.equal(dl.json.url, `https://s3.example/${bucket}/${iid}/shop/shop-20261101T153000Z.dump`);
    const v = await a.post(`/api/backups/${inst.id}/copies/verify`, { key: `${iid}/shop/shop-20261101T153000Z.dump` });
    assert.equal(v.status, 200, JSON.stringify(v.json));
    assert.equal(v.json.verification.ok, true);
    assert.deepEqual(sent.slice(-2).map(([, p]) => p.action[0]), ['fetch', 'verify']);
    assert.equal((await b.post(`/api/backups/${inst.id}/offsite`, { enabled: false })).status, 404, "another workspace's server");

    // nightly snapshots: one policy per region with servers, using the role the template created
    assert.deepEqual((await a.get('/api/backups/snapshots')).json.enabled, false);
    const s = await app.request('/api/backups/snapshots', { method: 'PUT', headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: a.cookieHeader() }, body: JSON.stringify({ enabled: true }) });
    assert.equal(s.status, 200);
    assert.equal((await s.json()).enabled, true);
    assert.equal(snapshotRole, `arn:aws:iam::${conn.account_id}:role/OpsConsoleSnapshots-${conn.region}`);
    assert.equal(policies['af-south-1'].retain, 7);
});

test('platform owner portal: only platform admins; suspend/reactivate (read-only for the customer), extend trial, complimentary plan, change email, all audited', async () => {
    const { db, withWorkspace, asSystem } = dist('db');
    const { rows: [alice] } = await db().query("SELECT id FROM users WHERE username = 'alice'");
    await asSystem(() => db().query('UPDATE users SET platform_admin = true WHERE id = $1', [alice.id]));
    try {
        const a = client();
        assert.equal((await a.post('/api/auth/login', { username: 'alice', password: 'correct-horse-1' })).status, 200);
        const b = client();
        assert.equal((await b.post('/api/auth/login', { username: 'bob@example.com', password: 'brand-new-pass-9' })).status, 200);
        const wsB = (await b.get('/api/auth/me')).json.user.workspaceId;
        assert.equal((await b.get('/api/platform/overview')).status, 404, 'customers never see the portal');
        assert.equal((await b.get('/api/auth/me')).json.user.platformAdmin, false);
        assert.equal((await a.get('/api/auth/me')).json.user.platformAdmin, true, 'flagged as a platform admin');
        // being an admin of the platform's own workspace is not enough (an invitation never grants the portal)
        const { rows: [bobUser] } = await db().query("SELECT id FROM users WHERE email = 'bob@example.com'");
        await asSystem(() => db().query("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (1, $1, 'admin') ON CONFLICT DO NOTHING", [bobUser.id]));
        assert.equal((await b.get('/api/platform/overview')).status, 404);
        await asSystem(() => db().query('DELETE FROM workspace_members WHERE workspace_id = 1 AND user_id = $1', [bobUser.id]));

        const ov = (await a.get('/api/platform/overview')).json;
        assert.ok(ov.customers >= 2 && typeof ov.mrr === 'number');
        const list = (await a.get('/api/platform/workspaces')).json.workspaces;
        const bob = list.find((w) => w.id === wsB);
        assert.ok(bob && bob.owner.email && typeof bob.usage.servers.used === 'number');
        assert.equal(list.find((w) => w.id === 1), undefined, "the platform's own workspace isn't a customer");
        assert.ok(bob.usage && typeof bob.usage.members.used === 'number');
        const det = (await a.get(`/api/platform/workspaces/${wsB}`)).json;
        assert.ok(det.members.some((m) => m.email === 'bob@example.com'));
        const health = (await a.get('/api/platform/console')).json;
        assert.ok(Array.isArray(health.concerns) && health.host.cpus > 0 && health.database.size > 0);

        // suspend: the customer's workspace becomes read-only (servers keep running), then reactivate
        const putDomain = (cl) => app.request('/api/aws-connection/apps-domain', { method: 'PUT', headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: cl.cookieHeader() }, body: JSON.stringify({ mode: 'external', domain: 'bob-apps.example' }) });
        assert.equal((await a.post(`/api/platform/workspaces/${wsB}/suspend`, { reason: 'no' })).status, 400, 'a reason is required');
        assert.equal((await a.post(`/api/platform/workspaces/${wsB}/suspend`, { reason: 'Terms review' })).status, 200);
        const blocked = await putDomain(b);
        assert.equal(blocked.status, 402);
        assert.match((await blocked.json()).error, /suspended \(Terms review\)/);
        assert.equal((await b.get('/api/billing')).json.suspended, true);
        assert.equal((await a.post(`/api/platform/workspaces/${wsB}/reactivate`)).status, 200);
        assert.equal((await putDomain(b)).status, 200);
        assert.ok((await withWorkspace(wsB, () => db().query("SELECT 1 FROM audit_log WHERE action = 'platform.suspend' AND username = 'platform:alice'"))).rows.length, "in the customer's audit log");

        // trial and complimentary plans (on a fresh trial workspace); the platform's own workspace is off limits
        const { rows: [ini] } = await asSystem(() => db().query("INSERT INTO workspaces (name, slug, plan, trial_ends_at) VALUES ('Initech', 'initech', 'trial', now() + interval '1 day') RETURNING id"));
        const ext = await a.post(`/api/platform/workspaces/${ini.id}/extend`, { days: 10 });
        assert.equal(ext.status, 200);
        assert.ok(Date.parse(ext.json.result) > Date.now() + 10.5 * 86400e3);
        assert.equal((await a.post(`/api/platform/workspaces/${ini.id}/extend`, { days: 500 })).status, 400);
        const until = new Date(Date.now() + 30 * 86400e3).toISOString();
        assert.equal((await a.post(`/api/platform/workspaces/${ini.id}/complimentary`, { plan: 'pro', until })).status, 200);
        let w = (await a.get(`/api/platform/workspaces/${ini.id}`)).json.workspace;
        assert.deepEqual([w.plan, w.status, w.active], ['pro', 'complimentary', true]);
        assert.equal((await a.post(`/api/platform/workspaces/${ini.id}/extend`, { days: 5 })).status, 409, 'a complimentary plan has its own end date');
        assert.equal((await a.post(`/api/platform/workspaces/${ini.id}/complimentary`, { plan: null })).status, 200);
        w = (await a.get(`/api/platform/workspaces/${ini.id}`)).json.workspace;
        assert.deepEqual([w.status, w.active], ['ended', false]);
        assert.equal((await a.post('/api/platform/workspaces/1/suspend', { reason: 'Testing it' })).status, 409);

        // change a customer's sign-in email: unique, to be confirmed by them
        const { rows: [dee] } = await db().query("SELECT id FROM users WHERE username = 'dee'");
        const put = (body) => app.request(`/api/platform/users/${dee.id}/email`, { method: 'PUT', headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: a.cookieHeader() }, body: JSON.stringify(body) });
        assert.equal((await put({ email: 'alice@example.com' })).status, 409);
        assert.equal((await put({ email: 'dee.new@example.com' })).status, 200);
        const { rows: [d2] } = await db().query("SELECT email, email_verified_at FROM users WHERE id = $1", [dee.id]);
        assert.deepEqual([d2.email, d2.email_verified_at], ['dee.new@example.com', null]);

        const trail = (await a.get('/api/platform/audit')).json.entries.map((e) => e.action);
        for (const x of ['platform.suspend', 'platform.reactivate', 'platform.extend', 'platform.complimentary', 'platform.complimentary_end', 'platform.email']) assert.ok(trail.includes(x), x);
    } finally {
        await asSystem(() => db().query('UPDATE users SET platform_admin = false WHERE id = $1', [alice.id]));
    }
});

test('billing run by the console: credit first, card change (kept as credit), plan switch with unused time, extensions, custom limits, retry, cancel/resume', async () => {
    const billing = dist('billing');
    const { db, asSystem } = dist('db');
    const ps = { verify: {}, charge: 'success', charged: [], inits: [] };
    billing.setPaystackFetch(async (url, init) => {
        const u = new URL(url); const body = init.body ? JSON.parse(init.body) : null;
        const ok = (data) => new Response(JSON.stringify({ status: true, message: 'ok', data }), { status: 200 });
        if (u.pathname === '/transaction/initialize') { ps.inits.push(body); return ok({ authorization_url: `https://checkout.paystack.com/${ps.inits.length}`, reference: `init_${ps.inits.length}` }); }
        if (u.pathname === '/transaction/charge_authorization') { ps.charged.push(body); return ok({ status: ps.charge, reference: body.reference, amount: body.amount, currency: 'ZAR', metadata: body.metadata, gateway_response: ps.charge === 'failed' ? 'Do Not Honour' : 'Approved' }); }
        const v = /^\/transaction\/verify\/(.+)$/.exec(u.pathname);
        if (v) return ok(ps.verify[v[1]] ?? { status: 'failed', reference: v[1] });
        return new Response(JSON.stringify({ status: false, message: 'not found' }), { status: 404 });
    });
    const { rows: [alice] } = await db().query("SELECT id FROM users WHERE username = 'alice'");
    await asSystem(() => db().query('UPDATE users SET platform_admin = true WHERE id = $1', [alice.id]));
    try {
        const admin = client();
        assert.equal((await admin.post('/api/auth/login', { username: 'alice', password: 'correct-horse-1' })).status, 200);
        const b = client();
        assert.equal((await b.post('/api/auth/login', { username: 'bob@example.com', password: 'brand-new-pass-9' })).status, 200);
        const ws = (await b.get('/api/auth/me')).json.user.workspaceId;
        await asSystem(() => db().query(`UPDATE workspaces SET plan = 'trial', trial_ends_at = now() + interval '5 days', billing_status = 'trialing', complimentary = false,
            paystack_authorization = NULL, card_label = NULL, current_period_end = NULL, subscription_code = NULL WHERE id = $1`, [ws]));
        const bill = async () => (await b.get('/api/billing')).json;
        const ended = () => asSystem(() => db().query(`UPDATE workspaces SET current_period_end = now() - interval '1 minute', next_retry_at = NULL WHERE id = $1`, [ws]));

        // the platform gives credit (with a note); it pays for whole months before any card is needed
        assert.equal((await admin.post(`/api/platform/workspaces/${ws}/credit`, { amount: 450, note: '' })).status, 400, 'a note is required');
        assert.equal((await admin.post(`/api/platform/workspaces/${ws}/credit`, { amount: 450, note: 'Launch partner' })).status, 200);
        assert.equal((await bill()).credit, 450);
        const co = await b.post('/api/billing/checkout', { plan: 'starter' });
        assert.equal(co.status, 200, JSON.stringify(co.json));
        assert.match(co.json.url, /\/billing\/return\?reference=oc-/, 'nothing to pay on Paystack');
        assert.equal(ps.inits.length, 0);
        assert.equal((await b.post('/api/billing/confirm', { reference: co.json.reference })).status, 200);
        let s = await bill();
        assert.deepEqual([s.plan, s.status, s.credit], ['starter', 'active', 251]);
        await ended(); await billing.renewDue();
        assert.equal((await bill()).credit, 52, 'renewed from credit');
        assert.equal(ps.charged.length, 0);

        // not enough credit and no card: payment failed (grace); a card change (R5 kept as credit) retries at once with the rest
        await ended(); await billing.renewDue();
        s = await bill();
        assert.deepEqual([s.status, s.lastChargeError, s.active], ['past_due', 'No card on file.', true]);
        const cardUrl = (await b.get('/api/billing/manage')).json.url;
        assert.ok(cardUrl.startsWith('https://checkout.paystack.com/'));
        assert.deepEqual([ps.inits.at(-1).amount, ps.inits.at(-1).metadata.kind], [500, 'card']);
        ps.verify.card_1 = { status: 'success', reference: 'card_1', amount: 500, currency: 'ZAR', metadata: { workspace_id: ws, kind: 'card' },
            customer: { email: 'bob@example.com' }, authorization: { authorization_code: 'AUTH_bob', reusable: true, brand: 'mastercard', last4: '5555' } };
        assert.equal((await b.post('/api/billing/confirm', { reference: 'card_1' })).status, 200);
        assert.deepEqual([ps.charged.at(-1).authorization_code, ps.charged.at(-1).amount], ['AUTH_bob', 19900 - 5700], 'R52 + R5 of credit, the rest on the card');
        s = await bill();
        assert.deepEqual([s.status, s.credit, s.card], ['active', 0, 'Mastercard •••• 5555']);

        // switching to Pro: unused Starter time becomes credit, Pro starts today, charged without leaving the console
        const sw = await b.post('/api/billing/checkout', { plan: 'pro' });
        assert.equal(sw.status, 200, JSON.stringify(sw.json));
        const charged = ps.charged.at(-1).amount;
        assert.ok(charged >= 59900 - 19900 && charged <= 59900 - 19800, `about R400 charged (got ${charged})`);
        s = await bill();
        assert.deepEqual([s.plan, s.credit], ['pro', 0]);

        // extension: the next renewal moves out (free time)
        const before = Date.parse(s.currentPeriodEnd);
        const ex = await admin.post(`/api/platform/workspaces/${ws}/extend`, { days: 30 });
        assert.equal(ex.status, 200);
        assert.ok(Math.abs(Date.parse((await bill()).currentPeriodEnd) - before - 30 * 86400e3) < 5000);

        // custom limits above the plan (only raise), then back to the plan's
        const lim = (body) => app.request(`/api/platform/workspaces/${ws}/limits`, { method: 'PUT', headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: admin.cookieHeader() }, body: JSON.stringify(body) });
        assert.equal((await lim({ servers: 'many' })).status, 400);
        assert.equal((await lim({ servers: 8 })).status, 200);
        assert.equal((await bill()).limits.servers, 8);
        assert.equal((await lim({ servers: 2 })).status, 200);
        assert.equal((await bill()).limits.servers, 5, 'overrides never lower the plan');
        assert.equal((await lim({ clear: true })).status, 200);
        assert.equal((await bill()).customLimits, false);

        // a declined renewal, retried by the platform once the customer fixed it
        await ended(); ps.charge = 'failed'; await billing.renewDue();
        assert.equal((await bill()).status, 'past_due');
        ps.charge = 'success';
        const r = await admin.post(`/api/platform/workspaces/${ws}/retry`);
        assert.deepEqual([r.status, r.json.result], [200, 'renewed']);
        assert.equal((await bill()).status, 'active');
        const owner = (await admin.get(`/api/platform/workspaces/${ws}`)).json;
        assert.ok(owner.credits.some((c) => c.kind === 'grant' && c.note === 'Launch partner'));
        assert.ok(owner.invoices.some((i) => i.credit > 0 && i.amount === 0), 'an invoice paid fully by credit');

        // cancel at period end, then undo it
        assert.equal((await b.post('/api/billing/cancel')).status, 200);
        assert.equal((await bill()).status, 'cancelling');
        assert.equal((await b.post('/api/billing/resume')).status, 200);
        assert.equal((await bill()).status, 'active');
    } finally {
        await asSystem(() => db().query('UPDATE users SET platform_admin = false WHERE id = $1', [alice.id]));
    }
});

test("emails are logged: a refused invitation email is reported to the admin and logged; resending doesn't take another seat", async () => {
    const notify = dist('notify');
    const { db, asSystem } = dist('db');
    const a = client();
    assert.equal((await a.post('/api/auth/login', { username: 'alice', password: 'correct-horse-1' })).status, 200);
    const inviteTo = 'newhire@example.com';
    notify.setTransport({ async email() { throw new Error('not authorized to perform ses:SendEmail'); }, async webhook() {} });
    try {
        const r = await a.post('/api/team/invites', { email: inviteTo, role: 'viewer' });
        assert.equal(r.status, 200, JSON.stringify(r.json));
        assert.deepEqual([r.json.emailSent, r.json.emailError], [false, 'not authorized to perform ses:SendEmail']);
    } finally {
        notify.setTransport({ async email() {}, async webhook() {} });
    }
    const resent = await a.post('/api/team/invites', { email: inviteTo, role: 'viewer' });
    assert.equal(resent.status, 200, 'resending a pending invitation is not blocked by the seat limit');
    assert.equal(resent.json.emailSent, true);
    const { rows } = await asSystem(() => db().query("SELECT ok, error FROM email_log WHERE kind = 'invite' AND recipients = $1 ORDER BY id", [inviteTo]));
    assert.deepEqual(rows.map((x) => x.ok), [false, true]);
    assert.match(rows[0].error, /ses:SendEmail/);
    await asSystem(() => db().query('DELETE FROM workspace_invites WHERE lower(email) = $1', [inviteTo]));
});

test("read-only demo in multi-company mode: one click, the demo account's workspace, nothing can be changed or seen that's private", async () => {
    const { db, asSystem } = dist('db');
    await asSystem(() => db().query(
        `INSERT INTO users (username, display_name, role, is_demo) SELECT 'demo', 'Demo', 'viewer', true WHERE NOT EXISTS (SELECT 1 FROM users WHERE lower(username) = 'demo')`));
    const { rows: [demo] } = await asSystem(() => db().query("UPDATE users SET is_demo = true, disabled = false WHERE lower(username) = 'demo' RETURNING id"));
    await asSystem(() => db().query("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (1, $1, 'viewer') ON CONFLICT DO NOTHING", [demo.id]));
    assert.equal((await client().get('/api/account/config')).json.demo, true);
    const d = client();
    assert.equal((await d.post('/api/auth/demo')).status, 200);
    const me = (await d.get('/api/auth/me')).json.user;
    assert.deepEqual([me.isDemo, me.role, me.workspaceId, me.platformAdmin], [true, 'viewer', 1, false]);
    assert.equal((await d.get('/api/instances')).status, 200, 'everything is visible');
    assert.equal((await d.get('/api/team')).status, 403, "team members (emails) aren't");
    assert.equal((await d.post('/api/team/invites', { email: 'x@example.com', role: 'viewer' })).status, 403, 'nothing can be changed');
    assert.equal((await d.get('/api/platform/overview')).status, 404);
    assert.equal((await d.post('/api/auth/login', { username: 'demo', password: 'anything-at-all' })).status, 401, 'no password sign-in for the demo account');
});

test('assistant: the workspace\'s own key (Claude or ChatGPT); streamed answers from read-only tools in the asker\'s workspace; history kept unchanged; private; not in the demo', async () => {
    const prov = dist('assistant/providers');
    const { db, withWorkspace } = dist('db');
    const stored = new Map();
    prov.setKeyStore({ get: async (r, n) => stored.get(n) ?? null, put: async (r, n, v) => { stored.set(n, v); }, del: async (r, n) => { stored.delete(n); } });
    // Claude: a stand-in SDK client
    const calls = [];
    let script = [];
    const anthropicKeys = [];
    prov.setAnthropicFactory((apiKey) => ({
        models: { list: async function* () { if (apiKey.endsWith('bad')) { const e = new Error('invalid'); throw e; } yield { id: 'claude-opus-5-5' }; yield { id: 'claude-haiku-5-5' }; yield { id: 'claude-3-old' }; } },
        beta: { messages: { stream: (params) => {
            anthropicKeys.push(apiKey);
            calls.push(JSON.parse(JSON.stringify(params)));
            const msg = script.shift();
            let textCb = null;
            return { on(evt, cb) { if (evt === 'text') textCb = cb; return this; },
                async finalMessage() { for (const b of msg.content) if (b.type === 'text' && textCb) textCb(b.text); return msg; } };
        } } },
    }));
    // OpenAI: a stand-in for /v1/models and the streamed /v1/responses
    const oaCalls = [];
    let oaScript = [];
    prov.setOpenAIFetch(async (url, init) => {
        const auth = init.headers.authorization;
        if (auth !== 'Bearer sk-proj-test-openai-key-123456789') return new Response('{"error":{"message":"bad key"}}', { status: 401 });
        if (url.endsWith('/v1/models')) return Response.json({ object: 'list', data: [{ id: 'gpt-test-1', created: 2 }, { id: 'gpt-test-1-audio', created: 3 }, { id: 'text-embedding-x', created: 1 }] });
        oaCalls.push(JSON.parse(init.body));
        const events = oaScript.shift();
        const body = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
        return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    const usage = { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 3000, cache_creation_input_tokens: 0 };
    const toolTurn = { stop_reason: 'tool_use', usage, content: [
        { type: 'thinking', thinking: '', signature: 'sig-1' },
        { type: 'tool_use', id: 'tu_1', name: 'list_servers', input: {} },
    ] };
    const answer = (text) => ({ stop_reason: 'end_turn', usage, content: [{ type: 'text', text }] });
    const sse = async (cl, body) => {
        const r = await app.request('/api/assistant/ask', { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: cl.cookieHeader() }, body: JSON.stringify(body) });
        const raw = await r.text();
        return raw.split('\n\n').filter(Boolean).map((chunk) => JSON.parse(chunk.split('\n').find((l) => l.startsWith('data:')).slice(5)));
    };
    try {
        const a = client();
        assert.equal((await a.post('/api/auth/login', { username: 'alice', password: 'correct-horse-1' })).status, 200);
        const wsA = (await a.get('/api/auth/me')).json.user.workspaceId;
        const st0 = (await a.get('/api/assistant')).json;
        assert.deepEqual([st0.enabled, st0.canConfigure], [false, true]);
        const notSet = await sse(a, { question: 'Hello?' });
        assert.match(notSet.at(-1).message, /isn't set up/);

        // an admin adds a Claude key: checked against Anthropic; only supported models offered; stored in the workspace's AWS account, never returned
        const claudeKey = 'sk-ant-api03-' + 'x'.repeat(40);
        assert.equal((await a.post('/api/assistant/models', { provider: 'anthropic', apiKey: 'not-a-key' })).status, 400);
        const m = (await a.post('/api/assistant/models', { provider: 'anthropic', apiKey: claudeKey })).json;
        assert.deepEqual([m.models, m.suggested], [['claude-opus-5-5', 'claude-haiku-5-5'], 'claude-opus-5-5']);
        assert.equal((await a.put('/api/assistant/settings', { provider: 'anthropic', model: 'claude-3-old', apiKey: claudeKey })).status, 400);
        const saved = await a.put('/api/assistant/settings', { provider: 'anthropic', model: 'claude-opus-5-5', apiKey: claudeKey });
        assert.equal(saved.status, 200);
        assert.equal(saved.json.settings.keyLast4, 'xxxx');
        assert.equal(stored.get('/apps/ops-console-assistant/API_KEY'), claudeKey);
        const rawSettings = JSON.stringify((await a.get('/api/assistant/settings')).json);
        assert.ok(!rawSettings.includes(claudeKey), 'the key is never sent back');
        const { rows: dbRows } = await withWorkspace(wsA, () => db().query("SELECT value::text AS v FROM settings WHERE key = 'assistant'"));
        assert.ok(!dbRows[0].v.includes(claudeKey), 'the key is not in the console database');

        script = [toolTurn, answer('All **2** servers are running.')];
        const ev = await sse(a, { question: 'Are my servers ok?' });
        assert.deepEqual(ev.map((e) => e.type), ['conversation', 'tool', 'text', 'done']);
        assert.equal(ev[1].label, 'Checked the servers');
        assert.equal(anthropicKeys.at(-1), claudeKey, 'the workspace\'s own key is used');
        const convId = ev[0].id;
        const first = calls[0];
        assert.deepEqual([first.model, first.output_config.effort, first.fallbacks, first.cache_control.type], ['claude-opus-5-5', 'low', 'default', 'ephemeral']);
        assert.ok(first.tools.length >= 6 && first.tools.every((t) => t.strict === true && t.eager_input_streaming === true));
        assert.ok(!first.tools.some((t) => /deploy_app|restart|delete/.test(t.name)), 'read-only tools only');
        const result = JSON.parse(calls[1].messages.at(-1).content[0].content);
        const mine = (await withWorkspace(wsA, () => db().query('SELECT name FROM instances'))).rows.map((r) => r.name).sort();
        assert.deepEqual(result.result.map((s) => s.name).sort(), mine);
        assert.ok(result.now);

        // follow-up: earlier turns go back unchanged (thinking block included)
        script = [answer('Nothing failed today.')];
        assert.equal((await sse(a, { question: 'Anything failed?', conversationId: convId })).at(-1).type, 'done');
        const sent = calls.at(-1).messages;
        assert.deepEqual(sent.slice(0, 4).map((x) => x.role), ['user', 'assistant', 'user', 'assistant']);
        assert.deepEqual(sent[1].content[0], { type: 'thinking', thinking: '', signature: 'sig-1' });
        const conv = (await a.get(`/api/assistant/conversations/${convId}`)).json;
        assert.deepEqual(conv.turns.map((t) => [t.role, t.text]), [['user', 'Are my servers ok?'], ['assistant', 'All **2** servers are running.'], ['user', 'Anything failed?'], ['assistant', 'Nothing failed today.']]);
        assert.deepEqual(conv.turns[1].tools, ['Checked the servers']);

        // private: another workspace's person can't read it, and isn't set up; the demo can't ask
        const b = client();
        assert.equal((await b.post('/api/auth/login', { username: 'bob@example.com', password: 'brand-new-pass-9' })).status, 200);
        assert.equal((await b.get(`/api/assistant/conversations/${convId}`)).status, 404);
        assert.equal((await b.get('/api/assistant')).json.enabled, false);
        const d = client();
        assert.equal((await d.post('/api/auth/demo')).status, 200);
        assert.equal((await d.get('/api/assistant')).status, 403);
        const bad = await dist('assistant/tools').runTool('get_server', { server_id: 'drop table' }, 'admin');
        assert.equal(bad.isError, true);

        // switch to ChatGPT: a wrong key is refused; only chat models are offered
        assert.equal((await a.post('/api/assistant/models', { provider: 'openai', apiKey: 'sk-proj-wrong-key-0000000000000' })).status, 400);
        const om = (await a.post('/api/assistant/models', { provider: 'openai', apiKey: 'sk-proj-test-openai-key-123456789' })).json;
        assert.deepEqual(om.models, ['gpt-test-1']);
        assert.equal((await a.put('/api/assistant/settings', { provider: 'openai', model: 'gpt-test-1' })).status, 400, 'a new provider needs its key');
        assert.equal((await a.put('/api/assistant/settings', { provider: 'openai', model: 'gpt-test-1', apiKey: 'sk-proj-test-openai-key-123456789' })).status, 200);
        // the Claude chat can't be continued with ChatGPT
        assert.match((await sse(a, { question: 'More?', conversationId: convId })).at(-1).message, /Start a new chat/);

        const reasoning = { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'enc-1' };
        const fcall = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'list_servers', arguments: '{}' };
        const msgItem = (text) => ({ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });
        const ou = { input_tokens: 900, output_tokens: 40, input_tokens_details: { cached_tokens: 500 } };
        oaScript = [
            [{ type: 'response.created' }, { type: 'response.completed', response: { status: 'completed', output: [reasoning, fcall], usage: ou } }],
            [{ type: 'response.output_text.delta', delta: 'Both servers ' }, { type: 'response.output_text.delta', delta: 'are up.' }, { type: 'response.completed', response: { status: 'completed', output: [msgItem('Both servers are up.')], usage: ou } }],
        ];
        const ev3 = await sse(a, { question: 'Servers ok?' });
        assert.deepEqual(ev3.map((e) => e.type), ['conversation', 'tool', 'text', 'text', 'done']);
        assert.equal(ev3.slice(2, 4).map((e) => e.delta).join(''), 'Both servers are up.');
        const [r1, r2] = oaCalls;
        assert.deepEqual([r1.model, r1.stream, r1.store, r1.include[0]], ['gpt-test-1', true, false, 'reasoning.encrypted_content']);
        assert.ok(r1.tools.every((t) => t.type === 'function' && t.name && t.parameters));
        assert.match(r1.instructions, /A proposal changes nothing/);
        // second turn: the reasoning and call go back unchanged, then the tool output from Alice's workspace
        assert.deepEqual(r2.input.slice(1, 3), [reasoning, fcall]);
        const out = r2.input[3];
        assert.equal(out.type, 'function_call_output'); assert.equal(out.call_id, 'call_1');
        assert.deepEqual(JSON.parse(out.output).result.map((s) => s.name).sort(), mine);
        const conv3 = (await a.get(`/api/assistant/conversations/${ev3[0].id}`)).json;
        assert.deepEqual(conv3.turns.map((t) => [t.role, t.text, t.tools]), [['user', 'Servers ok?', undefined], ['assistant', 'Both servers are up.', ['Checked the servers']]]);

        // usage recorded; removing the settings deletes the key
        const u = (await a.get('/api/assistant/settings')).json.usage;
        assert.ok(u.questions >= 3 && u.cachedTokens > 0);
        assert.equal((await a.del('/api/assistant/settings')).status, 200);
        assert.equal(stored.size, 0);
        assert.equal((await a.get('/api/assistant')).json.enabled, false);
    } finally {
        prov.setKeyStore(null); prov.setAnthropicFactory(null); prov.setOpenAIFetch(null);
    }
});

test('mcp: personal tokens (shown once, hashed); /mcp speaks MCP with the read-only tools in the token owner\'s workspace and role; revoked, foreign-origin, demo and bad tokens refused', async () => {
    const { db, asSystem, withWorkspace } = dist('db');
    const a = client();
    assert.equal((await a.post('/api/auth/login', { username: 'alice', password: 'correct-horse-1' })).status, 200);
    const wsA = (await a.get('/api/auth/me')).json.user.workspaceId;
    const view = (await a.get('/api/mcp-tokens')).json;
    assert.match(view.url, /\/mcp$/);
    assert.ok(view.tools.some((t) => t.name === 'list_servers'));
    assert.equal((await a.post('/api/mcp-tokens', { name: 'x' })).status, 400);
    const created = await a.post('/api/mcp-tokens', { name: 'Claude Desktop', days: 30 });
    assert.equal(created.status, 200);
    const token = created.json.token;
    assert.match(token, /^opc_[A-Za-z0-9_-]{40}$/);
    assert.ok(created.json.row.expiresAt);
    const { rows: stored } = await asSystem(() => db().query('SELECT token_hash, prefix FROM mcp_tokens WHERE id = $1', [created.json.row.id]));
    assert.notEqual(stored[0].token_hash, token, 'only a hash is stored');
    assert.ok(!JSON.stringify((await a.get('/api/mcp-tokens')).json).includes(token), 'the token is never listed again');

    const rpc = async (body, headers = {}) => {
        const r = await app.request('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}`, ...headers }, body: JSON.stringify(body) });
        return { status: r.status, json: r.status === 202 ? null : await r.json(), headers: r.headers };
    };
    // the MCP handshake
    const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
    assert.equal(init.status, 200);
    assert.equal(init.json.result.protocolVersion, '2025-06-18');
    assert.deepEqual(init.json.result.capabilities, { tools: { listChanged: false } });
    assert.match(init.json.result.instructions, /Read-only/);
    assert.equal((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
    const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { 'mcp-protocol-version': '2025-06-18' });
    const tools = list.json.result.tools;
    assert.ok(tools.length >= 6 && tools.every((t) => t.inputSchema && t.annotations.readOnlyHint === !t.name.startsWith('propose_')));
    assert.ok(!tools.some((t) => /deploy_app|restart|delete|stop|terminate/.test(t.name)), 'lookups and proposals only');
    // a call runs in Alice's workspace only
    const call = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_servers', arguments: {} } });
    assert.equal(call.json.result.isError, false);
    const mine = (await withWorkspace(wsA, () => db().query('SELECT name FROM instances'))).rows.map((r) => r.name).sort();
    assert.deepEqual(JSON.parse(call.json.result.content[0].text).result.map((s) => s.name).sort(), mine);
    assert.equal((await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_server', arguments: { server_id: 'drop table' } } })).json.result.isError, true);
    assert.equal((await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'restart_everything', arguments: {} } })).json.error.code, -32602);
    assert.equal((await rpc({ jsonrpc: '2.0', id: 6, method: 'nope' })).json.error.code, -32601);
    const { rows: [used] } = await asSystem(() => db().query('SELECT last_used_at FROM mcp_tokens WHERE id = $1', [created.json.row.id]));
    assert.ok(used.last_used_at);
    const { rows: audited } = await withWorkspace(wsA, () => db().query("SELECT target FROM audit_log WHERE action = 'mcp.tool' ORDER BY id DESC LIMIT 1"));
    assert.equal(audited[0].target, 'get_server');

    // refused: no token, a wrong token, a foreign browser origin, GET, an unknown protocol version
    const noAuth = await app.request('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' });
    assert.equal(noAuth.status, 401);
    assert.match(noAuth.headers.get('www-authenticate'), /^Bearer /);
    assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { authorization: 'Bearer opc_' + 'A'.repeat(40) })).status, 401);
    assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await app.request('/mcp', { headers: { authorization: `Bearer ${token}` } })).status, 405);
    assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { 'mcp-protocol-version': '1999-01-01' })).status, 400);

    // another workspace's person can't see or revoke Alice's token; the demo can't make tokens
    const b = client();
    assert.equal((await b.post('/api/auth/login', { username: 'bob@example.com', password: 'brand-new-pass-9' })).status, 200);
    assert.ok(!(await b.get('/api/mcp-tokens?all=1')).json.tokens.some((t) => t.id === created.json.row.id));
    assert.equal((await b.del(`/api/mcp-tokens/${created.json.row.id}`)).status, 404);
    const d = client();
    assert.equal((await d.post('/api/auth/demo')).status, 200);
    assert.equal((await d.post('/api/mcp-tokens', { name: 'demo token' })).status, 403);

    // revoked: refused at once
    assert.equal((await a.del(`/api/mcp-tokens/${created.json.row.id}`)).status, 200);
    assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' })).status, 401);
    assert.equal((await a.get('/api/mcp-tokens')).json.tokens.length, 0);
});

test('mcp oauth: discovery, client registration, approval with PKCE, single-use codes, hourly access tokens on /mcp, rotating refresh tokens (reuse ends the grant), revocation; bad requests refused', async () => {
    const { createHash, randomBytes } = require('crypto');
    const { db, asSystem } = dist('db');
    const form = (o) => new URLSearchParams(o).toString();
    const post = (path, body, headers = {}) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body });
    // discovery: /mcp's 401 points to the resource metadata, which points to the authorization server
    const r401 = await app.request('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' });
    assert.equal(r401.status, 401);
    const rm = /resource_metadata="([^"]+)"/.exec(r401.headers.get('www-authenticate'))[1];
    const prm = await (await app.request(new URL(rm).pathname)).json();
    assert.ok(prm.resource.endsWith('/mcp'));
    const asm = await (await app.request('/.well-known/oauth-authorization-server')).json();
    assert.equal(asm.issuer, prm.authorization_servers[0]);
    assert.deepEqual(asm.code_challenge_methods_supported, ['S256']);

    // dynamic registration: https or localhost redirects only
    assert.equal((await app.request('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://evil.example/cb'] }) })).status, 400);
    const reg = await app.request('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Test Connector', redirect_uris: ['https://connector.example/callback'], token_endpoint_auth_method: 'none' }) });
    assert.equal(reg.status, 201);
    const cl = await reg.json();
    assert.match(cl.client_id, /^ocl_/);
    assert.equal(cl.client_secret, undefined);

    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const authz = { client_id: cl.client_id, redirect_uri: 'https://connector.example/callback', response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', scope: 'mcp:read', state: 'st-1', resource: prm.resource };

    const a = client();
    assert.equal((await a.post('/api/auth/login', { username: 'alice', password: 'correct-horse-1' })).status, 200);
    const wsA = (await a.get('/api/auth/me')).json.user.workspaceId;
    // the approval page's checks
    const chk = await a.post('/api/oauth/check', authz);
    assert.equal(chk.status, 200);
    assert.equal(chk.json.client.name, 'Test Connector');
    assert.equal(chk.json.client.redirectHost, 'connector.example');
    assert.ok(chk.json.workspaces.some((w) => w.id === wsA));
    assert.equal((await a.post('/api/oauth/check', { ...authz, redirect_uri: 'https://evil.example/cb' })).status, 400, 'unregistered redirect: shown, never redirected');
    const noPkce = await a.post('/api/oauth/check', { ...authz, code_challenge_method: 'plain' });
    assert.equal(noPkce.status, 400);
    assert.match(noPkce.json.redirect, /^https:\/\/connector\.example\/callback\?error=invalid_request/);
    // declining sends the app access_denied
    const no = await a.post('/api/oauth/decide', { ...authz, approve: false });
    assert.match(no.json.redirect, /error=access_denied.*state=st-1/);
    // a workspace the person isn't in is refused
    assert.equal((await a.post('/api/oauth/decide', { ...authz, approve: true, workspaceId: 999999 })).status, 400);
    const yes = await a.post('/api/oauth/decide', { ...authz, approve: true, workspaceId: wsA });
    const back = new URL(yes.json.redirect);
    assert.equal(back.origin + back.pathname, 'https://connector.example/callback');
    assert.equal(back.searchParams.get('state'), 'st-1');
    const code = back.searchParams.get('code');
    // the demo can't approve
    const d = client();
    assert.equal((await d.post('/api/auth/demo')).status, 200);
    assert.equal((await d.post('/api/oauth/decide', { ...authz, approve: true, workspaceId: wsA })).status, 403);

    // token exchange: wrong verifier fails (and the code is then spent); a fresh code with the right verifier works once
    const tok = (o) => post('/oauth/token', form(o));
    assert.equal((await tok({ grant_type: 'authorization_code', code, code_verifier: randomBytes(32).toString('base64url'), client_id: cl.client_id, redirect_uri: authz.redirect_uri })).status, 400);
    const code2 = new URL((await a.post('/api/oauth/decide', { ...authz, approve: true, workspaceId: wsA })).json.redirect).searchParams.get('code');
    const t1 = await tok({ grant_type: 'authorization_code', code: code2, code_verifier: verifier, client_id: cl.client_id, redirect_uri: authz.redirect_uri, resource: prm.resource });
    assert.equal(t1.status, 200);
    assert.equal(t1.headers.get('cache-control'), 'no-store');
    const g1 = await t1.json();
    assert.deepEqual([g1.token_type, g1.expires_in, g1.scope], ['Bearer', 3600, 'mcp:read']);
    assert.equal((await tok({ grant_type: 'authorization_code', code: code2, code_verifier: verifier, client_id: cl.client_id })).status, 400, 'codes are single-use');

    // reuse of the code ended that grant (it may have been stolen); connect once more for the rest of the test
    assert.equal((await app.request('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${g1.access_token}` }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' })).status, 401);
    const code3 = new URL((await a.post('/api/oauth/decide', { ...authz, approve: true, workspaceId: wsA })).json.redirect).searchParams.get('code');
    const g = await (await tok({ grant_type: 'authorization_code', code: code3, code_verifier: verifier, client_id: cl.client_id })).json();
    const call = (token) => app.request('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_servers', arguments: {} } }) });
    const ok = await call(g.access_token);
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).result.isError, false);
    // it shows on the Account page as a connected app
    const listed = (await a.get('/api/mcp-tokens')).json.tokens.find((t) => t.kind === 'oauth');
    assert.equal(listed.name, 'Test Connector');

    // refresh rotates both tokens; the old access token stops working
    const r2 = await (await tok({ grant_type: 'refresh_token', refresh_token: g.refresh_token, client_id: cl.client_id })).json();
    assert.ok(r2.access_token && r2.refresh_token && r2.refresh_token !== g.refresh_token);
    assert.equal((await call(g.access_token)).status, 401);
    assert.equal((await call(r2.access_token)).status, 200);
    // presenting the old refresh token again ends the grant
    assert.equal((await tok({ grant_type: 'refresh_token', refresh_token: g.refresh_token, client_id: cl.client_id })).status, 400);
    assert.equal((await call(r2.access_token)).status, 401);

    // another connection, then revoked by the app (RFC 7009) and refused afterwards
    const code4 = new URL((await a.post('/api/oauth/decide', { ...authz, approve: true, workspaceId: wsA })).json.redirect).searchParams.get('code');
    const g4 = await (await tok({ grant_type: 'authorization_code', code: code4, code_verifier: verifier, client_id: cl.client_id })).json();
    assert.equal((await call(g4.access_token)).status, 200);
    assert.equal((await post('/oauth/revoke', form({ token: g4.refresh_token, client_id: cl.client_id }))).status, 200);
    assert.equal((await call(g4.access_token)).status, 401);
    assert.equal((await tok({ grant_type: 'refresh_token', refresh_token: g4.refresh_token, client_id: cl.client_id })).status, 400);

    // an expired access token is refused
    const code5 = new URL((await a.post('/api/oauth/decide', { ...authz, approve: true, workspaceId: wsA })).json.redirect).searchParams.get('code');
    const g5 = await (await tok({ grant_type: 'authorization_code', code: code5, code_verifier: verifier, client_id: cl.client_id })).json();
    await asSystem(() => db().query("UPDATE mcp_tokens SET expires_at = now() - interval '1 second' WHERE token_hash = $1", [createHash('sha256').update(g5.access_token).digest('hex')]));
    assert.equal((await call(g5.access_token)).status, 401);
    // unknown client / unsupported grant
    assert.equal((await tok({ grant_type: 'authorization_code', code: 'x', code_verifier: verifier, client_id: 'ocl_' + 'z'.repeat(24) })).status, 401);
    assert.equal((await tok({ grant_type: 'password', client_id: cl.client_id })).status, 400);
});

test('actions: AI proposes deploy/rollback/start/reboot; nothing runs until the proposer confirms; confirm runs it like the button; cancel, expiry, viewers, other users and workspaces refused; chat shows the card', async () => {
    const { db, asSystem, withWorkspace } = dist('db');
    const tools = dist('assistant/tools');
    const a = client();
    assert.equal((await a.post('/api/auth/login', { username: 'alice', password: 'correct-horse-1' })).status, 200);
    const me = (await a.get('/api/auth/me')).json.user;
    const tok = (await a.post('/api/mcp-tokens', { name: 'Proposals test' })).json.token;
    const rpc = async (method, params) => {
        const r = await app.request('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
        return (await r.json()).result;
    };
    const call = async (name, args) => JSON.parse((await rpc('tools/call', { name, arguments: args })).content[0].text);
    // a server of Alice's with an app on it
    const status = { apps: [{ project: 'shop', healthy: true }], deploying: null, deployEvents: [], services: [], certificates: [], databases: [],
        host: { memory: { used: 1, total: 2 }, disk: { used: 1, total: 2, free: 1 }, load: [0, 0, 0], cpus: 2, uptimeSeconds: 3600 } };
    const { rows: [inst] } = await withWorkspace(me.workspaceId, () => db().query(
        "INSERT INTO instances (name, aws_instance_id, region, last_status, last_ok_at, ec2_state) VALUES ('ai-box', 'i-0ddddddddddddddd4', 'af-south-1', $1, now(), 'running') RETURNING id, name, last_status", [JSON.stringify(status)]));
    const appName = inst.last_status.apps[0].project;
    const deploysBefore = (await withWorkspace(me.workspaceId, () => db().query('SELECT count(*)::int AS n FROM deployments'))).rows[0].n;

    // bad proposals come back as data, and create nothing
    assert.match((await call('propose_deploy', { server_id: inst.id, app: 'no-such-app' })).result.error, /isn't an app/);
    assert.match((await call('propose_deploy', { server_id: 999999, app: appName })).result.error, /No server/);
    assert.equal((await rpc('tools/call', { name: 'propose_server_power', arguments: { server_id: inst.id, action: 'terminate' } })).isError, true, 'only start/reboot');
    const viewer = await tools.runTool('propose_deploy', { server_id: inst.id, app: appName }, 'viewer', { userId: me.id, username: 'alice', source: 'mcp', via: 'x' });
    assert.match(JSON.parse(viewer.content).result.error, /viewer/);

    // a proposal: nothing has run
    const p = (await call('propose_deploy', { server_id: inst.id, app: appName })).result;
    assert.equal(p.proposed, true);
    assert.match(p.nextStep, /Nothing has happened yet/);
    assert.equal((await withWorkspace(me.workspaceId, () => db().query('SELECT count(*)::int AS n FROM deployments'))).rows[0].n, deploysBefore);
    // asking again returns the same open proposal
    assert.equal((await call('propose_deploy', { server_id: inst.id, app: appName })).result.actionId, p.actionId);
    const open = (await a.get('/api/actions?open=1')).json.actions;
    assert.equal(open.length, 1);
    assert.deepEqual([open[0].kind, open[0].app, open[0].via, open[0].source, open[0].status], ['deploy', appName, 'Proposals test', 'mcp', 'proposed']);

    // only the proposer decides: another workspace's admin can't see or confirm it
    const b = client();
    assert.equal((await b.post('/api/auth/login', { username: 'bob@example.com', password: 'brand-new-pass-9' })).status, 200);
    assert.equal((await b.post(`/api/actions/${p.actionId}/confirm`)).status, 404);
    assert.equal((await b.get('/api/actions')).json.actions.length, 0);
    const d = client();
    assert.equal((await d.post('/api/auth/demo')).status, 200);
    assert.equal((await d.post(`/api/actions/${p.actionId}/confirm`)).status, 403);

    // confirm: it runs through requestDeployment, as Alice, and is audited with where it came from
    const done = (await a.post(`/api/actions/${p.actionId}/confirm`)).json.action;
    assert.equal(done.status, 'done', JSON.stringify(done.result));
    {
        assert.ok(done.result.deploymentId);
        const { rows: [dep] } = await withWorkspace(me.workspaceId, () => db().query('SELECT requested_by_name, project FROM deployments WHERE id = $1', [done.result.deploymentId]));
        assert.deepEqual([dep.requested_by_name, dep.project], ['alice', appName]);
        const { rows: [au] } = await withWorkspace(me.workspaceId, () => db().query("SELECT detail FROM audit_log WHERE action LIKE 'app.deploy%' ORDER BY id DESC LIMIT 1"));
        assert.equal(au.detail.proposal, p.actionId);
        assert.equal(au.detail.via, 'Proposals test');
    }
    assert.equal((await a.post(`/api/actions/${p.actionId}/confirm`)).status, 409, 'decided once');

    // cancel; expiry
    const r = (await call('propose_rollback', { server_id: inst.id, app: appName })).result;
    assert.equal((await a.post(`/api/actions/${r.actionId}/cancel`)).json.action.status, 'cancelled');
    assert.equal((await a.post(`/api/actions/${r.actionId}/confirm`)).status, 409);
    await asSystem(() => db().query("UPDATE deployments SET status = 'failed', finished_at = now() WHERE status IN ('running', 'pending_approval')"));
    const e = (await call('propose_deploy', { server_id: inst.id, app: appName, ref: 'main' })).result;
    await asSystem(() => db().query("UPDATE assistant_actions SET expires_at = now() - interval '1 second' WHERE id = $1", [e.actionId]));
    const exp = await a.post(`/api/actions/${e.actionId}/confirm`);
    assert.equal(exp.status, 409);
    assert.match(exp.json.error, /expired/);

    // in the chat: the proposal arrives as an "action" event, and the conversation keeps the card with the answer
    const prov = dist('assistant/providers');
    const stored = new Map();
    prov.setKeyStore({ get: async (rg, n) => stored.get(n) ?? null, put: async (rg, n, v) => { stored.set(n, v); }, del: async (rg, n) => { stored.delete(n); } });
    let script = [];
    prov.setAnthropicFactory(() => ({
        models: { list: async function* () { yield { id: 'claude-opus-5-5' }; } },
        beta: { messages: { stream: () => { const msg = script.shift(); let cb = null; return { on(ev, f) { if (ev === 'text') cb = f; return this; }, async finalMessage() { for (const bl of msg.content) if (bl.type === 'text' && cb) cb(bl.text); return msg; } }; } } },
    }));
    try {
        assert.equal((await a.put('/api/assistant/settings', { provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'sk-ant-api03-' + 'y'.repeat(40) })).status, 200);
        const usage = { input_tokens: 10, output_tokens: 5 };
        script = [
            { stop_reason: 'tool_use', usage, content: [{ type: 'tool_use', id: 'tu_p', name: 'propose_server_power', input: { server_id: inst.id, action: 'reboot' } }] },
            { stop_reason: 'end_turn', usage, content: [{ type: 'text', text: `Once you confirm, ${inst.name} will reboot.` }] },
        ];
        const raw = await (await app.request('/api/assistant/ask', { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: a.cookieHeader() }, body: JSON.stringify({ question: `Reboot ${inst.name}` }) })).text();
        const ev = raw.split('\n\n').filter(Boolean).map((c) => JSON.parse(c.split('\n').find((l) => l.startsWith('data:')).slice(5)));
        const act = ev.find((x) => x.type === 'action');
        assert.ok(act, 'an action event');
        assert.deepEqual([act.action.kind, act.action.source, act.action.status], ['reboot', 'chat', 'proposed']);
        const conv = (await a.get(`/api/assistant/conversations/${ev[0].id}`)).json;
        assert.deepEqual(conv.turns.at(-1).actions, [act.action.id]);
        assert.equal(conv.actions[0].id, act.action.id);
        await a.post(`/api/actions/${act.action.id}/cancel`);
        await a.del('/api/assistant/settings');
    } finally {
        prov.setKeyStore(null); prov.setAnthropicFactory(null);
    }
});

test('billing: payments are tagged with the console; invoices and webhooks only take this console\'s payments for this workspace (a shared Paystack account and customer)', async () => {
    const billing = dist('billing');
    const { db, asSystem, withWorkspace } = dist('db');
    const ours = billing.consoleTag();
    const e1 = Date.now(), e2 = Date.now() + 1;
    const b = client();
    assert.equal((await b.post('/api/auth/login', { username: 'bob@example.com', password: 'brand-new-pass-9' })).status, 200);
    const ws = (await b.get('/api/auth/me')).json.user.workspaceId;
    await asSystem(() => db().query("UPDATE workspaces SET paystack_customer = 'CUS_shared' WHERE id = $1", [ws]));
    const tx = (reference, amount, metadata) => ({ status: 'success', reference, amount, currency: 'ZAR', paid_at: new Date().toISOString(), metadata, customer: { customer_code: 'CUS_shared', email: 'bob@example.com' } });
    const txs = [
        tx('other-console-1', 19900, { workspace_id: ws, console: 'ops.other.example', kind: 'subscribe', plan: 'starter' }),   // same workspace number, another console
        tx('untagged-1', 19900, {}),                                                                                           // no metadata (another product on the account)
        tx('card-check-1', 500, { workspace_id: ws, console: ours, kind: 'card' }),                                            // R5 card check: never an invoice by itself
        tx('ours-1', 19900, { workspace_id: ws, console: ours, kind: 'subscribe', plan: 'starter' }),                         // ours
    ];
    billing.setPaystackFetch(async (url) => {
        const u = new URL(url);
        const ok = (data) => new Response(JSON.stringify({ status: true, message: 'ok', data }), { status: 200 });
        if (u.pathname === '/customer/CUS_shared') return ok({ id: 77 });
        if (u.pathname === '/transaction') return ok(txs);
        return new Response(JSON.stringify({ status: false }), { status: 404 });
    });
    const before = (await withWorkspace(ws, () => db().query('SELECT reference FROM invoices'))).rows.map((r) => r.reference);
    await billing.syncInvoices(ws);
    const after = (await withWorkspace(ws, () => db().query('SELECT reference FROM invoices'))).rows.map((r) => r.reference).filter((r) => !before.includes(r));
    assert.deepEqual(after, ['ours-1'], 'only this console\'s payment for this workspace becomes an invoice');

    // webhook: another console's payment for "the same" workspace number is recorded but never applied
    const plan = (await asSystem(() => db().query('SELECT plan FROM workspaces WHERE id = $1', [ws]))).rows[0].plan;
    await billing.handlePaystackEvent({ event: 'charge.success', data: { id: e1, ...tx('other-console-2', 59900, { workspace_id: ws, console: 'ops.other.example', kind: 'subscribe', plan: 'pro' }) } });
    const { rows: [ev] } = await asSystem(() => db().query("SELECT workspace_id FROM billing_events WHERE id = $1", [`charge.success:${e1}`]));
    assert.equal(ev.workspace_id, null);
    assert.equal((await asSystem(() => db().query('SELECT plan FROM workspaces WHERE id = $1', [ws]))).rows[0].plan, plan, 'plan unchanged');
    assert.equal((await asSystem(() => db().query("SELECT 1 FROM invoices WHERE reference = 'other-console-2'"))).rows.length, 0);
    // an untagged payment naming a workspace whose Paystack customer is someone else's is not applied either
    await billing.handlePaystackEvent({ event: 'charge.success', data: { id: e2, ...tx('legacy-2', 59900, { workspace_id: ws, kind: 'subscribe', plan: 'pro' }), customer: { customer_code: 'CUS_someone_else' } } });
    assert.equal((await asSystem(() => db().query("SELECT workspace_id FROM billing_events WHERE id = $1", [`charge.success:${e2}`]))).rows[0].workspace_id, null);
    // another product's subscription renewal (same customer, same R199, no metadata) is not an invoice: this workspace never had a Paystack subscription
    await asSystem(() => db().query('UPDATE workspaces SET subscription_code = NULL WHERE id = $1', [ws]));
    await billing.handlePaystackEvent({ event: 'charge.success', data: { id: e2 + 1, ...tx('spaza-renewal-1', 19900, {}), plan: { plan_code: 'PLN_other', name: 'Another product', amount: 19900 } } });
    assert.equal((await asSystem(() => db().query("SELECT 1 FROM invoices WHERE reference = 'spaza-renewal-1'"))).rows.length, 0);
    // new payments started here carry the tag
    assert.equal(billing.consoleTag(), new URL(process.env.PUBLIC_URL || 'https://ops.glenify.studio').host);
    await asSystem(() => db().query("DELETE FROM invoices WHERE reference = 'ours-1'"));
    billing.setPaystackFetch(null);
});
