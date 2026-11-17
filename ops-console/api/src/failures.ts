/**
 * Failed deployments that still need attention:
 *  - deploys (any trigger: console, GitHub push, CI, deploy.sh) that failed or were rolled back automatically in the
 *    last 7 days, with no successful deploy of that app since, newest per app (from each instance's last snapshot)
 *  - new-app creations that failed in the last 14 days and were not followed by a successful one
 * Dismissing hides one and clears its "deploy failed" alert for good.
 */
import { resolve } from './alerts';
import { InstanceRow } from './collector';
import { db } from './db';
import { DeployError } from './deploys';

const DEPLOY_DAYS = 7, CREATE_DAYS = 14;

export interface FailedDeploy {
    instanceId: number; instance: string; project: string; status: string; at: string; actor: string; toSha: string; fromSha: string;
    trigger: string | null; runUrl: string | null; attempts: number; appExists: boolean;
}
export interface FailedCreation {
    id: number; instanceId: number; instance: string; project: string; repo: string; branch: string; domain: string; createdBy: string;
    createdAt: string; deploymentId: number | null; error: string | null; step: string | null;
}

export async function dismissedDeploys(instanceId: number): Promise<Set<string>> {
    const { rows } = await db().query<{ project: string; event_at: Date }>(
        `SELECT project, event_at FROM dismissed_failures WHERE instance_id = $1 AND kind = 'deploy'`, [instanceId]);
    return new Set(rows.map((r) => `${r.project}@${new Date(r.event_at).getTime()}`));
}
export const deployKey = (project: string, at: string) => `${project}@${Date.parse(at)}`;

export async function listFailures(): Promise<{ deploys: FailedDeploy[]; creations: FailedCreation[] }> {
    const { rows: insts } = await db().query<InstanceRow>('SELECT * FROM instances ORDER BY lower(name)');
    const deploys: FailedDeploy[] = [];
    const since = Date.now() - DEPLOY_DAYS * 86400e3;
    for (const inst of insts) {
        const snap = inst.last_status;
        if (!snap) continue;
        const dismissed = await dismissedDeploys(inst.id);
        const events = [...snap.deployEvents].sort((a, b) => (a.at < b.at ? 1 : -1));   // newest first
        const seen = new Set<string>();
        for (const e of events) {
            if (seen.has(e.project)) continue;
            if (e.status === 'success') { seen.add(e.project); continue; }        // fixed since: nothing to do
            if (!['failed', 'rolled_back'].includes(e.status) || e.action !== 'deploy') continue;
            if (Date.parse(e.at) < since) continue;
            seen.add(e.project);
            if (dismissed.has(deployKey(e.project, e.at))) continue;
            // failed attempts in a row since the last success (events are newest first)
            let attempts = 0;
            for (const x of events.filter((y) => y.project === e.project && y.action === 'deploy')) { if (x.status === 'success') break; attempts++; }
            deploys.push({ instanceId: inst.id, instance: inst.name, project: e.project, status: e.status, at: e.at, actor: e.actor,
                toSha: e.toSha, fromSha: e.fromSha, trigger: e.trigger ?? null, runUrl: e.runUrl ?? null, attempts,
                appExists: snap.apps.some((a) => a.project === e.project) });
        }
    }
    const { rows } = await db().query(
        `SELECT c.id, c.instance_id AS "instanceId", i.name AS instance, c.project, c.repo, c.branch, c.domain, c.created_by AS "createdBy",
                c.created_at AS "createdAt", c.deployment_id AS "deploymentId", d.output
           FROM app_creations c JOIN instances i ON i.id = c.instance_id LEFT JOIN deployments d ON d.id = c.deployment_id
          WHERE c.status = 'failed' AND c.created_at > now() - make_interval(days => $1)
            AND NOT EXISTS (SELECT 1 FROM app_creations s WHERE s.instance_id = c.instance_id AND s.project = c.project AND s.status = 'success' AND s.created_at > c.created_at)
            AND NOT EXISTS (SELECT 1 FROM app_creations l WHERE l.instance_id = c.instance_id AND l.project = c.project AND l.created_at > c.created_at)
            AND NOT EXISTS (SELECT 1 FROM dismissed_failures f WHERE f.kind = 'create' AND f.creation_id = c.id)
          ORDER BY c.created_at DESC`, [CREATE_DAYS]);
    const creations: FailedCreation[] = rows.map((r) => {
        const line = String(r.output ?? '').trim().split('\n').reverse().find((l: string) => l.startsWith('{') && l.includes('"step"'));
        let s: { step?: string; error?: string } = {};
        try { s = line ? JSON.parse(line) : {}; } catch { /* no summary */ }
        const appNow = insts.find((x) => x.id === r.instanceId)?.last_status?.apps.some((a) => a.project === r.project);
        return { ...r, output: undefined, step: s.step ?? null, error: s.error ?? (r.output ? String(r.output).slice(-200) : null), appExists: !!appNow };
    }).filter((c) => !(c as FailedCreation & { appExists: boolean }).appExists);
    return { deploys, creations };
}

export async function dismissFailure(b: { kind?: unknown; instanceId?: unknown; project?: unknown; at?: unknown; creationId?: unknown; note?: unknown }, by: string) {
    const note = String(b.note ?? '').trim().slice(0, 200) || null;
    if (b.kind === 'create') {
        const { rows: [c] } = await db().query<{ instance_id: number; project: string }>(`SELECT instance_id, project FROM app_creations WHERE id = $1 AND status = 'failed'`, [Number(b.creationId)]);
        if (!c) throw new DeployError('That failed creation was not found.', 404);
        await db().query(`INSERT INTO dismissed_failures (instance_id, project, kind, creation_id, note, dismissed_by) VALUES ($1, $2, 'create', $3, $4, $5)
                          ON CONFLICT (creation_id) WHERE kind = 'create' DO NOTHING`, [c.instance_id, c.project, Number(b.creationId), note, by]);
        return { project: c.project, instanceId: c.instance_id };
    }
    if (b.kind !== 'deploy') throw new DeployError('Unknown kind.');
    const project = String(b.project ?? '');
    const at = String(b.at ?? '');
    if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(project) || Number.isNaN(Date.parse(at))) throw new DeployError('Invalid failure.');
    const { rows: [inst] } = await db().query<InstanceRow>('SELECT * FROM instances WHERE id = $1', [Number(b.instanceId)]);
    if (!inst) throw new DeployError('Instance not found.', 404);
    const known = inst.last_status?.deployEvents.some((e) => e.project === project && e.at === at && ['failed', 'rolled_back'].includes(e.status));
    if (!known) throw new DeployError('That failed deploy was not found.', 404);
    await db().query(`INSERT INTO dismissed_failures (instance_id, project, kind, event_at, note, dismissed_by) VALUES ($1, $2, 'deploy', $3, $4, $5)
                      ON CONFLICT (instance_id, project, event_at) WHERE kind = 'deploy' DO NOTHING`, [inst.id, project, at, note, by]);
    await resolve(`deploy_failed:${inst.id}:${project}`);
    return { project, instanceId: inst.id };
}
