import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, AppStatus } from '../api';
import { useAuth } from '../auth';
import { ActivityList } from '../components/ActivityList';
import { ago, Alert, bytes, Dot, dur, Eyebrow, Kpi, PageHeader, pct, Skeleton, Sparkline } from '../components/ui';
import { appTone } from '../health';
import { usePoll } from '../usePoll';

const toneText = { ok: 'text-emerald-300', warn: 'text-amber-300', bad: 'text-rose-300', info: 'text-indigo-300', mute: 'text-slate-400' };

function AppRow({ a, instanceId }: { a: AppStatus; instanceId: number }) {
  const t = appTone(a);
  return (
    <tr>
      <td title={a.domain ?? a.project}>
        <div className="flex items-center gap-2"><Dot tone={t} /><Link to={`/instances/${instanceId}/apps/${a.project}`} className="truncate font-medium text-slate-100 hover:text-indigo-300 hover:underline">{a.project}</Link></div>
        <div className="truncate pl-3.5 text-xs text-slate-500">{a.domain ?? a.service}</div>
      </td>
      <td className={toneText[t]}>{a.healthy ? `HTTP ${a.healthCode} · ${a.healthMs} ms` : `Down · ${a.healthCode ?? 'no response'}`}</td>
      <td className="num hidden lg:table-cell">{bytes(a.memory)}</td>
      <td className="hidden xl:table-cell">{dur(a.uptimeSeconds)} · {a.restarts ?? 0} restarts</td>
      <td className="hidden md:table-cell" title={a.subject ?? ''}><span className="num text-xs text-slate-400">{a.sha ?? '—'}</span> <span className="text-slate-400">{a.subject ?? ''}</span></td>
      <td className="hidden lg:table-cell" title={a.lastDeploy?.at ?? ''}>{a.lastDeploy ? `${ago(a.lastDeploy.at)} · ${a.lastDeploy.actor}` : '—'}</td>
      <td className="text-right">
        {a.errors24h ? <span className="pill-bad">{a.errors24h} err</span> : a.warnings24h ? <span className="pill-warn">{a.warnings24h} warn</span> : <span className="pill-ok">clean</span>}
      </td>
    </tr>
  );
}

export function InstanceDetail() {
  const id = Number(useParams().id);
  const { user } = useAuth();
  const [refreshing, setRefreshing] = useState(false);
  const { data, error, setData } = usePoll(() => api.instance(id), 30_000, [id]);
  const i = data?.instance;
  const s = i?.status;
  const canRefresh = user?.role === 'admin' || user?.role === 'deployer';

  async function refresh() {
    setRefreshing(true);
    try { setData(await api.instance(id, true)); } finally { setRefreshing(false); }
  }

  if (error && !data) return <Alert>{error}</Alert>;
  if (!i) return <div className="space-y-3"><Skeleton className="h-12 w-72" /><Skeleton className="h-28" /><Skeleton className="h-64" /></div>;

  const mem = data!.samples.map((x) => x.memPct ?? 0);
  const load = data!.samples.map((x) => x.load1 ?? 0);
  return (
    <div>
      <div className="mb-2 text-xs text-slate-500"><Link to="/instances" className="hover:text-slate-300">Instances</Link> / <span className="text-slate-400">{i.name}</span></div>
      <PageHeader
        title={i.name}
        subtitle={<span title={`${i.awsInstanceId} · ${i.region}`}>{i.awsInstanceId} · {s?.host.instanceType ?? 'EC2'} · {s?.host.az ?? i.region} · <span className="capitalize">{i.environment}</span> · snapshot {ago(i.lastOkAt)}</span>}
        actions={canRefresh && (
          <button className="btn-secondary" onClick={() => void refresh()} disabled={refreshing}>
            <svg viewBox="0 0 24 24" className={`h-4 w-4 ${refreshing ? 'animate-spin motion-reduce:animate-none' : ''}`} fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M21 12a9 9 0 1 1-2.6-6.4M21 4v5h-5" /></svg>
            <span className="hidden sm:inline">{refreshing ? 'Fetching via SSM…' : 'Refresh now'}</span>
          </button>
        )}
      />
      {i.lastError && <div className="mb-4"><Alert tone="warn">Last fetch failed ({i.lastError}). Showing the snapshot from {ago(i.lastOkAt)}.</Alert></div>}
      {!s ? <div className="card text-sm text-slate-500">No snapshot yet.</div> : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <Kpi label="Memory" tone="info" value={`${pct(s.host.memory.used, s.host.memory.total).toFixed(0)}%`} unit={`of ${bytes(s.host.memory.total)}`} />
            <Kpi label="Disk" tone={pct(s.host.disk.used, s.host.disk.total) > 85 ? 'warn' : 'ok'} value={`${pct(s.host.disk.used, s.host.disk.total).toFixed(0)}%`} unit={`${bytes(s.host.disk.free)} free`} />
            <Kpi label="Load" tone="ok" value={(s.host.load[0] ?? 0).toFixed(2)} unit={`${s.host.cpus} vCPU`} className="col-span-2 md:col-span-1" />
            <Kpi label="Swap" tone={pct(s.host.swap.used, s.host.swap.total) > 50 ? 'warn' : 'ok'} value={bytes(s.host.swap.used)} unit={`of ${bytes(s.host.swap.total)}`} className="hidden md:block" />
            <Kpi label="Uptime" tone="info" value={dur(s.host.uptimeSeconds)} unit={s.source === 'agent' ? 'agent' : 'basic'} className="hidden md:block" />
          </div>

          <div className="mt-5 hidden gap-5 sm:grid sm:grid-cols-2">
            <div className="card p-0"><div className="px-5 pt-4 text-sm text-slate-400">Memory · 24h</div><div className="pt-2"><Sparkline values={mem} tone="info" /></div></div>
            <div className="card p-0"><div className="px-5 pt-4 text-sm text-slate-400">Load average · 24h</div><div className="pt-2"><Sparkline values={load} tone="warn" max={Math.max(2, ...load)} /></div></div>
          </div>

          <section className="card mt-5 overflow-hidden p-0">
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

          <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
            <div className="hidden min-w-0 space-y-5 md:block">
              <section className="card overflow-hidden p-0">
                <h2 className="px-5 py-4 font-medium text-slate-100">Databases</h2>
                {s.databases.length === 0 ? <p className="px-5 pb-5 text-sm text-slate-500">None reported.</p> : (
                  <table className="tbl">
                    <thead><tr><th>Database</th><th className="w-[18%] text-right">Size</th><th className="w-[16%] text-right">Tables</th><th className="w-[18%] text-right">Connections</th></tr></thead>
                    <tbody>{s.databases.map((d) => (
                      <tr key={d.name}><td className="num" title={d.name}>{d.name}</td><td className="num text-right">{bytes(d.size)}</td><td className="num text-right">{d.tables ?? '—'}</td><td className="num text-right">{d.connections}</td></tr>
                    ))}</tbody>
                  </table>
                )}
              </section>
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
            <section className="card min-w-0">
              <h2 className="font-medium text-slate-100">Recent deployments</h2>
              <ActivityList events={s.deployEvents.slice(0, 8)} showInstance={false} />
            </section>
          </div>
        </>
      )}
    </div>
  );
}
