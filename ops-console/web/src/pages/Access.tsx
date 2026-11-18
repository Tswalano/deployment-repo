import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError, Instance, MyKey, SecurityView, SshAccessView, SshGrant } from '../api';
import { useAuth } from '../auth';
import { ago, Alert, Kpi, PageHeader, Skeleton } from '../components/ui';
import { useDialog } from '../components/Dialog';

const err = (e: unknown) => (e instanceof Error ? e.message : String(e));
const when = (unix: number) => new Date(unix * 1000).toISOString();
const until = (iso: string) => {
  const m = Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 60000));
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
};
const short = (fp: string | null) => (fp ? `${fp.slice(0, 15)}…${fp.slice(-6)}` : '?');
const daysSince = (date: string | null) => (date ? Math.floor((Date.now() - Date.parse(date)) / 86400e3) : null);

/** Who can get onto an instance, and how: temporary SSH, keys, logins, terminal sessions, OS updates. */
export function Access() {
  const id = Number(useParams().id);
  const { user } = useAuth();
  const canWrite = user?.role === 'admin' && !user.isDemo;
  const [inst, setInst] = useState<Instance | null>(null);
  const [sec, setSec] = useState<SecurityView | null>(null);
  const [ssh, setSsh] = useState<SshAccessView | null>(null);
  const [sshError, setSshError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const loadSsh = useCallback(() => api.sshAccess(id).then((r) => { setSsh(r); setSshError(null); }).catch((e) => setSshError(err(e))), [id]);
  const check = useCallback(async () => {
    setChecking(true); setCheckError(null);
    try { const r = await api.refreshSecurity(id); setSec((s) => (s ? { ...s, at: r.at, snapshot: r.snapshot } : s)); }
    catch (e) { setCheckError(err(e)); }
    finally { setChecking(false); }
  }, [id]);

  useEffect(() => {
    api.instance(id).then((r) => setInst(r.instance)).catch((e) => setError(err(e)));
    void loadSsh();
    api.security(id).then((s) => {
      setSec(s);
      // first visit, or older than 6 hours: take a fresh snapshot (cheap, read-only)
      if (!s.at || Date.now() - Date.parse(s.at) > 6 * 3600e3) void check();
    }).catch((e) => setError(err(e)));
  }, [id, loadSsh, check]);

  // keep the countdowns moving and pick up expiries
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 30_000); return () => clearInterval(t); }, []);
  useEffect(() => { const t = setInterval(() => void loadSsh(), 60_000); return () => clearInterval(t); }, [loadSsh]);

  if (error) return <Alert>{error}</Alert>;
  if (!inst || !sec) return <Skeleton className="h-96" />;
  const snap = sec.snapshot;
  const off = inst.ec2State && inst.ec2State !== 'running';

  return (
    <div>
      <div className="mb-2 text-xs text-slate-500">
        <Link to="/instances" className="hover:text-slate-300">Instances</Link> / <Link to={`/instances/${inst.id}`} className="hover:text-slate-300">{inst.name}</Link> / <span className="text-slate-400">Access</span>
      </div>
      <PageHeader
        title={`Access · ${inst.name}`}
        subtitle={<>Who can get onto this server and how. {sec.at ? <>Checked {ago(sec.at)}.</> : 'Not checked yet.'}</>}
        actions={<>
          <button className="btn-secondary" onClick={() => void check()} disabled={checking || !!off}>
            <svg viewBox="0 0 24 24" className={`h-4 w-4 ${checking ? 'animate-spin motion-reduce:animate-none' : ''}`} fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M21 12a9 9 0 1 1-2.6-6.4M21 4v5h-5" /></svg>
            {checking ? 'Checking…' : 'Check now'}
          </button>
          {canWrite && <Link to={`/instances/${inst.id}/terminal`} className={`btn-primary ${off ? 'pointer-events-none opacity-50' : ''}`} aria-disabled={!!off}>Open terminal</Link>}
        </>}
      />
      {off && <div className="mb-4"><Alert tone="warn">{inst.name} is {inst.ec2State}: checks and the terminal need it running. The last snapshot is shown.</Alert></div>}
      {checkError && <div className="mb-4"><Alert>{checkError}</Alert></div>}
      {msg && <div className="mb-4"><Alert tone="ok">{msg}</Alert></div>}

      {snap ? <Summary snap={snap} /> : <div className="card mb-6 text-sm text-slate-400">{checking ? 'Taking the first security snapshot (a few seconds)…' : 'No snapshot yet: press Check now.'}</div>}

      {canWrite && <LaptopCard inst={inst} ssh={ssh} reload={loadSsh} onMessage={setMsg} />}
      <SshAccessCard instanceId={inst.id} ssh={ssh} error={sshError} canWrite={canWrite} reload={loadSsh} onMessage={setMsg} />
      {snap && <KeysCard instanceId={inst.id} sec={sec} canWrite={canWrite} onChanged={async (m) => { setMsg(m); const s = await api.security(id); setSec(s); }} />}
      {snap && <LoginsCard sec={sec} />}
      <SessionsCard sec={sec} />
      {snap && <UpdatesCard sec={sec} canTerminal={canWrite} instanceId={inst.id} />}
    </div>
  );
}

function Summary({ snap }: { snap: NonNullable<SecurityView['snapshot']> }) {
  const u = snap.updates;
  const newest = u.newer[u.newer.length - 1];
  const behind = daysSince(newest?.date ?? null) ?? 0;
  const age = daysSince(u.currentDate);
  const updTone = u.kind === 'release' ? (newest ? (age != null && age > 60 ? 'warn' : 'info') : 'ok') : u.advisoryCount ? 'warn' : 'ok';
  const updValue = u.kind === 'release' ? (newest ? u.newer.length : 'Current') : u.advisoryCount || 'None';
  const pw = snap.sshd.passwordauthentication;
  return (
    <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Kpi label="OS updates" tone={updTone} value={updValue} unit={u.kind === 'release' && newest ? (u.newer.length === 1 ? 'newer release' : 'newer releases') : u.kind === 'advisories' && u.advisoryCount ? 'security advisories' : undefined}
        sub={u.kind === 'release' ? (newest ? `latest ${newest.version}${behind ? ` (${behind} days old)` : ''}` : `on ${u.current ?? '?'}`) : u.error ?? (snap.os.name ?? '')} />
      <Kpi label="Reboot" tone={u.rebootRequired || u.kernelPending ? 'warn' : 'ok'} value={u.rebootRequired || u.kernelPending ? 'Needed' : u.rebootRequired === null ? '?' : 'Not needed'}
        sub={u.kernelPending ? `newer kernel ${u.newestKernel} installed` : `kernel ${snap.os.kernel}`} />
      <Kpi label="Failed SSH logins" tone={snap.logins.failed24h > 50 ? 'warn' : snap.logins.failed24h ? 'info' : 'ok'} value={snap.logins.failed24h} unit="in 24 h"
        sub={`${snap.logins.failedTotal} in 7 days from ${snap.logins.failedIps} address${snap.logins.failedIps === 1 ? '' : 'es'}`} />
      <Kpi label="Password logins" tone={pw === 'no' ? 'ok' : 'bad'} value={pw === 'no' ? 'Off' : pw === 'yes' ? 'On' : '?'}
        sub={pw === 'no' ? `keys only · root: ${snap.sshd.permitrootlogin ?? '?'}` : 'Turn off PasswordAuthentication in sshd_config'} />
    </div>
  );
}

function SshAccessCard({ instanceId, ssh, error, canWrite, reload, onMessage }:
  { instanceId: number; ssh: SshAccessView | null; error: string | null; canWrite: boolean; reload: () => Promise<void>; onMessage: (m: string) => void }) {
  const [hours, setHours] = useState(2);
  const [ip, setIp] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState<string | null>(null);
  const open = ssh?.grants.filter((g) => !g.revokedAt && g.kind === 'ip') ?? [];
  const recent = ssh?.grants.filter((g) => g.revokedAt && g.kind === 'ip').slice(0, 5) ?? [];
  const mineOpen = open.find((g) => ssh?.yourIp && !!g.cidr?.startsWith(`${ssh.yourIp}/`));

  async function grant() {
    setBusy(true); setFail(null);
    try {
      const r = await api.grantSsh(instanceId, { hours, ip: ip.trim() || undefined, reason: reason.trim() || undefined });
      onMessage(`SSH is open for ${r.grant.cidr} until ${new Date(r.grant.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${r.simulated ? ' (dry run: AWS confirmed it would be allowed; nothing changed)' : ''}. It closes by itself.`);
      setReason(''); await reload();
    } catch (e) { setFail(err(e)); }
    finally { setBusy(false); }
  }
  async function revoke(grantId: number) {
    setBusy(true); setFail(null);
    try { await api.revokeSsh(instanceId, grantId); onMessage('SSH access closed.'); await reload(); }
    catch (e) { setFail(err(e)); }
    finally { setBusy(false); }
  }

  return (
    <section className="card mb-6 space-y-4">
      <div>
        <h2 className="font-medium text-slate-100">Temporary SSH access</h2>
        <p className="mt-1 text-sm text-slate-400">Opens port 22 for one address only, and closes it again automatically. It's rarely needed: the <b className="font-medium text-slate-300">terminal</b> works without any open port.</p>
      </div>
      {error && <Alert>{error}</Alert>}
      {fail && <Alert>{fail}</Alert>}
      {ssh && !ssh.target && <Alert tone="warn">None of this instance's security groups is tagged <code>ops-console=managed</code>, so the console may not open SSH. An admin can run <code>infra/ops-console-access/tag-security-groups.sh</code> for this region.</Alert>}
      {ssh?.simulated && <Alert tone="warn">Local test mode: AWS is only asked whether the change would be allowed (dry run). No rule is created or removed.</Alert>}

      {canWrite && ssh?.target && (
        <div className="grid gap-3 md:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)_minmax(0,1.6fr)_auto] md:items-end">
          <div>
            <label className="label" htmlFor="ssh-ip">IP address</label>
            <input id="ssh-ip" className="input num" placeholder={ssh.yourIp ?? 'e.g. 203.0.113.7'} value={ip} onChange={(e) => setIp(e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="ssh-hours">For</label>
            <select id="ssh-hours" className="input" value={hours} onChange={(e) => setHours(Number(e.target.value))}>
              {ssh.hours.map((h) => <option key={h} value={h}>{h < 1 ? `${h * 60} minutes` : `${h} hour${h === 1 ? '' : 's'}`}</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="ssh-reason">Reason (optional)</label>
            <input id="ssh-reason" className="input" maxLength={200} placeholder="e.g. copying a file with scp" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <button className="btn-primary" disabled={busy || (!ip.trim() && !ssh.yourIp)} onClick={() => void grant()}>
            {mineOpen && !ip.trim() ? 'Extend my access' : ip.trim() ? 'Allow this IP' : 'Allow my IP'}
          </button>
        </div>
      )}

      {open.length > 0 && (
        <table className="tbl">
          <thead><tr><th className="w-[22%]">Address</th><th className="w-[16%]">Closes in</th><th className="w-[16%]">Opened by</th><th>Reason</th><th className="w-[14%] text-right"></th></tr></thead>
          <tbody>{open.map((g) => (
            <tr key={g.id}>
              <td className="num">{g.cidr}{ssh?.yourIp && !!g.cidr?.startsWith(`${ssh.yourIp}/`) && <span className="ml-2 text-xs text-slate-500">(this browser)</span>}</td>
              <td title={g.expiresAt}>{until(g.expiresAt)}{g.error && <span className="pill-bad ml-2" title={g.error}>close failed, retrying</span>}</td>
              <td>{g.grantedBy}</td>
              <td title={g.reason ?? ''} className="text-slate-400">{g.reason ?? '—'}</td>
              <td className="text-right">{canWrite && <button className="btn-danger px-2.5 py-1 text-xs" disabled={busy} onClick={() => void revoke(g.id)}>Close now</button>}</td>
            </tr>
          ))}</tbody>
        </table>
      )}

      {ssh && ssh.groups.length > 0 && (
        <div>
          <h3 className="eyebrow mb-2">Port 22 rules on the security groups</h3>
          <table className="tbl">
            <thead><tr><th className="w-[24%]">Security group</th><th className="w-[22%]">Allowed from</th><th>Description</th><th className="w-[18%]">Type</th></tr></thead>
            <tbody>
              {ssh.groups.flatMap((g) => {
                const rows = [...g.rules.map((r) => ({ k: r.cidr, from: r.cidr, desc: r.description, kind: r.temporary ? 'temp' : (r.cidr === '0.0.0.0/0' || r.cidr === '::/0') ? 'world' : 'fixed' })),
                  ...g.prefixLists.map((p) => ({ k: p.id, from: p.id, desc: p.description ?? 'prefix list (e.g. EC2 Instance Connect)', kind: 'list' }))];
                if (!rows.length) rows.push({ k: 'none', from: '—', desc: 'no SSH rules', kind: 'none' });
                return rows.map((r, i) => (
                  <tr key={`${g.groupId}-${r.k}`}>
                    <td title={g.groupId}>{i === 0 ? <>{g.name} <span className="dim num text-xs">{g.groupId}</span>{g.managedTag && <span className="pill-mute ml-2">console-managed</span>}</> : ''}</td>
                    <td className="num">{r.from}</td>
                    <td className="text-slate-400" title={r.desc ?? ''}>{r.desc ?? '—'}</td>
                    <td>{r.kind === 'temp' ? <span className="pill-info">temporary</span> : r.kind === 'world' ? <span className="pill-bad">open to everyone</span>
                      : r.kind === 'list' ? <span className="pill-mute">prefix list</span> : r.kind === 'fixed' ? <span className="pill-mute">permanent (not managed here)</span> : ''}</td>
                  </tr>
                ));
              })}
            </tbody>
          </table>
          {ssh.groups.some((g) => g.openToWorld) && <p className="mt-2 text-sm text-rose-300">Port 22 is open to the whole internet on at least one group. Remove that rule in the EC2 console and use temporary access instead.</p>}
        </div>
      )}
      {recent.length > 0 && (
        <p className="text-xs text-slate-500">Recently closed: {recent.map((g) => `${g.cidr} (${g.grantedBy}, closed ${g.revokedBy === 'expired' ? 'on expiry' : `by ${g.revokedBy}`} ${ago(g.revokedAt)})`).join(' · ')}</p>
      )}
    </section>
  );
}

function KeysCard({ instanceId, sec, canWrite, onChanged }: { instanceId: number; sec: SecurityView; canWrite: boolean; onChanged: (m: string) => Promise<void> }) {
  const dialog = useDialog();
  const snap = sec.snapshot!;
  const users = snap.users.filter((u) => u.keys.length || u.manageable);
  const manageable = snap.users.filter((u) => u.manageable).map((u) => u.user);
  const [adding, setAdding] = useState(false);
  const [who, setWho] = useState(manageable.includes('ec2-user') ? 'ec2-user' : manageable[0] ?? '');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [fail, setFail] = useState<string | null>(null);
  const lastUsed = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of snap.logins.accepted) if (l.fingerprint && !m.has(l.fingerprint)) m.set(l.fingerprint, l.at);
    return m;
  }, [snap]);
  const looksPrivate = /PRIVATE KEY/.test(key);

  async function add() {
    setBusy('add'); setFail(null);
    try {
      const r = await api.sshKey(instanceId, { action: 'add', user: who, key: key.trim() });
      setKey(''); setAdding(false);
      await onChanged(`Key ${r.fingerprint ?? ''} added for ${who}${r.dryRun ? ' (dry run: nothing changed)' : ''}.`);
    } catch (e) { setFail(err(e)); }
    finally { setBusy(null); }
  }
  async function remove(user: string, fingerprint: string, label: string) {
    if (!(await dialog.confirm({ title: `Remove ${label} from ${user}?`, body: 'Anyone using this key loses SSH access to this server.', confirmLabel: 'Remove key', danger: true }))) return;
    setBusy(fingerprint); setFail(null);
    try {
      const r = await api.sshKey(instanceId, { action: 'remove', user, fingerprint });
      await onChanged(`Key removed from ${user}${r.dryRun ? ' (dry run: nothing changed)' : ''}.`);
    } catch (e) { setFail(e instanceof ApiError ? e.message : err(e)); }
    finally { setBusy(null); }
  }

  return (
    <section className="card mb-6 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-medium text-slate-100">Authorized SSH keys</h2>
          <p className="mt-1 text-sm text-slate-400">The public keys that can log in, per user. "Last used" comes from the SSH log of the past 7 days.</p>
        </div>
        {canWrite && manageable.length > 0 && !adding && <button className="btn-secondary" onClick={() => setAdding(true)}>Add a key</button>}
      </div>
      {fail && <Alert>{fail}</Alert>}
      {adding && (
        <div className="space-y-3 rounded-lg border border-ink-700 bg-ink-950/50 p-4">
          <div className="grid gap-3 md:grid-cols-[12rem_minmax(0,1fr)]">
            <div>
              <label className="label" htmlFor="key-user">User</label>
              <select id="key-user" className="input" value={who} onChange={(e) => setWho(e.target.value)}>
                {manageable.map((u) => <option key={u}>{u}</option>)}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="key-text">Public key (contents of the .pub file)</label>
              <textarea id="key-text" rows={3} className="input num text-xs" placeholder="ssh-ed25519 AAAAC3Nza… user@laptop" value={key} onChange={(e) => setKey(e.target.value)} />
            </div>
          </div>
          {looksPrivate && <Alert>That is a <b>private</b> key. Never paste it anywhere: use the matching <code>.pub</code> file (for example <code>~/.ssh/id_ed25519.pub</code>).</Alert>}
          <div className="flex gap-2">
            <button className="btn-primary" disabled={!key.trim() || !who || looksPrivate || busy === 'add'} onClick={() => void add()}>{busy === 'add' ? 'Adding…' : `Add for ${who}`}</button>
            <button className="btn-ghost" onClick={() => { setAdding(false); setKey(''); }}>Cancel</button>
          </div>
        </div>
      )}
      <table className="tbl">
        <thead><tr><th className="w-[13%]">User</th><th className="w-[12%]">Type</th><th className="w-[27%]">Fingerprint</th><th>Comment</th><th className="w-[14%]">Last used</th><th className="w-[12%] text-right"></th></tr></thead>
        <tbody>
          {users.flatMap((u) => (u.keys.length ? u.keys : [null]).map((k, i) => (
            <tr key={`${u.user}-${k?.fingerprint ?? i}`}>
              <td className="font-medium text-slate-200">{u.user}</td>
              {k ? <>
                <td className="text-xs">{k.type.replace('ssh-', '').replace('ecdsa-sha2-', 'ecdsa ')}{k.bits ? ` · ${k.bits}` : ''}</td>
                <td className="num text-xs" title={k.fingerprint ?? ''}>{short(k.fingerprint)}</td>
                <td className="text-slate-400" title={k.comment}>{k.blocked ? <span className="pill-mute">login blocked (AWS default)</span> : k.comment || '—'}{k.expires ? <span className="pill-info ml-2" title={`from ${k.from ?? 'anywhere'}`}>temporary · {k.expires * 1000 > Date.now() ? `ends in ${until(new Date(k.expires * 1000).toISOString())}` : 'expired'}</span> : null}</td>
                <td>{k.fingerprint && lastUsed.has(k.fingerprint) ? ago(when(lastUsed.get(k.fingerprint)!)) : <span className="dim">not in 7 days</span>}</td>
                <td className="text-right">{canWrite && u.manageable && k.fingerprint && (
                  <button className="btn-danger px-2.5 py-1 text-xs" disabled={!!busy} onClick={() => void remove(u.user, k.fingerprint!, k.comment || short(k.fingerprint))}>{busy === k.fingerprint ? 'Removing…' : 'Remove'}</button>
                )}</td>
              </> : <td colSpan={5} className="dim">no keys</td>}
            </tr>
          )))}
        </tbody>
      </table>
    </section>
  );
}

function LoginsCard({ sec }: { sec: SecurityView }) {
  const snap = sec.snapshot!;
  const keyName = new Map<string, string>();
  for (const u of snap.users) for (const k of u.keys) if (k.fingerprint) keyName.set(k.fingerprint, k.comment || short(k.fingerprint));
  const l = snap.logins;
  return (
    <section className="card mb-6 space-y-4">
      <div>
        <h2 className="font-medium text-slate-100">SSH logins</h2>
        <p className="mt-1 text-sm text-slate-400">Successful logins of the past 7 days ({l.acceptedTotal}), newest first, and where failed attempts came from.{!l.journal && ' The SSH log could not be read.'}</p>
      </div>
      {l.accepted.length ? (
        <table className="tbl">
          <thead><tr><th className="w-[18%]">When</th><th className="w-[14%]">User</th><th className="w-[22%]">From</th><th>Key</th></tr></thead>
          <tbody>{l.accepted.slice(0, 15).map((x, i) => (
            <tr key={i}>
              <td title={when(x.at)}>{ago(when(x.at))}</td>
              <td>{x.user}</td>
              <td className="num">{x.ip}</td>
              <td className="text-slate-400" title={x.fingerprint ?? x.method}>{x.fingerprint ? keyName.get(x.fingerprint) ?? <span className="text-amber-300">{short(x.fingerprint)} (no longer authorized)</span> : x.method}</td>
            </tr>
          ))}</tbody>
        </table>
      ) : <p className="text-sm text-slate-500">No SSH logins in the past 7 days.</p>}
      {l.failed.length > 0 && (
        <div>
          <h3 className="eyebrow mb-2">Failed attempts by address (7 days)</h3>
          <table className="tbl">
            <thead><tr><th className="w-[24%]">Address</th><th className="w-[12%]">Attempts</th><th className="w-[12%]">24 h</th><th className="w-[16%]">Last</th><th>Users tried</th></tr></thead>
            <tbody>{l.failed.slice(0, 10).map((f) => (
              <tr key={f.ip}>
                <td className="num">{f.ip}</td><td className="num">{f.count}</td><td className="num">{f.count24h}</td>
                <td>{ago(when(f.last))}</td><td className="text-slate-400" title={f.users.join(', ')}>{f.users.join(', ') || '—'}</td>
              </tr>
            ))}</tbody>
          </table>
          <p className="mt-2 text-xs text-slate-500">Failed attempts are normal background noise on any public server; with password logins off they can't succeed. Closing port 22 (and using the terminal) stops them entirely.</p>
        </div>
      )}
    </section>
  );
}

function SessionsCard({ sec }: { sec: SecurityView }) {
  const now = sec.snapshot?.sessions ?? [];
  return (
    <section className="card mb-6 space-y-4">
      <div>
        <h2 className="font-medium text-slate-100">Sessions</h2>
        <p className="mt-1 text-sm text-slate-400">Who is logged in right now, and the browser terminal sessions opened from the console.</p>
      </div>
      <div className="flex flex-wrap gap-2 text-sm">
        {sec.activeTerminals.map((t, i) => <span key={`t${i}`} className="pill-info">terminal: {t.username} since {ago(t.startedAt)}</span>)}
        {now.map((s, i) => <span key={`w${i}`} className="pill-mute">{s.user} on {s.tty}{s.from ? ` from ${s.from}` : ''} since {s.since}</span>)}
        {!sec.activeTerminals.length && !now.length && <span className="text-slate-500">Nobody is logged in{sec.snapshot ? ' (as of the last check)' : ''}.</span>}
      </div>
      {sec.terminalSessions.length > 0 && (
        <table className="tbl">
          <thead><tr><th className="w-[18%]">Opened</th><th className="w-[14%]">By</th><th className="w-[14%]">Length</th><th>Ended</th></tr></thead>
          <tbody>{sec.terminalSessions.slice(0, 10).map((t) => {
            const secs = Math.round(((t.endedAt ? Date.parse(t.endedAt) : Date.now()) - Date.parse(t.startedAt)) / 1000);
            return (
              <tr key={t.id}>
                <td title={t.startedAt}>{ago(t.startedAt)}</td>
                <td>{t.username}{t.simulated && <span className="pill-mute ml-2">simulated</span>}</td>
                <td className="num">{secs >= 60 ? `${Math.floor(secs / 60)} min` : `${secs} s`}</td>
                <td className="text-slate-400" title={t.endReason ?? ''}>{t.endedAt ? t.endReason : <span className="pill-ok">open</span>}</td>
              </tr>
            );
          })}</tbody>
        </table>
      )}
    </section>
  );
}

function UpdatesCard({ sec, canTerminal, instanceId }: { sec: SecurityView; canTerminal: boolean; instanceId: number }) {
  const u = sec.snapshot!.updates;
  const os = sec.snapshot!.os;
  const [copied, setCopied] = useState(false);
  return (
    <section className="card mb-6 space-y-4">
      <div>
        <h2 className="font-medium text-slate-100">Operating system updates</h2>
        <p className="mt-1 text-sm text-slate-400">
          {os.name ?? 'Unknown OS'}{u.current ? <> · release <span className="num">{u.current}</span>{u.currentDate ? ` (${u.currentDate})` : ''}</> : ''} · kernel <span className="num">{os.kernel}</span>
        </p>
      </div>
      {u.error && <Alert tone="warn">Couldn't check for updates: {u.error}</Alert>}
      {u.kind === 'release' && (
        u.newer.length ? (
          <div className="space-y-2 text-sm">
            <p className="text-slate-300">
              Amazon Linux 2023 ships security fixes as new releases. <b className="font-medium">{u.newer.length} newer release{u.newer.length === 1 ? ' is' : 's are'}</b> available, up to <span className="num">{u.newer[u.newer.length - 1].version}</span>.
              {' '}<a className="underline" href={`https://docs.aws.amazon.com/linux/al2023/release-notes/relnotes-${u.newer[u.newer.length - 1].version}.html`} target="_blank" rel="noreferrer noopener">Release notes</a>
            </p>
            <p className="text-slate-400">Upgrading downloads and installs packages, and usually needs a reboot afterwards (a minute or two of downtime for the apps). Do it at a quiet time, after a backup.</p>
          </div>
        ) : <p className="text-sm text-emerald-300">This is the newest Amazon Linux 2023 release.</p>
      )}
      {u.advisories.length > 0 && (
        <table className="tbl">
          <thead><tr><th className="w-[28%]">Advisory</th><th className="w-[16%]">Severity</th><th>Package</th></tr></thead>
          <tbody>{u.advisories.slice(0, 20).map((a) => (
            <tr key={`${a.id}-${a.package}`}>
              <td className="num text-xs">{a.id}</td>
              <td><span className={/critical|important/i.test(a.severity) ? 'pill-bad' : /medium|moderate/i.test(a.severity) ? 'pill-warn' : 'pill-mute'}>{a.severity}</span></td>
              <td className="num text-xs" title={a.package}>{a.package}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
      {u.kind === 'advisories' && !u.advisoryCount && !u.error && <p className="text-sm text-emerald-300">No pending security advisories.</p>}
      {u.command && (
        <div className="flex flex-wrap items-center gap-2">
          <code className="num rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-xs text-slate-200">{u.command}</code>
          <button className="btn-ghost px-2.5 py-1.5 text-xs" onClick={() => { void navigator.clipboard?.writeText(u.command!); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? 'Copied' : 'Copy'}</button>
          {canTerminal && <Link to={`/instances/${instanceId}/terminal`} className="btn-secondary px-2.5 py-1.5 text-xs">Run it in the terminal</Link>}
        </div>
      )}
      {(u.rebootRequired || u.kernelPending) && <Alert tone="warn">A reboot is needed to finish earlier updates{u.kernelPending ? ` (kernel ${u.newestKernel} is installed but ${os.kernel} is running)` : ''}. Use Power → Reboot on the instance page.</Alert>}
    </section>
  );
}

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'server';
const keyFile = (type: string) => (type.includes('ed25519') ? '~/.ssh/id_ed25519' : type.includes('ecdsa') ? '~/.ssh/id_ecdsa' : '~/.ssh/id_rsa');

function Copyable({ text, label }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <div>
      {label && <div className="label">{label}</div>}
      <div className="relative">
        <pre className="overflow-x-auto whitespace-pre rounded-lg border border-ink-700 bg-ink-950 p-3 pr-20 font-mono text-[12px] leading-5 text-slate-200">{text}</pre>
        <button className="btn-ghost absolute right-2 top-2 px-2 py-1 text-xs" onClick={() => { void navigator.clipboard?.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); }}>{done ? 'Copied' : 'Copy'}</button>
      </div>
    </div>
  );
}

/** SSH from your own laptop with your own key: time-limited, locked to your IP or to the Session Manager tunnel. */
function LaptopCard({ inst, ssh, reload, onMessage }: { inst: Instance; ssh: SshAccessView | null; reload: () => Promise<void>; onMessage: (m: string) => void }) {
  const dialog = useDialog();
  const [keys, setKeys] = useState<MyKey[] | null>(null);
  const [keyId, setKeyId] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [route, setRoute] = useState<'direct' | 'ssm'>('direct');
  const [hours, setHours] = useState(2);
  const [ip, setIp] = useState('');
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState<string | null>(null);

  const loadKeys = useCallback(async () => {
    const k = await api.myKeys();
    setKeys(k);
    setKeyId((cur) => (cur && k.some((x) => x.id === cur) ? cur : k[0]?.id ?? null));
    if (!k.length) setAdding(true);
  }, []);
  useEffect(() => { loadKeys().catch((e) => setFail(err(e))); }, [loadKeys]);

  const active = ssh?.grants.filter((g) => g.kind === 'key' && !g.revokedAt) ?? [];
  const keyOf = (g: SshGrant) => keys?.find((k) => k.fingerprint === g.keyFingerprint);

  async function saveKey() {
    setBusy(true); setFail(null);
    try { const k = await api.saveMyKey({ key: newKey.trim() }); setNewKey(''); setAdding(false); await loadKeys(); setKeyId(k.id); }
    catch (e) { setFail(err(e)); }
    finally { setBusy(false); }
  }
  async function connect() {
    if (!keyId) return;
    setBusy(true); setFail(null);
    try {
      const r = await api.laptopAccess(inst.id, { keyId, route, hours, ip: route === 'direct' ? ip.trim() || undefined : undefined });
      onMessage(r.permanent
        ? `That key already has permanent access to ${inst.name}, so it was left as it is${r.ipGrant ? '; port 22 is open for this IP until ' + new Date(r.grant.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}.`
        : `The laptop can connect until ${new Date(r.grant.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.${r.simulated ? ' (Local test mode: nothing was changed on the server.)' : ''}`);
      await reload(); await loadKeys();
    } catch (e) { setFail(err(e)); }
    finally { setBusy(false); }
  }
  async function end(g: SshGrant) {
    setBusy(true); setFail(null);
    try {
      await api.revokeSsh(inst.id, g.id);
      // the port opened for this laptop (same address) closes with it
      const ipG = ssh?.grants.find((x) => x.kind === 'ip' && !x.revokedAt && g.route === 'direct' && x.cidr === g.keyFrom);
      if (ipG) await api.revokeSsh(inst.id, ipG.id);
      onMessage('Laptop access ended: the key is removed' + (ipG ? ' and port 22 is closed again.' : '.'));
      await reload();
    } catch (e) { setFail(err(e)); }
    finally { setBusy(false); }
  }

  const host = ssh?.host ?? '<server IP>';
  const alias = slug(inst.name);
  const commands = (g: SshGrant) => {
    const file = keyFile(keyOf(g)?.type ?? 'ed25519');
    const cfg = g.route === 'ssm'
      ? `Host ${alias}\n  HostName ${ssh?.awsInstanceId}\n  User ec2-user\n  IdentityFile ${file}\n  IdentitiesOnly yes\n  ProxyCommand aws ssm start-session --region ${ssh?.region} --target %h --document-name AWS-StartSSHSession --parameters portNumber=%p`
      : `Host ${alias}\n  HostName ${host}\n  User ec2-user\n  IdentityFile ${file}\n  IdentitiesOnly yes`;
    return { cfg, ssh: `ssh ${alias}`, tunnel: `ssh -N -L 5433:127.0.0.1:5432 ${alias}`, copy: `scp ./file.txt ${alias}:~/` };
  };

  return (
    <section className="card mb-6 space-y-4">
      <div>
        <h2 className="font-medium text-slate-100">Connect from a laptop</h2>
        <p className="mt-1 text-sm text-slate-400">
          SSH from a laptop with its own key, including tunnels and file copies. The console installs the public key for <b className="font-medium text-slate-300">ec2-user</b>, locked to one route and set to expire. When the time is up it removes the key and closes the port; even if that failed, the server itself refuses the key after it expires.
        </p>
      </div>
      {fail && <Alert>{fail}</Alert>}

      {active.map((g) => {
        const c = commands(g);
        return (
          <div key={g.id} className="space-y-3 rounded-lg border border-indigo-400/30 bg-indigo-500/[0.05] p-4">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="pill-ok">active</span>
              <span className="text-slate-200">{keyOf(g)?.name ?? 'key'} · {g.route === 'ssm' ? 'through Session Manager (no open port)' : `direct from ${g.keyFrom}`}</span>
              <span className="text-slate-400">· by {g.grantedBy} · ends in {until(g.expiresAt)}</span>
              {!g.keyAdded && <span className="pill-mute" title="This key was already in authorized_keys without an expiry">permanent key, unchanged</span>}
              {g.error && <span className="pill-bad" title={g.error}>clean-up failed, retrying</span>}
              <button className="btn-danger ml-auto px-2.5 py-1 text-xs" disabled={busy} onClick={() => void end(g)}>End now</button>
            </div>
            <Copyable label="1. Add this to ~/.ssh/config on the laptop (once)" text={c.cfg} />
            <div className="grid gap-3 md:grid-cols-3">
              <Copyable label="2. Connect" text={c.ssh} />
              <Copyable label="Tunnel: the server's Postgres on localhost:5433" text={c.tunnel} />
              <Copyable label="Copy a file" text={c.copy} />
            </div>
            {g.route === 'ssm' && <p className="text-xs text-slate-400">Needs the AWS CLI v2 and the Session Manager plugin on the laptop, and AWS credentials allowed to run <code>ssm:StartSession</code> on this instance with the <code>AWS-StartSSHSession</code> document.</p>}
            {ssh?.hostKeys.length ? (
              <p className="text-xs text-slate-400">On the first connection ssh asks to confirm the server's fingerprint. Answer yes only if it is: {ssh.hostKeys.map((k) => <span key={k.type} className="num ml-1 text-slate-300">{k.type} {k.fingerprint}</span>)}</p>
            ) : <p className="text-xs text-slate-500">Press Check now (top of the page) to show the server's fingerprints for verifying the first connection.</p>}
          </div>
        );
      })}

      {keys && (
        <div className="space-y-3">
          {adding ? (
            <div className="space-y-2">
              <label className="label" htmlFor="my-key">Public key: on the laptop, run <code>cat ~/.ssh/id_ed25519.pub</code> (or create one with <code>ssh-keygen -t ed25519</code>) and paste the line</label>
              <textarea id="my-key" rows={2} className="input num text-xs" placeholder="ssh-ed25519 AAAAC3Nza… user@laptop" value={newKey} onChange={(e) => setNewKey(e.target.value)} />
              {/PRIVATE KEY/.test(newKey) && <Alert>That is a <b>private</b> key: it must never be pasted anywhere. Use the <code>.pub</code> file.</Alert>}
              <div className="flex gap-2">
                <button className="btn-secondary" disabled={!newKey.trim() || /PRIVATE KEY/.test(newKey) || busy} onClick={() => void saveKey()}>Save key</button>
                {keys.length > 0 && <button className="btn-ghost" onClick={() => setAdding(false)}>Cancel</button>}
              </div>
            </div>
          ) : (
            <div className="grid gap-3 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1.6fr)_minmax(0,0.8fr)_minmax(0,1fr)_auto] md:items-end">
              <div>
                <label className="label" htmlFor="lap-key">Key</label>
                <div className="flex gap-2">
                  <select id="lap-key" className="input" value={keyId ?? ''} onChange={(e) => setKeyId(Number(e.target.value))}>
                    {keys.map((k) => <option key={k.id} value={k.id}>{k.name} ({k.fingerprint.slice(7, 15)}…)</option>)}
                  </select>
                  <button className="btn-ghost px-2.5" title="Add another key" onClick={() => setAdding(true)}>+</button>
                </div>
              </div>
              <div>
                <span className="label">Route</span>
                <div className="flex gap-1 rounded-lg border border-ink-600 bg-ink-950 p-1 text-xs">
                  {(['direct', 'ssm'] as const).map((r) => (
                    <button key={r} className={`flex-1 rounded-md px-2 py-1.5 ${route === r ? 'bg-indigo-500/20 text-indigo-200' : 'text-slate-400 hover:text-slate-200'}`}
                      disabled={r === 'direct' && !ssh?.target} title={r === 'direct' && !ssh?.target ? 'No security group is tagged for the console yet' : undefined}
                      onClick={() => setRoute(r)}>{r === 'direct' ? 'Direct SSH from my IP' : 'Session Manager tunnel'}</button>
                  ))}
                </div>
              </div>
              <div>
                <label className="label" htmlFor="lap-hours">For</label>
                <select id="lap-hours" className="input" value={hours} onChange={(e) => setHours(Number(e.target.value))}>
                  {(ssh?.hours ?? [0.5, 1, 2, 4, 8]).map((h) => <option key={h} value={h}>{h < 1 ? `${h * 60} min` : `${h} h`}</option>)}
                </select>
              </div>
              <div>
                {route === 'direct' ? <>
                  <label className="label" htmlFor="lap-ip">IP address</label>
                  <input id="lap-ip" className="input num" placeholder={ssh?.yourIp ?? 'e.g. 203.0.113.7'} value={ip} onChange={(e) => setIp(e.target.value)} />
                </> : <p className="pb-2 text-xs text-slate-500">No port opens: works from any network, via AWS.</p>}
              </div>
              <button className="btn-primary" disabled={busy || !keyId || (route === 'direct' && !ip.trim() && !ssh?.yourIp)} onClick={() => void connect()}>
                {busy ? 'Setting up…' : active.length ? 'Allow again / extend' : 'Allow my laptop'}
              </button>
            </div>
          )}
          {keys.length > 0 && !adding && (
            <p className="text-xs text-slate-500">
              Saved keys: {keys.map((k) => (
                <span key={k.id} className="mr-3">{k.name} <span className="num">{k.fingerprint.slice(0, 15)}…</span>{' '}
                  <button className="text-rose-300 underline-offset-2 hover:underline" onClick={async () => { if (await dialog.confirm({ title: `Forget ${k.name}?`, body: 'Access already granted with it ends on its own.', confirmLabel: 'Forget key', danger: true })) { await api.deleteMyKey(k.id); await loadKeys(); } }}>forget</button>
                </span>
              ))}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
