// Phase 11 (server access) with FAKE AWS: browser terminal over a fake Session Manager agent, temporary SSH
// rules on security groups, authorized keys and the security snapshot.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const zlib = require('zlib');
const { WebSocket, WebSocketServer } = require('ws');

const ORIGIN = 'https://ops.example.test';
const PORT = 57000 + Math.floor(Math.random() * 1000);
process.env.DATABASE_URL = `postgresql://postgres:pw@127.0.0.1:${PORT}/opsconsole_test`;
process.env.ALLOWED_ORIGINS = ORIGIN;
process.env.COOKIE_SECURE = 'false';

const dist = (m) => require(path.join(__dirname, '..', 'dist', m));
let pg, app, server, base, agent, agentUrl;
const IID = 'i-0aaaaaaaaaaaaaaa1';
const encode = (obj) => zlib.gzipSync(Buffer.from(JSON.stringify(obj))).toString('base64');

const fake = {
    instances: { [IID]: { name: 'web-1', state: 'running', type: 't3.micro', az: 'af-south-1a', managedTag: true } },
    groups: [
        { groupId: 'sg-other', name: 'default', managedTag: false, rules: [], prefixLists: [], openToWorld: false },
        { groupId: 'sg-web', name: 'web', managedTag: true, rules: [{ cidr: '198.51.100.9/32', description: 'admin-ssh 2026-11-01' }], prefixLists: [], openToWorld: false },
    ],
    authorized: [], revoked: [], docs: [], sessions: [], terminated: [], keyAnswer: null,
    async describeInstance(_r, id) { const i = this.instances[id]; return i ? { ...i, publicIp: '203.0.113.10' } : null; },
    async ssmOnline() { return true; },
    async getInvocation() { return null; },
    async sendDocument() { return 'cmd-1'; },
    async presignGet() { return ''; },
    async sshAccess() { return JSON.parse(JSON.stringify(this.groups)); },
    async authorizeSsh(_r, g, cidr, description) {
        this.authorized.push([g, cidr, description]);
        this.groups.find((x) => x.groupId === g).rules.push({ cidr, description });
    },
    async revokeSsh(_r, g, cidr) {
        this.revoked.push([g, cidr]);
        const grp = this.groups.find((x) => x.groupId === g); grp.rules = grp.rules.filter((r) => r.cidr !== cidr);
    },
    async startSession(_r, id) { this.sessions.push(id); return { sessionId: 'sess-1', streamUrl: agentUrl, tokenValue: 'tok-123' }; },
    async terminateSession(_r, sid) { this.terminated.push(sid); },
    async runDocument(_r, _id, document, params) {
        this.docs.push([document, params]);
        if (document === 'OpsConsole-Security') {
            return encode({ at: 1, os: { name: 'Amazon Linux 2023' }, updates: { kind: 'release', newer: [{ version: '2023.10.20260120', date: '2026-01-20' }] },
                users: [{ user: 'ec2-user', uid: 1000, keys: [{ type: 'ssh-ed25519', fingerprint: 'SHA256:' + 'A'.repeat(43), comment: 'laptop' }], manageable: true }],
                logins: { accepted: [], failed: [], failedTotal: 0 }, sessions: [], sshd: { passwordauthentication: 'no' } });
        }
        if (document === 'OpsConsole-SshKeys') {
            if (this.keyAnswer) throw new Error(`SSM command Failed: ${JSON.stringify(this.keyAnswer)}`);
            if (params.temporary?.[0] === 'yes') {
                return JSON.stringify(params.action[0] === 'add'
                    ? { ok: true, action: 'add', user: params.user[0], fingerprint: 'SHA256:x', added: !this.permanentKey, permanent: !!this.permanentKey }
                    : { ok: true, action: 'remove', user: params.user[0], fingerprint: params.fingerprint[0], removed: 1 });
            }
            return JSON.stringify({ ok: true, action: params.action[0], user: params.user[0], fingerprint: 'SHA256:' + 'B'.repeat(43), keys: 2 });
        }
        throw new Error('unexpected document ' + document);
    },
};

let ip = 0;
function client(fwd) {
    const myIp = fwd ?? `10.2.0.${++ip}`;
    let cookie = '';
    const call = async (method, url, body) => {
        const headers = { 'content-type': 'application/json', 'x-forwarded-for': myIp, origin: ORIGIN };
        if (cookie) headers.cookie = cookie;
        const res = await app.request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        const set = res.headers.get('set-cookie');
        if (set) cookie = set.split(';')[0];
        return { status: res.status, json: await res.json().catch(() => null) };
    };
    return { cookie: () => cookie, get: (u) => call('GET', u), post: (u, b) => call('POST', u, b ?? {}), del: (u) => call('DELETE', u) };
}
async function signedIn(role, fwd) {
    const c = client(fwd);
    if (role === 'demo') await c.post('/api/auth/demo');
    else await c.post('/api/auth/login', { username: role, password: `${role}-password-1` });
    return c;
}

// ---- a fake Session Manager agent speaking the data-channel protocol
const { encodeMessage, decodeMessage, PayloadType } = require(path.join(__dirname, '..', 'dist', 'ssmsession'));
function startAgent() {
    const wss = new WebSocketServer({ port: 0 });
    const state = { opened: null, inputs: [], acks: [], sizes: [], socket: null };
    wss.on('connection', (ws) => {
        state.socket = ws;
        let seq = 0;
        const out = (payloadType, text, s = seq++) => ws.send(encodeMessage({ type: 'output_stream_data', seq: s, flags: 0, payloadType, payload: Buffer.from(text) }));
        ws.on('message', (data, isBinary) => {
            if (!isBinary) {
                state.opened = JSON.parse(data.toString());
                out(PayloadType.HandshakeRequest, JSON.stringify({ AgentVersion: '3.3', RequestedClientActions: [{ ActionType: 'SessionType', ActionParameters: { SessionType: 'Standard_Stream' } }] }));
                return;
            }
            const m = decodeMessage(data);
            if (m.type === 'acknowledge') { state.acks.push(JSON.parse(m.payload.toString())); return; }
            if (m.payloadType === PayloadType.HandshakeResponse) {
                state.handshake = JSON.parse(m.payload.toString());
                out(PayloadType.HandshakeComplete, JSON.stringify({ HandshakeTimeToComplete: 1 }));
                // out of order on purpose: seq 3 before seq 2
                ws.send(encodeMessage({ type: 'output_stream_data', seq: 3, flags: 0, payloadType: 1, payload: Buffer.from('world ') }));
                ws.send(encodeMessage({ type: 'output_stream_data', seq: 2, flags: 0, payloadType: 1, payload: Buffer.from('hello ') }));
                seq = 4;
                return;
            }
            if (m.payloadType === PayloadType.Size) { state.sizes.push(JSON.parse(m.payload.toString())); return; }
            if (m.payloadType === PayloadType.Output) {
                state.inputs.push({ seq: m.seq, text: m.payload.toString() });
                if (m.payload.toString() === 'exit\r') {
                    ws.send(encodeMessage({ type: 'channel_closed', seq: 0, flags: 0, payloadType: 0, payload: Buffer.from(JSON.stringify({ Output: 'Exiting session with sessionId: sess-1.' })) }));
                } else out(PayloadType.Output, `echo:${m.payload.toString()}`);
            }
        });
    });
    return new Promise((res) => wss.on('listening', () => res({ wss, state, url: `ws://127.0.0.1:${wss.address().port}/stream` })));
}

function openTerminal(c, { origin = ORIGIN, cols = 100, rows = 30 } = {}) {
    const headers = { origin };
    if (c?.cookie()) headers.cookie = c.cookie();
    return new WebSocket(`${base.replace('http', 'ws')}/api/instances/1/terminal?cols=${cols}&rows=${rows}`, { headers });
}
const refusedWith = (ws) => new Promise((res) => {
    ws.on('unexpected-response', (_req, r) => res(r.statusCode));
    ws.on('open', () => res('opened'));
    ws.on('error', () => undefined);
});

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
    await dist('db').db().query(`INSERT INTO instances (name, aws_instance_id, region) VALUES ('web-1', $1, 'af-south-1')`, [IID]);
    const { serve } = require('@hono/node-server');
    server = await new Promise((res) => { const s = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => res(s)); });
    dist('terminal').attachTerminal(server);
    base = `http://127.0.0.1:${server.address().port}`;
    agent = await startAgent(); agentUrl = agent.url;
});
after(async () => {
    agent?.wss.close(); server?.close();
    await dist('db').closeDb(); await pg.stop();
});

test('protocol: messages round-trip with their UUID, digest and payload', () => {
    const id = '0b5f2a84-1c3d-4e5f-8a9b-0c1d2e3f4a5b';
    const buf = encodeMessage({ type: 'input_stream_data', seq: 7, flags: 0, payloadType: 1, payload: Buffer.from('ls -la\r'), id });
    assert.equal(buf.readUInt32BE(0), 116);
    assert.equal(buf.toString('utf8', 4, 36), 'input_stream_data'.padEnd(32, ' '));
    // UUID goes on the wire low 8 bytes first (as the AWS plugin writes it)
    assert.equal(buf.subarray(64, 72).toString('hex'), '8a9b0c1d2e3f4a5b');
    assert.equal(buf.subarray(80, 112).toString('hex'), require('crypto').createHash('sha256').update('ls -la\r').digest('hex'));
    const m = decodeMessage(buf);
    assert.deepEqual([m.type, m.seq, m.flags, m.payloadType, m.id, m.payload.toString()], ['input_stream_data', 7, 0, 1, id, 'ls -la\r']);
});

test('terminal: refused without an allowed Origin, a sign-in or the admin role', async () => {
    assert.equal(await refusedWith(openTerminal(null)), 401);
    const a = await signedIn('admin');
    assert.equal(await refusedWith(openTerminal(a, { origin: 'https://evil.example' })), 403, 'cross-site WebSocket hijacking is refused');
    assert.equal(await refusedWith(openTerminal(await signedIn('deployer'))), 403);
    assert.equal(await refusedWith(openTerminal(await signedIn('demo'))), 403);
    assert.equal(fake.sessions.length, 0, 'no session was ever started');
});

test('terminal: a full shell session through Session Manager (handshake, in-order output, acks, input, size, exit)', async () => {
    const a = await signedIn('admin');
    const ws = openTerminal(a, { cols: 100, rows: 30 });
    const got = { out: '', control: [] };
    const closed = new Promise((res) => ws.on('close', res));
    ws.on('message', (d, isBinary) => { if (isBinary) got.out += d.toString(); else got.control.push(JSON.parse(d.toString())); });
    await new Promise((res) => ws.on('open', res));
    const until = async (f) => { for (let i = 0; i < 100 && !f(); i++) await new Promise((r) => setTimeout(r, 20)); assert.ok(f()); };

    await until(() => got.control.some((m) => m.t === 'ready'));
    assert.equal(agent.state.opened.TokenValue, 'tok-123', 'the stream is opened with the session token');
    assert.deepEqual(agent.state.handshake.ProcessedClientActions, [{ ActionType: 'SessionType', ActionStatus: 1 }]);
    await until(() => agent.state.sizes.length > 0);
    assert.deepEqual(agent.state.sizes[0], { cols: 100, rows: 30 });
    await until(() => got.out.includes('world'));
    assert.equal(got.out, 'hello world ', 'out-of-order output is shown in sequence order');
    assert.deepEqual(agent.state.acks.map((x) => x.AcknowledgedMessageSequenceNumber).sort(), [0, 1, 2, 3], 'every output message is acknowledged');

    ws.send(JSON.stringify({ t: 'i', d: 'ls\r' }));
    await until(() => got.out.includes('echo:ls'));
    ws.send(JSON.stringify({ t: 'r', c: 140, r: 40 }));
    await until(() => agent.state.sizes.length > 1);
    assert.deepEqual(agent.state.sizes[1], { cols: 140, rows: 40 });
    const seqs = agent.state.inputs.map((x) => x.seq);
    ws.send(JSON.stringify({ t: 'i', d: 'exit\r' }));
    await closed;
    assert.ok(seqs[0] > 0, 'input sequence continues after the handshake response');
    assert.ok(got.control.some((m) => m.t === 'closed' && /Exiting session/.test(m.reason)));
    assert.deepEqual(fake.terminated, ['sess-1'], 'the SSM session is terminated');

    await new Promise((r) => setTimeout(r, 100));
    const { rows: [s] } = await dist('db').db().query('SELECT username, session_id, ended_at, end_reason FROM terminal_sessions');
    assert.deepEqual([s.username, s.session_id, !!s.ended_at], ['admin', 'sess-1', true]);
    const { rows: au } = await dist('db').db().query("SELECT action FROM audit_log WHERE action LIKE 'terminal.%' ORDER BY id");
    assert.deepEqual(au.map((x) => x.action), ['terminal.open', 'terminal.close']);
    const sec = (await a.get('/api/instances/1/security')).json;
    assert.equal(sec.terminalSessions[0].username, 'admin');
    assert.deepEqual(sec.activeTerminals, []);
});

test('ssh access: opens /32 for your public IP on the tagged group only, extends, refuses existing rules, expires', async () => {
    const a = await signedIn('admin', '203.0.113.50');
    const view = (await a.get('/api/instances/1/ssh-access')).json;
    assert.equal(view.yourIp, '203.0.113.50');
    assert.equal(view.target, 'sg-web');
    assert.equal(view.groups[1].rules[0].temporary, false, 'the hand-made admin rule is not the console\'s');

    const r = await a.post('/api/instances/1/ssh-access', { hours: 2, reason: 'debugging deploy' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(fake.authorized.map(([g, c]) => [g, c]), [['sg-web', '203.0.113.50/32']]);
    assert.match(fake.authorized[0][2], /^ops-console temp admin until \d{4}-\d\d-\d\d \d\d:\d\dZ$/);
    const again = await a.post('/api/instances/1/ssh-access', { hours: 4 });
    assert.equal(again.status, 200);
    assert.equal(fake.authorized.length, 1, 'same address again extends the grant, no second rule');
    assert.ok(Date.parse(again.json.grant.expiresAt) > Date.parse(r.json.grant.expiresAt));

    assert.equal((await a.post('/api/instances/1/ssh-access', { ip: '198.51.100.9', hours: 1 })).json.code, 'already_allowed');
    assert.equal((await a.post('/api/instances/1/ssh-access', { ip: '10.0.0.5', hours: 1 })).status, 400, 'private addresses are refused');
    assert.equal((await a.post('/api/instances/1/ssh-access', { ip: '0.0.0.0', hours: 1 })).status, 400);
    assert.equal((await a.post('/api/instances/1/ssh-access', { ip: '203.0.113.60/24', hours: 1 })).status, 400, 'never a range');
    assert.equal((await a.post('/api/instances/1/ssh-access', { ip: '203.0.113.60', hours: 24 })).status, 400);

    const d = await signedIn('deployer', '203.0.113.51');
    assert.equal((await d.get('/api/instances/1/ssh-access')).status, 200, 'deployers can see access');
    assert.equal((await d.post('/api/instances/1/ssh-access', { hours: 1 })).status, 403, 'but only admins open it');
    assert.equal((await (await signedIn('demo')).get('/api/instances/1/ssh-access')).status, 403);
    assert.equal((await (await signedIn('viewer')).get('/api/instances/1/security')).status, 403);

    await dist('db').db().query("UPDATE ssh_grants SET expires_at = now() - interval '1 minute'");
    assert.equal(await dist('access').expireSshGrants(), 1);
    assert.deepEqual(fake.revoked, [['sg-web', '203.0.113.50/32']]);
    const { rows: [g] } = await dist('db').db().query('SELECT revoked_by FROM ssh_grants');
    assert.equal(g.revoked_by, 'expired');
    assert.ok(fake.groups[1].rules.some((x) => x.cidr === '198.51.100.9/32'), 'the hand-made rule is never touched');

    // revoke now
    const r2 = await a.post('/api/instances/1/ssh-access', { ip: '2001:db8::7', hours: 1 });
    assert.equal(r2.json.grant.cidr, '2001:db8::7/128');
    assert.equal((await a.del(`/api/instances/1/ssh-access/${r2.json.grant.id}`)).json.grant.revokedBy, 'admin');
    assert.deepEqual(fake.revoked.at(-1), ['sg-web', '2001:db8::7/128']);

    // no tagged group: a clear message, nothing opened
    fake.groups[1].managedTag = false;
    const u = await a.post('/api/instances/1/ssh-access', { ip: '203.0.113.70', hours: 1 });
    assert.equal(u.json.code, 'untagged_group');
    assert.match(u.json.error, /tag-security-groups\.sh af-south-1/);
    fake.groups[1].managedTag = true;
});

test('keys and snapshot: validated before reaching the instance; refusals from the instance are shown', async () => {
    const a = await signedIn('admin');
    assert.equal((await a.post('/api/instances/1/ssh-keys', { action: 'add', user: 'ec2-user', key: '-----BEGIN OPENSSH PRIVATE KEY-----' })).status, 400);
    assert.equal((await a.post('/api/instances/1/ssh-keys', { action: 'add', user: 'root', key: 'ssh-ed25519 ' + 'A'.repeat(68) })).status, 400, 'never root');
    assert.equal((await a.post('/api/instances/1/ssh-keys', { action: 'add', user: 'ec2-user', key: "ssh-ed25519 AAAA'; rm -rf / #" })).status, 400);
    const before = fake.docs.length;
    const ok = await a.post('/api/instances/1/ssh-keys', { action: 'add', user: 'ec2-user', key: 'ssh-ed25519 ' + 'A'.repeat(68) + '  laptop@home' });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.deepEqual(fake.docs[before], ['OpsConsole-SshKeys', { action: ['add'], user: ['ec2-user'], key: ['ssh-ed25519 ' + 'A'.repeat(68) + ' laptop@home'], fingerprint: [''] }]);
    assert.equal(fake.docs[before + 1][0], 'OpsConsole-Security', 'the snapshot is refreshed after a change');

    fake.keyAnswer = { ok: false, error: "that is ec2-user's last key: removing it would lock everyone out of SSH. Add another key first." };
    const last = await a.post('/api/instances/1/ssh-keys', { action: 'remove', user: 'ec2-user', fingerprint: 'SHA256:' + 'A'.repeat(43) });
    assert.equal(last.status, 409);
    assert.match(last.json.error, /lock everyone out/);
    fake.keyAnswer = null;
    assert.equal((await (await signedIn('deployer')).post('/api/instances/1/ssh-keys', { action: 'remove', user: 'ec2-user', fingerprint: 'SHA256:' + 'A'.repeat(43) })).status, 403);

    const snap = (await a.get('/api/instances/1/security')).json;
    assert.equal(snap.snapshot.users[0].keys[0].comment, 'laptop');
    assert.equal(snap.snapshot.updates.newer[0].version, '2023.10.20260120');
    const { rows } = await dist('db').db().query("SELECT action FROM audit_log WHERE action LIKE 'ssh.%' ORDER BY id");
    assert.deepEqual(rows.map((x) => x.action), ['ssh.grant', 'ssh.grant', 'ssh.grant', 'ssh.revoke', 'ssh.key.add']);
});

test('laptop access: saved keys, direct (key from= your IP + port 22 for it) and Session Manager routes, expiry removes both', async () => {
    const { execFileSync } = require('child_process');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-key-'));
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'glen@laptop', '-f', path.join(dir, 'k')]);
    const pub = fs.readFileSync(path.join(dir, 'k.pub'), 'utf8').trim();
    const expectFp = execFileSync('ssh-keygen', ['-lf', path.join(dir, 'k.pub')]).toString().split(' ')[1];

    const a = await signedIn('admin', '203.0.113.80');
    assert.equal((await a.post('/api/ssh-keys', { key: '-----BEGIN OPENSSH PRIVATE KEY-----\nabc' })).status, 400, 'private keys are refused');
    const saved = await a.post('/api/ssh-keys', { name: '', key: pub });
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    assert.equal(saved.json.key.fingerprint, expectFp, 'same fingerprint as ssh-keygen');
    assert.equal(saved.json.key.name, 'glen@laptop');
    assert.equal((await a.post('/api/ssh-keys', { key: pub })).status, 409);
    assert.equal((await (await signedIn('deployer')).get('/api/ssh-keys')).status, 403);
    const keyId = saved.json.key.id;

    // direct
    const docsBefore = fake.docs.length, authBefore = fake.authorized.length;
    const d = await a.post('/api/instances/1/laptop-access', { keyId, route: 'direct', hours: 2 });
    assert.equal(d.status, 200, JSON.stringify(d.json));
    const [doc, params] = fake.docs[docsBefore];
    assert.equal(doc, 'OpsConsole-SshKeys');
    assert.deepEqual([params.action[0], params.user[0], params.key[0], params.from[0], params.temporary[0]], ['add', 'ec2-user', pub, '203.0.113.80/32', 'yes']);
    const exp = Number(params.expires[0]);
    assert.ok(Math.abs(exp - (Date.now() / 1000 + 7200)) < 60, 'expiry-time two hours out');
    assert.deepEqual(fake.authorized.slice(authBefore).map(([g, c]) => [g, c]), [['sg-web', '203.0.113.80/32']], 'port 22 opened for that IP only');
    assert.equal(d.json.host, '203.0.113.10');
    assert.equal(d.json.ipGrant.cidr, '203.0.113.80/32');
    assert.equal(d.json.grant.keyAdded, true);

    // the same key again through Session Manager replaces the open key grant, opens no port
    const authMid = fake.authorized.length;
    const m = await a.post('/api/instances/1/laptop-access', { keyId, route: 'ssm', hours: 1 });
    assert.equal(m.status, 200, JSON.stringify(m.json));
    assert.equal(fake.docs.at(-1)[1].from[0], '127.0.0.1/32,::1/128', 'the key only works through the Session Manager tunnel');
    assert.equal(fake.authorized.length, authMid);
    assert.equal(m.json.ipGrant, null);
    const { rows: open } = await dist('db').db().query("SELECT route FROM ssh_grants WHERE kind = 'key' AND revoked_at IS NULL");
    assert.deepEqual(open.map((x) => x.route), ['ssm']);

    // somebody else can't use my key
    const other = await signedIn('admin', '203.0.113.81');
    assert.equal((await other.post('/api/instances/1/laptop-access', { keyId: keyId + 999, route: 'ssm', hours: 1 })).status, 404);

    // expiry: temporary key removed (temporary=yes, never a permanent copy), port closed
    await dist('db').db().query("UPDATE ssh_grants SET expires_at = now() - interval '1 minute' WHERE revoked_at IS NULL");
    const revBefore = fake.revoked.length;
    await dist('access').expireSshGrants();
    const removal = fake.docs.filter(([doc, p]) => doc === 'OpsConsole-SshKeys' && p.action[0] === 'remove' && p.temporary?.[0] === 'yes');
    assert.equal(removal.length, 1);
    assert.equal(removal[0][1].fingerprint[0], expectFp);
    assert.ok(fake.revoked.slice(revBefore).some(([, c]) => c === '203.0.113.80/32'), 'the port opened for the laptop closes');
    const { rows: left } = await dist('db').db().query('SELECT count(*)::int AS n FROM ssh_grants WHERE revoked_at IS NULL');
    assert.equal(left[0].n, 0);

    // a key that already has permanent access is left alone: nothing to remove later
    fake.permanentKey = true;
    const p2 = await a.post('/api/instances/1/laptop-access', { keyId, route: 'ssm', hours: 1 });
    assert.equal(p2.json.permanent, true);
    assert.equal(p2.json.grant.keyAdded, false);
    fake.permanentKey = false;
});
