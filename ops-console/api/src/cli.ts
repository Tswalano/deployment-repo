/**
 * Admin CLI (run on the server).
 *   node dist/cli.js migrate
 *   node dist/cli.js set-admin <username>        # creates or resets an admin; password read from stdin
 *   node dist/cli.js ensure-demo                 # creates/enables the read-only demo viewer
 *   node dist/cli.js set-email <username> <email> # owner tool: set a user's sign-in email (confirmed again by them)
 *   node dist/cli.js cutover-check | cutover-prepare [region] | cutover-connect <roleArn>   # docs/saas-cutover.md
 *   node dist/cli.js platform-admin <username> on|off   # who may open the platform owner portal (never granted by invitations)
 */
import { audit } from './audit';
import { cutoverCheck, cutoverConnect, cutoverPrepare, setEmail } from './cutover';
import { asSystem, closeDb, db } from './db';
import { migrate } from './migrate';
import { hashPassword, passwordProblem } from './password';
import { destroyUserSessions } from './sessions';

async function readStdin(): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

async function main() {
    const [cmd, arg] = process.argv.slice(2);
    const arg2 = process.argv[4];
    if (cmd === 'cutover-check') { await migrate(); await cutoverCheck(); }
    else if (cmd === 'cutover-prepare') { await migrate(); await cutoverPrepare(arg || undefined); }
    else if (cmd === 'cutover-connect') {
        if (!arg) throw new Error('usage: cutover-connect <roleArn>');
        await migrate(); await cutoverConnect(arg);
    } else if (cmd === 'set-email') {
        if (!arg || !arg2) throw new Error('usage: set-email <username> <email>');
        await migrate(); await setEmail(arg, arg2);
    } else if (cmd === 'platform-admin') {
        if (!arg || (arg2 !== 'on' && arg2 !== 'off')) throw new Error('usage: platform-admin <username> on|off');
        await migrate();
        const { rowCount } = await db().query('UPDATE users SET platform_admin = $2 WHERE lower(username) = lower($1) AND NOT is_demo', [arg, arg2 === 'on']);
        if (!rowCount) throw new Error(`no user ${arg}`);
        await asSystem(() => audit(null, arg2 === 'on' ? 'platform.admin_grant' : 'platform.admin_revoke', arg, { via: 'cli' }, null));
        console.log(`${arg}: platform admin ${arg2}`);
    } else if (cmd === 'migrate') {
        const applied = await migrate();
        console.log(applied.length ? `applied: ${applied.join(', ')}` : 'up to date');
    } else if (cmd === 'set-admin') {
        if (!arg || !/^[A-Za-z0-9._-]{3,32}$/.test(arg)) throw new Error('usage: set-admin <username>  (password on stdin)');
        const password = await readStdin();
        const problem = passwordProblem(password);
        if (problem) throw new Error(problem);
        await migrate();
        const hash = await hashPassword(password);
        const { rows } = await db().query(
            `INSERT INTO users (username, display_name, role, password_hash, password_changed_at)
             VALUES ($1, $1, 'admin', $2, now())
             ON CONFLICT (lower(username)) DO UPDATE
               SET role = 'admin', password_hash = EXCLUDED.password_hash, disabled = false,
                   failed_logins = 0, locked_until = NULL, password_changed_at = now()
             RETURNING id, (xmax = 0) AS created`, [arg, hash]);
        await destroyUserSessions(rows[0].id);
        // the CLI acts outside any workspace: its audit entries are written as the system (row-level security)
        await asSystem(() => audit({ id: null, username: 'cli' }, rows[0].created ? 'user.create' : 'user.password_reset', arg, { role: 'admin', via: 'cli' }, null));
        console.log(`${rows[0].created ? 'created' : 'reset'} admin '${arg}'`);
    } else if (cmd === 'ensure-demo') {
        await migrate();
        await db().query(
            `INSERT INTO users (username, display_name, role, is_demo) VALUES ('demo', 'Demo visitor', 'viewer', true)
             ON CONFLICT (is_demo) WHERE is_demo DO UPDATE SET role = 'viewer', disabled = false`);
        console.log('demo viewer ready');
    } else {
        throw new Error('commands: migrate | set-admin <username> | ensure-demo');
    }
}

main().then(() => closeDb()).catch(async (err) => {
    console.error(err.message);
    await closeDb();
    process.exit(1);
});
