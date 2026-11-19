import { useCallback, useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError, AppAddress, AppDetailData, AppView, DbPoint, Deployment, LogsResult } from '../api';
import { useAuth } from '../auth';
import { ago, Alert, bytes, Dot, dur, Kpi, PageHeader, seriesOf, Skeleton, Sparkline } from '../components/ui';
import { appTone } from '../health';
import { fmtPct, pctTone, UptimeBars } from '../components/uptime';
import { usePoll } from '../usePoll';
import { DatabaseTab } from './app/DatabaseTab';
import { DeployTab } from './app/DeployTab';
import { LogsTab } from './app/LogsTab';
import { EnvTab } from './app/EnvTab';
import { RepoCard } from './app/RepoCard';
import { ActionDialog, errMsg, Facts, RunningBanner, Section } from './app/shared';
import { useDialog } from '../components/Dialog';
import { Database, KeyRound, LayoutDashboard, LucideIcon, Rocket, ScrollText } from 'lucide-react';
import { smallIcon } from '../components/icons';

type Tab = 'overview' | 'deploy' | 'environment' | 'database' | 'logs';
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function PendingCard({ d, me, onDone }: { d: Deployment; me: { username: string; canDecide: boolean }; onDone: (msg: string, ok: boolean) => Promise<void> }) {
  const dialog = useDialog();
  const [busy, setBusy] = useState(false);
  const mine = d.requestedBy === me.username;
  const act = async (fn: () => Promise<Deployment>, msg: (x: Deployment) => string) => {
    setBusy(true);
    try { const x = await fn(); await onDone(msg(x), true); } catch (e) { await onDone(errMsg(e), false); } finally { setBusy(false); }
  };
  return (
    <div className="card mb-5 flex flex-wrap items-center gap-4 border-amber-500/40 bg-amber-500/[0.06] p-4">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-amber-500/40 text-amber-300">
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z" /></svg>
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-slate-100">{d.action === 'deploy' ? 'Deploy' : 'Rollback'}{d.ref ? ` → ${d.ref}` : ''} is waiting for approval</div>
        <div className="truncate text-xs text-slate-400">requested by {d.requestedBy} {ago(d.createdAt)}{d.expiresAt ? ` · expires ${when(d.expiresAt)}` : ''}{mine ? ' · another deployer or admin must approve it' : ''}</div>
      </div>
      {me.canDecide && (
        <div className="flex shrink-0 gap-2">
          {mine ? (
            <button className="btn-secondary px-3 py-1.5 text-xs" disabled={busy} onClick={() => void act(() => api.rejectDeployment(d.id, ''), () => 'Request cancelled.')}>Cancel request</button>
          ) : (
            <>
              <button className="btn-secondary px-3 py-1.5 text-xs" disabled={busy} onClick={async () => {
                const reason = await dialog.prompt({ title: `Reject this ${d.action}?`, label: 'Reason (shown to the requester)', required: false, confirmLabel: 'Reject request', danger: true });
                if (reason !== null) void act(() => api.rejectDeployment(d.id, reason), () => 'Request rejected.');
              }}>Reject</button>
              <button className="btn-primary px-3 py-1.5 text-xs" disabled={busy} onClick={() => void act(() => api.approveDeployment(d.id), (x) => `Approved: ${x.action} of ${x.project} started.`)}>Approve & start</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function UptimeCard({ instanceId, project }: { instanceId: number; project: string }) {
  const { data } = usePoll(() => api.appUptime(instanceId, project), 60_000, [instanceId, project]);
  if (!data) return null;
  const { summary: s, series, incidents } = data;
  const L = seriesOf(series, (p) => p.avgMs);
  const lat = L.values;
  return (
    <section className="card">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="min-w-0"><h2 className="font-medium text-slate-100">Uptime</h2><p className="truncate text-xs text-slate-500">{s.url ?? 'no public endpoint'} · every minute</p></div>
        <div className="flex gap-5 text-xs">
          {([['24h', s.uptime.h24], ['7d', s.uptime.d7], ['30d', s.uptime.d30], ['90d', s.uptime.d90]] as const).map(([k, v]) => (
            <div key={k} className="text-right"><div className="text-slate-500">{k}</div><div className={`num text-sm ${pctTone(v)}`}>{fmtPct(v)}</div></div>
          ))}
        </div>
      </div>
      <div className="mt-4"><UptimeBars days={s.days} count={90} /></div>
      <div className="mt-5 grid gap-5 md:grid-cols-[minmax(0,1fr)_280px]">
        <div className="hidden md:block">
          <div className="mb-1 flex items-baseline justify-between text-xs"><span className="text-slate-500">Response time · 24h (10-min average)</span><span className="num text-slate-300">p95 {s.p95ms24h != null ? `${s.p95ms24h} ms` : '—'}</span></div>
          <Sparkline values={lat} times={L.times} tone="info" max={Math.max(200, ...lat)} height={56} format={(v) => `${Math.round(v)} ms`} label="avg response (10 min)" />
        </div>
        <div className="min-w-0">
          <div className="eyebrow mb-2">Incidents</div>
          {incidents.length === 0 ? <p className="text-sm text-slate-500">None recorded.</p> : (
            <ul className="space-y-1.5 text-sm">{incidents.slice(0, 5).map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-2"><span className={`h-1.5 w-1.5 shrink-0 rounded-full ${a.resolvedAt ? 'bg-slate-500' : 'bg-rose-400'}`} /><span className="truncate text-slate-300" title={a.detail}>{a.rule === 'app_slow' ? 'Slow' : 'Down'} {ago(a.openedAt)}</span></span>
                <span className="num shrink-0 text-xs text-slate-500">{a.resolvedAt ? dur((new Date(a.resolvedAt).getTime() - new Date(a.openedAt).getTime()) / 1000) : 'ongoing'}</span>
              </li>
            ))}</ul>
          )}
        </div>
      </div>
    </section>
  );
}

/** Latest errors and warnings (deployers/admins see the lines; everyone sees the counts). */
function ProblemsCard({ view }: { view: AppView }) {
  const { app, instance, canOperate } = view;
  const [logs, setLogs] = useState<LogsResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!canOperate) return;
    api.appLogs(instance.id, app.project, { lines: 1000, level: 'warning', since: '24h', q: '' }).then(setLogs).catch((e) => setError(errMsg(e)));
  }, [instance.id, app.project, canOperate]);
  // counts cover the whole 24 hours (counted on the instance); the list shows the most recent lines found
  const errs = app.errors24h;
  const warns = Math.max(0, app.warnings24h - app.errors24h);
  const recent = (logs?.entries ?? []).slice(-8).reverse();
  const open = (level: string) => `/instances/${instance.id}/apps/${app.project}?tab=logs&level=${level}&since=24h`;
  return (
    <section className="card">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-medium text-slate-100">Errors and warnings <span className="ml-1 text-sm font-normal text-slate-500">last 24 hours</span></h2>
        <div className="flex gap-2">
          <Link to={open('error')} className={`${errs ? 'pill-bad' : 'pill-ok'} px-3 py-1 hover:brightness-125`}>{errs} error{errs === 1 ? '' : 's'}</Link>
          <Link to={open('warning')} className={`${warns ? 'pill-warn' : 'pill-ok'} px-3 py-1 hover:brightness-125`}>{warns} warning{warns === 1 ? '' : 's'}</Link>
          {canOperate && <Link to={open('all')} className="btn-secondary hidden px-3 py-1 text-xs md:inline-flex">Open all logs</Link>}
        </div>
      </div>
      {!canOperate ? (
        <p className="mt-3 text-sm text-slate-500">Log lines are visible to deployers and admins.</p>
      ) : error ? <div className="mt-3"><Alert tone="warn">{error}</Alert></div> : !logs ? <Skeleton className="mt-3 h-24" /> : recent.length === 0 ? (
        errs + warns > 0
          ? <p className="mt-3 text-sm text-slate-400">{errs + warns} problem line{errs + warns === 1 ? '' : 's'} were counted in the last 24 hours but are older than the lines fetched here. <Link className="text-indigo-300 hover:underline" to={open(errs ? 'error' : 'warning')}>Open the logs</Link> to see them.</p>
          : <p className="mt-3 text-sm text-emerald-300">Nothing logged at warning level or above in the last 24 hours.</p>
      ) : (
        <ul className="mt-3 divide-y divide-ink-800 rounded-lg border border-ink-800 bg-ink-950 font-mono text-[12px]">
          {recent.map((e, i) => (
            <li key={i} className="flex gap-3 px-3 py-1.5">
              <span className="shrink-0 text-slate-600">{new Date(e.ts).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
              <span className={`shrink-0 rounded px-1 text-[10px] font-semibold uppercase leading-5 ${e.level === 'error' ? 'bg-rose-500/15 text-rose-300' : 'bg-amber-500/15 text-amber-300'}`}>{e.level.slice(0, 4)}</span>
              <span className={`min-w-0 truncate ${e.level === 'error' ? 'text-rose-200' : 'text-amber-100'}`} title={e.message}>{e.message}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function OverviewTab({ view, detail }: { view: AppView; detail: AppDetailData | null }) {
  const { app } = view;
  const u = detail?.unit, h = detail?.health, g = detail?.git;
  return (
    <div className="space-y-5">
      <ProblemsCard view={view} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="Health" tone={app.healthy ? 'ok' : 'bad'} value={app.healthy ? `HTTP ${app.healthCode}` : 'Down'} unit={app.healthMs != null ? `${app.healthMs} ms` : undefined} />
        <Kpi label="Memory" tone="info" value={bytes(app.memory)} unit={`${app.restarts ?? 0} restarts`} />
        <Kpi label="Uptime" tone="ok" value={dur(app.uptimeSeconds)} unit={u?.cpuSeconds != null ? `${dur(u.cpuSeconds)} CPU` : app.active} className="hidden md:block" />
        <Kpi label="Logs 24h" tone={app.errors24h ? 'bad' : app.warnings24h ? 'warn' : 'ok'} value={app.warnings24h} unit={`${app.errors24h} errors`} className="hidden md:block" />
      </div>

      <section className="card">
        <div className="eyebrow">Running version</div>
        <div className="mt-2 flex min-w-0 items-baseline gap-3">
          <span className="num shrink-0 text-sm text-indigo-300">{app.sha ?? '—'}</span>
          <span className="truncate text-sm text-slate-300" title={app.subject ?? ''}>{app.subject ?? ''}</span>
        </div>
        <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-slate-500">
          {g?.author && <span>by {g.author}{g.date ? ` · committed ${ago(g.date)}` : ''}</span>}
          {app.lastDeploy && <span>deployed {ago(app.lastDeploy.at)} by {app.lastDeploy.actor}</span>}
          {g?.behind ? <span className="text-amber-300">{g.behind} commit{g.behind === 1 ? '' : 's'} waiting on {g.tracking}</span> : null}
          {view.certificate && <span className="hidden sm:inline">TLS renews in {view.certificate.daysLeft}d</span>}
        </div>
      </section>

      {app.domain && <UptimeCard instanceId={view.instance.id} project={app.project} />}

      {!detail ? <Skeleton className="h-48" /> : (
        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
          <Section title="Service" sub={u?.enabled ? `systemd · ${u.enabled}` : 'systemd'}>
            <Facts rows={[
              ['State', `${u?.active ?? '—'}${u?.sub ? ` (${u.sub})` : ''}`], ['Started', u?.startedAt ?? '—'],
              ['Restarts', String(u?.restarts ?? 0)], ['Memory', bytes(u?.memory)], ['Tasks', String(u?.tasks ?? '—')],
              ['CPU time', u?.cpuSeconds != null ? dur(u.cpuSeconds) : '—'],
              ...(u?.user ? [['Runs as', u.user]] as [string, string][] : []),
              ...(u?.workingDir ? [['Directory', u.workingDir]] as [string, string][] : []),
            ]} />
          </Section>
          <Section title="Health check" sub={h?.url ?? 'HTTP probe from the instance'}>
            <Facts rows={[['Status', h?.code ? `HTTP ${h.code}` : 'no response'], ['Latency', h?.ms != null ? `${h.ms} ms` : '—'], ['Content type', h?.contentType ?? '—']]} />
            {h?.body && <pre className="mt-3 max-h-40 overflow-y-auto whitespace-pre-wrap break-all rounded-lg bg-ink-950 p-3 font-mono text-[11px] leading-4 text-slate-400">{h.body}</pre>}
          </Section>
          <Section title="Pipeline config" sub={detail.config ? 'projects/<app>.conf on the instance' : 'Visible to deployers and admins'}>
            {detail.config ? <Facts rows={Object.entries(detail.config).map(([k, v]) => [k, v, v])} /> : (
              <Facts rows={[['Branch', detail.branch], ['Deploys 7d', String(detail.deploySummary?.deploys7d ?? 0)], ['Success 7d', detail.deploySummary?.successRate7d != null ? `${detail.deploySummary.successRate7d}%` : '—']]} />
            )}
            {u?.env && u.env.length > 0 && (
              <p className="mt-3 truncate text-2xs text-slate-500" title={u.env.map((e) => e.name).join(', ')}>
                Environment: {u.env.map((e) => (e.value ? `${e.name}=${e.value}` : e.name)).join(', ')}
              </p>
            )}
          </Section>
        </div>
      )}
    </div>
  );
}

/** Shown while an app the console created has no HTTPS yet (usually: DNS at another provider, record not added yet). */
function AddressPanel({ instanceId, project, canOperate }: { instanceId: number; project: string; canOperate: boolean }) {
  const [a, setA] = useState<AppAddress | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const load = () => api.appAddress(instanceId, project).then(setA).catch(() => undefined);
  useEffect(() => { void load(); }, [instanceId, project]);   // eslint-disable-line react-hooks/exhaustive-deps
  if (!a || (a.tls && !msg)) return null;
  const pointsHere = !!a.expected && a.resolves.length > 0 && a.resolves.every((x) => x === a.expected);
  return (
    <section className="card mb-5 space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="font-medium text-slate-100">Address</h2>
        <span className="flex items-center gap-2 text-sm text-slate-300">
          <span className={`h-2 w-2 rounded-full ${a.tls ? 'bg-emerald-400' : pointsHere ? 'bg-amber-400' : 'bg-rose-400'}`} />
          {a.tls ? 'HTTPS enabled' : pointsHere ? 'DNS ready; HTTPS not enabled yet' : 'Waiting for DNS'}
        </span>
      </div>
      {!a.tls && (
        <>
          <p className="text-sm text-slate-400">
            {pointsHere ? <>The name now points at this server. Enable HTTPS to get the certificate.</>
              : <>At the domain&rsquo;s DNS provider, add this record. Changes usually take a few minutes{a.resolves.length ? <> (it currently points at <span className="num">{a.resolves.join(', ')}</span>)</> : null}.</>}
          </p>
          <div className="overflow-x-auto rounded-lg border border-ink-700">
            <table className="w-full text-sm">
              <thead className="bg-ink-900 text-left text-xs text-slate-500"><tr><th className="px-4 py-2 font-medium">Type</th><th className="px-4 py-2 font-medium">Name</th><th className="px-4 py-2 font-medium">Value</th><th className="px-4 py-2 font-medium">TTL</th></tr></thead>
              <tbody><tr className="num text-slate-200"><td className="px-4 py-2">A</td><td className="px-4 py-2">{a.domain}</td><td className="px-4 py-2">{a.expected ?? 'server public IP'}</td><td className="px-4 py-2">300</td></tr></tbody>
            </table>
          </div>
        </>
      )}
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      {!a.tls && canOperate && (
        <div className="flex flex-wrap gap-2">
          <button className="btn-primary" disabled={busy} onClick={async () => {
            setBusy(true); setMsg(null);
            try { const r = await api.enableHttps(instanceId, project); setMsg({ tone: r.tls ? 'ok' : 'bad', text: r.reason }); await load(); }
            catch (e) { setMsg({ tone: 'bad', text: e instanceof ApiError ? e.message : 'Something went wrong.' }); } finally { setBusy(false); }
          }}>{busy ? 'Checking DNS and requesting the certificate…' : 'Check DNS and enable HTTPS'}</button>
          <button className="btn-ghost" disabled={busy} onClick={() => void load()}>Refresh</button>
        </div>
      )}
    </section>
  );
}

export function AppDetail() {
  const params = useParams();
  const { user } = useAuth();
  const instanceId = Number(params.id);
  const project = params.project ?? '';
  const [search, setSearch] = useSearchParams();
  const [dialog, setDialog] = useState<{ action: 'deploy' | 'rollback'; ref?: string; note?: string } | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [detail, setDetail] = useState<AppDetailData | null>(null);
  const [series, setSeries] = useState<DbPoint[]>([]);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  const { data, error, reload } = usePoll(() => api.appView(instanceId, project), 30_000, [instanceId, project]);
  const running = data?.deployments.find((d) => d.status === 'running') ?? null;
  const pendingReq = data?.deployments.find((d) => d.status === 'pending_approval') ?? null;
  const op = !!data?.canOperate;
  const requested = (search.get('tab') as Tab) || 'overview';
  const tab: Tab = requested;

  const loadDetail = useCallback(async (fetch = false) => {
    if (fetch) setFetching(true);
    try {
      const r = await api.appDetail(instanceId, project, fetch);
      setDetail(r.detail); setSeries(r.dbSeries); setDetailError(null);
    } catch (err) { setDetailError(errMsg(err)); } finally { setFetching(false); }
  }, [instanceId, project]);
  useEffect(() => {
    void loadDetail();
    const t = setInterval(() => { if (document.visibilityState === 'visible') void loadDetail(); }, 60_000);
    return () => clearInterval(t);
  }, [loadDetail]);

  // While a deployment runs: follow it every 5s, then refresh everything when it finishes.
  useEffect(() => {
    if (!running) return;
    const t = setInterval(async () => {
      try {
        const d = await api.deployment(running.id);
        if (d.status !== 'running') {
          setNotice({ tone: d.status === 'success' ? 'ok' : 'bad', text: `${d.action === 'deploy' ? 'Deploy' : 'Rollback'} of ${d.project} ${d.status === 'success' ? 'finished successfully' : 'failed: open the Deploy tab for the pipeline output'}.` });
          void loadDetail();
        }
        await reload();
      } catch { /* keep polling */ }
    }, 5000);
    return () => clearInterval(t);
  }, [running?.id, reload, loadDetail]);   // eslint-disable-line react-hooks/exhaustive-deps

  if (error && !data) return <Alert>{error}</Alert>;
  if (!data) return <div className="space-y-3"><Skeleton className="h-12 w-72" /><Skeleton className="h-28" /><Skeleton className="h-64" /></div>;
  const { app, instance } = data;
  const t = appTone(app);
  const tabs: [Tab, string, boolean, LucideIcon][] = [['overview', 'Overview', true, LayoutDashboard], ['deploy', 'Deploy', true, Rocket], ['environment', 'Environment', op, KeyRound], ['database', 'Database', !!app.db, Database], ['logs', 'Logs', true, ScrollText]];

  return (
    <div>
      <div className="mb-2 truncate text-xs text-slate-500">
        <Link to="/instances" className="hover:text-slate-300">Instances</Link> / <Link to={`/instances/${instance.id}`} className="hover:text-slate-300">{instance.name}</Link> / <span className="text-slate-400">{app.project}</span>
      </div>
      <PageHeader
        title={app.project}
        subtitle={<span className="flex items-center gap-2"><Dot tone={t} pulse={t === 'bad'} />{app.domain ?? app.service} · <span className="capitalize">{instance.environment}</span></span>}
        actions={op && (
          <>
            <button className="btn-secondary" onClick={() => setDialog({ action: 'rollback' })} disabled={!!running || !!pendingReq}>Roll back</button>
            <button className="btn-primary" onClick={() => setDialog({ action: 'deploy' })} disabled={!!running || !!pendingReq}>
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 19V5M5 12l7-7 7 7" /></svg>
              Deploy
            </button>
          </>
        )}
      />
      {data.policy.freeze && (
        <div className="mb-5 flex items-center gap-3 rounded-xl border border-sky-500/30 bg-sky-500/10 px-4 py-3 text-sm text-sky-200">
          <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M12 2v20M2 12h20M5 5l14 14M19 5L5 19" /></svg>
          <span className="min-w-0 flex-1">Deploy freeze “{data.policy.freeze.name}” until {when(data.policy.freeze.endsAt)}.{data.policy.rollbackAllowedInFreeze ? ' Rollbacks are still allowed.' : ''}</span>
        </div>
      )}
      {pendingReq && <PendingCard d={pendingReq} me={{ username: user?.username ?? '', canDecide: op }}
                                  onDone={async (text, ok) => { setNotice({ tone: ok ? 'ok' : 'bad', text }); await reload(); }} />}
      {running && <RunningBanner d={running} step={data.deploying?.step ?? null} />}
      {notice && <div className="mb-5"><Alert tone={notice.tone}>{notice.text}</Alert></div>}
      {detailError && !detail && <div className="mb-5"><Alert tone="warn">Details unavailable: {detailError}</Alert></div>}

      <nav aria-label="App sections" className="mb-5 flex gap-1 overflow-x-auto border-b border-ink-700">
        {tabs.filter(([, , show]) => show).map(([id, label, , I]) => (
          <button key={id} onClick={() => setSearch(id === 'overview' ? {} : { tab: id }, { replace: true })}
                  className={`-mb-px items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm transition-colors ${id === 'logs' || id === 'environment' ? 'hidden md:flex' : 'flex'} ${tab === id
                    ? 'border-indigo-400 font-medium text-slate-100' : 'border-transparent text-slate-400 hover:text-slate-200'}`}
                  aria-current={tab === id ? 'page' : undefined}>
            {smallIcon(I)}{label}{id === 'deploy' && detail?.git.behind ? <span className="ml-1.5 rounded-full bg-amber-500/20 px-1.5 text-2xs text-amber-300">{detail.git.behind}</span> : null}
          </button>
        ))}
      </nav>

      {tab === 'overview' && <AddressPanel instanceId={instanceId} project={project} canOperate={op} />}
      {tab === 'overview' && <OverviewTab view={data} detail={detail} />}
      {tab === 'deploy' && <div className="mb-5"><RepoCard view={data} isAdmin={user?.role === 'admin' && !user.isDemo} onChange={async () => { await reload(); }} /></div>}
      {tab === 'environment' && op && <div className="hidden md:block"><EnvTab instanceId={instance.id} project={app.project} isAdmin={user?.role === 'admin' && !user.isDemo} /></div>}
      {tab === 'environment' && <p className="card text-sm text-slate-500 md:hidden">Environment variables are available on larger screens.</p>}
      {tab === 'deploy' && (
        <DeployTab view={data} detail={detail} fetching={fetching} onCheck={() => void loadDetail(true)}
                   onDeploy={(ref, note) => setDialog(ref.startsWith('rollback:') ? { action: 'rollback', ref: ref.slice(9) } : { action: 'deploy', ref, note })} />
      )}
      {tab === 'database' && <DatabaseTab detail={detail} series={series} operator={op} />}
      {tab === 'logs' && op && <div className="hidden md:block"><LogsTab instanceId={instance.id} project={app.project} /></div>}
      {tab === 'logs' && !op && (
        <div className="card hidden text-sm md:block">
          <p className="font-medium text-slate-200">Logs are available to deployers and admins</p>
          <p className="mt-1 text-slate-500">Application logs can contain customer data, so they're hidden from viewers and the public demo. Sign in as a deployer or admin to read, filter, search and download them.</p>
        </div>
      )}
      {tab === 'logs' && <p className="card text-sm text-slate-500 md:hidden">Logs are available on larger screens.</p>}

      {dialog && (
        <ActionDialog action={dialog.action} project={app.project} instance={instance.name} initialRef={dialog.ref} note={dialog.note}
                      isAdmin={user?.role === 'admin' && !user.isDemo}
                      policy={{
                        frozen: data.policy.freeze && !(dialog.action === 'rollback' && data.policy.rollbackAllowedInFreeze)
                          ? `Deploys to ${instance.environment} are frozen (“${data.policy.freeze.name}”) until ${when(data.policy.freeze.endsAt)}.` : null,
                        needsApproval: data.policy.needsApproval[dialog.action], ttl: data.policy.requestTtlMinutes,
                      }}
                      onClose={() => setDialog(null)}
                      onStart={async (ref, override) => {
                        const d = await api.startDeployment(instance.id, app.project, dialog.action, ref, override);
                        setDialog(null);
                        setNotice(d.status === 'pending_approval' ? { tone: 'ok', text: 'Request sent. It starts as soon as another deployer or admin approves it.' } : null);
                        setSearch({ tab: 'deploy' }, { replace: true });
                        await reload();
                      }} />
      )}
    </div>
  );
}
