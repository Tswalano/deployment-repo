import { FormEvent, useEffect, useState } from 'react';
import { AlertSettings, api, ApiError } from '../api';
import { ago, Alert } from './ui';

const err = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong.');

export function AlertSettingsForm() {
  const [s, setS] = useState<AlertSettings | null>(null);
  const [recipients, setRecipients] = useState('');
  const [webhook, setWebhook] = useState('');
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad' | 'warn'; text: string } | null>(null);
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);

  const apply = (v: AlertSettings) => { setS(v); setRecipients(v.recipients.join(', ')); setWebhook(v.webhookUrl); };
  useEffect(() => { api.alertSettings().then(apply).catch((e) => setMsg({ tone: 'bad', text: err(e) })); }, []);
  if (!s) return <section id="alerts" className="card text-sm text-slate-500">{msg?.text ?? 'Loading alert settings…'}</section>;

  const th = (k: keyof AlertSettings['thresholds'], v: string) => setS({ ...s, thresholds: { ...s.thresholds, [k]: Number(v) } });
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy('save'); setMsg(null);
    try {
      apply(await api.saveAlertSettings({
        recipients: recipients.split(/[\s,;]+/).filter(Boolean), webhookUrl: webhook,
        minSeverity: s!.minSeverity, repeatHours: s!.repeatHours, thresholds: s!.thresholds,
      }));
      setMsg({ tone: 'ok', text: 'Saved.' });
    } catch (e2) { setMsg({ tone: 'bad', text: err(e2) }); } finally { setBusy(null); }
  }
  async function test() {
    setBusy('test'); setMsg(null);
    try {
      const r = await api.testAlerts();
      const bad = r.filter((x) => !x.ok);
      setMsg(bad.length
        ? { tone: 'warn', text: `Sent to ${r.filter((x) => x.ok).map((x) => x.channel).join(' and ') || 'nothing'}. Failed: ${bad.map((x) => `${x.channel} (${x.error})`).join('; ')}` }
        : { tone: 'ok', text: `Test sent by ${r.map((x) => x.channel).join(' and ')}. Check the inbox.` });
      apply(await api.alertSettings());
    } catch (e2) { setMsg({ tone: 'bad', text: err(e2) }); } finally { setBusy(null); }
  }
  const num = (k: keyof AlertSettings['thresholds'], label: string, unit: string, min: number, max: number) => (
    <div>
      <label className="label" htmlFor={`th-${k}`}>{label}</label>
      <div className="flex items-center gap-2">
        <input id={`th-${k}`} type="number" min={min} max={max} className="input num" value={s.thresholds[k]} onChange={(e) => th(k, e.target.value)} />
        <span className="shrink-0 text-xs text-slate-500">{unit}</span>
      </div>
    </div>
  );

  return (
    <form id="alerts" onSubmit={save} className="card space-y-5">
      <div>
        <h2 className="font-medium text-slate-100">Alerts & notifications</h2>
        <p className="mt-1 text-sm text-slate-500">
          Email is sent through SES as <code className="rounded bg-ink-800 px-1 font-mono text-xs text-slate-300">ops@glenify.studio</code>.
          While SES is in sandbox mode, every recipient must be a verified address.
          The instance itself failing is covered separately by a CloudWatch alarm (EC2 status checks → SNS email).
        </p>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <label className="label" htmlFor="al-rcpt">Email recipients</label>
          <input id="al-rcpt" className="input" value={recipients} onChange={(e) => setRecipients(e.target.value)} placeholder="ops@example.com, oncall@example.com" />
        </div>
        <div>
          <label className="label" htmlFor="al-hook">Slack or Discord webhook <span className="text-slate-600">(optional)</span></label>
          <input id="al-hook" className="input font-mono text-xs" value={webhook} onChange={(e) => setWebhook(e.target.value)} placeholder="https://hooks.slack.com/services/…" autoComplete="off" spellCheck={false} />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label" htmlFor="al-sev">Notify from</label>
            <select id="al-sev" className="input" value={s.minSeverity} onChange={(e) => setS({ ...s, minSeverity: e.target.value as AlertSettings['minSeverity'] })}>
              <option value="critical">Critical only</option><option value="warning">Warning and up</option><option value="info">Everything</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="al-rep">Remind every</label>
            <div className="flex items-center gap-2">
              <input id="al-rep" type="number" min={0} max={168} className="input num" value={s.repeatHours} onChange={(e) => setS({ ...s, repeatHours: Number(e.target.value) })} />
              <span className="shrink-0 text-xs text-slate-500">hours (0 = off)</span>
            </div>
          </div>
        </div>
      </div>
      <div>
        <div className="eyebrow mb-3">Thresholds</div>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
          {num('downChecks', 'App down after', 'failed checks', 1, 30)}
          {num('latencyMs', 'Slow when p95 >', 'ms', 200, 60000)}
          {num('diskPct', 'Disk above', '%', 50, 99)}
          {num('memoryPct', 'Memory above', '%', 50, 99)}
          {num('certDays', 'Certificate within', 'days', 1, 60)}
          {num('backupHours', 'Backup older than', 'hours', 6, 240)}
        </div>
      </div>
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-ink-700 pt-4">
        <p className="text-xs text-slate-500">
          {s.recent.length ? <>Last notification: {s.recent[0].channel} {s.recent[0].ok ? 'delivered' : `failed (${s.recent[0].error})`} {ago(s.recent[0].at)}</> : 'No notifications sent yet.'}
        </p>
        <div className="flex gap-2">
          <button type="button" className="btn-secondary" onClick={() => void test()} disabled={busy !== null}>{busy === 'test' ? 'Sending…' : 'Send test'}</button>
          <button className="btn-primary" disabled={busy !== null}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </form>
  );
}
