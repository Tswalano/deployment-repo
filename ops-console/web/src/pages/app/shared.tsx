import { FormEvent, ReactNode, useEffect, useRef, useState } from 'react';
import { ApiError, Deployment } from '../../api';
import { Alert, ago, dur } from '../../components/ui';

export const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong.');
export const STATUS_PILL = { running: 'pill-info', success: 'pill-ok', failed: 'pill-bad' } as const;
export const took = (d: Deployment) => (d.finishedAt ? dur((new Date(d.finishedAt).getTime() - new Date(d.createdAt).getTime()) / 1000) : '—');
export const num = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString('en-US'));

export function Section({ title, sub, actions, children, flush }: { title: string; sub?: ReactNode; actions?: ReactNode; children: ReactNode; flush?: boolean }) {
  return (
    <section className={`card min-w-0 ${flush ? 'overflow-hidden p-0' : ''}`}>
      <div className={`flex flex-wrap items-start justify-between gap-3 ${flush ? 'px-5 py-4' : 'mb-4'}`}>
        <div className="min-w-0"><h2 className="font-medium text-slate-100">{title}</h2>{sub && <p className="mt-0.5 text-xs text-slate-500">{sub}</p>}</div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

/** Two-column key/value list that truncates long values. */
export function Facts({ rows }: { rows: [string, ReactNode, string?][] }) {
  return (
    <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-6 gap-y-2 text-sm">
      {rows.map(([k, v, title]) => (
        <div key={k} className="contents">
          <dt className="truncate text-slate-500">{k}</dt>
          <dd className="truncate text-right text-slate-200" title={title ?? (typeof v === 'string' ? v : undefined)}>{v ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Modal asking for the ref (deploy) or SHA (rollback) before starting. */
export function ActionDialog({ action, project, instance, initialRef = '', note, onClose, onStart }:
  { action: 'deploy' | 'rollback'; project: string; instance: string; initialRef?: string; note?: string;
    onClose: () => void; onStart: (ref: string) => Promise<void> }) {
  const [ref, setRef] = useState(initialRef);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [busy, onClose]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try { await onStart(ref.trim()); } catch (err) { setError(errMsg(err)); setBusy(false); }
  }
  const deploy = action === 'deploy';
  return (
    <div className="fixed inset-0 z-40 grid place-items-end bg-black/60 backdrop-blur-sm sm:place-items-center sm:p-4" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <form onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="dlg-title"
            className="w-full max-w-md rounded-t-2xl border border-ink-600 bg-ink-850 p-5 shadow-2xl shadow-black/60 sm:rounded-2xl">
        <h2 id="dlg-title" className="text-base font-semibold text-slate-100">{deploy ? 'Deploy' : 'Roll back'} {project}</h2>
        <p className="mt-1 text-sm text-slate-400">
          On <span className="text-slate-200">{instance}</span>. {deploy
            ? 'The pipeline backs up the database, pulls, builds, migrates, restarts and health-checks, and rolls back automatically if the app doesn’t come up.'
            : 'Returns the app to an earlier commit and health-checks it.'}
        </p>
        {note && <p className="mt-2 rounded-lg border border-ink-600 bg-ink-900 px-3 py-2 text-xs text-slate-300">{note}</p>}
        <label className="label mt-4" htmlFor="dlg-ref">{deploy ? 'Branch, tag or commit' : 'Commit SHA'} <span className="text-slate-600">(optional)</span></label>
        <input id="dlg-ref" ref={input} className="input font-mono" value={ref} onChange={(e) => setRef(e.target.value)} maxLength={100}
               placeholder={deploy ? 'default branch' : 'previous good deploy'} autoComplete="off" spellCheck={false} />
        {error && <div className="mt-3"><Alert>{error}</Alert></div>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className={deploy ? 'btn-primary' : 'btn-danger'} disabled={busy}>{busy ? 'Starting…' : deploy ? 'Deploy' : 'Roll back'}</button>
        </div>
      </form>
    </div>
  );
}

export function RunningBanner({ d, step }: { d: Deployment; step: string | null }) {
  return (
    <div className="card mb-5 flex items-center gap-4 border-indigo-400/40 bg-indigo-500/[0.07] p-4">
      <span className="relative grid h-9 w-9 shrink-0 place-items-center">
        <span className="absolute inset-0 animate-ping rounded-full bg-indigo-400/20 motion-reduce:animate-none" />
        <svg viewBox="0 0 24 24" className="h-5 w-5 animate-spin text-indigo-300 motion-reduce:animate-none" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M21 12a9 9 0 1 1-6.2-8.6" /></svg>
      </span>
      <div className="min-w-0">
        <div className="truncate text-sm font-medium text-slate-100">{d.action === 'deploy' ? 'Deploying' : 'Rolling back'} {d.project}{d.ref ? ` → ${d.ref}` : ''}</div>
        <div className="truncate text-xs text-slate-400">started by {d.requestedBy} {ago(d.createdAt)}{step ? ` · step: ${step.replace(/_/g, ' ')}` : ''} · {d.ssmStatus ?? 'sending'}</div>
      </div>
    </div>
  );
}
