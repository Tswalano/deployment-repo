/**
 * Phase 12b: a workspace's own AWS account (multi-customer mode).
 *
 * The customer creates a role in their account with our CloudFormation template. The role trusts ONLY the console's
 * own AWS identity and ONLY when the workspace's external ID is presented, so another customer (or anyone who learns
 * the role ARN) can't make the console use it. Every AWS call for the workspace then runs on short-lived credentials
 * from that role; the console host's own role is never used for a customer.
 */
import { randomBytes } from 'crypto';
import { AssumeRoleCommand, GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import type { AwsCredentialIdentity, AwsCredentialIdentityProvider } from '@smithy/types';
import { AwsProvider, dryRun, makeAws } from './aws';
import { config } from './config';
import { currentWorkspace, db } from './db';
import { DeployError } from './deploys';

export interface ConnectionRow {
    workspace_id: number; external_id: string; region: string; role_arn: string | null; account_id: string | null;
    status: 'pending' | 'connected' | 'error' | 'disconnected'; error: string | null; connected_by: string | null;
    connected_at: string | null; checked_at: string | null;
}
export const ROLE_ARN_RE = /^arn:aws:iam::(\d{12}):role\/[A-Za-z0-9+=,.@_\/-]{1,128}$/;
export const REGION_RE = /^[a-z]{2}(-gov)?-[a-z]+-\d$/;
export const STACK_NAME = 'OpsConsoleAccess';

export const connectionView = (c: ConnectionRow | null) => c && ({
    region: c.region, roleArn: c.role_arn, accountId: c.account_id, status: c.status, error: c.error,
    connectedBy: c.connected_by, connectedAt: c.connected_at, checkedAt: c.checked_at, externalId: c.external_id,
});

export async function connection(): Promise<ConnectionRow | null> {
    const { rows } = await db().query<ConnectionRow>('SELECT * FROM aws_connections WHERE workspace_id = current_workspace()');
    return rows[0] ?? null;
}

/** The workspace's connection record, created (pending, with a fresh external ID) on first use. */
export async function ensureConnection(region?: string): Promise<ConnectionRow> {
    const existing = await connection();
    if (existing) {
        if (region && REGION_RE.test(region) && existing.status !== 'connected' && region !== existing.region) {
            const { rows: [r] } = await db().query<ConnectionRow>('UPDATE aws_connections SET region = $1 WHERE workspace_id = current_workspace() RETURNING *', [region]);
            return r;
        }
        return existing;
    }
    const ext = `oc-${randomBytes(20).toString('hex')}`;
    const { rows: [r] } = await db().query<ConnectionRow>(
        'INSERT INTO aws_connections (external_id, region) VALUES ($1, $2) RETURNING *', [ext, region && REGION_RE.test(region) ? region : 'af-south-1']);
    return r;
}

// ---------------------------------------------------------------------------------------------- assuming the role

/** How the console assumes a customer role (swappable in tests). Uses the console host's own credentials. */
export type Assumer = (roleArn: string, externalId: string, region: string) => Promise<AwsCredentialIdentity & { accountId: string }>;
let assumer: Assumer = async (roleArn, externalId, region) => {
    const sts = new STSClient({ region });
    const r = await sts.send(new AssumeRoleCommand({ RoleArn: roleArn, ExternalId: externalId, RoleSessionName: `ops-console-${currentWorkspace() ?? 'x'}`, DurationSeconds: 3600 }))
        .catch((err) => { throw new Error(assumeError(err)); });
    const c = r.Credentials!;
    const creds = { accessKeyId: c.AccessKeyId!, secretAccessKey: c.SecretAccessKey!, sessionToken: c.SessionToken!, expiration: c.Expiration };
    const who = await new STSClient({ region, credentials: creds }).send(new GetCallerIdentityCommand({}));
    return { ...creds, accountId: who.Account! };
};
export function setAssumer(a: Assumer): void { assumer = a; providers.clear(); }

function assumeError(err: unknown): string {
    const name = (err as { name?: string }).name;
    if (name === 'AccessDenied' || name === 'AccessDeniedException') {
        return "AWS refused: the role doesn't exist, doesn't trust this console, or the external ID doesn't match. Use the role created by the template for THIS workspace.";
    }
    return (err as Error).message.slice(0, 300);
}

/** Workspace → provider on that workspace's role (credentials refreshed before they expire). */
type Factory = (conn: ConnectionRow, credentials: AwsCredentialIdentityProvider) => AwsProvider;
let factory: Factory = (_conn, credentials) => makeAws(credentials, dryRun);
export function setWorkspaceProviderFactory(f: Factory): void { factory = f; providers.clear(); }
const providers = new Map<number, { key: string; provider: AwsProvider }>();

function credentialsFor(conn: ConnectionRow): AwsCredentialIdentityProvider {
    let cached: (AwsCredentialIdentity & { accountId: string }) | null = null;
    return async () => {
        const exp = cached?.expiration ? new Date(cached.expiration).getTime() : 0;
        if (!cached || exp - Date.now() < 5 * 60_000) cached = await assumer(conn.role_arn!, conn.external_id, conn.region);
        return cached;
    };
}

/** The provider for the current workspace, or null when it has no connected AWS account. */
export async function workspaceProvider(): Promise<AwsProvider | null> {
    const ws = currentWorkspace();
    if (ws == null) return null;
    const conn = await connection();
    if (!conn || conn.status !== 'connected' || !conn.role_arn) { providers.delete(ws); return null; }
    const key = `${conn.role_arn}|${conn.external_id}|${conn.region}`;
    const hit = providers.get(ws);
    if (hit && hit.key === key) return hit.provider;
    const provider = factory(conn, credentialsFor(conn));
    providers.set(ws, { key, provider });
    return provider;
}

// ---------------------------------------------------------------------------------------------- connect / verify

/** Check a role ARN works for this workspace (assume it with the external ID, find our documents) and save it. */
export async function verifyConnection(roleArnInput: unknown, by: string): Promise<ConnectionRow> {
    const roleArn = String(roleArnInput ?? '').trim();
    const m = ROLE_ARN_RE.exec(roleArn);
    if (!m) throw new DeployError('Paste the role ARN from the stack\'s Outputs tab (it looks like arn:aws:iam::123456789012:role/OpsConsoleAccess-…).');
    const conn = await ensureConnection();
    let accountId: string;
    try {
        const creds = await assumer(roleArn, conn.external_id, conn.region);
        accountId = creds.accountId;
        const p = factory({ ...conn, role_arn: roleArn }, async () => creds);
        if (p.documentsReady && !(await p.documentsReady(conn.region))) {
            throw new Error(`The role works, but our documents aren't in ${conn.region}: was the stack created in ${conn.region}?`);
        }
    } catch (err) {
        const msg = (err as Error).message.slice(0, 300);
        await db().query(`UPDATE aws_connections SET status = CASE WHEN status = 'connected' THEN status ELSE 'error' END, error = $1, checked_at = now() WHERE workspace_id = current_workspace()`, [msg]);
        throw new DeployError(msg, 409);
    }
    if (accountId !== m[1]) throw new DeployError('The role answered from a different AWS account than its ARN says.', 409);
    const { rows: [r] } = await db().query<ConnectionRow>(
        `UPDATE aws_connections SET role_arn = $1, account_id = $2, status = 'connected', error = NULL, connected_by = $3, connected_at = now(), checked_at = now()
          WHERE workspace_id = current_workspace() RETURNING *`, [roleArn, accountId, by]);
    providers.delete(r.workspace_id);
    return r;
}

/** Stop using the account (the customer deletes the stack in their AWS console to remove our access entirely). */
export async function disconnect(): Promise<void> {
    const ws = currentWorkspace();
    // a fresh external ID: an old role can't be reconnected by accident
    await db().query(`UPDATE aws_connections SET status = 'disconnected', role_arn = NULL, error = NULL, external_id = $1 WHERE workspace_id = current_workspace()`,
        [`oc-${randomBytes(20).toString('hex')}`]);
    if (ws != null) providers.delete(ws);
}

/** The console's own AWS identity, which customer roles must trust (from the host's credentials). */
let hostArn: string | null = null;
export async function consolePrincipal(): Promise<string> {
    if (config.consolePrincipalArn) return config.consolePrincipalArn;
    if (hostArn) return hostArn;
    const who = await new STSClient({ region: 'us-east-1' }).send(new GetCallerIdentityCommand({}));
    // an assumed-role session ARN → the role ARN (what a trust policy names)
    const m = /^arn:aws:sts::(\d{12}):assumed-role\/([^/]+)\//.exec(who.Arn ?? '');
    hostArn = m ? `arn:aws:iam::${m[1]}:role/${m[2]}` : who.Arn!;
    return hostArn;
}
