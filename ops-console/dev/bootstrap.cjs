// Local test server bootstrap: start a persistent embedded PostgreSQL, apply migrations, create test logins,
// and register the managed EC2 instances (found by their ops-console=managed tag, using your AWS CLI credentials).
// Started by dev/local.sh; keeps running until Ctrl-C (it owns the database process).
const path = require('path'), fs = require('fs'), { execFileSync } = require('child_process'), crypto = require('crypto');
const API = path.join(__dirname, '..', 'api');
const STATE = path.join(__dirname, '..', '.local');
const PG_PORT = Number(process.env.OPS_LOCAL_PG_PORT || 55432);
const REGION = process.env.AWS_REGION || 'af-south-1';
process.env.DATABASE_URL = `postgresql://postgres:local@127.0.0.1:${PG_PORT}/opsconsole`;
const dist = (m) => require(path.join(API, 'dist', m));

let pg = null;
(async () => {
    fs.mkdirSync(STATE, { recursive: true, mode: 0o700 });
    const dataDir = path.join(STATE, 'pgdata');
    const fresh = !fs.existsSync(path.join(dataDir, 'PG_VERSION'));
    const { default: EmbeddedPostgres } = await import(require('url').pathToFileURL(require.resolve('embedded-postgres', { paths: [API] })).href);
    pg = new EmbeddedPostgres({ databaseDir: dataDir, user: 'postgres', password: 'local', port: PG_PORT, persistent: true, onLog: () => {} });
    if (fresh) await pg.initialise();
    await pg.start();
    if (fresh) await pg.createDatabase('opsconsole');
    const applied = await dist('migrate').migrate();
    if (applied.length) console.log('migrations applied:', applied.join(', '));

    const q = (sql, args) => dist('db').db().query(sql, args);
    const credFile = path.join(STATE, 'credentials.txt');
    if (!fs.existsSync(credFile)) {
        const pw = () => crypto.randomBytes(9).toString('base64url');
        const users = [['admin', 'admin', pw()], ['deployer', 'deployer', pw()], ['viewer', 'viewer', pw()]];
        for (const [u, role, p] of users) {
            await q(`INSERT INTO users (username, role, password_hash, display_name) SELECT $1, $2, $3, $4 WHERE NOT EXISTS (SELECT 1 FROM users WHERE username = $1)`,
                [u, role, await dist('password').hashPassword(p), `Local ${role}`]);
        }
        await q(`INSERT INTO users (username, role, is_demo, display_name) SELECT 'demo', 'viewer', true, 'Demo visitor' WHERE NOT EXISTS (SELECT 1 FROM users WHERE username = 'demo')`);
        fs.writeFileSync(credFile, users.map(([u, , p]) => `${u.padEnd(9)} ${p}`).join('\n') + '\n', { mode: 0o600 });
    }

    // Register every instance tagged ops-console=managed, in every enabled region (read-only AWS calls with your CLI credentials).
    try {
        const { execFile } = require('child_process');
        const run = (args) => new Promise((res, rej) => execFile('aws', args, { encoding: 'utf8' }, (e, out) => (e ? rej(e) : res(JSON.parse(out || '[]')))));
        const regions = process.env.OPS_LOCAL_REGIONS ? process.env.OPS_LOCAL_REGIONS.split(/[ ,]+/)
            : await run(['ec2', 'describe-regions', '--region', REGION, '--query', 'Regions[].RegionName', '--output', 'json']);
        const found = (await Promise.all(regions.map((r) => run(['ec2', 'describe-instances', '--region', r, '--filters', 'Name=tag:ops-console,Values=managed',
            'Name=instance-state-name,Values=pending,running,stopping,stopped',
            '--query', 'Reservations[].Instances[].{id:InstanceId,name:Tags[?Key==`Name`]|[0].Value}', '--output', 'json'])
            .then((xs) => xs.map((x) => ({ ...x, region: r }))).catch(() => [])))).flat();
        for (const i of found) {
            await q(`INSERT INTO instances (name, aws_instance_id, region, environment) VALUES ($1, $2, $3, 'production') ON CONFLICT (aws_instance_id) DO NOTHING`,
                [i.name || i.id, i.id, i.region]);
        }
        console.log(`instances: ${found.map((i) => `${i.name || i.id} (${i.region})`).join(', ') || 'none tagged ops-console=managed'}`);
    } catch (err) {
        console.warn('could not list EC2 instances (aws CLI credentials?):', String(err.message).split('\n')[0]);
    }
    await dist('db').closeDb();
    console.log('READY');
    const stop = async () => { await pg.stop(); process.exit(0); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    setInterval(() => {}, 1 << 30);
})().catch(async (err) => {
    console.error('bootstrap failed:', err instanceof Error ? err.message : err);
    if (pg) await pg.stop().catch(() => undefined);   // never leave an orphaned database behind
    process.exit(1);
});
