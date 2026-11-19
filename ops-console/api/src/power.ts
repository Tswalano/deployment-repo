import { announce } from './alerts';
import { audit } from './audit';
import { aws, dryRun, PowerAction } from './aws';
import { InstanceRow } from './collector';
import { db } from './db';
import { DeployError, Requester } from './deploys';

/** Start / reboot / stop / terminate an instance (the power menu, and confirmed assistant actions). Throws DeployError. */
export const POWER_ROLE: Record<PowerAction, 'deployer' | 'admin'> = { start: 'deployer', reboot: 'deployer', stop: 'admin', terminate: 'admin' };
const PAST: Record<PowerAction, string> = { start: 'started', reboot: 'rebooted', stop: 'stopped', terminate: 'terminated' };

export async function powerInstance(inst: InstanceRow, action: PowerAction, user: Requester, ip: string | null,
                                    opts: { confirm?: string; reason?: string; via?: string } = {}) {
    if (!(action in POWER_ROLE)) throw new DeployError('Unknown action.');
    if (user.role === 'viewer' || (POWER_ROLE[action] === 'admin' && user.role !== 'admin')) throw new DeployError(`Only ${POWER_ROLE[action]}s${POWER_ROLE[action] === 'deployer' ? ' and admins' : ''} can ${action} an instance.`, 403);
    if ((action === 'stop' || action === 'terminate') && (opts.confirm ?? '') !== inst.name) throw new DeployError(`Type the instance name (${inst.name}) to confirm.`);
    const reason = (opts.reason ?? '').trim().slice(0, 300);
    if (action === 'terminate' && reason.length < 10) throw new DeployError('Give a reason of at least 10 characters for terminating.');
    const self = await aws().selfInstanceId?.().catch(() => null);
    if (self && self === inst.aws_instance_id && (action === 'stop' || action === 'terminate')) {
        throw new DeployError(`The Ops Console runs on ${inst.name}: ${action === 'stop' ? 'stopping' : 'terminating'} it would take the console down, and it couldn't bring it back. Use the EC2 console for this one.`, 409);
    }
    if (!aws().powerAction) throw new DeployError('Power actions are not available.', 409);
    try {
        const info = await aws().describeInstance(inst.region, inst.aws_instance_id);
        if (!info) throw new DeployError('The instance no longer exists in AWS.', 409);
        if (!info.managedTag) throw new DeployError('The instance is no longer tagged ops-console=managed.', 409);
        await aws().powerAction!(inst.region, inst.aws_instance_id, action, false);
    } catch (err) {
        if (err instanceof DeployError) throw err;
        throw new DeployError((err as Error).message.slice(0, 300));
    }
    const next = { start: 'pending', stop: 'stopping', reboot: 'running', terminate: 'shutting-down' }[action];
    await db().query('UPDATE instances SET ec2_state = $2, ec2_state_at = now(), last_fetched_at = NULL WHERE id = $1', [inst.id, dryRun ? inst.ec2_state : next]);
    await audit({ id: user.id, username: user.username }, `instance.${action}`, `${inst.name} (${inst.aws_instance_id})`,
        { region: inst.region, reason: reason || undefined, dryRun: dryRun || undefined, via: opts.via }, ip);
    if (action !== 'start') {
        await announce(`[POWER] ${inst.name} ${dryRun ? `would be ${PAST[action]} (dry run)` : PAST[action]} by ${user.username}`,
            `${user.username} ${action === 'terminate' ? 'terminated' : PAST[action]} ${inst.name} (${inst.aws_instance_id}, ${inst.region}).${reason ? `\n\nReason: ${reason}` : ''}${opts.via ? `\n\nProposed by ${opts.via}, confirmed by ${user.username}.` : ''}`, 'power');
    }
    return { ok: true, action, dryRun, state: dryRun ? inst.ec2_state : next,
        message: dryRun ? `Dry run: AWS confirms ${user.username} may ${action} ${inst.name}. Nothing was changed (local test mode).` : `${inst.name}: ${action} requested.` };
}
