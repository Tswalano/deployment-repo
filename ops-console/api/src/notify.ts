import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';

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

let transport: Transport = realTransport;
export const notifier = () => transport;
export function setTransport(t: Transport): void {
    transport = t;
}
