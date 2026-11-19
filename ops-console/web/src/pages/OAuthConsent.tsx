import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import { Alert } from '../components/ui';

/**
 * /oauth/authorize: an AI app (ChatGPT, claude.ai, Claude Desktop, …) asks to read a workspace through the MCP server.
 * The person picks the workspace and approves or declines; the console then sends the browser back to the app.
 */
const KEYS = ['client_id', 'redirect_uri', 'response_type', 'code_challenge', 'code_challenge_method', 'scope', 'state', 'resource'] as const;
const ROLE: Record<string, string> = { admin: 'administrator', deployer: 'deployer', viewer: 'viewer' };

export function OAuthConsent() {
  const { user, site, logout } = useAuth();
  const [q] = useSearchParams();
  const params = useMemo(() => Object.fromEntries(KEYS.map((k) => [k, q.get(k) ?? undefined])), [q]);
  const [info, setInfo] = useState<Awaited<ReturnType<typeof api.oauthCheck>> | null>(null);
  const [ws, setWs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.oauthCheck(params).then((r) => {
      setInfo(r);
      setWs(r.workspaces.some((w) => w.id === r.current) ? r.current : r.workspaces[0]?.id ?? null);
    }).catch((e) => {
      if (e instanceof ApiError && e.redirect) { window.location.assign(e.redirect); return; }   // the app is told what went wrong
      setError(e instanceof ApiError ? e.message : 'This request could not be checked.');
    });
  }, [params]);

  async function decide(approve: boolean) {
    setBusy(true); setError(null);
    try {
      const r = await api.oauthDecide({ ...params, approve, workspaceId: ws });
      window.location.assign(r.redirect);
    } catch (e) { setError(e instanceof ApiError ? e.message : 'Something went wrong.'); setBusy(false); }
  }

  const chosen = info?.workspaces.find((w) => w.id === ws);
  return (
    <div className="grid min-h-screen place-items-center px-4 py-10">
      <div className="w-full max-w-md">
        <p className="text-center text-sm font-semibold tracking-wide text-slate-400">{site.productName}</p>
        <div className="card mt-4 space-y-5">
          {error && <Alert>{error}</Alert>}
          {!info && !error && <p className="text-sm text-slate-500">Checking the request…</p>}
          {info && (
            <>
              <div>
                <h1 className="text-lg font-semibold text-slate-100">Connect <span className="text-indigo-300">{info.client.name}</span>?</h1>
                <p className="mt-1 text-sm text-slate-400">
                  It will be able to <b className="text-slate-200">read</b> the workspace as <b className="text-slate-200">{user?.username}</b>{chosen ? ` (${ROLE[chosen.role] ?? chosen.role})` : ''}, through the MCP server.
                </p>
              </div>
              <ul className="space-y-1.5 text-sm text-slate-300">
                <li>✓ Servers, apps, deploys, alerts, uptime and backups{chosen && chosen.role !== 'viewer' ? ', and AWS costs' : ''}</li>
                <li className="text-slate-500">✕ It can&rsquo;t deploy, restart or change anything</li>
                <li className="text-slate-500">✕ It never sees setting values, passwords or keys</li>
              </ul>
              {site.multiTenant && (
                info.workspaces.length ? (
                  <label className="block">
                    <span className="label">Workspace</span>
                    <select className="input" value={ws ?? ''} onChange={(e) => setWs(Number(e.target.value))}>
                      {info.workspaces.map((w) => <option key={w.id} value={w.id}>{w.name} ({ROLE[w.role] ?? w.role})</option>)}
                    </select>
                  </label>
                ) : <Alert>This account isn&rsquo;t a member of any active workspace.</Alert>
              )}
              <p className="text-xs text-slate-500">
                After approving, the browser returns to <b className="text-slate-300">{info.client.redirectHost}</b>. The connection lasts 30 days while it&rsquo;s used, and can be ended any time under Account → AI tools (MCP). Data it reads goes to {info.client.name}&rsquo;s provider.
              </p>
              <div className="flex gap-2">
                <button className="btn-primary flex-1" disabled={busy || (site.multiTenant && !ws)} onClick={() => void decide(true)}>{busy ? 'Connecting…' : 'Approve'}</button>
                <button className="btn-ghost flex-1" disabled={busy} onClick={() => void decide(false)}>Decline</button>
              </div>
            </>
          )}
        </div>
        <p className="mt-4 text-center text-xs text-slate-500">
          Signed in as {user?.username}. <button className="hover:underline" onClick={() => void logout()}>Not you?</button>
        </p>
      </div>
    </div>
  );
}
