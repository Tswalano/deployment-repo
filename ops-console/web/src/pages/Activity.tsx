import { Link } from 'react-router-dom';
import { api } from '../api';
import { ActivityList } from '../components/ActivityList';
import { FailedDeployments } from '../components/FailedDeployments';
import { ago, Alert, dur, PageHeader, Skeleton } from '../components/ui';
import { usePoll } from '../usePoll';
import { MonitoringNav } from '../components/MonitoringNav';

const STATUS = { success: 'pill-ok', failed: 'pill-bad', rolled_back: 'pill-warn' } as Record<string, string>;

export function Activity() {
  const { data, error } = usePoll(api.overview, 30_000);
  const events = data?.activity ?? [];
  const { data: pending } = usePoll(api.pendingDeployments, 30_000);
  return (
    <div>
      <MonitoringNav />
      <PageHeader title="Activity" subtitle="Deployments across all instances, newest first" />
      {error && <div className="mb-4"><Alert>{error}</Alert></div>}
      <FailedDeployments />
      {pending && pending.length > 0 && (
        <section className="card mb-5 border-amber-500/30 p-0">
          <h2 className="px-5 pt-4 font-medium text-slate-100">Waiting for approval</h2>
          <ul className="divide-y divide-ink-800 px-5 pb-2">
            {pending.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-3 py-3">
                <span className="pill-warn">{d.action}</span>
                <span className="min-w-0 flex-1 truncate text-sm text-slate-200">{d.project}{d.ref ? ` → ${d.ref}` : ''} <span className="text-slate-500">on {d.instance} ({d.environment}) · by {d.requestedBy} {ago(d.createdAt)}</span></span>
                <Link to={`/instances/${d.instanceId}/apps/${d.project}?tab=deploy`} className="btn-secondary px-3 py-1 text-xs">Review</Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      {!data ? <Skeleton className="h-72" /> : (
        <>
          {/* phones: compact list */}
          <section className="card md:hidden"><ActivityList events={events} /></section>
          {/* larger screens: table */}
          <section className="card hidden overflow-hidden p-0 md:block">
            {events.length === 0 ? <p className="p-5 text-sm text-slate-500">No deployments recorded yet.</p> : (
              <table className="tbl">
                <thead><tr>
                  <th className="w-[13%]">When</th><th className="w-[15%]">Instance</th><th className="w-[14%]">App</th><th className="w-[11%]">Action</th>
                  <th className="w-[13%]">Status</th><th className="w-[18%]">Version</th><th className="w-[8%] text-right">Took</th><th>By</th>
                </tr></thead>
                <tbody>{events.map((e, i) => (
                  <tr key={`${e.at}-${i}`}>
                    <td title={e.at}>{ago(e.at)}</td><td title={e.instance}>{e.instance}</td><td className="font-medium text-slate-100">{e.project}</td>
                    <td>{e.action}</td><td><span className={STATUS[e.status] ?? 'pill-mute'}>{e.status.replace('_', ' ')}</span></td>
                    <td className="num text-xs">{e.fromSha || '—'} → {e.toSha || '—'}</td><td className="num text-right">{dur(e.durationS)}</td><td title={e.actor}>{e.actor}</td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </section>
        </>
      )}
    </div>
  );
}
