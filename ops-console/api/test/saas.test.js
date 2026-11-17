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
    return { cookieHeader: () => cookie, get: (u) => call('GET', u), post: (u, b) => call('POST', u, b ?? {}), patch: (u, b) => call('PATCH', u, b), del: (u) => call('DELETE', u) };
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
