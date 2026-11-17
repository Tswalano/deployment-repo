/**
 * Phase 11: server access.
 *  - Temporary SSH: open port 22 for one address on the instance's security group (tagged ops-console=managed),
 *    closed again automatically when it expires. Rules the console didn't open are shown but never touched.
 *  - Authorized keys: add / remove one public key of a login user (OpsConsole-SshKeys; never root).
 *  - Security snapshot: keys, SSH logins and failed attempts, sshd settings, OS updates (OpsConsole-Security),
 *    cached per instance and refreshed on demand.
 */
import { get as httpsGet } from 'https';
import { isIP } from 'net';
import { gunzipSync } from 'zlib';
import { aws, dryRun, SecurityGroupAccess } from './aws';
import { InstanceRow } from './collector';
import { db } from './db';
import { DeployError } from './deploys';

export const SECURITY_DOCUMENT = 'OpsConsole-Security';
export const KEYS_DOCUMENT = 'OpsConsole-SshKeys';
export const GRANT_HOURS = [0.5, 1, 2, 4, 8];
export const KEY_RE = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/]{40,2000}={0,3}( [A-Za-z0-9@._+-]{1,100})?$/;
export const FP_RE = /^SHA256:[A-Za-z0-9+/]{43}$/;
export const LOGIN_USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;

export interface GrantRow {
    id: number; instance_id: number; group_id: string; cidr: string; reason: string | null; granted_by: string;
    granted_at: string; expires_at: string; revoked_at: string | null; revoked_by: string | null; error: string | null;
}
export const grantView = (g: GrantRow) => ({
    id: g.id, groupId: g.group_id, cidr: g.cidr, reason: g.reason, grantedBy: g.granted_by, grantedAt: g.granted_at,
    expiresAt: g.expires_at, revokedAt: g.revoked_at, revokedBy: g.revoked_by, error: g.error,
});

// ---------------------------------------------------------------------------------------------- addresses

const v4 = (ip: string) => ip.split('.').map(Number);
/** Loopback, private, link-local, CGNAT, multicast, unspecified: never something to open a public port to. */
export function isPrivateIp(ip: string): boolean {
    if (isIP(ip) === 4) {
        const [a, b] = v4(ip);
        return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
    }
    const x = ip.toLowerCase();
    if (x.startsWith('::ffff:')) return isPrivateIp(x.slice(7));
    return x === '::' || x === '::1' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80') || x.startsWith('ff');
}

/** One public address as a single-host CIDR (/32 or /128); nothing wider is ever opened. */
export function hostCidr(input: string): string {
    const raw = input.trim().replace(/\/(32|128)$/, '');
    const fam = isIP(raw);
    if (!fam) throw new DeployError('Enter one IP address (for example 203.0.113.7).');
    const ip = raw.toLowerCase().startsWith('::ffff:') && isIP(raw.slice(7)) === 4 ? raw.slice(7) : raw;
    if (isPrivateIp(ip)) throw new DeployError(`${ip} is a private or local address: SSH rules need your public IP.`);
    return isIP(ip) === 4 ? `${ip}/32` : `${ip.toLowerCase()}/128`;
}

/** The address a person connects from. Locally (loopback), ask AWS what our public IP is. */
export async function detectPublicIp(seen: string | null): Promise<string | null> {
    const ip = seen?.toLowerCase().startsWith('::ffff:') ? seen.slice(7) : seen;
    if (ip && isIP(ip) && !isPrivateIp(ip)) return ip;
    if (!dryRun) return null;
    // IPv4 on purpose: fetch prefers IPv6, which hangs on machines without an IPv6 route (e.g. WSL)
    return new Promise((res) => {
        const req = httpsGet('https://checkip.amazonaws.com', { family: 4, timeout: 3000 }, (r) => {
            let t = '';
            r.on('data', (d) => { t += d; });
            r.on('end', () => res(isIP(t.trim()) ? t.trim() : null));
        });
        req.on('timeout', () => req.destroy());
        req.on('error', () => res(null));
    });
}

// ---------------------------------------------------------------------------------------------- SSH grants

const describe = (user: string, until: Date) =>
    `ops-console temp ${user.replace(/[^A-Za-z0-9._@-]/g, '').slice(0, 40)} until ${until.toISOString().slice(0, 16).replace('T', ' ')}Z`;

export async function sshAccess(inst: InstanceRow) {
    const groups: SecurityGroupAccess[] = aws().sshAccess ? await aws().sshAccess!(inst.region, inst.aws_instance_id) : [];
    const { rows: grants } = await db().query<GrantRow>(
        `SELECT * FROM ssh_grants WHERE instance_id = $1 AND (revoked_at IS NULL OR revoked_at > now() - interval '7 days')
          ORDER BY revoked_at IS NULL DESC, granted_at DESC LIMIT 30`, [inst.id]);
    const open = grants.filter((g) => !g.revoked_at);
    return {
        groups: groups.map((g) => ({
            ...g,
            rules: g.rules.map((r) => {
                const grant = open.find((x) => x.group_id === g.groupId && x.cidr === r.cidr);
                return { ...r, grantId: grant?.id ?? null, expiresAt: grant?.expires_at ?? null, temporary: !!grant };
            }),
        })),
        target: groups.find((g) => g.managedTag)?.groupId ?? null,
        grants: grants.map(grantView),
        simulated: dryRun,
    };
}

export async function grantSsh(inst: InstanceRow, user: string, cidr: string, hours: number, reason: string | null): Promise<GrantRow> {
    if (!GRANT_HOURS.includes(hours)) throw new DeployError(`Choose a duration of ${GRANT_HOURS.join(', ')} hours.`);
    if (!aws().sshAccess || !aws().authorizeSsh) throw new DeployError('SSH access changes are not available.', 409);
    const groups = await aws().sshAccess!(inst.region, inst.aws_instance_id);
    const target = groups.find((g) => g.managedTag);
    if (!target) {
        throw new DeployError(`None of ${inst.name}'s security groups (${groups.map((g) => g.groupId).join(', ') || 'none'}) is tagged ops-console=managed, so the console may not open SSH on them. Run infra/ops-console-access/tag-security-groups.sh ${inst.region}.`, 409, 'untagged_group');
    }
    const until = new Date(Date.now() + hours * 3600_000);
    const { rows: [existing] } = await db().query<GrantRow>(
        'SELECT * FROM ssh_grants WHERE instance_id = $1 AND group_id = $2 AND cidr = $3 AND revoked_at IS NULL', [inst.id, target.groupId, cidr]);
    if (existing) {
        // same address again: extend (never shorten) the open grant, no second rule
        const { rows: [g] } = await db().query<GrantRow>(
            'UPDATE ssh_grants SET expires_at = greatest(expires_at, $2), reason = coalesce($3, reason) WHERE id = $1 RETURNING *', [existing.id, until, reason]);
        return g;
    }
    if (target.rules.some((r) => r.cidr === cidr)) {
        throw new DeployError(`${cidr.replace(/\/(32|128)$/, '')} already has SSH access on ${target.groupId} through a rule the console didn't create, so there is nothing to open (and the console won't close that rule).`, 409, 'already_allowed');
    }
    await aws().authorizeSsh!(inst.region, target.groupId, cidr, describe(user, until));
    const { rows: [g] } = await db().query<GrantRow>(
        `INSERT INTO ssh_grants (instance_id, group_id, cidr, reason, granted_by, expires_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [inst.id, target.groupId, cidr, reason, user, until]);
    return g;
}

export async function revokeGrant(inst: InstanceRow, grantId: number, by: string): Promise<GrantRow> {
    const { rows: [g] } = await db().query<GrantRow>('SELECT * FROM ssh_grants WHERE id = $1 AND instance_id = $2', [grantId, inst.id]);
    if (!g) throw new DeployError('Grant not found.', 404);
    if (g.revoked_at) return g;
    await aws().revokeSsh!(inst.region, g.group_id, g.cidr);
    const { rows: [r] } = await db().query<GrantRow>('UPDATE ssh_grants SET revoked_at = now(), revoked_by = $2, error = NULL WHERE id = $1 RETURNING *', [g.id, by]);
    return r;
}

/** Poller: close every grant whose time is up. A failure is kept on the row and retried next minute. */
export async function expireSshGrants(): Promise<number> {
    const { rows } = await db().query<GrantRow & { region: string }>(
        `SELECT g.*, i.region FROM ssh_grants g JOIN instances i ON i.id = g.instance_id WHERE g.revoked_at IS NULL AND g.expires_at <= now()`);
    let closed = 0;
    for (const g of rows) {
        try {
            await aws().revokeSsh!(g.region, g.group_id, g.cidr);
            await db().query(`UPDATE ssh_grants SET revoked_at = now(), revoked_by = 'expired', error = NULL WHERE id = $1`, [g.id]);
            closed++;
        } catch (err) {
            await db().query('UPDATE ssh_grants SET error = $2 WHERE id = $1', [g.id, (err as Error).message.slice(0, 300)]);
        }
    }
    return closed;
}

// ---------------------------------------------------------------------------------------------- snapshot + keys

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function securitySnapshot(inst: InstanceRow): Promise<{ at: string; data: any } | null> {
    const { rows } = await db().query<{ at: string; data: any }>('SELECT at, data FROM security_snapshots WHERE instance_id = $1', [inst.id]);
    return rows[0] ?? null;
}

export async function refreshSecurity(inst: InstanceRow): Promise<{ at: string; data: any }> {
    const out = await aws().runDocument(inst.region, inst.aws_instance_id, SECURITY_DOCUMENT, {}, 170_000).catch((err) => {
        const m = (err as Error).message;
        if (/InvalidDocument|document/i.test(m) && /not found|InvalidDocument|does not exist/i.test(m)) {
            throw new DeployError(`The ${SECURITY_DOCUMENT} document isn't installed in ${inst.region} yet (run infra/ops-console-ssm/deploy.sh ${inst.region}).`, 409);
        }
        throw new DeployError(m.slice(0, 300));
    });
    let data: any;
    try { data = JSON.parse(gunzipSync(Buffer.from(out.trim(), 'base64')).toString('utf8')); } catch { throw new DeployError('The security snapshot could not be read.'); }
    const { rows: [r] } = await db().query<{ at: string; data: any }>(
        `INSERT INTO security_snapshots (instance_id, at, data) VALUES ($1, now(), $2)
         ON CONFLICT (instance_id) DO UPDATE SET at = now(), data = EXCLUDED.data RETURNING at, data`, [inst.id, JSON.stringify(data)]);
    return r;
}

export async function changeKey(inst: InstanceRow, action: 'add' | 'remove', user: string, value: string): Promise<{ fingerprint: string | null; keys?: number; dryRun?: boolean }> {
    if (!LOGIN_USER_RE.test(user) || user === 'root') throw new DeployError('Choose a login user (not root).');
    if (action === 'add' && !KEY_RE.test(value)) throw new DeployError('Paste one OpenSSH public key line, for example "ssh-ed25519 AAAA… you@laptop" (the .pub file, never the private key).');
    if (action === 'remove' && !FP_RE.test(value)) throw new DeployError('Invalid key fingerprint.');
    const out = await aws().runDocument(inst.region, inst.aws_instance_id, KEYS_DOCUMENT,
        { action: [action], user: [user], key: [action === 'add' ? value : ''], fingerprint: [action === 'remove' ? value : ''] }, 60_000)
        .catch((err) => {
            // the script exits 1 with its JSON answer when it refuses (e.g. last key): show that answer
            const m = (err as Error).message, j = m.match(/\{.*\}/s);
            try { const r = j ? JSON.parse(j[0]) : null; if (r?.error) throw new DeployError(r.error, 409); } catch (e) { if (e instanceof DeployError) throw e; }
            throw new DeployError(m.slice(0, 300));
        });
    const line = out.trim().split('\n').filter(Boolean).pop() ?? '{}';
    let r: any;
    try { r = JSON.parse(line); } catch { throw new DeployError(out.slice(0, 200) || 'No answer from the instance.'); }
    if (!r.ok) throw new DeployError(r.error ?? 'The key change failed.', 409);
    return { fingerprint: r.fingerprint ?? null, keys: r.keys, dryRun: r.dryRun };
}
