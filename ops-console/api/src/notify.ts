import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import { currentWorkspace, db } from './db';

/** How notifications leave the console; swappable so tests never send anything. */
export interface Transport {
    email(to: string[], subject: string, text: string): Promise<void>;
    webhook(url: string, text: string): Promise<void>;
}

const FROM = process.env.ALERT_FROM || 'Ops Console <ops@glenify.studio>';
const SES_REGION = process.env.SES_REGION || 'af-south-1';
let ses: SESv2Client | null = null;

export const realTransport: Transport = {
    async email(to, subject, text) {
        ses ??= new SESv2Client({ region: SES_REGION });
        await ses.send(new SendEmailCommand({
            FromEmailAddress: FROM,
            Destination: { ToAddresses: to },
            Content: { Simple: { Subject: { Data: subject.slice(0, 180), Charset: 'UTF-8' }, Body: { Text: { Data: text, Charset: 'UTF-8' } } } },
        }));
    },
    async webhook(url, text) {
        // Slack takes {text}; Discord takes {content}. The URL was validated against both hosts on save.
        const body = new URL(url).host.endsWith('slack.com') ? { text } : { content: text.slice(0, 1900) };
        const res = await fetch(url, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
            redirect: 'error', signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`webhook answered HTTP ${res.status}`);
    },
};

/** Local test mode (ALERTS_DRY_RUN=1): print notifications instead of sending them. */
const logTransport: Transport = {
    async email(to, subject, text) { console.log(`[alerts dry-run] email to ${to.length} recipient(s): ${subject}\n${text}\n`); },
    async webhook(_url, text) { console.log(`[alerts dry-run] webhook: ${text.split('\n')[0]}`); },
};
let transport: Transport = process.env.ALERTS_DRY_RUN === '1' ? logTransport : realTransport;
export const notifier = () => transport;
export function setTransport(t: Transport): void {
    transport = t;
}

/**
 * Send one email and record it (sent or refused) in email_log. Never throws: the result says what happened, so callers
 * can tell the person (e.g. "the invitation was created, but the email could not be sent").
 */
export async function sendEmail(kind: string, to: string[], subject: string, text: string): Promise<{ ok: boolean; error: string | null }> {
    let error: string | null = null;
    try { await transport.email(to, subject, text); } catch (err) { error = (err as Error).message.slice(0, 300); }
    try {
        await db().query('INSERT INTO email_log (workspace_id, kind, recipients, subject, ok, error) VALUES ($1, $2, $3, $4, $5, $6)',
            [currentWorkspace(), kind, to.join(', ').slice(0, 500), subject.slice(0, 200), !error, error]);
        if (Math.random() < 0.02) await db().query("DELETE FROM email_log WHERE at < now() - interval '90 days'");
    } catch (err) { console.error('email log write failed:', (err as Error).message); }
    if (error) console.error(`email (${kind}) failed:`, error);
    return { ok: !error, error };
}
