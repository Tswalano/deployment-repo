// Set a local test login's password (the local server must be running): node dev/set-password.cjs <username>
// Reads the new password from stdin (no echo when run through local.sh --password).
const path = require('path');
const API = path.join(__dirname, '..', 'api');
process.env.DATABASE_URL = `postgresql://postgres:local@127.0.0.1:${process.env.OPS_LOCAL_PG_PORT || 55432}/opsconsole`;
const dist = (m) => require(path.join(API, 'dist', m));
const user = process.argv[2];
let input = '';
process.stdin.on('data', (d) => (input += d)).on('end', async () => {
    const pw = input.replace(/\r?\n$/, '');
    if (pw.length < 8) { console.error('✘ at least 8 characters'); process.exit(1); }
    const r = await dist('db').db().query(
        'UPDATE users SET password_hash = $2, failed_logins = 0, locked_until = NULL WHERE username = $1 AND NOT is_demo RETURNING username',
        [user, await dist('password').hashPassword(pw)]);
    await dist('db').closeDb();
    if (!r.rowCount) { console.error(`✘ no local user "${user}" (admin, deployer, viewer)`); process.exit(1); }
    console.log(`✔ password set for local user "${user}" (lockout cleared)`);
});
