import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { dryRun } from './aws';
import { db } from './db';
import { checkOrigin, denyDemo, Env, loadSession, requireRole } from './middleware';
import alerts, { uptime } from './routes/alerts';
import apps, { deployments } from './routes/apps';
import auth from './routes/auth';
import backups from './routes/backups';
import policy from './routes/policy';
import secrets from './routes/secrets';
import { costs, schedules } from './routes/ops';
import github, { appRepo } from './routes/github';
import envRoutes from './routes/env';
import newapp from './routes/newapp';
import instances from './routes/instances';
import failures from './routes/failures';
import connect from './routes/connect';
import prepare from './routes/prepare';
import billingRoutes, { billingGuard } from './routes/billing';
import { setWorkspaceResolver } from './aws';
import { workspaceProvider } from './connections';
import { config } from './config';
import access, { myKeys } from './routes/access';
import users from './routes/users';
import { account, teamRoutes, workspaces } from './routes/accounts';
import platformRoutes from './routes/platform';
import { requestMetrics } from './consolehealth';
import assistantRoutes from './routes/assistant';

/** The API, without the HTTP server or static files (so tests can call it directly). */
export function createApp() {
    // multi-customer mode: AWS calls run in the CURRENT workspace's own account (or are refused when it has none)
    if (config.multiTenant) setWorkspaceResolver(workspaceProvider);
    const app = new Hono<Env>();

    app.use('*', secureHeaders({
        contentSecurityPolicy: {
            defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"], frameAncestors: ["'none'"],
        },
        referrerPolicy: 'no-referrer',
    }));

    app.get('/api/health', async (c) => {
        await db().query('SELECT 1');
        return c.json(dryRun ? { status: 'ok', mode: 'local-dry-run' } : { status: 'ok' });
    });

    app.use('/api/*', requestMetrics);
    app.use('/api/*', loadSession, checkOrigin, billingGuard);
    app.route('/api/auth', auth);
    app.route('/api/account', account);
    app.route('/api/workspaces', workspaces);
    app.route('/api/team', teamRoutes);
    app.route('/api/users', users);
    app.route('/api/instances', secrets);
    app.route('/api/instances', schedules);
    app.route('/api/costs', costs);
    app.route('/api/github', github);
    app.route('/api/instances', appRepo);
    app.route('/api/instances', envRoutes);
    app.route('/api', newapp);
    app.route('/api/instances', access);
    app.route('/api/instances', prepare);
    app.route('/api/ssh-keys', myKeys);
    app.route('/api/instances', apps);
    app.route('/api/instances', instances);
    app.route('/api/deployments', deployments);
    app.route('/api/failures', failures);
    app.route('/api/aws-connection', connect);
    app.route('/api/billing', billingRoutes);
    app.route('/api/platform', platformRoutes);
    app.route('/api/assistant', assistantRoutes);
    app.route('/api/alerts', alerts);
    app.route('/api/uptime', uptime);
    app.route('/api/backups', backups);
    app.route('/api/policy', policy);

    app.get('/api/audit', requireRole('admin'), denyDemo, async (c) => {
        const limit = Math.min(500, Math.max(1, Number(c.req.query('limit') || 100)));
        const { rows } = await db().query(
            `SELECT id, at, username, action, target, detail, ip FROM audit_log ORDER BY at DESC LIMIT $1`, [limit]);
        return c.json({ entries: rows });
    });

    app.notFound((c) => (c.req.path.startsWith('/api/') ? c.json({ error: 'Not found' }, 404) : c.text('Not found', 404)));
    app.onError((err, c) => {
        console.error('unhandled:', err.message);
        return c.json({ error: 'Internal error' }, 500);   // never leak details
    });
    return app;
}
