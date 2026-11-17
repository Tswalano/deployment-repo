import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, AppView, GithubRepo } from '../../api';
import { Alert } from '../../components/ui';
import { errMsg, Section } from './shared';

/** Which GitHub repository/branch this app deploys from, and whether pushes deploy automatically. */
export function RepoCard({ view, isAdmin, onChange }: { view: AppView; isAdmin: boolean; onChange: () => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [repos, setRepos] = useState<GithubRepo[] | null>(null);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [repo, setRepo] = useState(view.repo?.repo ?? '');
  const [branches, setBranches] = useState<string[]>([]);
  const [branch, setBranch] = useState(view.repo?.branch ?? 'main');
  const [auto, setAuto] = useState(view.repo?.autoDeploy ?? true);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (!editing) return;
    api.github().then((s) => { setConnected(s.connected); if (s.connected) api.githubRepos().then(setRepos).catch((e) => setMsg(errMsg(e))); }).catch((e) => setMsg(errMsg(e)));
  }, [editing]);
  useEffect(() => { if (repo) api.githubBranches(repo).then(setBranches).catch(() => setBranches([])); }, [repo]);
  const r = view.repo;
  const save = async (b: { repo: string; branch: string; autoDeploy: boolean }) => {
    setMsg(null);
    try { await api.linkRepo(view.instance.id, view.app.project, b); setEditing(false); await onChange(); } catch (e) { setMsg(errMsg(e)); }
  };

  return (
    <Section title="Repository" sub={r ? <>Deploys from <a className="text-indigo-300 hover:underline" href={`https://github.com/${r.repo}/tree/${r.branch}`} target="_blank" rel="noreferrer noopener">{r.repo}</a> · {r.branch}</> : 'Not linked to a GitHub repository yet'}
             actions={isAdmin && !editing && <button className="btn-secondary px-3 py-1.5 text-xs" onClick={() => setEditing(true)}>{r ? 'Change' : 'Link repository'}</button>}>
      {r && !editing && (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className={r.autoDeploy ? 'pill-ok' : 'pill-mute'}>{r.autoDeploy ? 'auto-deploy on' : 'auto-deploy off'}</span>
          <span className="text-slate-400">{r.autoDeploy ? `Every push to ${r.branch} is deployed (approvals and freezes still apply).` : 'Deploy manually from this page.'}</span>
          {isAdmin && (
            <button className="btn-ghost ml-auto px-2.5 py-1 text-xs" onClick={() => void save({ repo: r.repo, branch: r.branch, autoDeploy: !r.autoDeploy })}>
              {r.autoDeploy ? 'Turn auto-deploy off' : 'Turn auto-deploy on'}
            </button>
          )}
        </div>
      )}
      {editing && (
        connected === false ? (
          <p className="text-sm text-slate-400">GitHub isn't connected yet. <Link className="text-indigo-300 hover:underline" to="/settings#github">Connect it in Settings</Link>, then come back.</p>
        ) : (
          <div className="space-y-3">
            <div className="grid gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
              <div>
                <label className="label" htmlFor="rp-repo">Repository</label>
                <select id="rp-repo" className="input" value={repo} onChange={(e) => { setRepo(e.target.value); const x = repos?.find((y) => y.fullName === e.target.value); if (x) setBranch(x.defaultBranch); }}>
                  <option value="">{repos ? 'Choose…' : 'Loading…'}</option>
                  {repos?.map((x) => <option key={x.fullName} value={x.fullName}>{x.fullName}{x.private ? ' (private)' : ''}</option>)}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="rp-branch">Branch</label>
                <select id="rp-branch" className="input" value={branch} onChange={(e) => setBranch(e.target.value)}>
                  {(branches.length ? branches : [branch]).map((b) => <option key={b}>{b}</option>)}
                </select>
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm text-slate-300"><input type="checkbox" className="accent-indigo-400" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Deploy automatically when this branch is pushed</label>
            <p className="text-xs text-slate-500">Don't see the repository? Give the GitHub App access to it (Settings → GitHub → Change repository access).</p>
            <div className="flex justify-end gap-2">
              {r && <button className="btn-danger mr-auto px-3 py-1.5 text-xs" onClick={async () => { await api.unlinkRepo(view.instance.id, view.app.project); setEditing(false); await onChange(); }}>Unlink</button>}
              <button className="btn-ghost px-3 py-1.5 text-xs" onClick={() => setEditing(false)}>Cancel</button>
              <button className="btn-primary px-3 py-1.5 text-xs" disabled={!repo} onClick={() => void save({ repo, branch, autoDeploy: auto })}>Save</button>
            </div>
          </div>
        )
      )}
      {msg && <div className="mt-3"><Alert>{msg}</Alert></div>}
    </Section>
  );
}
