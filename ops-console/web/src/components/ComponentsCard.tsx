import { useCallback, useEffect, useState } from 'react';
import { Boxes, Database, Play, Plus, RefreshCw, Server as ServerIcon, Square, Trash2, Wrench } from 'lucide-react';
import { api, ApiError, ComponentAction, ComponentId, ComponentsView, ServerComponent } from '../api';
import { useAuth } from '../auth';
import { useDialog } from './Dialog';
import { smallIcon } from './icons';
import { ago, Alert } from './ui';

/**
 * Server page → Components: databases (PostgreSQL, MariaDB, SQLite), services (Valkey, nginx) and runtimes (Python,
 * Node.js) on this server, from the OS repositories. Admins install, start, stop or remove them; each change runs in
 * the background (one job per server at a time) and the inventory is read again when it finishes.
 */
const GROUPS: { id: ServerComponent['category']; label: string; icon: typeof Database }[] = [
  { id: 'database', label: 'Databases', icon: Database },
  { id: 'service', label: 'Services', icon: ServerIcon },
  { id: 'runtime', label: 'Runtimes', icon: Wrench },
];
const th = 'px-4 py-2.5 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500';
const td = 'px-4 py-3 align-middle';
const PAST: Record<ComponentAction, string> = { install: 'Installing', start: 'Starting', stop: 'Stopping', remove: 'Removing' };

function Status({ c }: { c: ServerComponent }) {
  if (!c.installed) return <span className="text-slate-500">Not installed</span>;
  if (c.active === null) return <span className="text-slate-300">Installed</span>;
  return c.active
    ? <span className="inline-flex items-center gap-1.5 text-emerald-300"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />Running</span>
    : <span className="inline-flex items-center gap-1.5 text-amber-300"><span className="h-1.5 w-1.5 rounded-full bg-amber-400" />Stopped</span>;
}

export function ComponentsCard({ instanceId }: { instanceId: number }) {
  const { user } = useAuth();
  const dialog = useDialog();
  const [v, setV] = useState<ComponentsView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [pick, setPick] = useState<Partial<Record<ComponentId, string>>>({});
  const [update, setUpdate] = useState<{ stackName?: string; templateUrl?: string | null; stacksUrl?: string } | null>(null);

  const load = useCallback(async (fresh = false) => {
    setLoading(true); setErr(null);
    try { setV(await api.components(instanceId, fresh)); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Could not read the components.'); }
    finally { setLoading(false); }
  }, [instanceId]);
  useEffect(() => { void load(); }, [load]);
  // a job is running: look again every 5 seconds until it finishes
  const running = v?.job?.status === 'running';
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => void api.components(instanceId).then((n) => {
      setV(n);
      if (n.job?.status !== 'running') setMsg(n.job?.status === 'success' ? { tone: 'ok', text: `Done: ${n.job.ref}.` } : { tone: 'bad', text: `It didn't work: ${n.job?.ref}. See the output below.` });
    }).catch(() => undefined), 5000);
    return () => clearInterval(t);
  }, [running, instanceId]);
  // an account connected before this feature: how to update its connection (admins)
  useEffect(() => {
    if (v && !v.available && user?.role === 'admin') api.awsConnection().then((c) => setUpdate((c as { update?: { stackName?: string; templateUrl?: string | null; stacksUrl?: string } }).update ?? {})).catch(() => setUpdate({}));
  }, [v?.available]); // eslint-disable-line react-hooks/exhaustive-deps

  async function change(c: ServerComponent, action: ComponentAction) {
    const version = action === 'install' ? (pick[c.id] ?? (c.id === 'python' ? c.offered.find((o) => !(c.versions ?? []).includes(o)) : c.offered[0]) ?? '') : action === 'remove' && c.id === 'python' ? pick[c.id] ?? c.versions?.[c.versions.length - 1] ?? '' : '';
    const label = `${c.name}${version ? ` ${version}` : ''}`;
    if (action === 'stop' && !(await dialog.confirm({ title: `Stop ${c.name}?`, body: 'Apps that use it stop working until it is started again. It also stays stopped after a reboot.', confirmLabel: 'Stop', danger: true }))) return;
    if (action === 'remove' && !(await dialog.confirm({ title: `Remove ${label}?`, body: 'The package is removed from the server. Its data folder is kept.', confirmLabel: 'Remove', danger: true }))) return;
    if (action === 'install' && v?.host && c.needMb > v.host.memoryAvailableMb + v.host.swapFreeMb / 2
        && !(await dialog.confirm({ title: `Install ${label}?`, body: `It needs about ${c.needMb} MB of memory and the server has about ${v.host.memoryAvailableMb} MB free. The install will probably be refused.`, confirmLabel: 'Try anyway' }))) return;
    setMsg(null);
    try {
      await api.changeComponent(instanceId, { action, component: c.id, version });
      await load();
    } catch (e) { setMsg({ tone: 'bad', text: e instanceof ApiError ? e.message : 'That did not work.' }); }
  }

  const can = (c: ServerComponent, a: ComponentAction) => !!v?.changeable[c.id]?.includes(a) && !running;
  return (
    <section className="card overflow-hidden p-0">
      <div className="flex flex-wrap items-center gap-3 px-5 py-4">
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 font-medium text-slate-100">{smallIcon(Boxes, 'text-slate-500')}Components</h2>
          <p className="mt-0.5 text-sm text-slate-400">Databases, services and runtimes on this server, from Amazon Linux&rsquo;s own packages.{v?.at ? ` Checked ${ago(v.at)}.` : ''}</p>
        </div>
        {v?.available && <button className="btn-ghost text-sm" disabled={loading || running} onClick={() => void load(true)}>{smallIcon(RefreshCw, loading ? 'animate-spin motion-reduce:animate-none' : '')}Check now</button>}
      </div>

      {(msg || err) && <div className="px-5 pb-4"><Alert tone={msg?.tone ?? 'bad'}>{msg?.text ?? err}</Alert></div>}

      {v && !v.available && (
        <div className="border-t border-ink-700 px-5 py-4 text-sm text-slate-300">
          <p><b className="text-slate-100">This AWS account needs a one-time connection update</b> before components can be managed: it was connected before this feature existed.</p>
          {user?.role === 'admin' ? (update?.stackName ? (
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-slate-400">
              <li>Open the <a className="text-indigo-300 hover:text-indigo-200" href={update.stacksUrl} target="_blank" rel="noreferrer">CloudFormation stack <code className="font-mono text-xs">{update.stackName}</code></a> and choose <b>Update</b>.</li>
              <li>Choose <b>Replace existing template</b> → <b>Amazon S3 URL</b> and paste: <code className="break-all font-mono text-xs text-slate-300">{update.templateUrl ?? 'the template address from your console admin'}</code></li>
              <li>Keep every setting as it is, tick the IAM acknowledgement, and submit. When the stack shows UPDATE_COMPLETE, select <b>Check now</b> here.</li>
            </ol>
          ) : <p className="mt-1 text-slate-400">Single-team console: publish the documents with <code className="font-mono text-xs">infra/ops-console-ssm/deploy.sh</code>.</p>)
            : <p className="mt-1 text-slate-400">A workspace admin can do this from the AWS console in a couple of minutes.</p>}
        </div>
      )}

      {running && v?.job && (
        <div className="flex items-center gap-2 border-t border-ink-700 bg-indigo-500/10 px-5 py-3 text-sm text-indigo-200">
          <RefreshCw className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />
          {PAST[(v.job.ref.split(' ')[0] as ComponentAction)] ?? 'Working on'} {v.job.ref.split(' ').slice(1).join(' ')}… started {ago(v.job.createdAt)} by {v.job.requestedBy}. Deploys on this server wait until it finishes.
        </div>
      )}
      {!running && v?.job && v.job.status === 'failed' && v.job.output && (
        <details className="border-t border-ink-700 px-5 py-3 text-sm">
          <summary className="cursor-pointer text-rose-300">The last change ({v.job.ref}) failed {ago(v.job.finishedAt)}: show the output</summary>
          <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded-lg bg-ink-950 p-3 font-mono text-xs text-slate-300">{v.job.output.split('\n').filter((l) => !l.startsWith('{')).slice(-30).join('\n')}</pre>
        </details>
      )}

      {v?.components && (
        <div className="overflow-x-auto border-t border-ink-700">
          <table className="w-full min-w-[46rem] text-sm">
            <thead className="bg-ink-850"><tr><th className={th}>Component</th><th className={th}>Version</th><th className={th}>Status</th><th className={th}>Memory</th>{Object.keys(v.changeable).length > 0 && <th className={th}><span className="sr-only">Actions</span></th>}</tr></thead>
            {GROUPS.map((g) => {
              const list = v.components!.filter((c) => c.category === g.id);
              return list.length ? (
                <tbody key={g.id} className="divide-y divide-ink-700 border-t border-ink-700">
                  <tr><td colSpan={5} className="bg-ink-850/50 px-4 py-1.5 text-2xs font-semibold uppercase tracking-wider text-slate-500"><span className="inline-flex items-center gap-1.5">{smallIcon(g.icon, 'h-3.5 w-3.5')}{g.label}</span></td></tr>
                  {list.map((c) => {
                    const installable = can(c, 'install') && (c.id === 'python' ? c.offered.some((o) => !(c.versions ?? []).includes(o)) : !c.installed) && c.offered.length > 0;
                    const choices = c.id === 'python' ? c.offered.filter((o) => !(c.versions ?? []).includes(o)) : c.offered;
                    return (
                      <tr key={c.id}>
                        <td className={td}><div className="text-slate-100">{c.name}</div><div className="text-2xs text-slate-500">{c.note}</div></td>
                        <td className={`${td} font-mono text-xs text-slate-300`}>{c.version ?? (c.offered.length ? <span className="font-sans text-slate-500">offered: {c.offered.join(', ')}</span> : '—')}</td>
                        <td className={td}><Status c={c} /></td>
                        <td className={`${td} text-slate-400`}>{c.installed && c.memoryMb ? `${c.memoryMb} MB` : c.installed ? '—' : c.needMb ? <span className="text-slate-500">needs ~{c.needMb} MB</span> : '—'}</td>
                        {Object.keys(v.changeable).length > 0 && (
                          <td className={`${td} whitespace-nowrap text-right`}>
                            {installable && <span className="inline-flex items-center gap-1.5">
                              {choices.length > 1 && <select className="rounded border border-ink-600 bg-transparent px-1.5 py-1 text-xs text-slate-300" value={pick[c.id] ?? choices[0]} onChange={(e) => setPick((p) => ({ ...p, [c.id]: e.target.value }))} aria-label={`${c.name} version`}>
                                {choices.map((o) => <option key={o} value={o}>{o}</option>)}</select>}
                              <button className="btn-primary px-2.5 py-1 text-xs" onClick={() => void change(c, 'install')}>{smallIcon(Plus, 'h-3.5 w-3.5')}Install</button>
                            </span>}
                            {c.installed && c.active === false && can(c, 'start') && <button className="btn-ghost ml-1 px-2.5 py-1 text-xs" onClick={() => void change(c, 'start')}>{smallIcon(Play, 'h-3.5 w-3.5')}Start</button>}
                            {c.installed && c.active === true && can(c, 'stop') && !(c.id === 'postgresql' && v.host?.consoleHost) && <button className="btn-ghost ml-1 px-2.5 py-1 text-xs" onClick={() => void change(c, 'stop')}>{smallIcon(Square, 'h-3.5 w-3.5')}Stop</button>}
                            {c.installed && can(c, 'remove') && <button className="btn-ghost ml-1 px-2.5 py-1 text-xs text-rose-300" onClick={() => void change(c, 'remove')}>{smallIcon(Trash2, 'h-3.5 w-3.5')}Remove</button>}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              ) : null;
            })}
          </table>
        </div>
      )}
      {v?.host && <p className="border-t border-ink-700 px-5 py-3 text-xs text-slate-500">Memory: about {v.host.memoryAvailableMb} MB free of {v.host.memoryTotalMb} MB{v.host.swapFreeMb ? ` (+${v.host.swapFreeMb} MB swap)` : ''}. Databases and Valkey listen on this server only.</p>}
      {!v && !err && <p className="border-t border-ink-700 px-5 py-4 text-sm text-slate-500">Reading the server&rsquo;s components…</p>}
    </section>
  );
}
