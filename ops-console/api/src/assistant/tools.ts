import type Anthropic from '@anthropic-ai/sdk';
import { InstanceRow } from '../collector';
import { latestCosts } from '../costs';
import { db } from '../db';
import { uptimeSummaries } from '../uptime';
import { ActionCtx, propose } from './actions';

/**

 * Tools for the assistant and the MCP server: read-only lookups, plus propose_* tools that only record a proposal for the
 * person to confirm in the console (actions.ts). Every tool runs in the asking user's workspace context (row-level security), so
 * it can only ever see that workspace; tools never return secrets (setting values, tokens, keys). Results are compact
 * JSON with a `now` timestamp, so the model can say "2 hours ago" without a clock in the (cached) system prompt.
 */
export type Role = 'admin' | 'deployer' | 'viewer';
interface Tool { def: Anthropic.Beta.BetaTool; label: string; proposes?: boolean; run: (input: Record<string, unknown>, role: Role, ctx?: ActionCtx) => Promise<unknown> }

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : null);
const gb = (n: number) => Math.round((n / 1073741824) * 10) / 10;
const obj = (properties: Record<string, unknown>, required: string[] = []): Anthropic.Beta.BetaTool['input_schema'] =>
    ({ type: 'object', properties, required, additionalProperties: false });

async function servers(): Promise<InstanceRow[]> {
    return (await db().query<InstanceRow>('SELECT * FROM instances ORDER BY lower(name)')).rows;
}
function serverState(r: InstanceRow) {
    const off = r.ec2_state && r.ec2_state !== 'running';
    return off ? r.ec2_state : r.last_error ? (r.last_ok_at ? 'not responding' : 'never connected') : 'running';
}

const TOOLS: Record<string, Tool> = {
    list_servers: {
        label: 'Checked the servers',
        def: { name: 'list_servers', description: 'All servers in this workspace with their state (running, stopped, not responding), region, environment, when they last reported, memory/disk/CPU load and how many apps are healthy.', input_schema: obj({}) },
        run: async () => (await servers()).map((r) => {
            const s = r.last_status;
            return {
                id: r.id, name: r.name, region: r.region, environment: r.environment, state: serverState(r), lastReported: r.last_ok_at,
                memoryUsedPct: s ? pct(s.host.memory.used, s.host.memory.total) : null, diskUsedPct: s ? pct(s.host.disk.used, s.host.disk.total) : null,
                diskFreeGb: s ? gb(s.host.disk.free) : null, load1m: s?.host.load[0] ?? null, cpus: s?.host.cpus ?? null,
                apps: s ? { total: s.apps.length, healthy: s.apps.filter((a) => a.healthy).length } : null,
            };
        }),
    },
    get_server: {
        label: 'Looked at a server',
        def: { name: 'get_server', description: 'Details of one server: host metrics, every app on it (health, version, last deploy, errors in 24h), system services, HTTPS certificates with days left, databases and the last backup. Use list_servers first to find the id.',
            input_schema: obj({ server_id: { type: 'integer', description: 'The server id from list_servers.' } }, ['server_id']) },
        run: async (input) => {
            const { rows: [r] } = await db().query<InstanceRow>('SELECT * FROM instances WHERE id = $1', [input.server_id]);
            if (!r) return { error: 'No server with that id in this workspace.' };
            const s = r.last_status;
            return {
                id: r.id, name: r.name, region: r.region, environment: r.environment, state: serverState(r), lastReported: r.last_ok_at, lastError: r.last_error,
                host: s ? { memoryUsedPct: pct(s.host.memory.used, s.host.memory.total), diskUsedPct: pct(s.host.disk.used, s.host.disk.total), diskFreeGb: gb(s.host.disk.free),
                    load: s.host.load, cpus: s.host.cpus, uptimeHours: Math.round(s.host.uptimeSeconds / 3600), instanceType: s.host.instanceType ?? null } : null,
                apps: (s?.apps ?? []).map((a) => ({ name: a.project, url: a.domain ? `https://${a.domain}` : null, healthy: a.healthy, healthCode: a.healthCode, responseMs: a.healthMs,
                    version: a.sha ? `${a.sha.slice(0, 7)} ${a.subject ?? ''}`.trim() : null, lastDeploy: a.lastDeploy, errors24h: a.errors24h, warnings24h: a.warnings24h, restarts: a.restarts })),
                services: (s?.services ?? []).map((v) => ({ unit: v.unit, active: v.active })),
                certificates: (s?.certificates ?? []).map((c) => ({ domain: c.domain, daysLeft: c.daysLeft })),
                databases: (s?.databases ?? []).map((d) => ({ name: d.name, sizeMb: Math.round(d.size / 1048576) })),
                lastBackup: s?.backups ?? null,
            };
        },
    },
    list_apps: {
        label: 'Checked the apps',
        def: { name: 'list_apps', description: 'Every app on every server: health, response time, the version running (commit), last deploy and errors/warnings in the last 24 hours.', input_schema: obj({}) },
        run: async () => (await servers()).flatMap((r) => (r.last_status?.apps ?? []).map((a) => ({
            name: a.project, server: r.name, serverId: r.id, url: a.domain ? `https://${a.domain}` : null, healthy: a.healthy, healthCode: a.healthCode, responseMs: a.healthMs,
            version: a.sha ? `${a.sha.slice(0, 7)} ${a.subject ?? ''}`.trim() : null, lastDeploy: a.lastDeploy, errors24h: a.errors24h, warnings24h: a.warnings24h,
            serverState: serverState(r),
        }))),
    },
    recent_deployments: {
        label: 'Read the deployments',
        def: { name: 'recent_deployments', description: 'Recent deploys, rollbacks and app creations, newest first: app, server, action, status (success, failed, running, pending_approval), commit, who started it and when.',
            input_schema: obj({ limit: { type: 'integer', description: 'How many (1-50, default 15).' }, app: { type: 'string', description: 'Only this app (optional).' } }) },
        run: async (input) => {
            const limit = Math.min(50, Math.max(1, Number(input.limit) || 15));
            const app = typeof input.app === 'string' && input.app ? input.app : null;
            const { rows } = await db().query(
                `SELECT d.project AS app, i.name AS server, d.action, d.status, left(d.ref, 12) AS ref, d.requested_by_name AS "by", d.created_at AS started, d.finished_at AS finished
                   FROM deployments d JOIN instances i ON i.id = d.instance_id ${app ? 'WHERE d.project = $2' : ''} ORDER BY d.created_at DESC LIMIT $1`, app ? [limit, app] : [limit]);
            return rows;
        },
    },
    open_alerts: {
        label: 'Checked the alerts',
        def: { name: 'open_alerts', description: 'Alerts that are open right now (not resolved or dismissed): severity, what, which server/app, since when.', input_schema: obj({}) },
        run: async () => (await db().query(
            `SELECT a.severity, a.title, a.detail, i.name AS server, a.project AS app, a.opened_at AS since
               FROM alerts a LEFT JOIN instances i ON i.id = a.instance_id WHERE a.resolved_at IS NULL AND a.acked_at IS NULL
              ORDER BY CASE a.severity WHEN 'critical' THEN 0 ELSE 1 END, a.opened_at DESC LIMIT 50`)).rows,
    },
    uptime: {
        label: 'Read the uptime history',
        def: { name: 'uptime', description: 'Uptime of every public app (checked every minute): percentage over 24 hours, 7, 30 and 90 days, the last check and the 95th-percentile response time today.', input_schema: obj({}) },
        run: async () => (await uptimeSummaries(90)).map((u) => ({ app: u.project, server: u.instance, url: u.url, last: u.last, uptimePct: u.uptime, p95ms24h: u.p95ms24h })),
    },
    aws_costs: {
        label: 'Read the AWS costs',
        def: { name: 'aws_costs', description: "This month's AWS cost so far, the forecast for the month, last month, and the most expensive AWS services (from Cost Explorer, refreshed about daily).", input_schema: obj({}) },
        run: async (_input, role) => {
            if (role === 'viewer') return { error: 'Costs are visible to deployers and admins only.' };
            const c = await latestCosts();
            return c ? { currency: c.currency, monthToDate: c.monthToDate, forecast: c.forecast, lastMonth: c.lastMonth, lastMonthSamePeriod: c.lastMonthSamePeriod,
                topServices: c.services.slice(0, 6), fetchedAt: c.fetchedAt } : { error: 'No cost data yet (the AWS account may not be connected).' };
        },
    },
};

// ------------------------------------------------------------------ proposals: change nothing until the person confirms in the console
const PROPOSE_NOTE = ' This only proposes it: nothing happens until the person confirms it in the console. Use it only when the person asks for this change, after checking the server and app exist (list_servers / get_server).';
Object.assign(TOOLS, {
    propose_deploy: {
        label: 'Prepared a deploy to confirm', proposes: true,
        def: { name: 'propose_deploy', description: 'Propose deploying an app: the latest commit of its branch, or a given branch, tag or commit.' + PROPOSE_NOTE,
            input_schema: obj({ server_id: { type: 'integer', description: 'The server id from list_servers.' }, app: { type: 'string', description: 'The app name as shown by get_server.' },
                ref: { type: 'string', description: 'Optional branch, tag or commit SHA. Leave out for the latest of the app\'s branch.' } }, ['server_id', 'app']) },
        run: (input, role, ctx) => propose('deploy', input, role, ctx),
    },
    propose_rollback: {
        label: 'Prepared a rollback to confirm', proposes: true,
        def: { name: 'propose_rollback', description: 'Propose rolling an app back: to the previous good deploy, or to a given commit SHA.' + PROPOSE_NOTE,
            input_schema: obj({ server_id: { type: 'integer', description: 'The server id from list_servers.' }, app: { type: 'string', description: 'The app name as shown by get_server.' },
                ref: { type: 'string', description: 'Optional commit SHA (7-40 hex). Leave out for the previous good deploy.' } }, ['server_id', 'app']) },
        run: (input, role, ctx) => propose('rollback', input, role, ctx),
    },
    propose_server_power: {
        label: 'Prepared a server action to confirm', proposes: true,
        def: { name: 'propose_server_power', description: 'Propose starting a stopped server or rebooting a running one. (Stopping or terminating servers is only done in the console itself.)' + PROPOSE_NOTE,
            input_schema: obj({ server_id: { type: 'integer', description: 'The server id from list_servers.' }, action: { type: 'string', enum: ['start', 'reboot'] } }, ['server_id', 'action']) },
        run: (input, role, ctx) => propose(input.action === 'start' ? 'start' : 'reboot', input, role, ctx),
    },
} satisfies Record<string, Tool>);
export const PROPOSAL_TOOLS = new Set(Object.entries(TOOLS).filter(([, t]) => t.proposes).map(([n]) => n));

/** Tool definitions in a fixed order (a stable prefix keeps the prompt cache warm). */
export const toolDefs = (): Anthropic.Beta.BetaTool[] =>
    Object.values(TOOLS).map((t) => ({ ...t.def, strict: true, eager_input_streaming: true }));

export const toolLabel = (name: string) => TOOLS[name]?.label ?? 'Looked something up';

/** Run one tool call. Inputs are untrusted model output: validated here; errors come back as data, not exceptions. */
export async function runTool(name: string, input: unknown, role: Role, ctx?: ActionCtx): Promise<{ content: string; isError: boolean }> {
    const t = TOOLS[name];
    if (!t) return { content: JSON.stringify({ error: `Unknown tool ${name}.` }), isError: true };
    const props = (t.def.input_schema as { properties: Record<string, { type: string; enum?: string[] }>; required?: string[] });
    const args = (input && typeof input === 'object' && !Array.isArray(input) ? input : null) as Record<string, unknown> | null;
    const bad = !args || Object.keys(args).some((k) => !props.properties[k])
        || (props.required ?? []).some((k) => args[k] === undefined)
        || Object.entries(args).some(([k, v]) => (props.properties[k].type === 'integer' ? !Number.isInteger(v) : typeof v !== 'string'))
        || Object.entries(args).some(([k, v]) => props.properties[k].enum && !props.properties[k].enum!.includes(v as string));
    if (bad) return { content: JSON.stringify({ error: 'Invalid input for this tool.', expected: props }), isError: true };
    try {
        const out = await t.run(args!, role, ctx);
        return { content: JSON.stringify({ now: new Date().toISOString(), result: out }), isError: false };
    } catch (err) {
        return { content: JSON.stringify({ error: (err as Error).message.slice(0, 200) }), isError: true };
    }
}
