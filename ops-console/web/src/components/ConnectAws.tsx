import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, AwsConnectionView, AwsServer } from '../api';
import { useAuth } from '../auth';
import { Alert } from './ui';

const err = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong.');

function Copy({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  return (
    <span className="flex min-w-0 items-center gap-2">
      <code className="num min-w-0 truncate rounded-md border border-ink-700 bg-ink-950 px-2 py-1 text-xs text-slate-200" title={value}>{value}</code>
      <button type="button" className="btn-ghost shrink-0 px-2 py-1 text-xs" onClick={() => { void navigator.clipboard?.writeText(value); setDone(true); setTimeout(() => setDone(false), 1500); }}>{done ? 'Copied' : 'Copy'}</button>
    </span>
  );
}

/** Step 2: create the access role in the customer's account (CloudFormation), then verify it. */
export function ConnectAwsPanel({ view, onChanged }: { view: AwsConnectionView; onChanged: () => Promise<void> }) {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin' && !user.isDemo;
  const c = view.connection;
  const [roleArn, setRoleArn] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(c.status === 'error' ? c.error : null);

  if (!isAdmin) return <Alert tone="warn">An admin of this workspace connects the AWS account.</Alert>;
  const region = view.regions.find(([r]) => r === c.region)?.[1] ?? c.region;

  return (
    <div className="space-y-4 rounded-xl border border-ink-700 bg-ink-950/40 p-4">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="label" htmlFor="aws-region">Region of your servers</label>
          <select id="aws-region" className="input" value={c.region} disabled={busy} onChange={async (e) => {
            setBusy(true); setMsg(null);
            try { await api.awsRegion(e.target.value); await onChanged(); } catch (e2) { setMsg(err(e2)); } finally { setBusy(false); }
          }}>
            {view.regions.map(([r, n]) => <option key={r} value={r}>{n} · {r}</option>)}
          </select>
        </div>
      </div>

      <ol className="space-y-4 text-sm">
        <li className="flex gap-3">
          <span className="num grid h-6 w-6 shrink-0 place-items-center rounded-full bg-ink-800 text-xs text-slate-300">1</span>
          <div className="min-w-0 flex-1">
            <p className="text-slate-200">Create the access role in your AWS account ({region}).</p>
            {view.quickCreateUrl ? (
              <div className="mt-2 flex flex-wrap gap-2">
                <a className="btn-primary" href={view.quickCreateUrl} target="_blank" rel="noreferrer noopener">Open AWS CloudFormation</a>
                <a className="btn-ghost" href="/api/aws-connection/template" download>Download template</a>
              </div>
            ) : (
              <>
                <div className="mt-2 flex flex-wrap gap-2">
                  <a className="btn-primary" href="/api/aws-connection/template" download>Download template</a>
                  <a className="btn-secondary" href={view.cloudFormationUrl} target="_blank" rel="noreferrer noopener">Open AWS CloudFormation</a>
                </div>
                <p className="mt-2 text-xs text-slate-500">In CloudFormation: <b>Create stack → Upload a template file</b>, choose the downloaded file, name the stack <code>OpsConsoleAccess</code>, keep the filled-in values, tick the IAM acknowledgement, and create it.</p>
              </>
            )}
            <details className="mt-2 text-xs text-slate-500">
              <summary className="cursor-pointer">Values in the template</summary>
              <div className="mt-2 grid gap-2">
                <span className="flex flex-wrap items-center gap-2">External ID (unique to this workspace): {c.externalId && <Copy value={c.externalId} />}</span>
                {view.principal && <span className="flex flex-wrap items-center gap-2">Allowed console identity: <Copy value={view.principal} /></span>}
                <span>Already using {`OpsConsole-*`} documents in this account and region (e.g. from <code>infra/ops-console-ssm/deploy.sh</code>)? Set <b>InstallDocuments</b> to <b>no</b>.</span>
              </div>
            </details>
          </div>
        </li>
        <li className="flex gap-3">
          <span className="num grid h-6 w-6 shrink-0 place-items-center rounded-full bg-ink-800 text-xs text-slate-300">2</span>
          <p className="text-slate-200">Wait until the stack shows <b>CREATE_COMPLETE</b> (about two minutes), then open its <b>Outputs</b> tab and copy <b>RoleArn</b>.</p>
        </li>
        <li className="flex gap-3">
          <span className="num grid h-6 w-6 shrink-0 place-items-center rounded-full bg-ink-800 text-xs text-slate-300">3</span>
          <form className="min-w-0 flex-1" onSubmit={async (e) => {
            e.preventDefault(); setBusy(true); setMsg(null);
            try { await api.awsVerify(roleArn.trim()); await onChanged(); } catch (e2) { setMsg(err(e2)); } finally { setBusy(false); }
          }}>
            <label className="label" htmlFor="aws-role">Paste the RoleArn</label>
            <div className="flex flex-wrap gap-2">
              <input id="aws-role" className="input num min-w-[18rem] flex-1 text-xs" placeholder="arn:aws:iam::123456789012:role/OpsConsoleAccess-af-south-1" value={roleArn} onChange={(e) => setRoleArn(e.target.value)} />
              <button className="btn-primary" disabled={busy || !roleArn.trim()}>{busy ? 'Checking…' : 'Connect'}</button>
            </div>
          </form>
        </li>
      </ol>
      {msg && <Alert>{msg}</Alert>}
    </div>
  );
}

/** Step 3: pick servers in the connected account. Adding tags them and gives them our instance profile if they have none. */
export function AddServersPanel({ onAdded }: { onAdded: (id: number) => void }) {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin' && !user.isDemo;
  const [data, setData] = useState<{ region: string; servers: AwsServer[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [env, setEnv] = useState('production');
  const load = useCallback(() => api.awsServers().then((d) => { setData(d); setError(null); }).catch((e) => setError(err(e))), []);
  useEffect(() => { void load(); }, [load]);

  if (error) return <Alert>{error}</Alert>;
  if (!data) return <p className="text-sm text-slate-500">Looking for servers in your account…</p>;
  const usable = data.servers.filter((s) => s.linux);
  return (
    <div className="space-y-3">
      {usable.length === 0 ? (
        <Alert tone="warn">No Linux EC2 servers in {data.region} yet. Launch one in the EC2 console (Amazon Linux 2023, t4g.small or larger works well), then <button className="underline" onClick={() => void load()}>look again</button>.</Alert>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 text-sm text-slate-400">
            Add as <select className="input w-auto py-1 text-sm" aria-label="Environment" value={env} onChange={(e) => setEnv(e.target.value)}>
              <option value="production">production</option><option value="staging">staging</option><option value="development">development</option>
            </select>
            <button className="btn-ghost ml-auto px-2.5 py-1 text-xs" onClick={() => void load()}>Refresh</button>
          </div>
          <ul className="divide-y divide-ink-800 rounded-xl border border-ink-700">
            {usable.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-slate-100">{s.name || s.id}</div>
                  <div className="num truncate text-xs text-slate-500">{s.id} · {s.type} · {s.az}{s.publicIp ? ` · ${s.publicIp}` : ''}</div>
                </div>
                <span className={s.state === 'running' ? 'pill-ok' : 'pill-mute'}>{s.state}</span>
                <span className={s.ssmOnline ? 'pill-ok' : 'pill-warn'} title={s.ssmOnline ? 'Reachable through Session Manager' : 'Not reachable through Session Manager yet: adding it attaches our instance profile; the agent connects within a few minutes'}>
                  {s.ssmOnline ? 'reachable' : 'not reachable yet'}
                </span>
                {s.added ? <span className="pill-info">added</span> : isAdmin && (
                  <button className="btn-primary px-3 py-1.5 text-xs" disabled={!!busy} onClick={async () => {
                    setBusy(s.id); setError(null);
                    try { const r = await api.awsAddServer({ awsInstanceId: s.id, environment: env }); onAdded(r.instance.id); }
                    catch (e) { setError(err(e)); } finally { setBusy(null); }
                  }}>{busy === s.id ? 'Adding…' : 'Add'}</button>
                )}
              </li>
            ))}
          </ul>
          <p className="text-xs text-slate-500">Adding a server tags it <code>ops-console=managed</code> (and its security groups) and, if it has no instance profile, attaches <code>OpsConsoleInstance-{data.region}</code> so the console can reach it without SSH.</p>
        </>
      )}
    </div>
  );
}

/** Settings → AWS account (multi-customer mode). */
export function AwsAccountCard() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin' && !user.isDemo;
  const [view, setView] = useState<AwsConnectionView | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad' | 'warn'; text: string } | null>(null);
  const load = useCallback(() => api.awsConnection().then(setView).catch((e) => setMsg({ tone: 'bad', text: err(e) })), []);
  useEffect(() => { void load(); }, [load]);
  if (!view) return null;
  const c = view.connection;
  return (
    <section className="card space-y-4">
      <div>
        <h2 className="font-medium text-slate-100">AWS account</h2>
        <p className="mt-1 text-sm text-slate-400">The console works in your account only through the access role you created.</p>
      </div>
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      {c.status === 'connected' ? (
        <>
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[10rem_minmax(0,1fr)]">
            <dt className="text-slate-500">Account</dt><dd className="num text-slate-200">{c.accountId}</dd>
            <dt className="text-slate-500">Region</dt><dd className="num text-slate-200">{c.region}</dd>
            <dt className="text-slate-500">Role</dt><dd className="num truncate text-slate-200" title={c.roleArn ?? ''}>{c.roleArn}</dd>
            <dt className="text-slate-500">Connected</dt><dd className="text-slate-200">{c.connectedAt ? new Date(c.connectedAt).toLocaleString() : '—'}{c.connectedBy ? ` by ${c.connectedBy}` : ''}</dd>
          </dl>
          {isAdmin && (
            <div className="flex flex-wrap items-center gap-3">
              <button className="btn-danger" onClick={async () => {
                if (!confirm('Disconnect this AWS account? The console stops managing its servers at once. Your servers and apps keep running.')) return;
                try { const r = await api.awsDisconnect(); setMsg({ tone: 'warn', text: `Disconnected. ${r.note}` }); await load(); } catch (e) { setMsg({ tone: 'bad', text: err(e) }); }
              }}>Disconnect</button>
              <span className="text-xs text-slate-500">To remove our access completely, also delete the <code>OpsConsoleAccess</code> stack in CloudFormation.</span>
            </div>
          )}
        </>
      ) : (
        <>
          <p className="text-sm text-slate-400">Not connected{c.status === 'disconnected' ? ' (disconnected)' : ''}. Until it is, the console can't reach your servers.</p>
          <ConnectAwsPanel view={view} onChanged={async () => { await load(); }} />
        </>
      )}
    </section>
  );
}
