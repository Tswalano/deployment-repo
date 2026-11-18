import { Hono } from 'hono';
import { alertView, AlertRow, sendTest } from '../alerts';
import { audit } from '../audit';
import { db } from '../db';
import { denyDemo, Env, rateLimit, requireRole } from '../middleware';
import { alertSettings, maskWebhook, saveAlertSettings, validateAlertSettings } from '../settings';
import { uptimeSeries, uptimeSummaries } from '../uptime';

const alerts = new Hono<Env>();
alerts.use('*', requireRole('viewer'));

alerts.get('/', async (c) => {
    const state = c.req.query('state') === 'open' ? 'open' : 'all';
    const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') || 50)));
    // active = open and not acknowledged; an acknowledged alert moves to the history even while its condition lasts
    const { rows } = await db().query<AlertRow & { instance_name: string | null; app_exists: boolean | null }>(
        `SELECT a.*, i.name AS instance_name,
                EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(i.last_status->'apps', '[]'::jsonb)) x WHERE x->>'project' = a.project) AS app_exists
           FROM alerts a LEFT JOIN instances i ON i.id = a.instance_id
          ${state === 'open' ? 'WHERE a.resolved_at IS NULL AND a.acked_at IS NULL' : ''}
          ORDER BY (a.resolved_at IS NULL AND a.acked_at IS NULL) DESC, CASE a.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
                   COALESCE(a.resolved_at, a.acked_at, a.opened_at) DESC
          LIMIT $1`, [limit]);
    const { rows: [counts] } = await db().query(
        `SELECT count(*) FILTER (WHERE resolved_at IS NULL AND acked_at IS NULL)::int AS open,
                count(*) FILTER (WHERE resolved_at IS NULL AND acked_at IS NULL AND severity = 'critical')::int AS critical,
                count(*) FILTER (WHERE opened_at > now() - interval '7 days')::int AS week
           FROM alerts`);
    return c.json({ alerts: rows.map((r) => ({ ...alertView(r), appExists: !!r.app_exists })), counts });
});

alerts.post('/:id/ack', requireRole('deployer'), denyDemo, async (c) => {
    const user = c.get('user')!;
    const { rows } = await db().query<AlertRow>(
        `UPDATE alerts SET acked_by = $2, acked_at = now() WHERE id = $1 AND resolved_at IS NULL AND acked_at IS NULL RETURNING *`,
        [Number(c.req.param('id')), user.username]);
    if (!rows.length) return c.json({ error: 'Alert not found, already resolved or already acknowledged' }, 404);
    await audit({ id: user.id, username: user.username }, 'alert.ack', rows[0].title, {}, c.get('ip'));
    return c.json({ alert: alertView(rows[0]) });
});

// ------------------------------------------------------------------ settings (admin)
const settingsView = async () => {
    const s = await alertSettings();
    const { rows } = await db().query(
        `SELECT channel, ok, error, at FROM notifications ORDER BY at DESC LIMIT 10`);
    return { ...s, webhookUrl: maskWebhook(s.webhookUrl), webhookSet: !!s.webhookUrl, recent: rows };
};

alerts.get('/settings', requireRole('admin'), denyDemo, async (c) => c.json({ settings: await settingsView() }));

alerts.put('/settings', requireRole('admin'), denyDemo, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const current = await alertSettings();
    // the UI sends the masked webhook back unchanged; only a new full URL (or '') replaces it
    if (typeof body.webhookUrl === 'string' && body.webhookUrl.includes('…')) delete body.webhookUrl;
    const next = validateAlertSettings(body, current);
    if (typeof next === 'string') return c.json({ error: next }, 400);
    const user = c.get('user')!;
    await saveAlertSettings(next, user.username);
    await audit({ id: user.id, username: user.username }, 'alert.settings', 'alert settings',
        { recipients: next.recipients.length, webhook: !!next.webhookUrl, minSeverity: next.minSeverity, thresholds: next.thresholds }, c.get('ip'));
    return c.json({ settings: await settingsView() });
});

alerts.post('/test', requireRole('admin'), denyDemo, rateLimit(5, 10 * 60_000, (c) => `alert-test:${c.get('user')!.id}`), async (c) => {
    const user = c.get('user')!;
    const results = await sendTest(user.username);
    await audit({ id: user.id, username: user.username }, 'alert.test', 'test notification', { results }, c.get('ip'));
    if (!results.length) return c.json({ error: 'Add an email recipient or a webhook first.' }, 400);
    return c.json({ results });
});

// ------------------------------------------------------------------ uptime
export const uptime = new Hono<Env>();
uptime.use('*', requireRole('viewer'));
uptime.get('/', async (c) => c.json({ apps: await uptimeSummaries(Math.min(90, Math.max(7, Number(c.req.query('days') || 90)))) }));
uptime.get('/:instanceId/:project', async (c) => {
    const id = Number(c.req.param('instanceId'));
    const project = c.req.param('project');
    const all = await uptimeSummaries(90);
    const summary = all.find((x) => x.instanceId === id && x.project === project);
    if (!summary) return c.json({ error: 'Not found' }, 404);
    const { rows } = await db().query<AlertRow>(
        `SELECT * FROM alerts WHERE instance_id = $1 AND project = $2 AND rule IN ('app_down', 'app_slow')
          ORDER BY opened_at DESC LIMIT 20`, [id, project]);
    return c.json({ summary, series: await uptimeSeries(id, project), incidents: rows.map(alertView) });
});

export default alerts;
