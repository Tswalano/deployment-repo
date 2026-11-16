import { announce } from './alerts';
import { aws, dryRun, ParamMeta } from './aws';
import { InstanceRow } from './collector';
import { DeployError } from './deploys';

export const ROTATE_DOCUMENT = 'OpsConsole-RotateSecret';
export const STALE_DAYS = 180;
const RESERVED = /^\/apps\/(ops-console|ops-dashboard|ops-dashboard-auth)\//;

export type Kind = 'db' | 'jwt' | 'provider' | 'secret' | 'config';
/** How a parameter is handled: generated & rotatable here, provider-issued (paste a new one), or plain config. */
export function classify(key: string): Kind {
    if (/^(DATABASE_URL|DATABASE_PASSWORD|PGPASSWORD|DB_PASSWORD)$/.test(key)) return 'db';
    if (/^(JWT_SECRET|SESSION_SECRET)$/.test(key)) return 'jwt';
    if (/(PAYSTACK|STRIPE|SENTRY|MAPBOX|TWILIO|SENDGRID|SMTP|API_KEY|_TOKEN$|_DSN$|SECRET_KEY|PUBLIC_KEY)/.test(key)) return 'provider';
    if (/(PASSWORD|SECRET|TOKEN|PRIVATE|CREDENTIAL)/.test(key)) return 'secret';
    return 'config';
}

export interface SecretView {
    name: string; key: string; type: string; version: number; lastModified: string | null; lastModifiedBy: string | null;
    kind: Kind; ageDays: number | null; stale: boolean;
}

const userOf = (url: string | null) => (url ? /^[a-z]+:\/\/([^:/@]+):/.exec(url)?.[1] ?? null : null);

/** Names and dates only; for DATABASE_URLs the console reads the value server-side to report the role name. */
export async function inventory(inst: InstanceRow) {
    const a = aws();
    if (!a.listParameters) throw new DeployError('Secrets are not available.');
    const services = [...new Set((inst.last_status?.apps ?? []).map((x) => ({ service: x.service, project: x.project })).map((x) => JSON.stringify(x)))].map((x) => JSON.parse(x) as { service: string; project: string });
    const roles = new Map<string, string[]>();
    const apps = [];
    for (const { service, project } of services) {
        const params: ParamMeta[] = await a.listParameters(inst.region, `/apps/${service}`);
        const secrets: SecretView[] = params.map((p) => {
            const key = p.name.split('/').pop()!;
            const kind = classify(key);
            const ageDays = p.lastModified ? Math.floor((Date.now() - Date.parse(p.lastModified)) / 86_400_000) : null;
            return { name: p.name, key, type: p.type, version: p.version, lastModified: p.lastModified, lastModifiedBy: p.lastModifiedBy,
                kind, ageDays, stale: kind !== 'config' && ageDays !== null && ageDays > STALE_DAYS };
        }).sort((x, y) => x.key.localeCompare(y.key));
        const url = secrets.find((s) => s.key === 'DATABASE_URL');
        const role = url && a.getParameter ? userOf(await a.getParameter(inst.region, url.name).catch(() => null)) : null;
        if (role) roles.set(role, [...(roles.get(role) ?? []), project]);
        apps.push({ project, service, dbRole: role, hasJwt: secrets.some((s) => s.key === 'JWT_SECRET'), secrets });
    }
    return { apps, dbRoles: [...roles.entries()].map(([role, usedBy]) => ({ role, usedBy })), staleDays: STALE_DAYS, dryRun };
}

const parse = (out: string) => { try { return JSON.parse(out.trim().split('\n').pop() ?? '{}'); } catch { return { ok: false, error: out.slice(0, 200) }; } };

/** Rotate a DB role password or an app's JWT secret on the instance (the box generates the value and restores on failure). */
export async function rotate(inst: InstanceRow, kind: 'db-password' | 'jwt', target: string, by: string) {
    if (!/^[a-z_][a-z0-9_-]{0,30}$/.test(target)) throw new DeployError('Invalid target.');
    if (kind === 'db-password' && ['opsconsole', 'ops_monitor'].includes(target)) throw new DeployError('That role belongs to the console.');
    const r = parse(await aws().runDocument(inst.region, inst.aws_instance_id, ROTATE_DOCUMENT, { kind: [kind], target: [target] }, 600_000).catch((err) => {
        // the document exits non-zero on failure but still prints its JSON result
        const m = /\{.*\}/s.exec((err as Error).message); return m ? m[0] : JSON.stringify({ ok: false, error: (err as Error).message });
    }));
    const what = kind === 'jwt' ? `JWT secret of ${target}` : `database password of role ${target}`;
    await announce(r.ok ? `[SECRETS] Rotated the ${what} on ${inst.name}` : `[SECRETS] Rotation of the ${what} on ${inst.name} FAILED`,
        r.ok ? `${by} rotated the ${what}${r.dryRun ? ' (dry run)' : ''}. Updated: ${(r.updated ?? []).join(', ') || '—'}. Restarted: ${(r.restarted ?? []).join(', ') || '—'}.`
             : `${by} tried to rotate the ${what}. Error: ${r.error}. ${r.restored ? 'The previous values were restored.' : 'Check the apps now.'}`, 'secrets');
    return r;
}

/** Replace a provider-issued value (e.g. a new Paystack key): save, reload the app, restore the old value if it fails. */
export async function updateValue(inst: InstanceRow, service: string, key: string, value: string, by: string) {
    const a = aws();
    if (!a.getParameter || !a.putParameter) throw new DeployError('Secrets are not available.');
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(service) || !/^[A-Z][A-Z0-9_]{0,63}$/.test(key)) throw new DeployError('Invalid parameter.');
    const name = `/apps/${service}/${key}`;
    if (RESERVED.test(name)) throw new DeployError('The console never changes its own parameters.', 403);
    if (!(inst.last_status?.apps ?? []).some((x) => x.service === service)) throw new DeployError(`${service} isn't an app on ${inst.name}.`);
    const kind = classify(key);
    if (kind === 'db' || kind === 'jwt') throw new DeployError('Use “Rotate” for database passwords and JWT secrets: the console generates those.');
    if (!value || value.length > 4096 || /[\r\n]/.test(value)) throw new DeployError('Enter a single-line value (up to 4096 characters).');
    const old = await a.getParameter(inst.region, name);
    if (old === null) throw new DeployError(`${name} doesn't exist; the console only updates existing parameters.`);
    if (old === value) throw new DeployError('That is already the current value.');
    await a.putParameter(inst.region, name, value);
    const r = parse(await aws().runDocument(inst.region, inst.aws_instance_id, ROTATE_DOCUMENT, { kind: ['reload'], target: [service] }, 300_000)
        .catch((err) => JSON.stringify({ ok: false, error: (err as Error).message })));
    if (!r.ok) {
        await a.putParameter(inst.region, name, old);
        await aws().runDocument(inst.region, inst.aws_instance_id, ROTATE_DOCUMENT, { kind: ['reload'], target: [service] }, 300_000).catch(() => undefined);
        await announce(`[SECRETS] New ${key} for ${service} on ${inst.name} was rolled back`,
            `${by} saved a new ${key}, but ${service} was unhealthy afterwards (${r.error ?? JSON.stringify(r.health)}). The previous value was restored.`, 'secrets');
        throw new DeployError(`${service} was unhealthy with the new value, so the previous value was restored. ${r.error ?? ''}`.trim(), 409);
    }
    await announce(`[SECRETS] ${key} updated for ${service} on ${inst.name}`, `${by} replaced ${name}${dryRun ? ' (dry run: nothing was written)' : ''}; ${service} restarted and is healthy.`, 'secrets');
    return { ok: true, name, health: r.health ?? {}, dryRun };
}
