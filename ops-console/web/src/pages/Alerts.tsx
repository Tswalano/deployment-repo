import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert as AlertT, api, ApiError } from '../api';
import { useAuth } from '../auth';
import { ago, Alert, dur, PageHeader, Skeleton } from '../components/ui';
import { usePoll } from '../usePoll';

const SEV = {
  critical: { pill: 'pill-bad', bar: 'bg-rose-500', label: 'Critical' },
  warning: { pill: 'pill-warn', bar: 'bg-amber-400', label: 'Warning' },
  info: { pill: 'pill-info', bar: 'bg-indigo-400', label: 'Info' },
};
const RULES: Record<string, string> = {
  app_down: 'App down', app_slow: 'Slow responses', instance_unreachable: 'Instance unreachable', disk_high: 'Disk',
  memory_high: 'Memory', cert_expiring: 'Certificate', backup: 'Backups', deploy_failed: 'Deploy failed', db_sessions: 'Database',
};
const lasted = (a: AlertT) => dur(((a.resolvedAt ? new Date(a.resolvedAt).getTime() : Date.now()) - new Date(a.openedAt).getTime()) / 1000);

function OpenAlert({ a, canAck, onAck }: { a: AlertT; canAck: boolean; onAck: () => void }) {
  const s = SEV[a.severity];
  const link = a.project && a.instanceId ? `/instances/${a.instanceId}/apps/${a.project}` : a.instanceId ? `/instances/${a.instanceId}` : null;
  return (
    <li className="card relative overflow-hidden p-0">
      <span className={`absolute inset-y-0 left-0 w-1 ${s.bar}`} />
      <div className="flex flex-wrap items-start gap-3 py-4 pl-5 pr-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={s.pill}>{s.label}</span>
            <span className="text-2xs uppercase tracking-wider text-slate-500">{RULES[a.rule] ?? a.rule}</span>
            {a.ackedBy && <span className="pill-mute">acknowledged by {a.ackedBy}</span>}
          </div>
          <h3 className="mt-1.5 font-medium text-slate-100">{link ? <Link to={link} className="hover:text-indigo-300">{a.title}</Link> : a.title}</h3>
          <p className="mt-1 text-sm text-slate-400">{a.detail}</p>
          <p className="mt-2 text-xs text-slate-500">
            Open for {lasted(a)} · since {new Date(a.openedAt).toLocaleString()} · last seen {ago(a.lastSeenAt)}
            {a.notifyCount ? ` · notified ${a.notifyCount}×` : ''}
          </p>
        </div>
        {canAck && !a.ackedBy && <button className="btn-secondary shrink-0 px-3 py-1.5 text-xs" onClick={onAck}>Acknowledge</button>}
      </div>
    </li>
  );
}

export function Alerts() {
  const { user } = useAuth();
  const { data, error, reload } = usePoll(() => api.alerts('all'), 30_000);
  const [actionError, setActionError] = useState<string | null>(null);
  const canAck = !!user && (user.role === 'admin' || user.role === 'deployer') && !user.isDemo;
  const open = data?.alerts.filter((a) => !a.resolvedAt) ?? [];
  const history = data?.alerts.filter((a) => a.resolvedAt) ?? [];

  return (
    <div>
      <PageHeader
        title="Alerts"
        subtitle={data ? `${data.counts.open} open · ${data.counts.week ?? 0} in the last 7 days` : 'Loading…'}
        actions={user?.role === 'admin' && <Link to="/settings#alerts" className="btn-secondary hidden md:inline-flex">Notification settings</Link>}
      />
      {(error || actionError) && <div className="mb-4"><Alert>{actionError || error}</Alert></div>}
      {!data ? <Skeleton className="h-40" /> : (
        <div className="space-y-6">
          {open.length === 0 ? (
            <div className="card flex items-center gap-4">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-emerald-500/30 bg-emerald-500/10 text-emerald-300">
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M5 12l5 5L20 7" /></svg>
              </span>
              <div><p className="font-medium text-slate-100">All clear</p><p className="text-sm text-slate-500">No open alerts. Apps are checked every minute; instances every 5 minutes.</p></div>
            </div>
          ) : (
            <ul className="space-y-3">
              {open.map((a) => (
                <OpenAlert key={a.id} a={a} canAck={canAck} onAck={async () => {
                  setActionError(null);
                  try { await api.ackAlert(a.id); await reload(); } catch (err) { setActionError(err instanceof ApiError ? err.message : 'Failed'); }
                }} />
              ))}
            </ul>
          )}

          <section className="card overflow-hidden p-0">
            <h2 className="px-5 py-4 font-medium text-slate-100">History</h2>
            {history.length === 0 ? <p className="px-5 pb-5 text-sm text-slate-500">No resolved alerts yet.</p> : (
              <table className="tbl">
                <thead><tr>
                  <th className="w-[24%] md:w-[14%]">Opened</th><th className="hidden w-[11%] md:table-cell">Severity</th><th>Alert</th>
                  <th className="w-[18%] text-right md:w-[11%]">Lasted</th><th className="hidden w-[14%] lg:table-cell">Acknowledged</th>
                </tr></thead>
                <tbody>{history.map((a) => (
                  <tr key={a.id}>
                    <td title={a.openedAt}>{ago(a.openedAt)}</td>
                    <td className="hidden md:table-cell"><span className={SEV[a.severity].pill}>{SEV[a.severity].label}</span></td>
                    <td title={`${a.title}: ${a.detail}`}>{a.title}</td>
                    <td className="num text-right">{lasted(a)}</td>
                    <td className="hidden lg:table-cell">{a.ackedBy ?? '—'}</td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
