import { useEffect, useRef, useState } from 'react';
import { api, ApiError, Instance } from '../api';
import { useAuth } from '../auth';
import { Alert } from './ui';

type Action = 'start' | 'reboot' | 'stop' | 'terminate';
const COPY: Record<Action, { title: string; body: string; button: string; danger: boolean; admin: boolean }> = {
  start: { title: 'Start', body: 'Boots the instance. Apps start with it; the console picks it up within a few minutes.', button: 'Start instance', danger: false, admin: false },
  reboot: { title: 'Reboot', body: 'Restarts the operating system. Every app on it is down for about a minute.', button: 'Reboot instance', danger: false, admin: false },
  stop: { title: 'Stop', body: 'Shuts the instance down. Every app on it goes offline until someone starts it again. Disks and data are kept.', button: 'Stop instance', danger: true, admin: true },
  terminate: { title: 'Terminate', body: 'Permanently deletes the instance. Its root disk is usually deleted with it, including any data and local backups on it. This cannot be undone.', button: 'Terminate permanently', danger: true, admin: true },
};

export const stateTone = (s: string | null | undefined) =>
  s === 'running' ? 'pill-ok' : s === 'stopped' || s === 'terminated' ? 'pill-bad' : s ? 'pill-warn' : 'pill-mute';

export function PowerControls({ instance, isConsoleHost, dryRun, onDone }:
  { instance: Instance; isConsoleHost: boolean; dryRun: boolean; onDone: (msg: string) => void }) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [action, setAction] = useState<Action | null>(null);
  const [confirm, setConfirm] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  if (!user || user.isDemo || user.role === 'viewer') return null;
  const isAdmin = user.role === 'admin';
  const state = instance.ec2State ?? (instance.status ? 'running' : null);
  const available = (a: Action) => {
    if (COPY[a].admin && !isAdmin) return 'admins only';
    if (isConsoleHost && (a === 'stop' || a === 'terminate')) return 'the console runs here';
    if (a === 'start' && state === 'running') return 'already running';
    if ((a === 'reboot' || a === 'stop') && state === 'stopped') return 'not running';
    if (state === 'terminated' || state === 'shutting-down') return 'terminated';
    return null;
  };
  const c = action ? COPY[action] : null;
  const needsName = action === 'stop' || action === 'terminate';

  async function run() {
    setBusy(true); setError(null);
    try {
      const r = await api.power(instance.id, action!, { confirm, reason });
      setAction(null); setConfirm(''); setReason('');
      onDone(r.message);
    } catch (e) { setError(e instanceof ApiError ? e.message : 'Something went wrong.'); } finally { setBusy(false); }
  }

  return (
    <div className="relative" ref={ref}>
      <button className="btn-secondary" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}>
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M12 3v9M6.3 7.7a8 8 0 1 0 11.4 0" /></svg>
        <span className="hidden sm:inline">Power</span>
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-11 z-30 w-60 overflow-hidden rounded-xl border border-ink-600 bg-ink-850 shadow-2xl shadow-black/50">
          {(['start', 'reboot', 'stop', 'terminate'] as Action[]).map((a) => {
            const why = available(a);
            return (
              <button key={a} role="menuitem" disabled={!!why} onClick={() => { setOpen(false); setError(null); setAction(a); }}
                      className={`flex w-full items-center justify-between px-4 py-2.5 text-left text-sm disabled:cursor-not-allowed disabled:opacity-40 ${COPY[a].danger ? 'text-rose-300 hover:bg-rose-500/10' : 'text-slate-200 hover:bg-ink-800'}`}>
                <span>{COPY[a].title}</span>{why && <span className="text-2xs text-slate-500">{why}</span>}
              </button>
            );
          })}
        </div>
      )}
      {action && c && (
        <div className="fixed inset-0 z-40 grid place-items-end bg-black/60 backdrop-blur-sm sm:place-items-center sm:p-4" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) setAction(null); }}>
          <div role="dialog" aria-modal="true" aria-labelledby="pw-title" className={`w-full max-w-md rounded-t-2xl border bg-ink-850 p-5 shadow-2xl shadow-black/60 sm:rounded-2xl ${c.danger ? 'border-rose-500/40' : 'border-ink-600'}`}>
            <h2 id="pw-title" className="text-base font-semibold text-slate-100">{c.title} {instance.name}?</h2>
            <p className="mt-1 text-xs text-slate-500">{instance.awsInstanceId} · {instance.region} · <span className="capitalize">{instance.environment}</span></p>
            <p className={`mt-3 text-sm ${c.danger ? 'text-rose-200' : 'text-slate-300'}`}>{c.body}</p>
            {isConsoleHost && action === 'reboot' && <p className="mt-2 text-sm text-amber-200">The console itself runs on this instance and will be unavailable while it reboots.</p>}
            {dryRun && <p className="mt-2 rounded-lg border border-fuchsia-500/30 bg-fuchsia-500/10 px-3 py-2 text-xs text-fuchsia-200">Local test mode: AWS will only confirm the permission (DryRun). Nothing changes.</p>}
            {needsName && (
              <>
                <label className="label mt-4" htmlFor="pw-confirm">Type <span className="font-mono text-slate-200">{instance.name}</span> to confirm</label>
                <input id="pw-confirm" className="input" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" spellCheck={false} autoFocus />
              </>
            )}
            {action === 'terminate' && (
              <>
                <label className="label mt-3" htmlFor="pw-reason">Reason (logged and sent to the alert channels)</label>
                <input id="pw-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
              </>
            )}
            {error && <div className="mt-3"><Alert>{error}</Alert></div>}
            <div className="mt-5 flex justify-end gap-2">
              <button className="btn-ghost" onClick={() => setAction(null)} disabled={busy}>Cancel</button>
              <button className={c.danger ? 'btn-danger' : 'btn-primary'} onClick={() => void run()}
                      disabled={busy || (needsName && confirm !== instance.name) || (action === 'terminate' && reason.trim().length < 10)}>
                {busy ? 'Working…' : c.button}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
