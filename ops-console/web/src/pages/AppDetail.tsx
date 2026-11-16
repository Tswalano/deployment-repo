import { FormEvent, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError, Deployment } from '../api';
import { ActivityList } from '../components/ActivityList';
import { ago, Alert, bytes, Dot, dur, Kpi, PageHeader, Skeleton } from '../components/ui';
import { appTone } from '../health';
import { usePoll } from '../usePoll';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong.');
const STATUS_PILL = { running: 'pill-info', success: 'pill-ok', failed: 'pill-bad' } as const;
const took = (d: Deployment) => (d.finishedAt ? dur((new Date(d.finishedAt).getTime() - new Date(d.createdAt).getTime()) / 1000) : '—');

/** Modal asking for the ref (deploy) or SHA (rollback) before starting. */
function ActionDialog({ action, project, instance, onClose, onStart }:
  { action: 'deploy' | 'rollback'; project: string; instance: string; onClose: () => void; onStart: (ref: string) => Promise<void> }) {
  const [ref, setRef] = useState('');
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
    <div className="fixed inset-0 z-40 grid place-items-end bg-black/60 p-0 backdrop-blur-sm sm:place-items-center sm:p-4" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <form onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="dlg-title"
            className="w-full max-w-md rounded-t-2xl border border-ink-600 bg-ink-850 p-5 shadow-2xl shadow-black/60 sm:rounded-2xl">
        <h2 id="dlg-title" className="text-base font-semibold text-slate-100">{deploy ? 'Deploy' : 'Roll back'} {project}</h2>
        <p className="mt-1 text-sm text-slate-400">
          On <span className="text-slate-200">{instance}</span>. {deploy
            ? 'The pipeline backs up the database, pulls, builds, migrates, restarts and health-checks, and rolls back automatically if the app doesn’t come up.'
            : 'Returns the app to an earlier commit and health-checks it.'}
        </p>
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

function RunningBanner({ d, step }: { d: Deployment; step: string | null }) {
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

function Logs({ instanceId, project }: { instanceId: number; project: string }) {
  const [lines, setLines] = useState(200);
  const [data, setData] = useState<{ lines: string[]; fetchedAt: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLPreElement>(null);
  async function load() {
    setBusy(true);
    setError(null);
    try { setData(await api.appLogs(instanceId, project, lines)); } catch (err) { setError(errMsg(err)); } finally { setBusy(false); }
  }
  useEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight; }, [data]);
  const tone = (l: string) => (/\b(error|fatal|exception|ERR)\b/i.test(l) ? 'text-rose-300' : /\bwarn(ing)?\b/i.test(l) ? 'text-amber-200' : 'text-slate-300');
  return (
    <section className="card hidden p-0 md:block">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
        <div>
          <h2 className="font-medium text-slate-100">Logs</h2>
          <p className="text-xs text-slate-500">{data ? `${data.lines.length} lines · fetched ${ago(data.fetchedAt)} · secrets masked on the server` : 'Fetched on demand through SSM; secrets are masked on the server.'}</p>
        </div>
        <div className="flex items-center gap-2">
          <label className="sr-only" htmlFor="log-lines">Lines</label>
          <select id="log-lines" className="input w-28 py-1.5" value={lines} onChange={(e) => setLines(Number(e.target.value))}>
            {[50, 100, 200, 500].map((n) => <option key={n} value={n}>{n} lines</option>)}
          </select>
          <button className="btn-secondary" onClick={() => void load()} disabled={busy}>{busy ? 'Fetching…' : data ? 'Refresh' : 'Load logs'}</button>
        </div>
      </div>
      {error && <div className="px-5 pb-4"><Alert>{error}</Alert></div>}
      {data && (
        <pre ref={box} className="max-h-[28rem] overflow-y-auto border-t border-ink-700 bg-ink-950 px-5 py-3 font-mono text-[12px] leading-5">
          {data.lines.map((l, i) => <div key={i} className={`whitespace-pre-wrap break-all ${tone(l)}`}>{l}</div>)}
        </pre>
      )}
    </section>
  );
}

export function AppDetail() {
  const params = useParams();
  const instanceId = Number(params.id);
  const project = params.project ?? '';
  const [dialog, setDialog] = useState<'deploy' | 'rollback' | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const { data, error, reload } = usePoll(() => api.appView(instanceId, project), 30_000, [instanceId, project]);
  const running = data?.deployments.find((d) => d.status === 'running') ?? null;

  // While a deployment runs: follow it every 5s, then reload the page data when it finishes.
  useEffect(() => {
    if (!running) return;
    const t = setInterval(async () => {
      try {
        const d = await api.deployment(running.id);
        if (d.status !== 'running') {
          setNotice({ tone: d.status === 'success' ? 'ok' : 'bad', text: `${d.action === 'deploy' ? 'Deploy' : 'Rollback'} of ${d.project} ${d.status === 'success' ? 'finished successfully' : 'failed'}.` });
          setOpen(d.id);
        }
        await reload();
      } catch { /* keep polling */ }
    }, 5000);
    return () => clearInterval(t);
  }, [running?.id, reload]);   // eslint-disable-line react-hooks/exhaustive-deps

  if (error && !data) return <Alert>{error}</Alert>;
  if (!data) return <div className="space-y-3"><Skeleton className="h-12 w-72" /><Skeleton className="h-28" /><Skeleton className="h-64" /></div>;
  const { app, instance } = data;
  const t = appTone(app);

  return (
    <div>
      <div className="mb-2 truncate text-xs text-slate-500">
        <Link to="/instances" className="hover:text-slate-300">Instances</Link> / <Link to={`/instances/${instance.id}`} className="hover:text-slate-300">{instance.name}</Link> / <span className="text-slate-400">{app.project}</span>
      </div>
      <PageHeader
        title={app.project}
        subtitle={<span className="flex items-center gap-2"><Dot tone={t} pulse={t === 'bad'} />{app.domain ?? app.service} · <span className="capitalize">{instance.environment}</span></span>}
        actions={data.canOperate && (
          <>
            <button className="btn-secondary" onClick={() => setDialog('rollback')} disabled={!!running}>Roll back</button>
            <button className="btn-primary" onClick={() => setDialog('deploy')} disabled={!!running}>
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 19V5M5 12l7-7 7 7" /></svg>
              Deploy
            </button>
          </>
        )}
      />
      {running && <RunningBanner d={running} step={data.deploying?.step ?? null} />}
      {notice && <div className="mb-5"><Alert tone={notice.tone}>{notice.text}</Alert></div>}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="Health" tone={app.healthy ? 'ok' : 'bad'} value={app.healthy ? `HTTP ${app.healthCode}` : 'Down'} unit={app.healthMs != null ? `${app.healthMs} ms` : undefined} />
        <Kpi label="Memory" tone="info" value={bytes(app.memory)} unit={`${app.restarts ?? 0} restarts`} />
        <Kpi label="Uptime" tone="ok" value={dur(app.uptimeSeconds)} unit={app.active} className="hidden md:block" />
        <Kpi label="Logs 24h" tone={app.errors24h ? 'bad' : app.warnings24h ? 'warn' : 'ok'} value={app.warnings24h} unit={`${app.errors24h} errors`} className="hidden md:block" />
      </div>

      <section className="card mt-5">
        <div className="eyebrow">Running version</div>
        <div className="mt-2 flex min-w-0 items-baseline gap-3">
          <span className="num shrink-0 text-sm text-indigo-300">{app.sha ?? '—'}</span>
          <span className="truncate text-sm text-slate-300" title={app.subject ?? ''}>{app.subject ?? ''}</span>
        </div>
        <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-slate-500">
          {app.lastDeploy && <span>Last deploy {ago(app.lastDeploy.at)} by {app.lastDeploy.actor}</span>}
          {data.database && <span className="hidden sm:inline">DB {data.database.name} · {bytes(data.database.size)} · {data.database.tables ?? '—'} tables</span>}
          {data.certificate && <span className="hidden sm:inline">TLS renews in {data.certificate.daysLeft}d</span>}
        </div>
      </section>

      <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0 space-y-5">
          <section className="card overflow-hidden p-0">
            <div className="px-5 py-4"><h2 className="font-medium text-slate-100">Console deployments</h2><p className="text-xs text-slate-500">Started from the Ops Console{data.canOperate ? ' · click a row for the pipeline output' : ''}</p></div>
            {data.deployments.length === 0 ? <p className="px-5 pb-5 text-sm text-slate-500">None yet.</p> : (
              <table className="tbl">
                <thead><tr><th className="w-[28%] sm:w-[16%]">When</th><th className="w-[24%] sm:w-[14%]">Action</th><th className="hidden sm:table-cell">Ref</th><th className="w-[26%] sm:w-[16%]">Status</th><th className="hidden w-[11%] text-right sm:table-cell">Took</th><th className="hidden w-[16%] md:table-cell">By</th></tr></thead>
                <tbody>{data.deployments.map((d) => [
                  <tr key={d.id} className={data.canOperate && d.output ? 'cursor-pointer' : ''} onClick={() => data.canOperate && d.output && setOpen(open === d.id ? null : d.id)}>
                    <td title={d.createdAt}>{ago(d.createdAt)}</td>
                    <td className="capitalize">{d.action}</td>
                    <td className="num hidden text-xs sm:table-cell" title={d.ref}>{d.ref || <span className="text-slate-500">default</span>}</td>
                    <td><span className={STATUS_PILL[d.status]}>{d.status}</span></td>
                    <td className="num hidden text-right sm:table-cell">{took(d)}</td>
                    <td className="hidden md:table-cell" title={d.requestedBy}>{d.requestedBy}</td>
                  </tr>,
                  open === d.id && d.output ? (
                    <tr key={`${d.id}-out`}><td colSpan={6} className="whitespace-normal bg-ink-950 p-0">
                      <pre className="max-h-80 overflow-y-auto whitespace-pre-wrap break-all px-5 py-3 font-mono text-[12px] leading-5 text-slate-300">{d.output}</pre>
                    </td></tr>
                  ) : null,
                ])}</tbody>
              </table>
            )}
          </section>
          {data.canOperate && <Logs instanceId={instance.id} project={app.project} />}
        </div>
        <section className="card min-w-0">
          <h2 className="font-medium text-slate-100">Pipeline history</h2>
          <ActivityList events={data.events.slice(0, 10)} showInstance={false} />
        </section>
      </div>

      {dialog && (
        <ActionDialog action={dialog} project={app.project} instance={instance.name} onClose={() => setDialog(null)}
                      onStart={async (ref) => {
                        await api.startDeployment(instance.id, app.project, dialog, ref);
                        setDialog(null);
                        setNotice(null);
                        await reload();
                      }} />
      )}
    </div>
  );
}
