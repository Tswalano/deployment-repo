import { FormEvent, ReactNode, useCallback, useEffect, useState } from 'react';
import { api, ApiError, Profile, Role } from '../api';
import { useAuth } from '../auth';
import { ago, Alert, Skeleton } from '../components/ui';
import { McpTokens } from '../components/McpTokens';

const err = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong.');
const date = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : '—');
const ROLE: Record<Role, string> = { admin: 'Administrator', deployer: 'Deployer', viewer: 'Viewer' };

/** One settings row: what it is on the left, the fields on the right. */
function Row({ title, sub, children }: { title: string; sub?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid gap-4 py-6 first:pt-0 last:pb-0 md:grid-cols-[14rem_minmax(0,1fr)] md:gap-8">
      <div>
        <h2 className="text-sm font-medium text-slate-100">{title}</h2>
        {sub && <p className="mt-1 text-sm text-slate-500">{sub}</p>}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function Status({ msg }: { msg: { tone: 'ok' | 'bad'; text: string } | null }) {
  return msg ? <Alert tone={msg.tone}>{msg.text}</Alert> : null;
}

function ProfileForm({ p, onSaved }: { p: Profile; onSaved: () => Promise<void> }) {
  const [name, setName] = useState(p.displayName);
  const [username, setUsername] = useState(p.username.includes('@') ? '' : p.username);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const dirty = name.trim() !== p.displayName || (username.trim() !== '' && username.trim().toLowerCase() !== p.username.toLowerCase());
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setMsg(null);
    try {
      await api.updateProfile({ displayName: name.trim(), ...(username.trim() ? { username: username.trim().toLowerCase() } : {}) });
      await onSaved(); setMsg({ tone: 'ok', text: 'Saved.' });
    } catch (e2) { setMsg({ tone: 'bad', text: err(e2) }); } finally { setBusy(false); }
  }
  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="pf-name">Full name</label>
          <input id="pf-name" className="input" autoComplete="name" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="pf-user">Username</label>
          <div className="relative">
            <span className="pointer-events-none absolute inset-y-0 left-3 grid place-items-center text-sm text-slate-500">@</span>
            <input id="pf-user" className="input pl-7" autoComplete="username" maxLength={30} value={username}
                   onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/\s+/g, ''))} />
          </div>
        </div>
      </div>
      <Status msg={msg} />
      <div className="flex justify-end"><button className="btn-primary" disabled={busy || !dirty || name.trim().length < 1}>{busy ? 'Saving…' : 'Save'}</button></div>
    </form>
  );
}

/** The sign-in email: read-only once set (changing it is an owner action); accounts without one can add it. */
function EmailBlock({ p, onSaved }: { p: Profile; onSaved: () => Promise<void> }) {
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [resent, setResent] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  if (p.email) {
    return (
      <div className="space-y-1 text-sm">
        <div className="text-slate-200">{p.email}</div>
        <div className="text-slate-500">
          {p.emailVerifiedAt ? `Confirmed ${date(p.emailVerifiedAt)}.` : <>Not confirmed yet. {resent ? 'Link sent again.' : <button className="text-slate-300 underline underline-offset-2 hover:text-slate-100" onClick={() => { void api.resendVerification().then(() => setResent(true)); }}>Resend the link</button>}</>}
        </div>
        <p className="pt-2 text-xs text-slate-500">The sign-up email can't be changed here. Contact support to change it.</p>
      </div>
    );
  }
  return (
    <form className="space-y-4" onSubmit={async (e) => {
      e.preventDefault(); setBusy(true); setMsg(null);
      try { await api.setEmail(email.trim(), pw); setPw(''); await onSaved(); }
      catch (e2) { setMsg({ tone: 'bad', text: err(e2) }); } finally { setBusy(false); }
    }}>
      <p className="text-sm text-slate-400">An email is needed for password resets and invitations. It can't be changed afterwards.</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <div><label className="label" htmlFor="em-addr">Email</label><input id="em-addr" type="email" className="input" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
        <div><label className="label" htmlFor="em-pw">Current password</label><input id="em-pw" type="password" className="input" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} /></div>
      </div>
      <Status msg={msg} />
      <div className="flex justify-end"><button className="btn-primary" disabled={busy || !email.trim() || !pw}>{busy ? 'Saving…' : 'Add email'}</button></div>
    </form>
  );
}

function PasswordForm({ onChanged }: { onChanged: () => Promise<void> }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (next !== confirm) { setMsg({ tone: 'bad', text: "The new passwords don't match." }); return; }
    setBusy(true); setMsg(null);
    try {
      await api.changePassword(current, next);
      setCurrent(''); setNext(''); setConfirm('');
      setMsg({ tone: 'ok', text: 'Password changed. Other sessions were signed out.' });
      await onChanged();
    } catch (e2) { setMsg({ tone: 'bad', text: err(e2) }); } finally { setBusy(false); }
  }
  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="sm:max-w-[calc(50%-0.5rem)]">
        <label className="label" htmlFor="pw-cur">Current password</label>
        <input id="pw-cur" type="password" autoComplete="current-password" className="input" value={current} onChange={(e) => setCurrent(e.target.value)} />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div><label className="label" htmlFor="pw-new">New password</label><input id="pw-new" type="password" autoComplete="new-password" className="input" minLength={8} value={next} onChange={(e) => setNext(e.target.value)} /></div>
        <div><label className="label" htmlFor="pw-conf">Repeat new password</label><input id="pw-conf" type="password" autoComplete="new-password" className="input" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></div>
      </div>
      <Status msg={msg} />
      <div className="flex justify-end"><button className="btn-primary" disabled={busy || !current || next.length < 8 || !confirm}>{busy ? 'Saving…' : 'Update password'}</button></div>
    </form>
  );
}

export function Account() {
  const { user, refresh } = useAuth();
  const [p, setP] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api.profile().then(setP).catch((e) => setError(err(e))), []);
  useEffect(() => { void load(); }, [load]);
  if (!user) return null;
  if (error) return <div className="mx-auto max-w-4xl"><Alert>{error}</Alert></div>;
  if (!p) return <div className="mx-auto max-w-4xl space-y-4"><Skeleton className="h-24" /><Skeleton className="h-72" /></div>;

  const name = p.displayName || p.username;
  const initials = name.split(/[\s._@-]+/).filter(Boolean).map((x) => x[0]).join('').slice(0, 2).toUpperCase();
  const current = p.workspaces.find((w) => w.current);
  const saved = async () => { await load(); await refresh(); };
  return (
    <div className="mx-auto max-w-4xl">
      <header className="flex flex-wrap items-center gap-4 border-b border-ink-700 pb-6">
        <span className="grid h-14 w-14 shrink-0 place-items-center rounded-full border border-ink-600 bg-ink-850 text-lg font-medium text-slate-200">{initials}</span>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-xl font-semibold tracking-tight text-slate-100">{name}</h1>
          <p className="mt-0.5 truncate text-sm text-slate-500">
            {p.username.includes('@') ? '' : `@${p.username} · `}{ROLE[p.role]}{current ? ` in ${current.name}` : ''}
          </p>
        </div>
      </header>

      {p.isDemo ? <div className="mt-6"><Alert tone="warn">This is the read-only demo account: nothing here can be changed.</Alert></div> : (
        <div className="divide-y divide-ink-700 pt-6">
          <Row title="Profile" sub="Name and sign-in username.">
            <ProfileForm p={p} onSaved={saved} />
          </Row>
          <Row title="Email" sub="Used for sign-in, password resets and invitations.">
            <EmailBlock p={p} onSaved={saved} />
          </Row>
          <Row title="Password" sub="At least 8 characters; a long passphrase is best. Changing it ends all other sessions.">
            <PasswordForm onChanged={load} />
          </Row>
          {p.workspaces.length > 0 && (
            <div id="mcp">
              <Row title="AI tools (MCP)" sub="Connect Claude Code, Claude Desktop, Cursor or VS Code to this workspace. They can only read, with this account's role.">
                <McpTokens />
              </Row>
            </div>
          )}
          <Row title="Account" sub="Account history and access.">
            <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
              <div><dt className="text-slate-500">Member since</dt><dd className="mt-0.5 text-slate-200">{date(p.createdAt)}</dd></div>
              <div><dt className="text-slate-500">Last sign-in</dt><dd className="mt-0.5 text-slate-200">{p.lastLoginAt ? ago(p.lastLoginAt) : '—'}</dd></div>
              <div><dt className="text-slate-500">Password last changed</dt><dd className="mt-0.5 text-slate-200">{p.passwordChangedAt ? ago(p.passwordChangedAt) : '—'}</dd></div>
              <div><dt className="text-slate-500">Role</dt><dd className="mt-0.5 text-slate-200">{ROLE[p.role]}</dd></div>
              {p.workspaces.length > 0 && (
                <div className="sm:col-span-2">
                  <dt className="text-slate-500">Workspaces</dt>
                  <dd className="mt-0.5 text-slate-200">{p.workspaces.map((w) => `${w.name} (${ROLE[w.role].toLowerCase()})`).join(' · ')}</dd>
                </div>
              )}
            </dl>
          </Row>
        </div>
      )}
    </div>
  );
}
