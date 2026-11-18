import { FormEvent, ReactNode, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import { Alert } from '../components/ui';

const err = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong. Try again.');

function Brand() {
  const { site } = useAuth();
  return (
    <Link to="/" className="flex items-center gap-2.5">
      <span className="grid h-7 w-7 place-items-center rounded-lg border border-indigo-400/40 bg-indigo-500/15 text-indigo-300">
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M12 3 3 20h18L12 3z" /></svg>
      </span>
      <span className="text-sm font-semibold tracking-tight text-slate-100">{site.productName}</span>
    </Link>
  );
}

/** Narrow centred card for the account forms. */
function FormShell({ title, sub, children }: { title: string; sub?: ReactNode; children: ReactNode }) {
  return (
    <div className="min-h-screen px-4 py-10">
      <div className="mx-auto max-w-sm">
        <div className="mb-8 flex justify-center"><Brand /></div>
        <h1 className="text-center text-xl font-semibold text-slate-100">{title}</h1>
        {sub && <p className="mt-2 text-center text-sm text-slate-400">{sub}</p>}
        <div className="mt-6">{children}</div>
      </div>
    </div>
  );
}

export function Signup() {
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const [f, setF] = useState({ name: '', email: '', password: '', workspace: '', username: '' });
  const [busy, setBusy] = useState(false);
  // username: suggested from the email until the person types their own; checked as they type
  const [touched, setTouched] = useState(false);
  const [avail, setAvail] = useState<'ok' | 'taken' | 'format' | null>(null);
  useEffect(() => {
    if (touched || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email)) return;
    const t = setTimeout(() => { api.usernameSuggestion(f.email).then((u) => { if (u) setF((x) => ({ ...x, username: u })); }).catch(() => undefined); }, 400);
    return () => clearTimeout(t);
  }, [f.email, touched]);
  useEffect(() => {
    if (!f.username) { setAvail(null); return; }
    const t = setTimeout(() => { api.usernameAvailable(f.username.toLowerCase()).then((r) => setAvail(r.available ? 'ok' : r.reason === 'format' ? 'format' : 'taken')).catch(() => setAvail(null)); }, 350);
    return () => clearTimeout(t);
  }, [f.username]);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      await api.signup({ ...f, username: f.username.trim() || undefined, workspace: f.workspace.trim() || `${f.name.trim().split(' ')[0] || 'My'}'s team` });
      await refresh(); navigate('/');
    } catch (e2) { setError(err(e2)); } finally { setBusy(false); }
  }
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <FormShell title="Create an account">
      <form onSubmit={submit} className="card space-y-4" noValidate>
        {error && <Alert>{error}</Alert>}
        <div><label className="label" htmlFor="su-name">Full name</label><input id="su-name" className="input" autoComplete="name" value={f.name} onChange={set('name')} required /></div>
        <div><label className="label" htmlFor="su-email">Work email</label><input id="su-email" type="email" className="input" autoComplete="email" value={f.email} onChange={set('email')} required /></div>
        <div>
          <label className="label" htmlFor="su-user">Username</label>
          <div className="relative">
            <span className="pointer-events-none absolute inset-y-0 left-3 grid place-items-center text-sm text-slate-500">@</span>
            <input id="su-user" className="input pl-7" autoComplete="username" placeholder="e.g. thandi" maxLength={30} value={f.username}
                   onChange={(e) => { setTouched(true); setF({ ...f, username: e.target.value.toLowerCase().replace(/\s+/g, '') }); }} />
          </div>
          <p className={`mt-1 text-xs ${avail === 'taken' || avail === 'format' ? 'text-rose-300' : 'text-slate-500'}`}>
            {avail === 'taken' ? 'That username is taken.' : avail === 'format' ? '3–30 letters, numbers, dots, dashes or underscores.' : avail === 'ok' ? 'Available. Sign-in works with the username or the email.' : 'Sign-in works with the username or the email.'}
          </p>
        </div>
        <div><label className="label" htmlFor="su-pw">Password</label><input id="su-pw" type="password" className="input" autoComplete="new-password" minLength={8} value={f.password} onChange={set('password')} required />
          <p className="mt-1 text-xs text-slate-500">At least 8 characters.</p></div>
        <div><label className="label" htmlFor="su-ws">Company or team name</label><input id="su-ws" className="input" placeholder="e.g. Acme" value={f.workspace} onChange={set('workspace')} /></div>
        <button className="btn-primary w-full" disabled={busy || !f.name || !f.email || f.password.length < 8 || avail === 'taken' || avail === 'format'}>{busy ? 'Creating…' : 'Create account'}</button>
        <p className="text-center text-xs text-slate-500">Already have an account? <Link to="/login" className="text-indigo-300 hover:underline">Sign in</Link></p>
      </form>
    </FormShell>
  );
}

export function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <FormShell title="Reset password" sub="A link to choose a new password will be emailed.">
      {sent ? <div className="card text-sm text-slate-300">If <b>{email}</b> has an account, a reset link is on its way. It works once, for an hour. <div className="mt-4"><Link to="/login" className="text-indigo-300 hover:underline">Back to sign in</Link></div></div> : (
        <form className="card space-y-4" onSubmit={async (e) => { e.preventDefault(); setBusy(true); await api.forgotPassword(email).catch(() => undefined); setBusy(false); setSent(true); }}>
          <div><label className="label" htmlFor="fp-email">Email</label><input id="fp-email" type="email" className="input" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></div>
          <button className="btn-primary w-full" disabled={busy || !email}>{busy ? 'Sending…' : 'Send reset link'}</button>
          <p className="text-center text-xs"><Link to="/login" className="text-slate-400 hover:underline">Back to sign in</Link></p>
        </form>
      )}
    </FormShell>
  );
}

export function ResetPassword() {
  const [q] = useSearchParams();
  const [pw, setPw] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <FormShell title="Choose a new password">
      {done ? <div className="card text-sm text-slate-300">Password changed. All sessions were signed out. <div className="mt-4"><Link to="/login" className="btn-primary w-full">Sign in</Link></div></div> : (
        <form className="card space-y-4" onSubmit={async (e) => { e.preventDefault(); setBusy(true); setError(null); try { await api.resetOwnPassword(q.get('token') ?? '', pw); setDone(true); } catch (e2) { setError(err(e2)); } finally { setBusy(false); } }}>
          {error && <Alert>{error}</Alert>}
          <div><label className="label" htmlFor="rp-pw">New password</label><input id="rp-pw" type="password" className="input" autoComplete="new-password" minLength={8} value={pw} onChange={(e) => setPw(e.target.value)} required /></div>
          <button className="btn-primary w-full" disabled={busy || pw.length < 8}>{busy ? 'Saving…' : 'Save password'}</button>
        </form>
      )}
    </FormShell>
  );
}

export function VerifyEmail() {
  const [q] = useSearchParams();
  const { refresh, user } = useAuth();
  const [state, setState] = useState<'busy' | 'ok' | string>('busy');
  useEffect(() => {
    api.verifyEmail(q.get('token') ?? '').then(async () => { setState('ok'); await refresh(); }).catch((e) => setState(err(e)));
  }, [q, refresh]);
  return (
    <FormShell title="Email confirmation">
      <div className="card text-sm text-slate-300">
        {state === 'busy' ? 'Checking the link…' : state === 'ok' ? 'The email address is confirmed.' : <Alert>{state}</Alert>}
        <div className="mt-4"><Link to={user ? '/' : '/login'} className="btn-primary w-full">{user ? 'Open the console' : 'Sign in'}</Link></div>
      </div>
    </FormShell>
  );
}

export function AcceptInvite() {
  const [q] = useSearchParams();
  const token = q.get('token') ?? '';
  const { user, refresh } = useAuth();
  const navigate = useNavigate();
  const [info, setInfo] = useState<{ email: string; role: string; workspace: string; hasAccount: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [f, setF] = useState({ name: '', password: '' });
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.inviteInfo(token).then(setInfo).catch((e) => setError(err(e))); }, [token]);
  async function accept(e?: FormEvent) {
    e?.preventDefault(); setBusy(true); setError(null);
    try { await api.acceptInvite(token, user ? {} : f); await refresh(); navigate('/'); }
    catch (e2) { setError(err(e2)); } finally { setBusy(false); }
  }
  if (!info) return <FormShell title="Join a workspace">{error ? <Alert>{error}</Alert> : <div className="card text-sm text-slate-400">Loading…</div>}</FormShell>;
  const wrongUser = user && user.email?.toLowerCase() !== info.email.toLowerCase();
  return (
    <FormShell title={`Join ${info.workspace}`} sub={<>Invitation for {info.email} as <b>{info.role}</b>.</>}>
      <div className="card space-y-4">
        {error && <Alert>{error}</Alert>}
        {user ? (wrongUser
          ? <Alert tone="warn">Signed in as {user.email ?? user.username}. Sign out and sign in as {info.email} to accept.</Alert>
          : <button className="btn-primary w-full" disabled={busy} onClick={() => void accept()}>{busy ? 'Joining…' : `Join ${info.workspace}`}</button>)
          : info.hasAccount ? (
            <p className="text-sm text-slate-300">{info.email} already has an account. <Link to={`/login?next=${encodeURIComponent(`/invite?token=${token}`)}`} className="text-indigo-300 hover:underline">Sign in</Link> to accept.</p>
          ) : (
            <form className="space-y-4" onSubmit={accept}>
              <div><label className="label" htmlFor="ai-name">Full name</label><input id="ai-name" className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></div>
              <div><label className="label" htmlFor="ai-pw">Choose a password</label><input id="ai-pw" type="password" className="input" autoComplete="new-password" minLength={8} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required /></div>
              <button className="btn-primary w-full" disabled={busy || !f.name || f.password.length < 8}>{busy ? 'Joining…' : 'Create account and join'}</button>
            </form>
          )}
      </div>
    </FormShell>
  );
}
