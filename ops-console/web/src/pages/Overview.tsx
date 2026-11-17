import { Link } from 'react-router-dom';
import { api, DeployEvent, Instance, Overview as OverviewData, Sample } from '../api';
import { ActivityList } from '../components/ActivityList';
import { InstanceCard } from '../components/InstanceCard';
import { ago, Alert, bytes, Cells, Eyebrow, Kpi, PageHeader, Skeleton, Sparkline, Tone } from '../components/ui';
import { appTone, sortInstances } from '../health';
import { UptimeTable } from '../components/uptime';
import { usePoll } from '../usePoll';


/** Average a metric across instances per ~5 minute bucket. */
function series(samples: Sample[], key: 'memPct' | 'diskPct' | 'load1'): { values: number[]; times: string[] } {
  const buckets = new Map<number, number[]>();
  for (const s of samples) {
    const v = s[key];
    if (v == null) continue;
    const b = Math.floor(new Date(s.at).getTime() / 300_000);
    buckets.set(b, [...(buckets.get(b) ?? []), v]);
  }
  const sorted = [...buckets.entries()].sort((a, b) => a[0] - b[0]);
  return { values: sorted.map(([, vs]) => vs.reduce((a, v) => a + v, 0) / vs.length), times: sorted.map(([b]) => new Date(b * 300_000).toISOString()) };
}

const trend = (values: number[]): string | null => {
  if (values.length < 2) return null;
  const d = values[values.length - 1] - values[0];
  return `${d >= 0 ? '+' : ''}${d.toFixed(1)}`;
};

function MetricCard({ title, value, unit, values, times, tone, max, format }: { title: string; value: string; unit?: string; values: number[]; times: string[]; tone: Tone; max?: number; format?: (v: number) => string }) {
  const t = trend(values);
  return (
    <div className="card flex min-w-0 flex-col p-0">
      <div className="flex items-start justify-between px-5 pt-4">
        <span className="text-sm text-slate-400">{title}</span>
        {t && <span className={`num text-xs ${t.startsWith('+') && t !== '+0.0' ? 'text-amber-300' : 'text-emerald-300'}`} title="change over the last 24h">{t}{unit === '%' ? '%' : ''}</span>}
      </div>
      <div className="num px-5 pt-1 text-[1.7rem] font-medium tracking-tight text-slate-100">{value}<span className="ml-1 text-base text-slate-500">{unit}</span></div>
      <div className="mt-auto pt-3"><Sparkline values={values} times={times} tone={tone} max={max} format={format} label={title.toLowerCase()} /></div>
    </div>
  );
}

function ServiceHealth({ instances }: { instances: Instance[] }) {
  const apps = instances.flatMap((i) => (i.status?.apps ?? []).map((a) => ({ a, i })));
  const offline = instances.filter((i) => !i.status || i.lastError);
  const cells = [
    ...apps.map(({ a, i }) => ({ key: `${i.id}-${a.project}`, tone: appTone(a), href: `/instances/${i.id}/apps/${a.project}`, title: `${a.project} on ${i.name}: ${a.healthy ? 'healthy' : `down (HTTP ${a.healthCode ?? 'none'})`}${a.warnings24h ? ` · ${a.warnings24h} warnings/24h` : ''}` })),
    ...offline.map((i) => ({ key: `off-${i.id}`, tone: 'mute' as Tone, title: `${i.name}: unreachable` })),
  ];
  const count = (t: Tone) => cells.filter((c) => c.tone === t).length;
  const svcCount = instances.reduce((n, i) => n + (i.status?.services.length ?? 0), 0);
  const certs = instances.flatMap((i) => i.status?.certificates ?? []);
  const dbCount = instances.reduce((n, i) => n + (i.status?.databases.length ?? 0), 0);
  return (
    <section className="card grid gap-6 lg:grid-cols-[1fr_auto]">
      <div className="min-w-0">
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-medium text-slate-100">Service health <span className="ml-1 text-sm font-normal text-slate-500">{apps.length} apps monitored · click one to open it</span></h2>
          <span className="pill-ok"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />LIVE</span>
        </div>
        <div className="mt-4">{cells.length ? <Cells items={cells} /> : <p className="text-sm text-slate-500">No apps reported yet.</p>}</div>
        <div className="mt-4 flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-400">
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-emerald-500/70" />Healthy <b className="num font-medium text-slate-200">{count('ok')}</b></span>
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-amber-400/80" />Warning <b className="num font-medium text-slate-200">{count('warn')}</b></span>
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-rose-500/85" />Critical <b className="num font-medium text-slate-200">{count('bad')}</b></span>
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-ink-600" />Offline <b className="num font-medium text-slate-200">{count('mute')}</b></span>
        </div>
      </div>
      <div className="hidden border-l border-ink-700 pl-6 lg:block">
        <Eyebrow>Resources</Eyebrow>
        <dl className="mt-3 grid grid-cols-[auto_auto] gap-x-6 gap-y-2 text-sm">
          {[['Instances', instances.length], ['Applications', apps.length], ['Databases', dbCount], ['Services', svcCount], ['Certificates', certs.length]].map(([k, v]) => (
            <div key={k as string} className="contents"><dt className="text-slate-400">{k}</dt><dd className="num text-right text-slate-100">{v}</dd></div>
          ))}
        </dl>
      </div>
    </section>
  );
}

function Capacity({ data }: { data: OverviewData }) {
  const snaps = data.instances.map((i) => i.status).filter(Boolean);
  const memTotal = snaps.reduce((n, s) => n + (s?.host.memory.total ?? 0), 0);
  const memUsed = snaps.reduce((n, s) => n + (s?.host.memory.used ?? 0), 0);
  const diskTotal = snaps.reduce((n, s) => n + (s?.host.disk.total ?? 0), 0);
  const diskUsed = snaps.reduce((n, s) => n + (s?.host.disk.used ?? 0), 0);
  const colors = ['bg-indigo-400', 'bg-sky-400', 'bg-amber-400', 'bg-emerald-400', 'bg-rose-400'];
  const multi = data.instances.filter((i) => i.status).length > 1;
  const apps = data.instances.flatMap((i) => (i.status?.apps ?? []).map((a) => ({ ...a, key: `${i.id}-${a.project}`, label: multi ? `${a.project} · ${i.name}` : a.project })))
    .filter((a) => a.memory).sort((a, b) => (b.memory ?? 0) - (a.memory ?? 0));
  const appMem = apps.reduce((n, a) => n + (a.memory ?? 0), 0);
  const certs = data.instances.flatMap((i) => i.status?.certificates ?? []).filter((c) => c.daysLeft != null).sort((a, b) => (a.daysLeft ?? 0) - (b.daysLeft ?? 0));
  const backups = data.instances.map((i) => i.status?.backups).filter(Boolean);
  const lastBackup = backups.sort((a, b) => ((a!.at < b!.at) ? 1 : -1))[0];
  return (
    <section className="card">
      <div className="flex items-center justify-between"><h2 className="font-medium text-slate-100">Memory by app</h2><span className="text-xs text-slate-500">{bytes(memUsed)} of {bytes(memTotal)}</span></div>
      <div className="num mt-3 text-[1.9rem] font-medium tracking-tight text-slate-100">{bytes(appMem)}<span className="ml-2 text-sm text-slate-500">in {apps.length} apps</span></div>
      <div className="mt-3 flex h-1.5 overflow-hidden rounded-full bg-ink-700">
        {apps.map((a, i) => <div key={a.key} className={colors[i % colors.length]} style={{ width: `${((a.memory ?? 0) / (memTotal || 1)) * 100}%` }} title={`${a.label}: ${bytes(a.memory)}`} />)}
      </div>
      <ul className="mt-4 space-y-2.5 text-sm">
        {apps.slice(0, 5).map((a, i) => (
          <li key={a.key} className="flex items-center gap-2.5">
            <span className={`h-2 w-2 shrink-0 rounded-sm ${colors[i % colors.length]}`} />
            <span className="min-w-0 flex-1 truncate text-slate-300" title={a.label}>{a.label}</span>
            <span className="num text-slate-200">{bytes(a.memory)}</span>
            <span className="num w-10 text-right text-xs text-slate-500">{Math.round(((a.memory ?? 0) / (appMem || 1)) * 100)}%</span>
          </li>
        ))}
      </ul>
      <div className="mt-5 grid grid-cols-2 gap-4 border-t border-ink-700 pt-4">
        <div><Eyebrow>Disk</Eyebrow><div className="num mt-1.5 text-lg text-slate-100">{diskTotal ? `${Math.round((diskUsed / diskTotal) * 100)}%` : '—'}</div><div className="text-xs text-slate-500">{bytes(diskTotal - diskUsed)} free</div></div>
        <div><Eyebrow>Backups</Eyebrow>
          <div className={`num mt-1.5 text-lg ${lastBackup?.ok ? 'text-emerald-300' : lastBackup ? 'text-rose-300' : 'text-slate-500'}`}>{lastBackup ? (lastBackup.ok ? 'OK' : 'Failed') : '—'}</div>
          <div className="text-xs text-slate-500">{lastBackup ? ago(lastBackup.at) : 'none reported'}</div></div>
      </div>
      {certs[0] && (
        <div className="mt-4 flex items-center justify-between rounded-lg border border-ink-700 bg-ink-850 px-3 py-2 text-xs">
          <span className="truncate text-slate-400" title={certs[0].domain}>Next TLS renewal · {certs[0].domain}</span>
          <span className={`num shrink-0 ${certs[0].daysLeft! < 14 ? 'text-rose-300' : certs[0].daysLeft! < 30 ? 'text-amber-300' : 'text-emerald-300'}`}>{certs[0].daysLeft}d</span>
        </div>
      )}
    </section>
  );
}

export function Overview() {
  const { data, error, loading, reload } = usePoll(api.overview, 30_000);
  const { data: uptime } = usePoll(api.uptime, 60_000);
  const k = data?.kpis;
  const score = k && k.appsTotal ? Math.round((k.appsHealthy / k.appsTotal) * 1000) / 10 : null;
  const scoreTone: Tone = score == null ? 'mute' : score >= 99 ? 'ok' : score >= 75 ? 'warn' : 'bad';
  const mem = data ? series(data.samples, 'memPct') : { values: [], times: [] };
  const disk = data ? series(data.samples, 'diskPct') : { values: [], times: [] };
  const load = data ? series(data.samples, 'load1') : { values: [], times: [] };
  const events: DeployEvent[] = data?.activity ?? [];

  return (
    <div>
      <PageHeader
        title="Infrastructure Overview"
        subtitle={data ? `${k!.instances} instance${k!.instances === 1 ? '' : 's'} · ${k!.appsTotal} apps · updated ${ago(data.generatedAt)}` : 'Loading…'}
        actions={<button className="btn-secondary" onClick={() => void reload()} disabled={loading}>
          <svg viewBox="0 0 24 24" className={`h-4 w-4 ${loading ? 'animate-spin motion-reduce:animate-none' : ''}`} fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M21 12a9 9 0 1 1-2.6-6.4M21 4v5h-5" /></svg>
          <span className="hidden sm:inline">Refresh</span>
        </button>}
      />
      {error && <div className="mb-4"><Alert>{error}</Alert></div>}
      {data && data.alerts.open > 0 && (
        <Link to="/alerts" className={`mb-5 flex items-center gap-3 rounded-xl border px-4 py-3 text-sm transition hover:brightness-125 ${data.alerts.critical
          ? 'border-rose-500/40 bg-rose-500/10 text-rose-200' : 'border-amber-500/40 bg-amber-500/10 text-amber-200'}`}>
          <span className={`h-2 w-2 shrink-0 animate-pulse rounded-full motion-reduce:animate-none ${data.alerts.critical ? 'bg-rose-400' : 'bg-amber-400'}`} />
          <span className="min-w-0 flex-1 truncate">{data.alerts.open} open alert{data.alerts.open === 1 ? '' : 's'}{data.alerts.critical ? `, ${data.alerts.critical} critical` : ''}</span>
          <span className="shrink-0 text-xs opacity-80">View →</span>
        </Link>
      )}

      {!data ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-[104px]" />)}</div>
      ) : data.instances.length === 0 ? (
        <div className="card py-12 text-center">
          <p className="font-medium text-slate-200">No instances yet</p>
          <p className="mt-1 text-sm text-slate-500">An admin can add EC2 instances under <Link to="/settings" className="text-indigo-300 hover:underline">Settings</Link>.</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
            <Kpi label="System health" tone={scoreTone} value={score ?? '—'} unit="/100 score" />
            <Kpi label="Applications" tone={k!.appsHealthy === k!.appsTotal ? 'ok' : 'bad'} value={`${k!.appsHealthy}/${k!.appsTotal}`} unit="healthy" />
            <Kpi label="Instances" tone={k!.instancesOnline === k!.instances ? 'ok' : 'warn'} value={`${k!.instancesOnline}/${k!.instances}`} unit="online" />
            <Kpi label="Warnings 24h" tone={k!.warnings24h ? 'warn' : 'ok'} value={k!.warnings24h} unit="log lines" />
            <Kpi label="Errors 24h" tone={k!.errors24h ? 'bad' : 'ok'} value={k!.errors24h} unit="log lines" className="hidden sm:block" />
            <Kpi label="Open alerts" tone={data.alerts.critical ? 'bad' : data.alerts.open ? 'warn' : 'ok'} value={data.alerts.open} unit={data.alerts.critical ? `${data.alerts.critical} critical` : data.alerts.open ? 'warnings' : 'all clear'} className="hidden sm:block" />
          </div>

          <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
            <div className="min-w-0 space-y-5">
              <ServiceHealth instances={data.instances} />
              <section className="card">
                <div className="mb-4 flex items-baseline justify-between gap-3">
                  <h2 className="font-medium text-slate-100">Uptime <span className="ml-1 text-sm font-normal text-slate-500">public endpoints, checked every minute</span></h2>
                  <span className="hidden text-xs text-slate-500 md:inline">90 days</span>
                </div>
                {uptime ? <UptimeTable apps={uptime} /> : <Skeleton className="h-24" />}
              </section>
              <div className="hidden gap-5 sm:grid sm:grid-cols-3">
                <MetricCard title="Memory utilization" value={k!.memPct?.toFixed(1) ?? '—'} unit="%" values={mem.values} times={mem.times} tone="info" format={(v) => `${v.toFixed(1)}%`} />
                <MetricCard title="Disk usage" value={k!.diskPct?.toFixed(1) ?? '—'} unit="%" values={disk.values} times={disk.times} tone="ok" format={(v) => `${v.toFixed(1)}%`} />
                <MetricCard title="Load average" value={load.values.length ? load.values[load.values.length - 1].toFixed(2) : '—'} values={load.values} times={load.times} tone="warn" max={Math.max(2, ...load.values)} format={(v) => v.toFixed(2)} />
              </div>
              <section className="card">
                <div className="flex items-baseline justify-between gap-3">
                  <h2 className="font-medium text-slate-100">Instances <span className="ml-1 text-sm font-normal text-slate-500">each cell is an app</span></h2>
                  <Link to="/instances" className="text-sm text-indigo-300 hover:text-indigo-200">View all</Link>
                </div>
                <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {sortInstances(data.instances).map((i) => <InstanceCard key={i.id} instance={i} />)}
                </div>
              </section>
            </div>
            <div className="min-w-0 space-y-5">
              <div className="hidden sm:block"><Capacity data={data} /></div>
              <section className="card">
                <div className="flex items-baseline justify-between"><h2 className="font-medium text-slate-100">Activity</h2><Link to="/activity" className="text-sm text-indigo-300 hover:text-indigo-200">View all</Link></div>
                <ActivityList events={events.slice(0, 7)} />
              </section>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
