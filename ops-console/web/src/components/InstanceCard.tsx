import { Link } from 'react-router-dom';
import { Instance } from '../api';
import { appTone, poweredOff } from '../health';
import { ago, Cells, Meter, pct } from './ui';

export function InstanceCard({ instance: i }: { instance: Instance }) {
  const s = i.status;
  const off = poweredOff(i);
  const unreachable = !off && (!s || !!i.lastError);
  const loadPct = s ? Math.min(100, ((s.host.load[0] ?? 0) / (s.host.cpus || 1)) * 100) : null;
  const stateWord = i.ec2State === 'terminated' || i.ec2State === 'shutting-down' ? 'Terminated' : i.ec2State === 'stopping' ? 'Stopping' : 'Stopped';
  return (
    <Link to={`/instances/${i.id}`}
          className={`card card-hover relative block p-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/70 ${off || unreachable ? 'border-rose-700/70' : ''}`}>
      {off && (
        <div className="mb-3 flex items-center gap-2 rounded-md border border-rose-500/40 bg-rose-500/10 px-2.5 py-1.5 text-xs font-semibold text-rose-300">
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden><path d="M12 3v9M6.3 7.7a8 8 0 1 0 11.4 0" /></svg>
          {stateWord}{i.ec2StateAt ? <span className="font-normal text-rose-300/80">· since {ago(i.ec2StateAt)}</span> : null}
        </div>
      )}
      <div className={off ? 'opacity-45 grayscale' : ''}>
        <div className="flex items-center justify-between gap-2">
          <span className="truncate font-medium text-slate-100" title={i.name}>{i.name}</span>
          <span className="num shrink-0 text-2xs text-slate-500">{s ? `${s.apps.length} apps` : '—'}</span>
        </div>
        <div className="mt-0.5 truncate text-2xs text-slate-500" title={`${i.awsInstanceId} · ${i.region}`}>
          {s?.host.instanceType ?? 'EC2'} · {s?.host.az ?? i.region}
        </div>
        <div className="mt-3 min-h-[1.5rem]">
          {s && s.apps.length ? (
            <Cells size="sm" items={s.apps.map((a) => ({ key: a.project, tone: off ? 'mute' : appTone(a), title: `${a.project}: ${off ? 'instance stopped' : a.healthy ? 'healthy' : 'down'}` }))} />
          ) : (
            <span className="text-2xs text-slate-500">{s ? 'no apps reported (host metrics only)' : 'waiting for first snapshot'}</span>
          )}
        </div>
        <div className="mt-3 space-y-1.5">
          <Meter label="Load" value={off ? null : loadPct} />
          <Meter label="Mem" value={s && !off ? pct(s.host.memory.used, s.host.memory.total) : null} />
          <Meter label="Disk" value={s && !off ? pct(s.host.disk.used, s.host.disk.total) : null} />
        </div>
      </div>
      {off && <p className="mt-3 truncate text-2xs text-rose-300">Apps on it are offline · last seen {ago(i.lastOkAt)}</p>}
      {unreachable && <p className="mt-3 truncate text-2xs text-rose-300" title={i.lastError ?? ''}>Unreachable · last OK {ago(i.lastOkAt)}</p>}
    </Link>
  );
}
