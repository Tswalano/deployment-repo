import { useCallback, useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, AppDetailData, AppView, DbPoint } from '../api';
import { ago, Alert, bytes, Dot, dur, Kpi, PageHeader, Skeleton, Sparkline } from '../components/ui';
import { appTone } from '../health';
import { fmtPct, pctTone, UptimeBars } from '../components/uptime';
import { usePoll } from '../usePoll';
import { DatabaseTab } from './app/DatabaseTab';
import { DeployTab } from './app/DeployTab';
import { LogsTab } from './app/LogsTab';
import { ActionDialog, errMsg, Facts, RunningBanner, Section } from './app/shared';

type Tab = 'overview' | 'deploy' | 'database' | 'logs';

function UptimeCard({ instanceId, project }: { instanceId: number; project: string }) {
  const { data } = usePoll(() => api.appUptime(instanceId, project), 60_000, [instanceId, project]);
  if (!data) return null;
  const { summary: s, series, incidents } = data;
  const lat = series.map((p) => p.avgMs).filter((x): x is number => x != null);
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
          <Sparkline values={lat} tone="info" max={Math.max(200, ...lat)} height={56} />
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

function OverviewTab({ view, detail }: { view: AppView; detail: AppDetailData | null }) {
  const { app } = view;
  const u = detail?.unit, h = detail?.health, g = detail?.git;
  return (
    <div className="space-y-5">
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

export function AppDetail() {
  const params = useParams();
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
  const op = !!data?.canOperate;
  const requested = (search.get('tab') as Tab) || 'overview';
  const tab: Tab = requested === 'logs' && !op ? 'overview' : requested;

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
  const tabs: [Tab, string, boolean][] = [['overview', 'Overview', true], ['deploy', 'Deploy', true], ['database', 'Database', !!app.db], ['logs', 'Logs', op]];

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
            <button className="btn-secondary" onClick={() => setDialog({ action: 'rollback' })} disabled={!!running}>Roll back</button>
            <button className="btn-primary" onClick={() => setDialog({ action: 'deploy' })} disabled={!!running}>
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 19V5M5 12l7-7 7 7" /></svg>
              Deploy
            </button>
          </>
        )}
      />
      {running && <RunningBanner d={running} step={data.deploying?.step ?? null} />}
      {notice && <div className="mb-5"><Alert tone={notice.tone}>{notice.text}</Alert></div>}
      {detailError && !detail && <div className="mb-5"><Alert tone="warn">Details unavailable: {detailError}</Alert></div>}

      <nav aria-label="App sections" className="mb-5 flex gap-1 overflow-x-auto border-b border-ink-700">
        {tabs.filter(([, , show]) => show).map(([id, label]) => (
          <button key={id} onClick={() => setSearch(id === 'overview' ? {} : { tab: id }, { replace: true })}
                  className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm transition-colors ${id === 'logs' ? 'hidden md:block' : ''} ${tab === id
                    ? 'border-indigo-400 font-medium text-slate-100' : 'border-transparent text-slate-400 hover:text-slate-200'}`}
                  aria-current={tab === id ? 'page' : undefined}>
            {label}{id === 'deploy' && detail?.git.behind ? <span className="ml-1.5 rounded-full bg-amber-500/20 px-1.5 text-2xs text-amber-300">{detail.git.behind}</span> : null}
          </button>
        ))}
      </nav>

      {tab === 'overview' && <OverviewTab view={data} detail={detail} />}
      {tab === 'deploy' && (
        <DeployTab view={data} detail={detail} fetching={fetching} onCheck={() => void loadDetail(true)}
                   onDeploy={(ref, note) => setDialog(ref.startsWith('rollback:') ? { action: 'rollback', ref: ref.slice(9) } : { action: 'deploy', ref, note })} />
      )}
      {tab === 'database' && <DatabaseTab detail={detail} series={series} operator={op} />}
      {tab === 'logs' && op && <div className="hidden md:block"><LogsTab instanceId={instance.id} project={app.project} /></div>}
      {tab === 'logs' && <p className="card text-sm text-slate-500 md:hidden">Logs are available on larger screens.</p>}

      {dialog && (
        <ActionDialog action={dialog.action} project={app.project} instance={instance.name} initialRef={dialog.ref} note={dialog.note}
                      onClose={() => setDialog(null)}
                      onStart={async (ref) => {
                        await api.startDeployment(instance.id, app.project, dialog.action, ref);
                        setDialog(null);
                        setNotice(null);
                        setSearch({ tab: 'deploy' }, { replace: true });
                        await reload();
                      }} />
      )}
    </div>
  );
}
