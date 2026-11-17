import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, FailedCreation, FailedDeploy } from '../api';
import { useAuth } from '../auth';
import { ago, Alert } from './ui';

const err = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong.');
const sha = (s: string) => (s ? s.slice(0, 8) : '');

/** Deploys and new-app creations that failed and haven't been fixed since: retry, roll back, try again or dismiss. */
export function FailedDeployments() {
  const { user } = useAuth();
  const canAct = (user?.role === 'admin' || user?.role === 'deployer') && !user.isDemo;
  const [data, setData] = useState<{ deploys: FailedDeploy[]; creations: FailedCreation[] } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad' | 'warn'; text: string } | null>(null);
  const load = useCallback(() => api.failures().then(setData).catch(() => undefined), []);
  useEffect(() => { void load(); const t = setInterval(() => void load(), 60_000); return () => clearInterval(t); }, [load]);

  const run = async (key: string, fn: () => Promise<string>) => {
    setBusy(key); setMsg(null);
    try { setMsg({ tone: 'ok', text: await fn() }); await load(); } catch (e) { setMsg({ tone: 'bad', text: err(e) }); } finally { setBusy(null); }
  };
  const retry = (d: FailedDeploy) => run(`r${d.instanceId}${d.project}`, async () => {
    const r = await api.startDeployment(d.instanceId, d.project, 'deploy', d.toSha);
    return r.status === 'pending_approval' ? `Retry of ${d.project} is waiting for approval.` : `Retrying ${d.project} (${sha(d.toSha)}). Follow it on the app's Deploy tab.`;
  });
  const dismissDeploy = (d: FailedDeploy) => {
    const note = prompt(`Dismiss the failed deploy of ${d.project}? Its alert is cleared and it leaves this list.\n\nOptional note (why):`);
    if (note === null) return;
    void run(`d${d.instanceId}${d.project}`, async () => { await api.dismissFailure({ kind: 'deploy', instanceId: d.instanceId, project: d.project, at: d.at, note }); return `Dismissed the failed deploy of ${d.project}.`; });
  };
  const dismissCreation = (c: FailedCreation) => {
    const note = prompt(`Dismiss the failed creation of ${c.project}? (Everything that run created was already removed.)\n\nOptional note (why):`);
    if (note === null) return;
    void run(`c${c.id}`, async () => { await api.dismissFailure({ kind: 'create', creationId: c.id, note }); return `Dismissed the failed creation of ${c.project}.`; });
  };

  if (!data || (data.deploys.length === 0 && data.creations.length === 0)) return msg ? <div className="mb-5"><Alert tone={msg.tone}>{msg.text}</Alert></div> : null;
  return (
    <section className="card mb-5 border-rose-500/30 p-0">
      <div className="px-5 pt-4">
        <h2 className="font-medium text-slate-100">Failed deployments</h2>
        <p className="mt-1 text-sm text-slate-400">Not fixed by a later successful deploy yet. Retry, roll back, or dismiss what you've dealt with (that also clears its alert).</p>
      </div>
      {msg && <div className="px-5 pt-3"><Alert tone={msg.tone}>{msg.text}</Alert></div>}
      <ul className="divide-y divide-ink-800 px-5 pb-2">
        {data.deploys.map((d) => {
          const k = `${d.instanceId}${d.project}`;
          return (
            <li key={`d${k}`} className="flex flex-wrap items-center gap-3 py-3">
              <span className={d.status === 'rolled_back' ? 'pill-warn' : 'pill-bad'}>{d.status === 'rolled_back' ? 'rolled back' : 'failed'}</span>
              <span className="min-w-0 flex-1 text-sm text-slate-200">
                {d.appExists ? <Link to={`/instances/${d.instanceId}/apps/${d.project}?tab=deploy`} className="font-medium hover:underline">{d.project}</Link> : <span className="font-medium">{d.project}</span>}
                {' '}<span className="num text-slate-400">{sha(d.toSha)}</span>
                <span className="text-slate-500"> on {d.instance} · by {d.actor}{d.trigger ? ` (${d.trigger})` : ''} · {ago(d.at)}{d.attempts > 1 ? ` · ${d.attempts} failed attempts in a row` : ''}</span>
                {!d.appExists && <span className="pill-mute ml-2" title="The app is not on this instance (any more)">app not found</span>}
                {d.status === 'rolled_back' && <span className="block text-xs text-slate-500">The previous version was restored automatically: the app is up, the new version isn't live.</span>}
              </span>
              <span className="flex flex-wrap gap-2">
                {d.runUrl && <a href={d.runUrl} target="_blank" rel="noreferrer noopener" className="btn-ghost px-2.5 py-1 text-xs">CI run</a>}
                {d.appExists && <Link to={`/instances/${d.instanceId}/apps/${d.project}?tab=deploy`} className="btn-ghost px-2.5 py-1 text-xs">Logs and roll back</Link>}
                {canAct && d.appExists && d.toSha && <button className="btn-secondary px-2.5 py-1 text-xs" disabled={!!busy} onClick={() => void retry(d)}>{busy === `r${k}` ? 'Starting…' : 'Retry'}</button>}
                {canAct && <button className="btn-ghost px-2.5 py-1 text-xs" disabled={!!busy} onClick={() => dismissDeploy(d)}>Dismiss</button>}
              </span>
            </li>
          );
        })}
        {data.creations.map((c) => (
          <li key={`c${c.id}`} className="flex flex-wrap items-center gap-3 py-3">
            <span className="pill-bad">new app failed</span>
            <span className="min-w-0 flex-1 text-sm text-slate-200">
              <span className="font-medium">{c.project}</span> <span className="text-slate-500">({c.repo}@{c.branch}) on {c.instance} · by {c.createdBy} · {ago(c.createdAt)}</span>
              {c.error && <span className="block truncate text-xs text-rose-300" title={c.error}>{c.step ? `at "${c.step}": ` : ''}{c.error}</span>}
              <span className="block text-xs text-slate-500">Everything that run created was removed again.</span>
            </span>
            <span className="flex flex-wrap gap-2">
              {c.deploymentId && <Link to={`/instances/${c.instanceId}/new-app?job=${c.deploymentId}`} className="btn-ghost px-2.5 py-1 text-xs">Output</Link>}
              {user?.role === 'admin' && !user.isDemo && (
                <Link to={`/instances/${c.instanceId}/new-app?${new URLSearchParams({ repo: c.repo, branch: c.branch, project: c.project, subdomain: c.domain.split('.')[0] })}`} className="btn-secondary px-2.5 py-1 text-xs">Try again</Link>
              )}
              {canAct && <button className="btn-ghost px-2.5 py-1 text-xs" disabled={!!busy} onClick={() => dismissCreation(c)}>Dismiss</button>}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
