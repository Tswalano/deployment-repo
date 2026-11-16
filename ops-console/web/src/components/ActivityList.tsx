import { DeployEvent } from '../api';
import { ago, dur } from './ui';

const STYLE: Record<string, { ring: string; icon: string; label: string }> = {
  success: { ring: 'border-sky-500/30 bg-sky-500/10 text-sky-300', icon: 'M12 19V5M5 12l7-7 7 7', label: 'succeeded' },
  rolled_back: { ring: 'border-amber-500/30 bg-amber-500/10 text-amber-300', icon: 'M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-1', label: 'rolled back' },
  failed: { ring: 'border-rose-500/30 bg-rose-500/10 text-rose-300', icon: 'M12 19V5M5 12l7-7 7 7', label: 'failed' },
};

export function ActivityList({ events, showInstance = true }: { events: DeployEvent[]; showInstance?: boolean }) {
  if (!events.length) return <p className="mt-4 text-sm text-slate-500">No deployments recorded yet.</p>;
  return (
    <ul className="mt-3 divide-y divide-ink-800">
      {events.map((e, idx) => {
        const st = STYLE[e.status] ?? STYLE.success;
        const verb = e.action === 'rollback' ? 'Rolled back' : e.action === 'restore' ? 'Restored' : e.status === 'failed' ? 'Deploy failed' : 'Deployed';
        return (
          <li key={`${e.at}-${e.project}-${idx}`} className="flex items-start gap-3 py-3">
            <span className={`mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg border ${st.ring}`}>
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={st.icon} /></svg>
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm text-slate-200" title={`${verb} ${e.project} ${e.toSha || ''}`}>
                {verb} {e.project} <span className="num text-xs text-slate-500">{e.toSha || e.fromSha}</span>
              </div>
              <div className="truncate text-xs text-slate-500">
                {showInstance && e.instance ? `${e.instance} · ` : ''}{e.actor} · {st.label}{e.durationS ? ` · ${dur(e.durationS)}` : ''}
              </div>
            </div>
            <span className="num shrink-0 pt-0.5 text-2xs text-slate-500" title={e.at}>{ago(e.at)}</span>
          </li>
        );
      })}
    </ul>
  );
}
