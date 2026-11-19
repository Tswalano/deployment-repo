import { randomBytes } from 'crypto';
import { audit } from '../audit';
import { InstanceRow } from '../collector';
import { db } from '../db';
import { DeployError, PROJECT_RE, REF_RE, Requester, requestDeployment, SHA_RE } from '../deploys';
import { activeFreeze, deployPolicy } from '../policy';
import { powerInstance } from '../power';

/**
 * Actions the assistant (or an MCP client) proposes: deploy, roll back, start or reboot a server. Proposing changes
 * nothing. Only the person it was proposed to can confirm it, in the console, within 15 minutes; it then runs exactly
 * like the button would (requestDeployment / powerInstance: role checks, approvals, freeze windows, audit, emails).
 * Stopping and terminating servers, overrides of the deploy policy and every other change stay with the console's own UI.
 */
export type ActionKind = 'deploy' | 'rollback' | 'start' | 'reboot';
export type Role = 'admin' | 'deployer' | 'viewer';
export interface ActionCtx {
    userId: number; username: string; source: 'chat' | 'mcp'; via: string; conversationId?: string | null;
    onAction?: (a: ActionView) => void | Promise<void>;
}
export interface ActionView {
    id: string; kind: ActionKind; summary: string; note: string | null; server: { id: number; name: string; environment: string }; app: string | null; ref: string;
    status: 'proposed' | 'running' | 'done' | 'failed' | 'cancelled' | 'expired'; source: 'chat' | 'mcp'; via: string;
    createdAt: string; expiresAt: string; decidedAt: string | null; result: { message?: string; error?: string; deploymentId?: number; deploymentStatus?: string } | null;
    link: string;
}
const MAX_OPEN = 10;
const VERB: Record<ActionKind, string> = { deploy: 'Deploy', rollback: 'Roll back', start: 'Start', reboot: 'Reboot' };

const SELECT = `SELECT a.*, i.name AS server_name, i.environment AS server_env,
                       CASE WHEN a.status = 'proposed' AND a.expires_at < now() THEN 'expired' ELSE a.status END AS live_status
                  FROM assistant_actions a JOIN instances i ON i.id = a.instance_id`;
interface Row { id: string; kind: ActionKind; summary: string; note: string | null; instance_id: number; server_name: string; server_env: string; project: string | null; ref: string;
    live_status: ActionView['status']; source: 'chat' | 'mcp'; via: string; created_at: Date; expires_at: Date; decided_at: Date | null; result: ActionView['result']; user_id: number }
const view = (r: Row): ActionView => ({
    id: r.id, kind: r.kind, summary: r.summary, note: r.note, server: { id: r.instance_id, name: r.server_name, environment: r.server_env }, app: r.project, ref: r.ref,
    status: r.live_status, source: r.source, via: r.via, createdAt: new Date(r.created_at).toISOString(), expiresAt: new Date(r.expires_at).toISOString(),
    decidedAt: r.decided_at ? new Date(r.decided_at).toISOString() : null, result: r.result,
    link: r.project ? `/instances/${r.instance_id}/apps/${r.project}?tab=deploy` : `/instances/${r.instance_id}`,
});

/** Create a proposal (called from the propose_* tools). Problems come back as data for the model to explain. */
export async function propose(kind: ActionKind, input: Record<string, unknown>, role: Role, ctx: ActionCtx | undefined): Promise<unknown> {
    if (!ctx) return { error: 'Actions can only be proposed from Ask Ops Console or a connected AI tool.' };
    if (role === 'viewer') return { error: 'This account is a viewer: it can\'t deploy, roll back or power servers. A deployer or admin can do it from the console.' };
    const { rows: [inst] } = await db().query<InstanceRow>('SELECT * FROM instances WHERE id = $1', [input.server_id]);
    if (!inst) return { error: 'No server with that id in this workspace.' };
    let project: string | null = null;
    const ref = typeof input.ref === 'string' ? input.ref.trim() : '';
    let note: string | null = null;
    if (kind === 'deploy' || kind === 'rollback') {
        project = String(input.app ?? '').trim();
        if (!PROJECT_RE.test(project) || !inst.last_status?.apps.some((a) => a.project === project)) {
            return { error: `${project || 'That app'} isn't an app on ${inst.name}.`, appsOnServer: (inst.last_status?.apps ?? []).map((a) => a.project) };
        }
        if (ref && (!REF_RE.test(ref) || ref.includes('..'))) return { error: 'That is not a valid git ref (a branch, tag or commit SHA).' };
        if (kind === 'rollback' && ref && !SHA_RE.test(ref)) return { error: 'Roll back to a commit SHA, or leave ref empty for the previous good deploy.' };
        const policy = await deployPolicy();
        const freeze = activeFreeze(policy, inst.environment);
        if (freeze && !(kind === 'rollback' && policy.rollbackAllowedInFreeze)) {
            return { error: `Deploys to ${inst.environment} are frozen ("${freeze.name}") until ${freeze.endsAt}. An admin can override with a reason on the app's page; this can't be proposed here.` };
        }
        const env = inst.environment as keyof typeof policy.approvals;
        if (policy.approvals[env] && (kind === 'deploy' || policy.rollbackNeedsApproval)) note = `${inst.environment} needs approval: after confirming, another deployer or admin must approve it.`;
    } else {
        const state = inst.ec2_state ?? 'running';
        if (kind === 'start' && state !== 'stopped') return { error: `${inst.name} is ${state}, not stopped.` };
        if (kind === 'reboot' && state !== 'running') return { error: `${inst.name} is ${state}; only a running server can be rebooted.` };
        note = kind === 'reboot' ? 'Its apps are unavailable for a minute or two while it restarts.' : null;
    }
    const summary = project
        ? `${VERB[kind]} ${project} on ${inst.name} (${inst.environment})${ref ? ` to ${ref}` : kind === 'rollback' ? ' to the previous good deploy' : ' (latest of its branch)'}`
        : `${VERB[kind]} the server ${inst.name} (${inst.environment})`;

    // the same proposal still open: hand it back instead of piling up duplicates
    const { rows: [dup] } = await db().query<Row>(`${SELECT} WHERE a.user_id = $1 AND a.kind = $2 AND a.instance_id = $3 AND a.project IS NOT DISTINCT FROM $4 AND a.ref = $5
                                                    AND a.status = 'proposed' AND a.expires_at > now()`, [ctx.userId, kind, inst.id, project, ref]);
    let action: ActionView;
    if (dup) action = view(dup);
    else {
        const { rows: [n] } = await db().query<{ n: number }>("SELECT count(*)::int AS n FROM assistant_actions WHERE user_id = $1 AND status = 'proposed' AND expires_at > now()", [ctx.userId]);
        if (n.n >= MAX_OPEN) return { error: `There are already ${MAX_OPEN} proposals waiting for confirmation. Confirm or cancel some first.` };
        const id = randomBytes(12).toString('hex');
        await db().query(`INSERT INTO assistant_actions (id, user_id, source, via, conversation_id, kind, instance_id, project, ref, summary, note)
                          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [id, ctx.userId, ctx.source, ctx.via.slice(0, 80), ctx.conversationId ?? null, kind, inst.id, project, ref, summary, note]);
        action = (await getAction(id, ctx.userId))!;
    }
    await ctx.onAction?.(action);
    return {
        proposed: true, actionId: action.id, summary, note, expiresAt: action.expiresAt,
        nextStep: ctx.source === 'chat'
            ? 'Nothing has happened yet. A confirmation card is shown to the person in this chat; it runs only if they confirm. Tell them briefly what will happen.'
            : 'Nothing has happened yet. The person must confirm it in the console within 15 minutes, under AI Console → Proposals.',
    };
}

export async function getAction(id: string, userId: number): Promise<ActionView | null> {
    if (!/^[0-9a-f]{24}$/.test(id)) return null;
    const { rows: [r] } = await db().query<Row>(`${SELECT} WHERE a.id = $1 AND a.user_id = $2`, [id, userId]);
    return r ? view(r) : null;
}
/** The person's proposals: open ones (any source) and, optionally, recent decided ones. */
export async function listActions(userId: number, opts: { openOnly?: boolean; conversationId?: string } = {}): Promise<ActionView[]> {
    const { rows } = await db().query<Row>(
        `${SELECT} WHERE a.user_id = $1 AND ($2::boolean IS NOT TRUE OR (a.status = 'proposed' AND a.expires_at > now())) AND ($3::text IS NULL OR a.conversation_id = $3)
          ORDER BY a.created_at DESC LIMIT 50`, [userId, opts.openOnly ?? false, opts.conversationId ?? null]);
    return rows.map(view);
}

export async function cancelAction(id: string, userId: number): Promise<ActionView> {
    const { rowCount } = await db().query("UPDATE assistant_actions SET status = 'cancelled', decided_at = now() WHERE id = $1 AND user_id = $2 AND status = 'proposed'", [id, userId]);
    const a = await getAction(id, userId);
    if (!a) throw new DeployError('Proposal not found.', 404);
    if (!rowCount) throw new DeployError(`This proposal is already ${a.status}.`, 409);
    return a;
}

/** The person confirmed: run it as them, exactly like the console's button. */
export async function confirmAction(id: string, user: Requester & { id: number }, ip: string | null): Promise<ActionView> {
    const { rows: [r] } = await db().query<{ kind: ActionKind; instance_id: number; project: string | null; ref: string; via: string }>(
        `UPDATE assistant_actions SET status = 'running', decided_at = now() WHERE id = $1 AND user_id = $2 AND status = 'proposed' AND expires_at > now()
         RETURNING kind, instance_id, project, ref, via`, [id, user.id]);
    if (!r) {
        const a = await getAction(id, user.id);
        if (!a) throw new DeployError('Proposal not found.', 404);
        throw new DeployError(a.status === 'expired' ? 'This proposal expired (15 minutes). Ask again for a new one.' : `This proposal is already ${a.status}.`, 409);
    }
    const finish = async (status: 'done' | 'failed', result: ActionView['result']) =>
        db().query('UPDATE assistant_actions SET status = $2, result = $3 WHERE id = $1', [id, status, JSON.stringify(result)]);
    try {
        if (user.role === 'viewer') throw new DeployError('Your role can no longer do this.', 403);
        const { rows: [inst] } = await db().query<InstanceRow>('SELECT * FROM instances WHERE id = $1', [r.instance_id]);
        if (!inst) throw new DeployError('The server is no longer in this workspace.', 404);
        if (r.kind === 'deploy' || r.kind === 'rollback') {
            const d = await requestDeployment(inst, r.project!, r.kind, r.ref, user);
            const what = d.status === 'pending_approval' ? `app.${r.kind}_requested` : `app.${r.kind}`;
            await audit({ id: user.id, username: user.username }, what, `${r.project} on ${inst.name}`, { ref: r.ref || '(default)', deployment: d.id, via: r.via, proposal: id }, ip);
            await finish('done', {
                deploymentId: d.id, deploymentStatus: d.status,
                message: d.status === 'pending_approval' ? 'Sent for approval: another deployer or admin must approve it.' : `${r.kind === 'deploy' ? 'Deploy' : 'Rollback'} started.`,
            });
        } else {
            const out = await powerInstance(inst, r.kind, user, ip, { via: r.via });
            await finish('done', { message: out.message });
        }
    } catch (err) {
        const message = err instanceof DeployError ? err.message : 'It could not be started. Try from the console.';
        if (!(err instanceof DeployError)) console.error('assistant action failed:', (err as Error).message);
        await finish('failed', { error: message });
    }
    return (await getAction(id, user.id))!;
}
