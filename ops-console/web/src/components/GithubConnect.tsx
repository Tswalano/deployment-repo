import { useEffect, useState } from 'react';
import { api, ApiError, GithubStatus } from '../api';
import { Alert } from './ui';

const err = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong.');
const Mark = () => (
  <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor" aria-hidden>
    <path d="M12 .5a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2.1c-3.3.7-4-1.6-4-1.6-.6-1.4-1.4-1.8-1.4-1.8-1.1-.7.1-.7.1-.7 1.2.1 1.9 1.3 1.9 1.3 1.1 1.9 2.9 1.3 3.6 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0C17.3 4.6 18.3 5 18.3 5c.7 1.7.2 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .5z" />
  </svg>
);

/** Settings card: connect the console to GitHub by creating a private GitHub App from a manifest (one click). */
/** Multi-customer: this workspace's own GitHub installations (the platform's app is shared; installations are not). */
function WorkspaceGithub({ s, reload }: { s: GithubStatus; reload: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  if (!s.connected || !s.linkable) return <Alert tone="warn">GitHub isn't available yet on this platform.</Alert>;
  return (
    <div className="space-y-4">
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      {s.installations?.length ? (
        <ul className="divide-y divide-ink-800 rounded-xl border border-ink-700">
          {s.installations.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
              <span className="min-w-0 flex-1 truncate text-slate-200">Installed on <b className="font-medium">{i.account}</b></span>
              <button className="btn-ghost px-2.5 py-1 text-xs" disabled={busy} onClick={async () => {
                if (!confirm(`Unlink ${i.account} from this workspace? Apps linked to its repositories stop deploying on push.`)) return;
                setBusy(true); try { const r = await api.githubUnlink(i.id); setMsg({ tone: 'ok', text: r.note }); await reload(); } catch (e) { setMsg({ tone: 'bad', text: err(e) }); } finally { setBusy(false); }
              }}>Unlink</button>
            </li>
          ))}
        </ul>
      ) : <p className="text-sm text-slate-400">Not installed yet. Install the app on your GitHub account or organisation and choose which repositories it may read.</p>}
      <button className={s.installations?.length ? 'btn-secondary' : 'btn-primary'} disabled={busy} onClick={async () => {
        setBusy(true); setMsg(null);
        try { window.location.assign((await api.githubInstallLink()).url); } catch (e) { setMsg({ tone: 'bad', text: err(e) }); setBusy(false); }
      }}>{s.installations?.length ? 'Add another account or change access' : 'Install on GitHub'}</button>
      <p className="text-xs text-slate-500">GitHub asks you to authorise the app at the end: that's how the console confirms the installation is yours before linking it here.</p>
    </div>
  );
}

/** GitHub sends people here after installing the app (multi-customer): confirm and link the installation. */
export function GithubInstalled() {
  const [state, setState] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const code = q.get('code'), id = Number(q.get('installation_id')), st = q.get('state');
    if (!code || !id || !st) { setState({ tone: 'bad', text: 'GitHub did not send the details needed. Start again from Settings → GitHub.' }); return; }
    api.githubLinkInstallation({ code, installationId: id, state: st })
      .then((r) => setState({ tone: 'ok', text: `GitHub is linked: ${r.account}'s repositories can now be deployed.` }))
      .catch((e) => setState({ tone: 'bad', text: err(e) }));
  }, []);
  return (
    <div className="mx-auto max-w-lg py-10">
      {state ? <Alert tone={state.tone}>{state.text}</Alert> : <p className="text-sm text-slate-400">Linking your GitHub installation…</p>}
      <a className="btn-secondary mt-4" href="/settings#github">Back to Settings</a>
    </div>
  );
}

export function GithubConnect() {
  const [s, setS] = useState<GithubStatus | null>(null);
  const [org, setOrg] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const load = () => api.github().then(setS).catch((e) => setMsg({ tone: 'bad', text: err(e) }));
  useEffect(() => { void load(); }, []);

  async function connect() {
    setBusy(true); setMsg(null);
    try {
      const { action, manifest } = await api.githubManifest(org.trim() || undefined);
      // GitHub's manifest flow is a form POST from the browser to github.com
      const f = document.createElement('form');
      f.method = 'post'; f.action = action;
      const i = document.createElement('input');
      i.type = 'hidden'; i.name = 'manifest'; i.value = JSON.stringify(manifest);
      f.appendChild(i); document.body.appendChild(f); f.submit();
    } catch (e) { setMsg({ tone: 'bad', text: err(e) }); setBusy(false); }
  }

  // multi-customer: workspaces link their own installations; a platform admin with no app yet gets the set-up below
  if (s?.multiTenant && !(s.canManageApp && !s.connected)) {
    return (
      <section id="github" className="card space-y-4">
        <div>
          <h2 className="font-medium text-slate-100">GitHub</h2>
          <p className="mt-1 text-sm text-slate-400">Deploy from your repositories, and on every push.</p>
        </div>
        <WorkspaceGithub s={s} reload={load} />
      </section>
    );
  }
  return (
    <section id="github" className="card space-y-4">
      <div className="flex items-center gap-3">
        <span className="grid h-9 w-9 place-items-center rounded-lg border border-ink-600 bg-ink-850 text-slate-200"><Mark /></span>
        <div>
          <h2 className="font-medium text-slate-100">GitHub</h2>
          <p className="text-sm text-slate-500">Connect repositories to deploy them, and deploy automatically on every push.</p>
        </div>
      </div>
      {!s ? <p className="text-sm text-slate-500">Loading…</p> : !s.connected ? (
        <>
          <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-400">
            <li>Click <b className="text-slate-200">Connect GitHub</b>. GitHub opens and asks you to create a private app called “Ops Console …” (read-only access to code).</li>
            <li>GitHub sends you back here. Then install the app and pick the repositories it may see.</li>
          </ol>
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="label" htmlFor="gh-org">GitHub organisation <span className="text-slate-600">(optional, leave empty for your personal account)</span></label>
              <input id="gh-org" className="input w-72" value={org} onChange={(e) => setOrg(e.target.value)} placeholder="e.g. Tswalano" />
            </div>
            <button className="btn-primary" onClick={() => void connect()} disabled={busy}><Mark />{busy ? 'Opening GitHub…' : 'Connect GitHub'}</button>
          </div>
        </>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-ink-700 px-4 py-3">
            <span className="pill-ok">connected</span>
            <a href={s.app!.htmlUrl} target="_blank" rel="noreferrer noopener" className="text-sm text-slate-200 hover:underline">{s.app!.slug}</a>
            <span className="text-sm text-slate-500">owned by {s.app!.owner}</span>
            <span className="ml-auto text-xs text-slate-500">
              {s.installations?.length ? s.installations.map((i) => `installed on ${i.account} (${i.selection === 'all' ? 'all repositories' : 'selected repositories'})`).join(' · ') : 'not installed yet'}
            </span>
          </div>
          {s.error && <Alert tone="warn">{s.error}</Alert>}
          <div className="flex flex-wrap gap-2">
            <a className={s.installations?.length ? 'btn-secondary' : 'btn-primary'} href={s.installUrl} target="_blank" rel="noreferrer noopener">
              {s.installations?.length ? 'Change repository access' : 'Install on GitHub and pick repositories'}
            </a>
            <button className="btn-ghost" onClick={() => void load()}>I’ve installed it: refresh</button>
            <button className="btn-danger ml-auto" onClick={async () => {
              if (!window.confirm('Disconnect GitHub? Auto-deploys stop. You can then delete the app on GitHub.')) return;
              try { const r = await api.githubDisconnect(); setMsg({ tone: 'ok', text: r.deleteAppUrl ? 'Disconnected. To remove the app from GitHub too, open its settings → Advanced → Delete.' : 'Disconnected.' }); await load(); }
              catch (e) { setMsg({ tone: 'bad', text: err(e) }); }
            }}>Disconnect</button>
          </div>
          <p className="text-xs text-slate-500">GitHub sends pushes to <code className="font-mono">{s.webhookUrl}</code>. Auto-deploy works once the console runs there.</p>
        </>
      )}
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
    </section>
  );
}

/** /github/callback: GitHub returns here after creating the app (code) or installing it (installed=1). */
export function GithubCallback() {
  const [state, setState] = useState<{ tone: 'ok' | 'bad'; text: string; installUrl?: string } | null>(null);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get('installed')) { setState({ tone: 'ok', text: 'GitHub App installed. Your repositories are now available in the console.' }); return; }
    const code = q.get('code'), st = q.get('state');
    if (!code || !st) { setState({ tone: 'bad', text: 'Missing code from GitHub. Start again from Settings → GitHub.' }); return; }
    api.githubExchange(code, st)
      .then((r) => setState({ tone: 'ok', text: 'GitHub is connected. One more step: install the app and choose which repositories the console may use.', installUrl: r.installUrl }))
      .catch((e) => setState({ tone: 'bad', text: err(e) }));
  }, []);
  return (
    <div className="mx-auto max-w-xl py-10">
      <h1 className="mb-4 text-lg font-semibold text-slate-100">GitHub</h1>
      {!state ? <p className="text-sm text-slate-500">Finishing the connection…</p> : (
        <div className="space-y-4">
          <Alert tone={state.tone}>{state.text}</Alert>
          <div className="flex gap-2">
            {state.installUrl && <a className="btn-primary" href={state.installUrl}>Install on GitHub</a>}
            <a className="btn-secondary" href="/settings#github">Back to Settings</a>
          </div>
        </div>
      )}
    </div>
  );
}
