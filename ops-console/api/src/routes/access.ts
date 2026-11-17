import { Context, Hono } from 'hono';
import { audit } from '../audit';
import { announce } from '../alerts';
import { changeKey, detectPublicIp, GRANT_HOURS, grantSsh, grantView, hostCidr, laptopAccess, refreshSecurity, revokeGrant, saveUserKey, securitySnapshot, sshAccess, userKeys, userKeyView } from '../access';
import { aws, dryRun } from '../aws';
import { InstanceRow } from '../collector';
import { db } from '../db';
import { DeployError } from '../deploys';
import { denyDemo, Env, rateLimit, requireRole } from '../middleware';
import { activeTerminals } from '../terminal';

// Guards are per route: a router-wide use('*') would also apply to every other /api/instances/* path.
const access = new Hono<Env>();
const read = [requireRole('deployer'), denyDemo] as const;
const write = [requireRole('admin'), denyDemo] as const;

const fail = (c: Context<Env>, err: unknown) => err instanceof DeployError
    ? c.json({ error: err.message, code: err.code }, err.status)
    : c.json({ error: `AWS: ${(err as Error).message.slice(0, 200)}` }, 502);

async function instance(c: Context<Env>): Promise<InstanceRow | null> {
    const { rows } = await db().query<InstanceRow>('SELECT * FROM instances WHERE id = $1', [Number(c.req.param('id'))]);
    return rows[0] ?? null;
}
const actor = (c: Context<Env>) => ({ id: c.get('user')!.id, username: c.get('user')!.username });

// ------------------------------------------------------------------ security snapshot (keys, logins, updates)
access.get('/:id/security', ...read, async (c) => {
    const inst = await instance(c);
    if (!inst) return c.json({ error: 'Instance not found' }, 404);
    const snap = await securitySnapshot(inst);
    const { rows: sessions } = await db().query(
        `SELECT id, username, ip, simulated, started_at AS "startedAt", ended_at AS "endedAt", end_reason AS "endReason"
           FROM terminal_sessions WHERE instance_id = $1 ORDER BY started_at DESC LIMIT 20`, [inst.id]);
    return c.json({ at: snap?.at ?? null, snapshot: snap?.data ?? null, terminalSessions: sessions, activeTerminals: activeTerminals(inst.id) });
});

access.post('/:id/security/refresh', ...read, rateLimit(6, 60_000, (c) => `secrefresh:${c.req.param('id')}`), async (c) => {
    const inst = await instance(c);
    if (!inst) return c.json({ error: 'Instance not found' }, 404);
    if (inst.ec2_state && inst.ec2_state !== 'running') return c.json({ error: `${inst.name} is ${inst.ec2_state}.` }, 409);
    try {
        const r = await refreshSecurity(inst);
        return c.json({ at: r.at, snapshot: r.data });
    } catch (err) { return fail(c, err); }
});

// ------------------------------------------------------------------ authorized keys
access.post('/:id/ssh-keys', ...write, rateLimit(20, 10 * 60_000, (c) => `keys:${c.get('user')!.id}`), async (c) => {
    const inst = await instance(c);
    if (!inst) return c.json({ error: 'Instance not found' }, 404);
    const b = await c.req.json().catch(() => ({}));
    const action = b.action === 'remove' ? 'remove' : b.action === 'add' ? 'add' : null;
    if (!action) return c.json({ error: 'Unknown action.' }, 400);
    const user = String(b.user ?? '');
    const value = String(action === 'add' ? b.key ?? '' : b.fingerprint ?? '').trim().replace(/\s+/g, ' ');
    try {
        const r = await changeKey(inst, action, user, value);
        await audit(actor(c), `ssh.key.${action}`, `${inst.name} (${user})`, { fingerprint: r.fingerprint, dryRun: r.dryRun || undefined }, c.get('ip'));
        await announce(`[ACCESS] SSH key ${action === 'add' ? 'added for' : 'removed from'} ${user} on ${inst.name}${r.dryRun ? ' (dry run)' : ''}`,
            `${c.get('user')!.username} ${action === 'add' ? 'added' : 'removed'} the key ${r.fingerprint ?? ''} ${action === 'add' ? 'for' : 'from'} ${user} on ${inst.name}.`, 'access');
        if (!r.dryRun) await refreshSecurity(inst).catch(() => undefined);
        return c.json({ ok: true, ...r });
    } catch (err) { return fail(c, err); }
});

// ------------------------------------------------------------------ temporary SSH access (security group)
access.get('/:id/ssh-access', ...read, async (c) => {
    const inst = await instance(c);
    if (!inst) return c.json({ error: 'Instance not found' }, 404);
    try {
        const r = await sshAccess(inst);
        const info = await aws().describeInstance(inst.region, inst.aws_instance_id).catch(() => null);
        const snap = await securitySnapshot(inst);
        return c.json({ ...r, yourIp: await detectPublicIp(c.get('ip')), hours: GRANT_HOURS,
            host: info?.publicIp ?? null, awsInstanceId: inst.aws_instance_id, region: inst.region, hostKeys: snap?.data?.hostKeys ?? [] });
    } catch (err) { return fail(c, err); }
});

access.post('/:id/ssh-access', ...write, rateLimit(20, 10 * 60_000, (c) => `sshgrant:${c.get('user')!.id}`), async (c) => {
    const inst = await instance(c);
    if (!inst) return c.json({ error: 'Instance not found' }, 404);
    const b = await c.req.json().catch(() => ({}));
    const user = c.get('user')!;
    try {
        const ip = String(b.ip ?? '').trim() || await detectPublicIp(c.get('ip'));
        if (!ip) return c.json({ error: "Couldn't tell your public IP address: enter it." }, 400);
        const cidr = hostCidr(ip);
        const hours = Number(b.hours ?? 2);
        const reason = String(b.reason ?? '').trim().slice(0, 200) || null;
        const g = await grantSsh(inst, user.username, cidr, hours, reason);
        await audit(actor(c), 'ssh.grant', `${inst.name} (${g.group_id})`, { cidr, hours, expiresAt: g.expires_at, reason, dryRun: dryRun || undefined }, c.get('ip'));
        await announce(`[ACCESS] SSH opened on ${inst.name} for ${cidr}${dryRun ? ' (dry run)' : ''}`,
            `${user.username} opened port 22 on ${inst.name} (${g.group_id}) for ${cidr} until ${new Date(g.expires_at).toUTCString()}${reason ? `.\n\nReason: ${reason}` : '.'}\nIt closes automatically.`, 'access');
        return c.json({ grant: grantView(g), simulated: dryRun });
    } catch (err) { return fail(c, err); }
});

access.delete('/:id/ssh-access/:grantId', ...write, async (c) => {
    const inst = await instance(c);
    if (!inst) return c.json({ error: 'Instance not found' }, 404);
    try {
        const g = await revokeGrant(inst, Number(c.req.param('grantId')), c.get('user')!.username);
        await audit(actor(c), 'ssh.revoke', `${inst.name} (${g.group_id})`, { cidr: g.cidr, dryRun: dryRun || undefined }, c.get('ip'));
        return c.json({ grant: grantView(g) });
    } catch (err) { return fail(c, err); }
});

// ------------------------------------------------------------------ SSH from your own laptop
access.post('/:id/laptop-access', ...write, rateLimit(20, 10 * 60_000, (c) => `laptop:${c.get('user')!.id}`), async (c) => {
    const inst = await instance(c);
    if (!inst) return c.json({ error: 'Instance not found' }, 404);
    const b = await c.req.json().catch(() => ({}));
    const user = c.get('user')!;
    const route = b.route === 'ssm' ? 'ssm' : b.route === 'direct' ? 'direct' : null;
    if (!route) return c.json({ error: 'Choose how to connect.' }, 400);
    try {
        const ip = route === 'direct' ? (String(b.ip ?? '').trim() || await detectPublicIp(c.get('ip'))) : null;
        if (route === 'direct' && !ip) return c.json({ error: "Couldn't tell your public IP address: enter it." }, 400);
        const reason = String(b.reason ?? '').trim().slice(0, 200) || null;
        const r = await laptopAccess(inst, { id: user.id, username: user.username }, Number(b.keyId), route, Number(b.hours ?? 2), ip, reason);
        const snap = await securitySnapshot(inst);
        await audit(actor(c), 'ssh.laptop', `${inst.name} (ec2-user)`, { route, fingerprint: r.grant.key_fingerprint, from: r.grant.key_from, expiresAt: r.grant.expires_at,
            portOpened: !!r.ipGrant, permanentKey: r.permanent || undefined, dryRun: dryRun || undefined }, c.get('ip'));
        await announce(`[ACCESS] ${user.username} can SSH into ${inst.name} from a laptop${dryRun ? ' (dry run)' : ''}`,
            `${user.username} allowed their key ${r.grant.key_fingerprint} for ec2-user on ${inst.name} ${route === 'ssm' ? 'through Session Manager (no open port)' : `from ${r.grant.key_from}`} until ${new Date(r.grant.expires_at).toUTCString()}.${reason ? `\n\nReason: ${reason}` : ''}\nThe key and any port opened for it are removed automatically.`, 'access');
        return c.json({
            grant: grantView(r.grant), ipGrant: r.ipGrant ? grantView(r.ipGrant) : null, permanent: r.permanent, ipAlreadyAllowed: r.ipAlreadyAllowed,
            host: r.host, user: r.user, awsInstanceId: r.awsInstanceId, region: r.region, name: inst.name,
            hostKeys: snap?.data?.hostKeys ?? [], simulated: dryRun,
        });
    } catch (err) { return fail(c, err); }
});

// Your saved public keys (only ever public keys; used for laptop access).
export const myKeys = new Hono<Env>();
myKeys.get('/', ...write, async (c) => c.json({ keys: (await userKeys(c.get('user')!.id)).map(userKeyView) }));
myKeys.post('/', ...write, rateLimit(20, 10 * 60_000, (c) => `mykeys:${c.get('user')!.id}`), async (c) => {
    const b = await c.req.json().catch(() => ({}));
    try {
        const k = await saveUserKey(c.get('user')!.id, String(b.name ?? ''), String(b.key ?? ''));
        await audit(actor(c), 'ssh.mykey.add', k.name, { fingerprint: k.fingerprint }, c.get('ip'));
        return c.json({ key: userKeyView(k) });
    } catch (err) { return fail(c, err); }
});
myKeys.delete('/:keyId', ...write, async (c) => {
    const { rows: [k] } = await db().query('DELETE FROM user_ssh_keys WHERE id = $1 AND user_id = $2 RETURNING name, fingerprint', [Number(c.req.param('keyId')), c.get('user')!.id]);
    if (!k) return c.json({ error: 'Key not found' }, 404);
    await audit(actor(c), 'ssh.mykey.remove', k.name, { fingerprint: k.fingerprint }, c.get('ip'));
    return c.json({ ok: true });
});

export default access;
