import { FormEvent, ReactNode, useCallback, useEffect, useState } from 'react';
import { api, ApiError, Profile, ROLE_INFO } from '../api';
import { useAuth } from '../auth';
import { ago, Alert, Skeleton } from '../components/ui';

const err = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong.');
const date = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : '—');

function Section({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <section className="card">
      <h2 className="font-medium text-slate-100">{title}</h2>
      {sub && <p className="mt-1 text-sm text-slate-400">{sub}</p>}
      <div className="mt-5">{children}</div>
    </section>
  );
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
      {p.username.includes('@') && <Alert tone="warn">Choose a username: right now your email is used as one.</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="pf-name">Name</label>
          <input id="pf-name" className="input" autoComplete="name" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="pf-user">Username</label>
          <div className="relative">
            <span className="pointer-events-none absolute inset-y-0 left-3 grid place-items-center text-sm text-slate-500">@</span>
            <input id="pf-user" className="input pl-7" autoComplete="username" maxLength={30} placeholder="choose one" value={username}
                   onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/\s+/g, ''))} />
          </div>
        </div>
      </div>
      <p className="text-xs text-slate-500">You can sign in with your username{p.email ? ' or your email' : ''}.</p>
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      <div className="flex justify-end"><button className="btn-primary" disabled={busy || !dirty || name.trim().length < 1}>{busy ? 'Saving…' : 'Save changes'}</button></div>
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
      setMsg({ tone: 'ok', text: 'Password changed. Your other sessions were signed out.' });
      await onChanged();
    } catch (e2) { setMsg({ tone: 'bad', text: err(e2) }); } finally { setBusy(false); }
  }
  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <label className="label" htmlFor="pw-cur">Current password</label>
        <input id="pw-cur" type="password" autoComplete="current-password" className="input" value={current} onChange={(e) => setCurrent(e.target.value)} />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="pw-new">New password</label>
          <input id="pw-new" type="password" autoComplete="new-password" className="input" minLength={8} value={next} onChange={(e) => setNext(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="pw-conf">Repeat new password</label>
          <input id="pw-conf" type="password" autoComplete="new-password" className="input" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </div>
      </div>
      <p className="text-xs text-slate-500">At least 8 characters; a long passphrase is best. Changing it signs you out everywhere else.</p>
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      <div className="flex justify-end"><button className="btn-primary" disabled={busy || !current || next.length < 8 || !confirm}>{busy ? 'Saving…' : 'Change password'}</button></div>
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
  if (error) return <div className="mx-auto max-w-3xl"><Alert>{error}</Alert></div>;
  if (!p) return <div className="mx-auto max-w-3xl space-y-4"><Skeleton className="h-28" /><Skeleton className="h-56" /></div>;

  const name = p.displayName || p.username;
  const initials = name.split(/[\s._@-]+/).filter(Boolean).map((x) => x[0]).join('').slice(0, 2).toUpperCase();
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      {/* who you are */}
      <section className="card flex flex-wrap items-center gap-5">
        <span className="grid h-16 w-16 shrink-0 place-items-center rounded-full border border-indigo-400/40 bg-indigo-500/15 text-xl font-semibold text-indigo-200">{initials}</span>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-xl font-semibold tracking-tight text-slate-100">{name}</h1>
          <p className="mt-0.5 truncate text-sm text-slate-400">{p.username.includes('@') ? 'No username yet' : `@${p.username}`}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
            <span className={ROLE_INFO[p.role].badge}>{ROLE_INFO[p.role].label}</span>
            {p.email && <span className="text-slate-400">{p.email}</span>}
            {p.email && (p.emailVerifiedAt ? <span className="pill-ok">confirmed</span> : <span className="pill-warn">not confirmed</span>)}
          </div>
        </div>
      </section>

      {p.isDemo ? <Alert tone="warn">This is the read-only demo account: nothing here can be changed.</Alert> : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_17rem] lg:items-start">
          <div className="space-y-6">
            <Section title="Profile" sub="How you appear to your team.">
              <ProfileForm p={p} onSaved={async () => { await load(); await refresh(); }} />
            </Section>
            <Section title="Password">
              <PasswordForm onChanged={load} />
            </Section>
          </div>
          <Section title="Your account">
            <dl className="space-y-3 text-sm">
              <div><dt className="text-xs text-slate-500">Member since</dt><dd className="text-slate-200">{date(p.createdAt)}</dd></div>
              <div><dt className="text-xs text-slate-500">Last sign-in</dt><dd className="text-slate-200">{p.lastLoginAt ? ago(p.lastLoginAt) : '—'}</dd></div>
              <div><dt className="text-xs text-slate-500">Password changed</dt><dd className="text-slate-200">{p.passwordChangedAt ? ago(p.passwordChangedAt) : '—'}</dd></div>
              {p.workspaces.length > 0 && (
                <div>
                  <dt className="text-xs text-slate-500">Workspaces</dt>
                  <dd className="mt-1 space-y-1">{p.workspaces.map((w) => (
                    <div key={w.name} className="flex items-center gap-2 text-slate-200">
                      <span className={`h-1.5 w-1.5 rounded-full ${w.current ? 'bg-indigo-400' : 'bg-ink-500'}`} />
                      <span className="min-w-0 flex-1 truncate">{w.name}</span><span className="text-2xs capitalize text-slate-500">{w.role}</span>
                    </div>
                  ))}</dd>
                </div>
              )}
            </dl>
          </Section>
        </div>
      )}
    </div>
  );
}
