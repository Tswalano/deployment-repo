import { Context, Hono } from 'hono';
import { audit } from '../audit';
import { announce } from '../alerts';
import { changeKey, detectPublicIp, GRANT_HOURS, grantSsh, grantView, hostCidr, refreshSecurity, revokeGrant, securitySnapshot, sshAccess } from '../access';
import { dryRun } from '../aws';
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
        return c.json({ ...r, yourIp: await detectPublicIp(c.get('ip')), hours: GRANT_HOURS });
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

export default access;
