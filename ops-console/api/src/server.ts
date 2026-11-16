import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { createApp } from './app';
import { config } from './config';
import { migrate } from './migrate';
import { purgeExpiredSessions } from './sessions';

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

    setInterval(() => purgeExpiredSessions().catch(() => undefined), 60 * 60 * 1000).unref();
    serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) =>
        console.log(`ops-console listening on http://${info.address}:${info.port}`));
}

main().catch((err) => {
    console.error('fatal:', err.message);
    process.exit(1);
});
