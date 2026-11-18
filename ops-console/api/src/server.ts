import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { createApp } from './app';
import { startPoller } from './collector';
import { startUptime } from './uptime';
import { config } from './config';
import { migrate } from './migrate';
import { purgeExpiredSessions } from './sessions';
import { attachTerminal } from './terminal';
import { expireSshGrants } from './access';
import { forEachWorkspace } from './db';
import type { Server } from 'http';
import { tracked } from './consolehealth';
import { billingEnabled, renewDue } from './billing';

async function main() {
    const applied = await migrate();
    if (applied.length) console.log('applied migrations:', applied.join(', '));

    const app = createApp();
    const dist = resolve(__dirname, '..', config.webDist);
    if (existsSync(dist)) {
        // Built React app: static assets, and index.html for every client-side route.
        app.use('/assets/*', serveStatic({ root: config.webDist }));
        const index = readFileSync(resolve(dist, 'index.html'), 'utf8');
        app.get('*', (c) => (c.req.path.startsWith('/api/') ? c.notFound() : c.html(index)));
    } else {
        console.warn(`web build not found at ${dist}: serving the API only`);
    }

    startPoller();
    startUptime();
    setInterval(() => void tracked('Session clean-up', 3600_000, purgeExpiredSessions)().catch(() => undefined), 60 * 60 * 1000).unref();
    // temporary SSH rules close within a minute of expiring (also after a restart: the grants are in the database)
    setInterval(() => void tracked('Closing expired SSH access', 60_000, () => forEachWorkspace(async () => { await expireSshGrants(); }))()
        .catch((err) => console.error('closing expired SSH access failed:', (err as Error).message)), 60_000).unref();
    // subscriptions renewed by the console (charging the saved card; credits first)
    if (billingEnabled()) {
        const renew = tracked('Subscription renewals', 15 * 60_000, renewDue);
        setTimeout(() => void renew().catch((err) => console.error('renewals failed:', (err as Error).message)), 60_000).unref();
        setInterval(() => void renew().catch((err) => console.error('renewals failed:', (err as Error).message)), 15 * 60_000).unref();
    }
    const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) =>
        console.log(`ops-console listening on http://${info.address}:${info.port}`));
    attachTerminal(server as Server);   // browser terminal (WebSocket → SSM Session Manager)
}

main().catch((err) => {
    console.error('fatal:', err.message);
    process.exit(1);
});
