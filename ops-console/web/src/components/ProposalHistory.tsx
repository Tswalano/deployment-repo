import { Fragment, useState } from 'react';
import { Link } from 'react-router-dom';
import { AssistantAction } from '../api';
import { ago } from './ui';

/** AI Console → Proposals → History: decided proposals as a table; a row expands to the full detail. */
const STATUS: Record<AssistantAction['status'], { label: string; tone: string }> = {
  proposed: { label: 'Waiting', tone: 'border-amber-400/40 text-amber-300' },
  running: { label: 'Starting', tone: 'border-indigo-400/40 text-indigo-300' },
  done: { label: 'Done', tone: 'border-emerald-500/40 text-emerald-300' },
  failed: { label: 'Failed', tone: 'border-rose-500/40 text-rose-300' },
  cancelled: { label: 'Cancelled', tone: 'border-ink-600 text-slate-400' },
  expired: { label: 'Expired', tone: 'border-ink-600 text-slate-500' },
};
const KIND: Record<AssistantAction['kind'], string> = { deploy: 'Deploy', rollback: 'Rollback', start: 'Start server', reboot: 'Reboot server' };
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const outcome = (a: AssistantAction) => a.result?.error ?? a.result?.message ?? (a.status === 'expired' ? 'Not confirmed within 15 minutes.' : a.status === 'cancelled' ? 'Cancelled, nothing ran.' : '—');
const PAGE = 10;

export function ProposalHistory({ items, isAdmin = false }: { items: AssistantAction[]; isAdmin?: boolean }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [shown, setShown] = useState(PAGE);
  const Detail = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div><dt className="text-2xs uppercase tracking-wider text-slate-500">{label}</dt><dd className="mt-0.5 text-slate-200">{children}</dd></div>
  );
  return (
    <div>
      <div className="overflow-x-auto rounded-lg border border-ink-700">
        <table className="w-full min-w-[44rem] text-left text-sm">
          <thead className="bg-ink-850 text-2xs uppercase tracking-wider text-slate-500">
            <tr>
              <th className="w-8 px-3 py-2" aria-label="Expand" />
              <th className="px-3 py-2 font-semibold">When</th>
              <th className="px-3 py-2 font-semibold">Action</th>
              <th className="px-3 py-2 font-semibold">Server · app</th>
              <th className="px-3 py-2 font-semibold">Proposed by</th>
              <th className="px-3 py-2 font-semibold">Status</th>
              <th className="px-3 py-2 font-semibold">Result</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-700">
            {items.slice(0, shown).map((a) => {
              const open = openId === a.id;
              return (
                <Fragment key={a.id}>
                  <tr className={`cursor-pointer align-top hover:bg-ink-850 ${open ? 'bg-ink-850' : ''}`} onClick={() => setOpenId(open ? null : a.id)}
                      aria-expanded={open} tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpenId(open ? null : a.id); } }}>
                    <td className="px-3 py-2 text-slate-500">{open ? '▾' : '▸'}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-slate-400" title={new Date(a.createdAt).toLocaleString()}>{ago(a.decidedAt ?? a.createdAt)}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-slate-200">{KIND[a.kind]}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-slate-300">{a.server.name}{a.app ? <span className="text-slate-500"> · {a.app}</span> : null}</td>
                    <td className="max-w-[12rem] truncate px-3 py-2 text-slate-400" title={a.via}>{a.via}</td>
                    <td className="whitespace-nowrap px-3 py-2"><span className={`rounded border px-1.5 py-0.5 text-2xs ${STATUS[a.status].tone}`}>{STATUS[a.status].label}</span></td>
                    <td className="max-w-[18rem] truncate px-3 py-2 text-slate-400" title={outcome(a)}>{outcome(a)}</td>
                  </tr>
                  {open && (
                    <tr className="bg-ink-850">
                      <td />
                      <td colSpan={6} className="px-3 pb-4 pt-1">
                        <p className="text-sm text-slate-200">{a.summary}</p>
                        <dl className="mt-3 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
                          <Detail label="Server">{a.server.name} <span className="text-slate-500">({a.server.environment})</span></Detail>
                          <Detail label="App">{a.app ?? '—'}</Detail>
                          <Detail label="Version">{a.ref ? <code className="font-mono text-xs">{a.ref}</code> : a.kind === 'rollback' ? 'Previous good deploy' : a.kind === 'deploy' ? 'Latest of the branch' : '—'}</Detail>
                          <Detail label="From">{a.source === 'chat' ? 'Ask Ops Console chat' : 'Connected AI tool (MCP)'} · {a.via}</Detail>
                          <Detail label="Proposed">{when(a.createdAt)}</Detail>
                          <Detail label={a.status === 'cancelled' ? 'Cancelled' : a.status === 'expired' ? 'Expired' : 'Confirmed'}>{when(a.status === 'expired' ? a.expiresAt : a.decidedAt)}</Detail>
                          {a.result?.deploymentStatus && <Detail label="Deployment">{a.result.deploymentStatus.replace('_', ' ')}{a.result.deploymentId ? ` (#${a.result.deploymentId})` : ''}</Detail>}
                        </dl>
                        {(a.result?.error || a.result?.message || a.note) && (
                          <div className="mt-3 space-y-1 text-sm">
                            {a.note && <p className="text-slate-400">Note at the time: {a.note}</p>}
                            {a.result?.message && <p className="text-emerald-300">{a.result.message}</p>}
                            {a.result?.error && <p className="text-rose-300">{a.result.error}</p>}
                          </div>
                        )}
                        <div className="mt-3 flex gap-4 text-xs">
                          <Link className="text-indigo-300 hover:text-indigo-200" to={a.link}>{a.app ? 'Open the app’s deploys' : 'Open the server'} →</Link>
                          {isAdmin && <Link className="text-indigo-300 hover:text-indigo-200" to="/audit">Audit log →</Link>}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="mt-2 flex items-center justify-between text-xs text-slate-500">
        <span>Showing {Math.min(shown, items.length)} of {items.length}{items.length >= 50 ? ' (the latest 50)' : ''}</span>
        {shown < items.length && <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setShown((n) => n + PAGE)}>Show more</button>}
      </div>
    </div>
  );
}
