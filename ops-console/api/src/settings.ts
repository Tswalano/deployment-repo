import { db } from './db';

export interface AlertSettings {
    /** Email recipients (SES; in the sandbox each one must be a verified identity). */
    recipients: string[];
    /** Slack or Discord incoming-webhook URL ('' = off). Treated as a secret: never returned in full. */
    webhookUrl: string;
    /** Lowest severity that notifies (lower ones still show in the console). */
    minSeverity: 'critical' | 'warning' | 'info';
    /** Re-notify an open, unacknowledged alert this often (0 = never). */
    repeatHours: number;
    thresholds: {
        downChecks: number;     // consecutive failed probes before "app down" (1 probe per minute)
        latencyMs: number;      // p95 over the last 15 min above this → "slow"
        diskPct: number;
        memoryPct: number;
        certDays: number;
        backupHours: number;    // last good backup older than this → stale
    };
}

export const DEFAULT_ALERT_SETTINGS: AlertSettings = {
    recipients: [],
    webhookUrl: '',
    minSeverity: 'warning',
    repeatHours: 6,
    thresholds: { downChecks: 3, latencyMs: 2000, diskPct: 85, memoryPct: 92, certDays: 14, backupHours: 26 },
};

let cache: { at: number; value: AlertSettings } | null = null;

export async function alertSettings(): Promise<AlertSettings> {
    if (cache && Date.now() - cache.at < 10_000) return cache.value;
    const { rows } = await db().query("SELECT value FROM settings WHERE key = 'alerts'");
    const stored = (rows[0]?.value ?? {}) as Partial<AlertSettings>;
    const value: AlertSettings = {
        ...DEFAULT_ALERT_SETTINGS, ...stored,
        thresholds: { ...DEFAULT_ALERT_SETTINGS.thresholds, ...(stored.thresholds ?? {}) },
    };
    cache = { at: Date.now(), value };
    return value;
}

export async function saveAlertSettings(value: AlertSettings, by: string): Promise<void> {
    await db().query(
        `INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('alerts', $1, now(), $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
        [JSON.stringify(value), by]);
    cache = null;
}

const EMAIL_RE = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
/** Only real Slack/Discord webhook endpoints: the console never POSTs to arbitrary hosts. */
const WEBHOOK_RE = /^https:\/\/(hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{10,200}|(discord|discordapp)\.com\/api\/webhooks\/\d{5,30}\/[A-Za-z0-9_-]{20,200})$/;

export function maskWebhook(url: string): string {
    if (!url) return '';
    const u = new URL(url);
    return `https://${u.host}/…${url.slice(-4)}`;
}

/** Validate an update from the UI. `webhookUrl` undefined = keep the stored one. */
export function validateAlertSettings(input: Record<string, unknown>, current: AlertSettings): AlertSettings | string {
    const recipients = Array.isArray(input.recipients) ? input.recipients.map((x) => String(x).trim().toLowerCase()).filter(Boolean) : current.recipients;
    if (recipients.length > 10) return 'At most 10 recipients.';
    const bad = recipients.find((r) => !EMAIL_RE.test(r));
    if (bad) return `Not an email address: ${bad}`;
    let webhookUrl = current.webhookUrl;
    if (typeof input.webhookUrl === 'string') {
        webhookUrl = input.webhookUrl.trim();
        if (webhookUrl && !WEBHOOK_RE.test(webhookUrl)) return 'Webhook must be a Slack (hooks.slack.com/services/…) or Discord (discord.com/api/webhooks/…) URL.';
    }
    const minSeverity = ['critical', 'warning', 'info'].includes(String(input.minSeverity)) ? input.minSeverity as AlertSettings['minSeverity'] : current.minSeverity;
    const int = (v: unknown, d: number, lo: number, hi: number) => {
        const n = Math.round(Number(v));
        return Number.isFinite(n) && v !== null && v !== '' && v !== undefined ? Math.max(lo, Math.min(hi, n)) : d;
    };
    const t = (input.thresholds ?? {}) as Record<string, unknown>;
    const c = current.thresholds;
    return {
        recipients: [...new Set(recipients)], webhookUrl, minSeverity,
        repeatHours: int(input.repeatHours, current.repeatHours, 0, 168),
        thresholds: {
            downChecks: int(t.downChecks, c.downChecks, 1, 30), latencyMs: int(t.latencyMs, c.latencyMs, 200, 60_000),
            diskPct: int(t.diskPct, c.diskPct, 50, 99), memoryPct: int(t.memoryPct, c.memoryPct, 50, 99),
            certDays: int(t.certDays, c.certDays, 1, 60), backupHours: int(t.backupHours, c.backupHours, 6, 240),
        },
    };
}
