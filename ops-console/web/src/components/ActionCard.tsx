import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, AssistantAction } from '../api';
import { ago } from './ui';

/**
 * A deploy, rollback or server start/reboot proposed by Ask Ops Console or a connected AI tool. Nothing has happened
 * until the person confirms here; it then runs like the console's own button (roles, approvals, freeze windows, audit).
 */
const TONE: Record<AssistantAction['status'], string> = {
  proposed: 'border-amber-400/40', running: 'border-indigo-400/40', done: 'border-emerald-500/40', failed: 'border-rose-500/40', cancelled: 'border-ink-700', expired: 'border-ink-700',
};
const STATUS: Record<AssistantAction['status'], string> = {
  proposed: 'Waiting for confirmation', running: 'Starting…', done: 'Done', failed: 'Failed', cancelled: 'Cancelled', expired: 'Expired (not confirmed within 15 minutes)',
};

export function ActionCard({ action, onChange, compact = false }: { action: AssistantAction; onChange?: (a: AssistantAction) => void; compact?: boolean }) {
  const [a, setA] = useState(action);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setA(action); }, [action.id, action.status]); // eslint-disable-line react-hooks/exhaustive-deps
  const current = a;
  const update = (x: AssistantAction) => { setA(x); onChange?.(x); window.dispatchEvent(new Event('ops:actions-changed')); };
  async function act(confirm: boolean) {
    setBusy(true); setError(null);
    try { update(confirm ? await api.confirmAction(current.id) : await api.cancelAction(current.id)); }
    catch (e) { setError(e instanceof ApiError ? e.message : 'That did not work.'); }
    finally { setBusy(false); }
  }
  const open = current.status === 'proposed';
  return (
    <div className={`rounded-xl border ${TONE[current.status]} bg-ink-950/60 p-3 text-sm`}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="font-medium text-slate-100">{current.summary}</div>
          <div className="mt-0.5 text-2xs text-slate-500">
            {STATUS[current.status]} · proposed by {current.via} {ago(current.createdAt)}
          </div>
        </div>
      </div>
      {current.note && open && <p className="mt-2 text-xs text-slate-400">{current.note}</p>}
      {current.result?.message && <p className="mt-2 text-xs text-emerald-300">{current.result.message}</p>}
      {current.result?.error && <p className="mt-2 text-xs text-rose-300">{current.result.error}</p>}
      {error && <p className="mt-2 text-xs text-rose-300">{error}</p>}
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        {open && <button className="btn-primary px-3 py-1 text-xs" disabled={busy} onClick={() => void act(true)}>{busy ? 'Working…' : 'Confirm'}</button>}
        {open && <button className="btn-ghost px-3 py-1 text-xs" disabled={busy} onClick={() => void act(false)}>Cancel</button>}
        {!compact && <Link className="text-xs text-indigo-300 hover:text-indigo-200" to={current.link}>{current.app ? 'Open the app' : 'Open the server'} →</Link>}
      </div>
      {open && <p className="mt-2 text-2xs text-slate-500">Confirming runs it as you, with the console&rsquo;s usual approvals and freeze windows.</p>}
    </div>
  );
}
