import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, AppStatus, DbPoint, NewAppCreation, Snapshot } from '../api';
import { useAuth } from '../auth';
import { ActivityList } from '../components/ActivityList';
import { ago, Alert, bytes, Dot, dur, Eyebrow, Kpi, PageHeader, pct, seriesOf, Skeleton, Sparkline } from '../components/ui';
import { Facts } from './app/shared';
import { PowerControls, StateDot } from '../components/PowerControls';
import { PrepareServer } from '../components/PrepareServer';
import { ScheduleCard } from '../components/ScheduleCard';
import { appTone } from '../health';
import { usePoll } from '../usePoll';
import { ComponentsCard } from '../components/ComponentsCard';


function AppRow({ a, instanceId }: { a: AppStatus; instanceId: number }) {
  const t = appTone(a);
  const navigate = useNavigate();
  const href = `/instances/${instanceId}/apps/${a.project}`;
  return (
    <tr className="cursor-pointer" onClick={() => navigate(href)} title={`Open ${a.project}`}>
      <td title={a.domain ?? a.project}>
        <div className="flex items-center gap-2"><Dot tone={t} /><Link to={href} onClick={(e) => e.stopPropagation()} className="truncate font-medium text-slate-100 hover:text-indigo-300 hover:underline">{a.project}</Link></div>
        <div className="truncate pl-3.5 text-xs text-slate-500">{a.domain ?? a.service}</div>
      </td>
      <td className={a.healthy ? 'text-emerald-300' : 'text-rose-300'}>{a.healthy ? `HTTP ${a.healthCode} · ${a.healthMs} ms` : `Down · ${a.healthCode ?? 'no response'}`}</td>
      <td className="num hidden lg:table-cell">{bytes(a.memory)}</td>
      <td className="hidden xl:table-cell">{dur(a.uptimeSeconds)} · {a.restarts ?? 0} restarts</td>
      <td className="hidden md:table-cell" title={a.subject ?? ''}><span className="num text-xs text-slate-400">{a.sha ?? '—'}</span> <span className="text-slate-400">{a.subject ?? ''}</span></td>
      <td className="hidden lg:table-cell" title={a.lastDeploy?.at ?? ''}>{a.lastDeploy ? `${ago(a.lastDeploy.at)} · ${a.lastDeploy.actor}` : '—'}</td>
      <td className="text-right">
        {a.errors24h || a.warnings24h ? (
          <Link to={`${href}?tab=logs&level=${a.errors24h ? 'error' : 'warning'}&since=24h`} onClick={(e) => e.stopPropagation()}
                className={`${a.errors24h ? 'pill-bad' : 'pill-warn'} hover:brightness-125`} title="Open these log lines">
            {a.errors24h ? `${a.errors24h} err` : `${a.warnings24h} warn`} →
          </Link>
        ) : <span className="pill-ok">clean</span>}
      </td>
    </tr>
  );
}

/** Fixed colour per PostgreSQL connection state, with a plain-English meaning for the legend. */
const CONN: Record<string, { label: string; bar: string; hint: string }> = {
  active: { label: 'Active (running a query)', bar: 'bg-emerald-400', hint: 'executing a statement right now' },
  idle: { label: 'Idle (pooled, waiting)', bar: 'bg-sky-400', hint: 'open and ready; apps keep these in their connection pool' },
  'idle in transaction': { label: 'Idle in transaction', bar: 'bg-amber-400', hint: 'a transaction was left open; holds locks if it lasts' },
  background: { label: 'Background (PostgreSQL)', bar: 'bg-indigo-400', hint: "PostgreSQL's own workers: checkpointer, autovacuum, WAL writer" },
  other: { label: 'Other', bar: 'bg-rose-400', hint: 'fastpath, disabled or unknown state' },
};
const CONN_ORDER = ['active', 'idle in transaction', 'idle', 'background', 'other'];
const connKey = (k: string) => (k in CONN ? k : k.startsWith('idle in transaction') ? 'idle in transaction' : 'other');

function DbServer({ s, series }: { s: Snapshot; series: Record<string, DbPoint[]> }) {
  const v = s.dbServer;
  const conns = v ? Object.values(v.connectionsByState).reduce((a, b) => a + b, 0) : 0;
  const latest = (db: string, k: 'tps' | 'cacheHitPct') => {
    const pts = (series[db] ?? []).map((p) => p[k]).filter((x): x is number => x != null);
    return pts.length ? pts[pts.length - 1] : null;
  };
  const tpsSeries = (db: string) => seriesOf(series[db] ?? [], (p) => p.tps);
  return (
    <section className="card overflow-hidden p-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-5 py-4">
        <h2 className="font-medium text-slate-100">Databases</h2>
        {v && <span className="truncate text-xs text-slate-500" title={v.version}>{v.version} · up {v.startedAt ? ago(v.startedAt).replace(' ago', '') : '—'}</span>}
      </div>
      {v && (
        <div className="grid gap-6 border-y border-ink-800 px-5 py-4 lg:grid-cols-2">
          <div>
            <div className="flex items-baseline justify-between text-xs"><span className="text-slate-400">Connections</span><span className="num text-slate-200">{conns} of {v.maxConnections ?? '—'} allowed</span></div>
            <div className="mt-2 flex h-2 overflow-hidden rounded-full bg-ink-700" role="img" aria-label="Database connections by state">
              {Object.entries(v.connectionsByState).sort(([a], [b]) => CONN_ORDER.indexOf(connKey(a)) - CONN_ORDER.indexOf(connKey(b))).map(([k, n]) => (
                <div key={k} title={`${n} ${k}: ${CONN[connKey(k)].hint}`} className={CONN[connKey(k)].bar} style={{ width: `${(n / (v.maxConnections || conns || 1)) * 100}%` }} />
              ))}
            </div>
            <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
              {Object.entries(v.connectionsByState).sort(([a], [b]) => CONN_ORDER.indexOf(connKey(a)) - CONN_ORDER.indexOf(connKey(b))).map(([k, n]) => (
                <li key={k} className="flex items-center gap-2" title={CONN[connKey(k)].hint}>
                  <span className={`h-2.5 w-2.5 shrink-0 rounded-sm ${CONN[connKey(k)].bar}`} />
                  <span className="truncate text-slate-300">{CONN[connKey(k)].label}</span>
                  <span className="num ml-auto text-slate-100">{n}</span>
                </li>
              ))}
              <li className="flex items-center gap-2" title="Connections still available before PostgreSQL refuses new ones">
                <span className="h-2.5 w-2.5 shrink-0 rounded-sm bg-ink-700 ring-1 ring-inset ring-ink-500" />
                <span className="truncate text-slate-300">Free</span>
                <span className="num ml-auto text-slate-100">{Math.max(0, (v.maxConnections ?? conns) - conns)}</span>
              </li>
            </ul>
          </div>
          <Facts rows={[
            ['Cache hit', v.cacheHitPct != null ? `${v.cacheHitPct.toFixed(2)}%` : '—'],
            ['Long-running (>60s)', String(v.longRunningQueries ?? '—')],
            ['Idle in transaction', String(v.idleInTransaction ?? '—')],
            ['Waiting locks', String(v.waitingLocks ?? '—')],
            ['Shared buffers', v.sharedBuffers ?? '—'],
          ]} />
        </div>
      )}
      {s.databases.length === 0 ? <p className="px-5 py-4 text-sm text-slate-500">None reported.</p> : (
        <table className="tbl">
          <thead><tr><th>Database</th><th className="w-[15%] text-right">Size</th><th className="hidden w-[12%] text-right xl:table-cell">Tables</th>
            <th className="w-[12%] text-right">Conns</th><th className="w-[13%] text-right">tx/s</th><th className="hidden w-[20%] xl:table-cell">24h</th></tr></thead>
          <tbody>{s.databases.map((d) => {
            const tps = latest(d.name, 'tps');
            return (
              <tr key={d.name}>
                <td className="num" title={d.name}>{d.name}</td><td className="num text-right">{bytes(d.size)}</td>
                <td className="num hidden text-right xl:table-cell">{d.tables ?? '—'}</td><td className="num text-right">{d.connections}</td>
                <td className="num text-right">{tps == null ? '—' : tps.toFixed(2)}</td>
                <td className="hidden py-1 xl:table-cell"><Sparkline {...tpsSeries(d.name)} tone="info" max={Math.max(0.5, ...tpsSeries(d.name).values)} height={24} format={(v) => `${v.toFixed(2)} tx/s`} /></td>
              </tr>
            );
          })}</tbody>
        </table>
      )}
    </section>
  );
}

/** "An app is being created here" with a link back to its live progress (survives refreshes). */
function CreatingBanner({ instanceId }: { instanceId: number }) {
  const [running, setRunning] = useState<NewAppCreation[]>([]);
  useEffect(() => {
    const load = () => api.newAppHistory(instanceId).then((h) => setRunning(h.filter((c) => c.status === 'running' && c.deploymentId))).catch(() => undefined);
    void load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [instanceId]);
  if (!running.length) return null;
  return (
    <div className="mb-4 space-y-2">
      {running.map((c) => (
        <div key={c.id} className="card flex flex-wrap items-center gap-3 border-indigo-400/40 bg-indigo-500/[0.07] p-3">
          <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-indigo-400 motion-reduce:animate-none" />
          <span className="min-w-0 flex-1 truncate text-sm text-slate-200"><b>{c.project}</b> is being created ({c.domain}) · started {ago(c.createdAt)} by {c.createdBy}</span>
          <Link className="btn-secondary px-3 py-1 text-xs" to={`/instances/${instanceId}/new-app?job=${c.deploymentId}`}>View progress</Link>
        </div>
      ))}
    </div>
  );
}

export function InstanceDetail() {
  const id = Number(useParams().id);
  const { user, site } = useAuth();
  const [refreshing, setRefreshing] = useState(false);
  const { data, error, setData } = usePoll(() => api.instance(id), 30_000, [id]);
  const i = data?.instance;
  const s = i?.status;
  const canRefresh = user?.role === 'admin' || user?.role === 'deployer';

  async function refresh() {
    setRefreshing(true);
    try { setData(await api.instance(id, true)); } finally { setRefreshing(false); }
  }

  const [powerMsg, setPowerMsg] = useState<string | null>(null);
  if (error && !data) return <Alert>{error}</Alert>;
  if (!i) return <div className="space-y-3"><Skeleton className="h-12 w-72" /><Skeleton className="h-28" /><Skeleton className="h-64" /></div>;

  const mem = seriesOf(data!.samples, (x) => x.memPct);
  const load = seriesOf(data!.samples, (x) => x.load1);
  // stopped, or not answering: the figures below are a snapshot, so they're greyed out and uptime becomes downtime
  const stopped = !!i.ec2State && i.ec2State !== 'running';
  const down = stopped || !!i.lastError;
  const downSince = stopped ? (i.ec2StateAt ?? i.lastOkAt) : i.lastOkAt;
  const stale = down ? 'opacity-50 grayscale' : '';
  return (
    <div>
      <div className="mb-2 text-xs text-slate-500"><Link to="/instances" className="hover:text-slate-300">Instances</Link> / <span className="text-slate-400">{i.name}</span></div>
      <PageHeader
        title={i.name}
        subtitle={<span title={`${i.awsInstanceId} · ${i.region}`}>{i.awsInstanceId} · {s?.host.instanceType ?? 'EC2'} · {s?.host.az ?? i.region} · <span className="capitalize">{i.environment}</span> · snapshot {ago(i.lastOkAt)}</span>}
        actions={canRefresh && (
          <>
          <StateDot state={i.ec2State ?? (s ? 'running' : null)} className="mr-1 hidden sm:inline-flex" />
          <PowerControls instance={i} isConsoleHost={!!i.isConsoleHost} dryRun={!!data?.powerDryRun} onDone={(m) => { setPowerMsg(m); void refresh(); }} />
          <Link to={`/instances/${i.id}/access`} className="btn-secondary" title="SSH access, keys, logins, OS updates">Access</Link>
          {user?.role === 'admin' && !user.isDemo && i.ec2State !== 'stopped' && <Link to={`/instances/${i.id}/terminal`} className="btn-secondary hidden md:inline-flex">Terminal</Link>}
          {user?.role === 'admin' && !user.isDemo && <Link to={`/instances/${i.id}/new-app`} className="btn-primary hidden md:inline-flex">New app</Link>}
          <button className="btn-secondary" onClick={() => void refresh()} disabled={refreshing}>
            <svg viewBox="0 0 24 24" className={`h-4 w-4 ${refreshing ? 'animate-spin motion-reduce:animate-none' : ''}`} fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M21 12a9 9 0 1 1-2.6-6.4M21 4v5h-5" /></svg>
            <span className="hidden sm:inline">{refreshing ? 'Fetching via SSM…' : 'Refresh now'}</span>
          </button>
          </>
        )}
      />
      {canRefresh && <CreatingBanner instanceId={i.id} />}
      {site.multiTenant && (!s || s.source !== 'agent') && i.ec2State !== 'stopped' && <PrepareServer instanceId={i.id} rebootToConnect={!!i.rebootToConnect} onDone={() => void refresh()} />}
      {powerMsg && <div className="mb-4"><Alert tone="ok">{powerMsg}</Alert></div>}
      {down && (
        <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-ink-700 px-4 py-3 text-sm">
          <span className="flex items-center gap-2 text-slate-200" title={i.lastError ?? undefined}>
            <span className="h-2 w-2 rounded-full bg-rose-400" />{stopped ? `Server ${i.ec2State}` : 'Server not responding'}{downSince ? ` for ${dur((Date.now() - new Date(downSince).getTime()) / 1000)}` : ''}
          </span>
          <span className="text-slate-500">Greyed-out figures are from the last snapshot{i.lastOkAt ? `, ${ago(i.lastOkAt)}` : ''}.</span>
        </div>
      )}
      {!s ? <div className="card text-sm text-slate-500">No snapshot yet.</div> : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <Kpi label="Memory" tone={down ? undefined : 'info'} value={`${pct(s.host.memory.used, s.host.memory.total).toFixed(0)}%`} unit={`of ${bytes(s.host.memory.total)}`} className={stale} />
            <Kpi label="Disk" tone={down ? undefined : pct(s.host.disk.used, s.host.disk.total) > 85 ? 'warn' : 'ok'} value={`${pct(s.host.disk.used, s.host.disk.total).toFixed(0)}%`} unit={`${bytes(s.host.disk.free)} free`} className={stale} />
            <Kpi label="Load" tone={down ? undefined : 'ok'} value={(s.host.load[0] ?? 0).toFixed(2)} unit={`${s.host.cpus} vCPU`} className={`col-span-2 md:col-span-1 ${stale}`} />
            <Kpi label="Swap" tone={down ? undefined : pct(s.host.swap.used, s.host.swap.total) > 50 ? 'warn' : 'ok'} value={bytes(s.host.swap.used)} unit={`of ${bytes(s.host.swap.total)}`} className={`hidden md:block ${stale}`} />
            {down
              ? <Kpi label="Downtime" tone="bad" value={downSince ? dur((Date.now() - new Date(downSince).getTime()) / 1000) : '—'} unit={stopped ? i.ec2State! : 'not responding'} className="hidden md:block" />
              : <Kpi label="Uptime" tone="info" value={dur(s.host.uptimeSeconds)} unit={s.source === 'agent' ? 'agent' : 'basic'} className="hidden md:block" />}
          </div>

          <div className={`mt-5 hidden gap-5 sm:grid sm:grid-cols-2 ${stale}`}>
            <div className="card p-0"><div className="px-5 pt-4 text-sm text-slate-400">Memory · 24h</div><div className="pt-2"><Sparkline {...mem} tone="info" format={(v) => `${v.toFixed(1)}%`} label="memory used" /></div></div>
            <div className="card p-0"><div className="px-5 pt-4 text-sm text-slate-400">Load average · 24h</div><div className="pt-2"><Sparkline {...load} tone="warn" max={Math.max(2, ...load.values)} format={(v) => v.toFixed(2)} label="load (1 min)" /></div></div>
          </div>

          <section className={`card mt-5 overflow-hidden p-0 ${stale}`}>
            <div className="flex items-center justify-between px-5 py-4"><h2 className="font-medium text-slate-100">Applications</h2><span className="text-xs text-slate-500">{s.apps.filter((a) => a.healthy).length}/{s.apps.length} healthy</span></div>
            {s.apps.length === 0 ? <p className="px-5 pb-5 text-sm text-slate-500">{s.source === 'basic' ? 'This instance has no ops agent, so only host metrics are available.' : 'No apps configured.'}</p> : (
              <table className="tbl">
                <thead><tr>
                  <th className="w-[34%] md:w-[20%]">App</th><th className="w-[40%] md:w-[18%]">Health</th>
                  <th className="hidden w-[10%] lg:table-cell">Memory</th><th className="hidden w-[14%] xl:table-cell">Uptime</th>
                  <th className="hidden md:table-cell">Running version</th><th className="hidden w-[15%] lg:table-cell">Last deploy</th>
                  <th className="w-[26%] text-right md:w-[11%]">24h</th>
                </tr></thead>
                <tbody>{s.apps.map((a) => <AppRow key={a.project} a={a} instanceId={i.id} />)}</tbody>
              </table>
            )}
          </section>

          {s.source === 'agent' && !stopped && <div className="mt-5 hidden md:block"><ComponentsCard instanceId={i.id} /></div>}

          <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
            <div className={`hidden min-w-0 space-y-5 md:block ${stale}`}>
              <DbServer s={s} series={data!.dbSeries} />
              <section className="card">
                <h2 className="font-medium text-slate-100">Services, certificates & backups</h2>
                <div className="mt-4 grid gap-6 sm:grid-cols-3">
                  <div><Eyebrow>Services</Eyebrow><ul className="mt-2 space-y-1.5 text-sm">{s.services.map((v) => (
                    <li key={v.unit} className="flex items-center gap-2"><Dot tone={v.active === 'active' ? 'ok' : 'warn'} /><span className="truncate text-slate-300" title={v.unit}>{v.unit}</span></li>
                  ))}</ul></div>
                  <div><Eyebrow>Certificates</Eyebrow><ul className="mt-2 space-y-1.5 text-sm">{s.certificates.map((c) => (
                    <li key={c.domain} className="flex items-center justify-between gap-2"><span className="truncate text-slate-300" title={c.domain}>{c.domain}</span>
                      <span className={`num shrink-0 text-xs ${(c.daysLeft ?? 99) < 14 ? 'text-rose-300' : (c.daysLeft ?? 99) < 30 ? 'text-amber-300' : 'text-emerald-300'}`}>{c.daysLeft ?? '—'}d</span></li>
                  ))}</ul></div>
                  <div><Eyebrow>Backups</Eyebrow><p className={`mt-2 text-sm ${s.backups?.ok ? 'text-emerald-300' : 'text-slate-400'}`}>{s.backups ? `${s.backups.ok ? 'Last backup OK' : 'Last backup FAILED'} · ${ago(s.backups.at)}` : 'No backup status reported'}</p></div>
                </div>
              </section>
            </div>
            <div className="min-w-0 space-y-5">
            <ScheduleCard instanceId={i.id} />
            <section className="card min-w-0">
              <h2 className="font-medium text-slate-100">Recent deployments</h2>
              <ActivityList events={s.deployEvents.slice(0, 8)} showInstance={false} />
            </section>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
