import { Hono } from 'hono';
import { cancelAction, confirmAction, getAction, listActions } from '../assistant/actions';
import { DeployError } from '../deploys';
import { denyDemo, Env, rateLimit, requireRole } from '../middleware';

/**
 * /api/actions: deploys, rollbacks and server starts/reboots proposed to the signed-in person by Ask Ops Console or a
 * connected AI tool. Only that person sees and decides them; confirming runs them as that person, like the buttons.
 */
const actions = new Hono<Env>();
actions.use('*', requireRole('viewer'), denyDemo);
const fail = (c: { json: (b: unknown, s: number) => Response }, err: unknown) => {
    if (err instanceof DeployError) return c.json({ error: err.message }, err.status);
    throw err;
};

actions.get('/', async (c) => c.json({ actions: await listActions(c.get('user')!.id, { openOnly: c.req.query('open') === '1' }) }));
actions.get('/:id', async (c) => {
    const a = await getAction(c.req.param('id'), c.get('user')!.id);
    return a ? c.json({ action: a }) : c.json({ error: 'Proposal not found.' }, 404);
});
actions.post('/:id/confirm', rateLimit(20, 60_000, (c) => `deploy:${c.get('user')!.id}`), async (c) => {
    const user = c.get('user')!;
    try { return c.json({ action: await confirmAction(c.req.param('id'), { id: user.id, username: user.username, role: user.role }, c.get('ip')) }); }
    catch (err) { return fail(c, err); }
});
actions.post('/:id/cancel', async (c) => {
    try { return c.json({ action: await cancelAction(c.req.param('id'), c.get('user')!.id) }); }
    catch (err) { return fail(c, err); }
});

export default actions;
