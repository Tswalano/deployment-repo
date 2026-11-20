import { Hono } from 'hono';
import { InstanceRow } from '../collector';
import { CHANGEABLE, changeComponent, ComponentAction, ComponentId, inventory } from '../components';
import { db } from '../db';
import { deploymentView, DeployError } from '../deploys';
import { denyDemo, Env, rateLimit, requireRole } from '../middleware';

/** /api/instances/:id/components: what runs on the server, and (admins) installing, starting, stopping or removing it. */
const components = new Hono<Env>();

async function load(id: string): Promise<InstanceRow | null> {
    const { rows: [inst] } = await db().query<InstanceRow>('SELECT * FROM instances WHERE id = $1', [Number(id)]);
    return inst ?? null;
}

components.get('/:id/components', requireRole('viewer'), async (c) => {
    const inst = await load(c.req.param('id'));
    if (!inst) return c.json({ error: 'Instance not found' }, 404);
    try {
        const r = await inventory(inst, c.req.query('fresh') === '1');
        const admin = c.get('user')!.role === 'admin' && !c.get('user')!.isDemo;
        return c.json({ ...r.inventory, at: r.at, available: r.available, changeable: admin ? CHANGEABLE : {}, job: r.job ? deploymentView(r.job, admin) : null });
    } catch (err) {
        if (err instanceof DeployError) return c.json({ error: err.message, code: err.code }, err.status);
        return c.json({ error: `Couldn't read the components: ${(err as Error).message.slice(0, 200)}` }, 502);
    }
});

components.post('/:id/components', requireRole('admin'), denyDemo, rateLimit(10, 10 * 60_000, (c) => `components:${c.get('user')!.id}`), async (c) => {
    const inst = await load(c.req.param('id'));
    if (!inst) return c.json({ error: 'Instance not found' }, 404);
    const b = await c.req.json().catch(() => ({})) as { action?: unknown; component?: unknown; version?: unknown };
    const action = String(b.action ?? '') as ComponentAction;
    const component = String(b.component ?? '') as ComponentId;
    if (!['install', 'start', 'stop', 'remove'].includes(action) || !(component in CHANGEABLE)) return c.json({ error: 'Unknown component or action.' }, 400);
    const user = c.get('user')!;
    try {
        const d = await changeComponent(inst, action, component, typeof b.version === 'string' ? b.version.trim() : '', { id: user.id, username: user.username, role: user.role }, c.get('ip'));
        return c.json({ job: deploymentView(d, true) }, 202);
    } catch (err) {
        if (err instanceof DeployError) return c.json({ error: err.message, code: err.code }, err.status);
        return c.json({ error: `AWS: ${(err as Error).message.slice(0, 240)}` }, 502);
    }
});

export default components;
