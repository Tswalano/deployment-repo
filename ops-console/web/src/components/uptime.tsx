import { Link } from 'react-router-dom';
import { UptimeApp } from '../api';

export const fmtPct = (p: number | null | undefined) => (p == null ? '—' : p >= 99.995 ? '100%' : `${p.toFixed(p >= 99 ? 2 : 1)}%`);
export const pctTone = (p: number | null | undefined) =>
  p == null ? 'text-slate-500' : p >= 99.9 ? 'text-emerald-300' : p >= 99 ? 'text-amber-300' : 'text-rose-300';

/** Status-page style strip: one bar per day (oldest → today), coloured by that day's availability. */
export function UptimeBars({ days, count = 90 }: { days: UptimeApp['days']; count?: number }) {
  const byDay = new Map(days.map((d) => [d.day, d]));
  const bars = Array.from({ length: count }, (_, i) => {
    const day = new Date(Date.now() - (count - 1 - i) * 86_400_000).toISOString().slice(0, 10);
    return { day, d: byDay.get(day) };
  });
  return (
    <div className="flex h-7 items-stretch gap-[2px]" role="img" aria-label={`Availability per day, last ${count} days`}>
      {bars.map(({ day, d }) => {
        const c = !d ? 'bg-ink-700' : d.pct! >= 99.9 ? 'bg-emerald-500/80' : d.pct! >= 99 ? 'bg-amber-400/90' : 'bg-rose-500/90';
        return <span key={day} className={`min-w-0 flex-1 rounded-[2px] ${c} transition-opacity hover:opacity-70`}
                     title={d ? `${day}: ${fmtPct(d.pct)} up (${d.ok}/${d.checks} checks)` : `${day}: no data (instance off or not monitored yet)`} />;
      })}
    </div>
  );
}

export function UptimeTable({ apps }: { apps: UptimeApp[] }) {
  if (!apps.length) return <p className="text-sm text-slate-500">No public endpoints to monitor yet.</p>;
  return (
    <ul className="divide-y divide-ink-800">
      {apps.map((a) => (
        <li key={`${a.instanceId}-${a.project}`} className="py-3 first:pt-0 last:pb-0">
          <div className="flex items-center gap-3">
            <span className={`h-2 w-2 shrink-0 rounded-full ${a.last == null ? 'bg-slate-500' : a.last.ok ? 'bg-emerald-400' : 'bg-rose-400'}`} />
            <Link to={`/instances/${a.instanceId}/apps/${a.project}`} className="min-w-0 truncate font-medium text-slate-100 hover:text-indigo-300" title={a.url ?? ''}>{a.project}</Link>
            <span className="hidden truncate text-xs text-slate-500 sm:inline">{a.domain}</span>
            <span className="ml-auto flex shrink-0 items-baseline gap-4 text-xs">
              <span className="hidden text-slate-500 md:inline">p95 <span className="num text-slate-300">{a.p95ms24h != null ? `${a.p95ms24h} ms` : '—'}</span></span>
              <span className="hidden text-slate-500 sm:inline">24h <span className={`num ${pctTone(a.uptime.h24)}`}>{fmtPct(a.uptime.h24)}</span></span>
              <span className="text-slate-500">30d <span className={`num ${pctTone(a.uptime.d30)}`}>{fmtPct(a.uptime.d30)}</span></span>
            </span>
          </div>
          <div className="mt-2.5 hidden md:block"><UptimeBars days={a.days} /></div>
          <div className="mt-2.5 md:hidden"><UptimeBars days={a.days} count={30} /></div>
        </li>
      ))}
    </ul>
  );
}
