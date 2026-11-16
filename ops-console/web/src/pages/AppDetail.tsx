import { useCallback, useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, AppDetailData, AppView, DbPoint } from '../api';
import { ago, Alert, bytes, Dot, dur, Kpi, PageHeader, Skeleton } from '../components/ui';
import { appTone } from '../health';
import { usePoll } from '../usePoll';
import { DatabaseTab } from './app/DatabaseTab';
import { DeployTab } from './app/DeployTab';
import { LogsTab } from './app/LogsTab';
import { ActionDialog, errMsg, Facts, RunningBanner, Section } from './app/shared';

type Tab = 'overview' | 'deploy' | 'database' | 'logs';

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
