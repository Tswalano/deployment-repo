import { useState } from 'react';
import { AppDetailData, AppView } from '../../api';
import { ActivityList } from '../../components/ActivityList';
import { ago, dur, Skeleton } from '../../components/ui';
import { Section, STATUS_LABEL, STATUS_PILL, took } from './shared';

export function DeployTab({ view, detail, fetching, onCheck, onDeploy }:
  { view: AppView; detail: AppDetailData | null; fetching: boolean; onCheck: () => void; onDeploy: (ref: string, note?: string) => void }) {
  const [open, setOpen] = useState<number | null>(null);
  const op = view.canOperate;
  const g = detail?.git;
  const running = view.deployments.some((d) => d.status === 'running' || d.status === 'pending_approval');
  const s = detail?.deploySummary;

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
      <div className="min-w-0 space-y-5">
        <Section
          title="Ready to deploy"
          sub={g ? <>{g.tracking ?? `origin/${detail?.branch}`} · fetched {ago(g.lastFetch)}{detail?.fetchError ? ` · ${detail.fetchError}` : ''}</> : 'Comparing with the remote branch…'}
          actions={op && <button className="btn-secondary" onClick={onCheck} disabled={fetching}>{fetching ? 'Checking…' : 'Check for updates'}</button>}>
          {!g ? <Skeleton className="h-16" /> : g.behind ? (
            <>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-slate-300"><span className="num font-medium text-amber-300">{g.behind}</span> new commit{g.behind === 1 ? '' : 's'} on {g.tracking} not running yet.</p>
                {op && <button className="btn-primary" disabled={running} onClick={() => onDeploy('', `Deploys the latest ${detail!.branch} (${g.behind} new commit${g.behind === 1 ? '' : 's'}).`)}>Deploy latest</button>}
              </div>
              <ul className="divide-y divide-ink-800 rounded-lg border border-ink-700">
                {g.upstream.map((c) => (
                  <li key={c.sha} className="flex items-center gap-3 px-3 py-2.5">
                    <span className="num shrink-0 text-xs text-indigo-300">{c.sha}</span>
                    <span className="min-w-0 flex-1 truncate text-sm text-slate-200" title={c.subject}>{c.subject}</span>
                    <span className="hidden shrink-0 text-xs text-slate-500 sm:inline" title={c.date}>{c.author} · {ago(c.date)}</span>
                    {op && <button className="btn-ghost shrink-0 px-2 py-1 text-xs" disabled={running} onClick={() => onDeploy(c.sha, `Deploys exactly ${c.sha}: ${c.subject}`)}>Deploy</button>}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="text-sm text-slate-400">Up to date with {g.tracking}. {op ? 'Use “Check for updates” to fetch the latest commits.' : ''}</p>
          )}
          {g && Array.isArray(g.dirty) && g.dirty.length > 0 && (
            <p className="mt-3 truncate text-xs text-amber-300" title={g.dirty.join(', ')}>Uncommitted changes on the server: {g.dirty.join(', ')}</p>
          )}
        </Section>

        <Section title="Console deployments" sub={op ? 'Started from the Ops Console · click a row for the pipeline output' : 'Started from the Ops Console'} flush>
          {view.deployments.length === 0 ? <p className="px-5 pb-5 text-sm text-slate-500">None yet.</p> : (
            <table className="tbl">
              <thead><tr><th className="w-[28%] sm:w-[16%]">When</th><th className="w-[24%] sm:w-[14%]">Action</th><th className="hidden sm:table-cell">Ref</th><th className="w-[30%] sm:w-[21%]">Status</th><th className="hidden w-[11%] text-right sm:table-cell">Took</th><th className="hidden w-[16%] md:table-cell">By</th></tr></thead>
              <tbody>{view.deployments.map((d) => [
                <tr key={d.id} className={op && d.output ? 'cursor-pointer' : ''} onClick={() => op && d.output && setOpen(open === d.id ? null : d.id)}>
                  <td title={d.createdAt}>{ago(d.createdAt)}</td>
                  <td className="capitalize">{d.action}</td>
                  <td className="num hidden text-xs sm:table-cell" title={d.ref}>{d.ref || <span className="text-slate-500">default</span>}</td>
                  <td title={d.decisionReason ?? d.overrideReason ?? (d.approvedBy ? `approved by ${d.approvedBy}` : '')}>
                    <span className={STATUS_PILL[d.status]}>{STATUS_LABEL(d.status)}</span>{d.overrideReason && <span className="ml-1.5 text-2xs text-rose-300">override</span>}
                  </td>
                  <td className="num hidden text-right sm:table-cell">{took(d)}</td>
                  <td className="hidden md:table-cell" title={d.requestedBy}>{d.requestedBy}</td>
                </tr>,
                open === d.id && d.output ? (
                  <tr key={`${d.id}-out`}><td colSpan={6} className="whitespace-normal bg-ink-950 p-0">
                    <pre className="max-h-80 overflow-y-auto whitespace-pre-wrap break-all px-5 py-3 font-mono text-[12px] leading-5 text-slate-300">{d.output}</pre>
                  </td></tr>
                ) : null,
              ])}</tbody>
            </table>
          )}
        </Section>
      </div>

      <div className="min-w-0 space-y-5">
        {s && (
          <section className="card grid grid-cols-3 gap-3 text-center">
            <div><div className="eyebrow justify-center">Deploys 7d</div><div className="num mt-1.5 text-xl text-slate-100">{s.deploys7d}</div></div>
            <div><div className="eyebrow justify-center">Success</div><div className={`num mt-1.5 text-xl ${s.successRate7d == null ? 'text-slate-500' : s.successRate7d >= 90 ? 'text-emerald-300' : 'text-amber-300'}`}>{s.successRate7d == null ? '—' : `${s.successRate7d}%`}</div></div>
            <div><div className="eyebrow justify-center">Median</div><div className="num mt-1.5 text-xl text-slate-100">{dur(s.medianDurationS)}</div></div>
          </section>
        )}
        <Section title="Pipeline history" sub="All runs: GitHub Actions, console and CLI">
          <ActivityList events={view.events.slice(0, 12)} showInstance={false} />
        </Section>
        {g && g.commits.length > 0 && (
          <Section title="Recent commits on the server">
            <ul className="space-y-2 text-sm">
              {g.commits.slice(0, 8).map((c, i) => (
                <li key={c.sha} className="flex min-w-0 items-center gap-2">
                  <span className={`num shrink-0 text-xs ${i === 0 ? 'text-emerald-300' : 'text-slate-500'}`}>{c.sha}</span>
                  <span className="min-w-0 flex-1 truncate text-slate-300" title={c.subject}>{c.subject}</span>
                  {op && i > 0 && <button className="btn-ghost shrink-0 px-2 py-0.5 text-2xs" disabled={running} title="Roll back to this commit" onClick={() => onDeploy(`rollback:${c.sha}`)}>Roll back here</button>}
                </li>
              ))}
            </ul>
          </Section>
        )}
      </div>
    </div>
  );
}
