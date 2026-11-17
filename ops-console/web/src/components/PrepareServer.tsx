import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError, Deployment } from '../api';
import { useAuth } from '../auth';
import { Alert } from './ui';

const err = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong.');
const WHAT = [
  ['Web server', 'nginx, with HTTPS certificates from Let\'s Encrypt'],
  ['Node.js and git', 'the newest Node.js Amazon Linux offers, to build and run your apps'],
  ['PostgreSQL 15', 'for apps that need a database, with nightly backups kept on the server'],
  ['Status agent', 'read-only; reports health, memory, disk and app status to the console'],
  ['Deploy pipeline', 'deploys from GitHub with automatic rollback'],
] as const;

/** A customer server that hasn't been prepared yet (no status agent): install what the console needs. */
export function PrepareServer({ instanceId, onDone }: { instanceId: number; onDone: () => void }) {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin' && !user.isDemo;
  const [job, setJob] = useState<Deployment | null>(null);
  const [configured, setConfigured] = useState(true);
  const [openWeb, setOpenWeb] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => api.prepareStatus(instanceId).then((r) => { setJob(r.deployment); setConfigured(r.configured); }).catch(() => undefined), [instanceId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!job || job.status !== 'running') return;
    const t = setInterval(async () => {
      try {
        const d = await api.deployment(job.id);
        setJob(d);
        if (d.status === 'success') onDone();
      } catch { /* keep polling */ }
    }, 4000);
    return () => clearInterval(t);
  }, [job, onDone]);

  const summary = useMemo(() => {
    const line = (job?.output ?? '').trim().split('\n').reverse().find((l) => l.startsWith('{') && l.includes('"step"'));
    try { return line ? JSON.parse(line) as { ok: boolean; step: string; error: string | null; node: string | null; steps: string[] } : null; } catch { return null; }
  }, [job]);

  const running = job?.status === 'running';
  return (
    <section className="card mb-6 space-y-4 border-indigo-400/30">
      <div>
        <h2 className="font-medium text-slate-100">{running ? 'Preparing this server…' : job?.status === 'success' ? 'Server prepared' : 'Prepare this server'}</h2>
        <p className="mt-1 text-sm text-slate-400">
          {running ? 'Installing everything the console needs. This takes 3 to 6 minutes; you can leave this page.'
            : 'This server doesn\'t have the console\'s software yet. Preparing it installs, once:'}
        </p>
      </div>
      {!running && job?.status !== 'success' && (
        <ul className="grid gap-2 sm:grid-cols-2">
          {WHAT.map(([t, d]) => (
            <li key={t} className="rounded-lg border border-ink-700 p-3 text-sm"><div className="font-medium text-slate-200">{t}</div><div className="mt-0.5 text-xs text-slate-500">{d}</div></li>
          ))}
        </ul>
      )}
      {job?.status === 'failed' && <Alert>{summary?.error ? `Stopped at "${summary.step}": ${summary.error}` : 'The preparation failed: see the output below.'} You can run it again: every step checks what's already done.</Alert>}
      {summary?.steps?.length ? (
        <ol className="space-y-1 text-sm">{summary.steps.map((s) => <li key={s} className="flex gap-2 text-slate-300"><span className="text-emerald-300">✓</span>{s}</li>)}</ol>
      ) : null}
      {running && <div className="h-1.5 overflow-hidden rounded-full bg-ink-700"><div className="h-full w-1/3 animate-pulse rounded-full bg-indigo-500 motion-reduce:animate-none" /></div>}
      {!configured && <Alert tone="warn">Server preparation isn't set up on this console yet (the server release bundle hasn't been published).</Alert>}
      {error && <Alert>{error}</Alert>}
      {isAdmin && !running && job?.status !== 'success' && configured && (
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-sm text-slate-300">
            <input type="checkbox" className="accent-indigo-500" checked={openWeb} onChange={(e) => setOpenWeb(e.target.checked)} />
            Open web ports 80 and 443 to the internet (needed for your apps' websites)
          </label>
          <button className="btn-primary ml-auto" disabled={busy} onClick={async () => {
            setBusy(true); setError(null);
            try { const r = await api.prepareServer(instanceId, openWeb); setJob(r.deployment); } catch (e) { setError(err(e)); } finally { setBusy(false); }
          }}>{busy ? 'Starting…' : job?.status === 'failed' ? 'Run again' : 'Prepare server'}</button>
        </div>
      )}
      {!isAdmin && !running && job?.status !== 'success' && <p className="text-sm text-slate-500">An admin of this workspace prepares the server.</p>}
      {job?.output && (job.status !== 'success') && (
        <details className="text-xs" open={job.status === 'failed'}>
          <summary className="cursor-pointer text-slate-400">Output</summary>
          <pre className="mt-2 max-h-72 overflow-y-auto whitespace-pre-wrap break-all rounded-lg bg-ink-950 p-3 font-mono text-[12px] leading-5 text-slate-300">{job.output}</pre>
        </details>
      )}
    </section>
  );
}
