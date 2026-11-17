/**
 * Moving the single-team console to multi-company mode (docs/saas-cutover.md). Everything here works on workspace 1
 * (the original console's data) and runs BEFORE OPS_MULTI_TENANT is switched on, so the console is already connected
 * when the switch happens: no window where it can't reach your servers.
 */
import { cleanEmail } from './accounts';
import { hostAws } from './aws';
import { config } from './config';
import { connection, consolePrincipal, ensureConnection, STACK_NAME, verifyConnection } from './connections';
import { db, withWorkspace } from './db';
import { githubConfig, installations } from './github';
import { APPS_DOMAIN } from './newapp';

const WS = 1;
const line = (ok: boolean | null, text: string) => console.log(`${ok === null ? '·' : ok ? '✔' : '✘'} ${text}`);

export async function cutoverCheck(): Promise<void> {
    await withWorkspace(WS, async () => {
        console.log(`mode: ${config.multiTenant ? 'MULTI-COMPANY (switched)' : 'single-team (not switched yet)'}\n`);
        const { rows: [w] } = await db().query('SELECT name, plan FROM workspaces WHERE id = $1', [WS]);
        line(w?.plan === 'internal', `workspace 1 "${w?.name}" is the platform's own (plan ${w?.plan}; never billed)`);
        const { rows: users } = await db().query<{ username: string; email: string | null; role: string; is_demo: boolean }>(
            'SELECT u.username, u.email, m.role, u.is_demo FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 ORDER BY u.username', [WS]);
        for (const u of users.filter((x) => !x.is_demo)) line(u.email ? true : null, `${u.username} (${u.role})${u.email ? ` has an email` : ': no email yet (can still sign in with the username; add one under Account)'}`);
        if (users.some((x) => x.is_demo)) line(null, 'the demo account stops working in multi-company mode (demo sign-in is off there)');
        const c = await connection();
        line(c?.status === 'connected', c?.status === 'connected' ? `AWS connected: account ${c.account_id}, ${c.role_arn}` : `AWS not connected yet (run cutover-prepare, create the stack, then cutover-connect)`);
        const gh = await db().query('SELECT installation_id, account_login FROM github_installations');
        line(gh.rows.length > 0 || !(await githubConfig()), gh.rows.length ? `GitHub installations linked: ${gh.rows.map((r) => r.account_login).join(', ')}` : (await githubConfig()) ? 'GitHub installations not linked yet (cutover-connect does it)' : 'GitHub not connected (nothing to link)');
        const { rows: [d] } = await db().query("SELECT value FROM settings WHERE key = 'apps_domain'");
        line(!!d, d ? `apps domain: ${d.value.domain}` : `apps domain not set yet (cutover-connect sets ${APPS_DOMAIN})`);
    });
}

export async function cutoverPrepare(region = 'af-south-1'): Promise<void> {
    await withWorkspace(WS, async () => {
        const c = await ensureConnection(region);
        const principal = await consolePrincipal();
        console.log(`External ID (workspace 1): ${c.external_id}
Console identity:           ${principal}
Region:                     ${c.region}

Create the access stack in YOUR account (the documents already exist there, so InstallDocuments=no):

  aws cloudformation create-stack --region ${c.region} --stack-name ${STACK_NAME} \\
    --template-body file://ops-console/api/assets/connect-aws.json --capabilities CAPABILITY_NAMED_IAM \\
    --parameters ParameterKey=ExternalId,ParameterValue=${c.external_id} \\
                 ParameterKey=ConsolePrincipal,ParameterValue=${principal} \\
                 ParameterKey=InstallDocuments,ParameterValue=no

(The template is over CloudFormation's 51 KB inline limit: add --template-url with the published copy, or
 upload the file in the CloudFormation console.) Then: node dist/cli.js cutover-connect <RoleArn from the stack's Outputs>`);
    });
}

export async function cutoverConnect(roleArn: string): Promise<void> {
    await withWorkspace(WS, async () => {
        const c = await verifyConnection(roleArn, 'cutover');
        line(true, `AWS connected: account ${c.account_id} through ${c.role_arn}`);
        const cfg = await githubConfig();
        if (cfg) {
            // the app's installations all belong to the original console's owner: link them to workspace 1
            for (const i of await installations(cfg)) {
                await db().query(`INSERT INTO github_installations (installation_id, account_login, linked_by) VALUES ($1, $2, 'cutover')
                                  ON CONFLICT (workspace_id, installation_id) DO NOTHING`, [i.id, i.account]);
                line(true, `GitHub installation linked: ${i.account} (#${i.id})`);
            }
        }
        const zoneId = process.env.APPS_HOSTED_ZONE_ID || (await hostAws().hostedZoneId?.(APPS_DOMAIN)) || null;
        if (zoneId) {
            await db().query(`INSERT INTO settings (key, value, updated_by) VALUES ('apps_domain', $1, 'cutover')
                              ON CONFLICT (workspace_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [JSON.stringify({ domain: APPS_DOMAIN, zoneId })]);
            line(true, `apps domain: ${APPS_DOMAIN} (${zoneId})`);
        } else line(false, `no Route 53 zone found for ${APPS_DOMAIN}: set the apps domain in Settings after the switch`);
    });
}

/** Owner tool: set (or correct) a user's sign-in email. The new address must be confirmed again. */
export async function setEmail(username: string, emailInput: string): Promise<void> {
    const email = cleanEmail(emailInput);
    const taken = await db().query('SELECT 1 FROM users WHERE (lower(email) = $1 OR lower(username) = $1) AND lower(username) <> lower($2)', [email, username]);
    if (taken.rows.length) throw new Error('another account already uses that email');
    const { rowCount } = await db().query('UPDATE users SET email = $2, email_verified_at = NULL WHERE lower(username) = lower($1)', [username, email]);
    if (!rowCount) throw new Error(`no user ${username}`);
    console.log(`email set for ${username} (to be confirmed by them)`);
}
