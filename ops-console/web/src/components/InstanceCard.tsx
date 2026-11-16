import { Link } from 'react-router-dom';
import { Instance } from '../api';
import { appTone } from '../health';
import { ago, Cells, Meter, pct } from './ui';

export function InstanceCard({ instance: i }: { instance: Instance }) {
  const s = i.status;
  const unreachable = !s || !!i.lastError;
  const loadPct = s ? Math.min(100, ((s.host.load[0] ?? 0) / (s.host.cpus || 1)) * 100) : null;
  return (
    <Link to={`/instances/${i.id}`}
          className={`card card-hover block p-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/70 ${unreachable ? 'border-rose-900/60' : ''}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-medium text-slate-100" title={i.name}>{i.name}</span>
        <span className="num shrink-0 text-2xs text-slate-500">{s ? `${s.apps.length} apps` : '—'}</span>
      </div>
      <div className="mt-0.5 truncate text-2xs text-slate-500" title={`${i.awsInstanceId} · ${i.region}`}>
        {s?.host.instanceType ?? 'EC2'} · {s?.host.az ?? i.region}
      </div>
      <div className="mt-3 min-h-[1.5rem]">
        {s && s.apps.length ? (
          <Cells size="sm" items={s.apps.map((a) => ({ key: a.project, tone: appTone(a), title: `${a.project}: ${a.healthy ? 'healthy' : 'down'}` }))} />
        ) : (
          <span className="text-2xs text-slate-500">{s ? 'no apps reported (basic metrics)' : 'waiting for first snapshot'}</span>
        )}
      </div>
      <div className="mt-3 space-y-1.5">
        <Meter label="Load" value={loadPct} />
        <Meter label="Mem" value={s ? pct(s.host.memory.used, s.host.memory.total) : null} />
        <Meter label="Disk" value={s ? pct(s.host.disk.used, s.host.disk.total) : null} />
      </div>
      {unreachable && <p className="mt-3 truncate text-2xs text-rose-300" title={i.lastError ?? ''}>Unreachable · last OK {ago(i.lastOkAt)}</p>}
    </Link>
  );
}
