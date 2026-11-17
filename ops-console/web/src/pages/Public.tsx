import { FormEvent, ReactNode, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import { Alert } from '../components/ui';
import { PLANS } from '../plans';

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

const FEATURES: [string, string][] = [
  ['Deploy from GitHub', 'Pick a repository and a subdomain. It builds, starts and gets HTTPS, and every push to your branch deploys by itself, with automatic rollback if the new version is unhealthy.'],
  ['Know when something breaks', 'Health checks every minute, uptime history, and alerts for downtime, disk, memory, certificates and failed deploys, by email, Slack or Discord.'],
  ['Backups you can trust', 'Nightly database backups that are restore-tested automatically, with one-click downloads.'],
  ['Get onto your server safely', 'A browser terminal with no open SSH port, and temporary, auto-expiring SSH access for your own laptop.'],
  ['Costs under control', "See this month's AWS bill and forecast in Rand or dollars, get budget alerts, and stop servers on a schedule overnight."],
  ['Built for teams', 'Invite your team with roles, require approvals for production deploys, set freeze windows, and keep a full audit log.'],
];

export function Landing() {
  const { site } = useAuth();
  return (
    <div className="min-h-screen">
      <header className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-4 sm:px-6">
        <Brand />
        <nav className="ml-auto flex items-center gap-2">
          <a href="#pricing" className="hidden px-3 py-2 text-sm text-slate-400 hover:text-slate-200 sm:inline">Pricing</a>
          <Link to="/login" className="btn-ghost">Sign in</Link>
          <Link to="/signup" className="btn-primary">Start free trial</Link>
        </nav>
      </header>

      <section className="mx-auto max-w-4xl px-4 pb-16 pt-14 text-center sm:px-6 sm:pt-20">
        <p className="eyebrow justify-center text-indigo-300">Your own Heroku, on your own AWS</p>
        <h1 className="mt-4 text-3xl font-semibold tracking-tight text-slate-100 sm:text-5xl">Run your apps on your AWS servers, without the DevOps job</h1>
        <p className="mx-auto mt-5 max-w-2xl text-base text-slate-400 sm:text-lg">
          {site.productName} deploys your Node.js apps from GitHub to EC2 servers in your own AWS account, watches them, backs them up and lets your team in safely. You keep full control and pay AWS directly; we never hold your servers hostage.
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Link to="/signup" className="btn-primary px-5 py-2.5">Start your {site.trialDays}-day free trial</Link>
          <a href="#how" className="btn-secondary px-5 py-2.5">How it works</a>
        </div>
        <p className="mt-3 text-xs text-slate-500">No card needed for the trial.</p>
      </section>

      <section className="mx-auto max-w-6xl px-4 pb-16 sm:px-6">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map(([t, d]) => (
            <div key={t} className="card">
              <h3 className="font-medium text-slate-100">{t}</h3>
              <p className="mt-2 text-sm text-slate-400">{d}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="how" className="mx-auto max-w-4xl px-4 pb-16 sm:px-6">
        <h2 className="text-center text-2xl font-semibold text-slate-100">How it works</h2>
        <ol className="mt-8 grid gap-4 sm:grid-cols-3">
          {[['Sign up', 'Create your workspace and invite your team.'],
            ['Connect AWS', 'One click creates a narrowly scoped access role in your AWS account. Delete it any time to disconnect.'],
            ['Deploy', 'Pick a server and a GitHub repository. Your app is live with HTTPS in minutes.']].map(([t, d], i) => (
            <li key={t} className="card">
              <span className="num grid h-7 w-7 place-items-center rounded-full bg-indigo-500/15 text-sm text-indigo-300">{i + 1}</span>
              <h3 className="mt-3 font-medium text-slate-100">{t}</h3>
              <p className="mt-1 text-sm text-slate-400">{d}</p>
            </li>
          ))}
        </ol>
      </section>

      <section id="pricing" className="mx-auto max-w-4xl px-4 pb-16 sm:px-6">
        <h2 className="text-center text-2xl font-semibold text-slate-100">Pricing</h2>
        <p className="mt-2 text-center text-sm text-slate-400">Start with a {site.trialDays}-day free trial. Your AWS servers are billed by AWS, separately.</p>
        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          {PLANS.map((p) => (
            <div key={p.id} className={`card flex flex-col ${'highlight' in p && p.highlight ? 'border-indigo-400/50' : ''}`}>
              <div className="flex items-baseline justify-between">
                <h3 className="font-medium text-slate-100">{p.name}</h3>
                {'highlight' in p && p.highlight && <span className="pill-info">most popular</span>}
              </div>
              <p className="mt-1 text-sm text-slate-400">{p.blurb}</p>
              <p className="mt-4"><span className="num text-3xl font-semibold text-slate-100">R{p.price}</span><span className="text-sm text-slate-500"> / month</span></p>
              <ul className="mt-4 flex-1 space-y-2 text-sm text-slate-300">
                {p.features.map((f) => <li key={f} className="flex gap-2"><span className="text-emerald-300">✓</span>{f}</li>)}
              </ul>
              <Link to={`/signup?plan=${p.id}`} className={`${'highlight' in p && p.highlight ? 'btn-primary' : 'btn-secondary'} mt-6`}>Start free trial</Link>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-3xl px-4 pb-20 sm:px-6">
        <h2 className="text-center text-2xl font-semibold text-slate-100">Questions</h2>
        <div className="mt-6 space-y-3">
          {[['Who pays for the servers?', 'You do, directly to AWS, in your own account. We only charge for the console.'],
            ['Can you get into my AWS account?', 'Only through the access role you create, which is limited to what the console needs (running its own fixed commands on servers you tag, reading costs, managing DNS records for your apps). Deleting the role cuts us off immediately.'],
            ['What if I stop paying or leave?', 'Your servers and apps keep running: they live in your AWS account. The workspace becomes read-only until you subscribe again.'],
            ['What can I deploy?', 'Node.js web apps today. Static front-ends (React, Vite) and more runtimes are on the way.']].map(([q, a]) => (
            <details key={q} className="card group">
              <summary className="cursor-pointer list-none font-medium text-slate-100">{q}</summary>
              <p className="mt-2 text-sm text-slate-400">{a}</p>
            </details>
          ))}
        </div>
      </section>

      <footer className="border-t border-ink-700 py-8 text-center text-xs text-slate-500">© {new Date().getFullYear()} {site.productName}</footer>
    </div>
  );
}

export function Signup() {
  const { refresh, site } = useAuth();
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
    <FormShell title="Create your account" sub={`${site.trialDays}-day free trial · no card needed`}>
      <form onSubmit={submit} className="card space-y-4" noValidate>
        {error && <Alert>{error}</Alert>}
        <div><label className="label" htmlFor="su-name">Your name</label><input id="su-name" className="input" autoComplete="name" value={f.name} onChange={set('name')} required /></div>
        <div><label className="label" htmlFor="su-email">Work email</label><input id="su-email" type="email" className="input" autoComplete="email" value={f.email} onChange={set('email')} required /></div>
        <div>
          <label className="label" htmlFor="su-user">Username</label>
          <div className="relative">
            <span className="pointer-events-none absolute inset-y-0 left-3 grid place-items-center text-sm text-slate-500">@</span>
            <input id="su-user" className="input pl-7" autoComplete="username" placeholder="e.g. thandi" maxLength={30} value={f.username}
                   onChange={(e) => { setTouched(true); setF({ ...f, username: e.target.value.toLowerCase().replace(/\s+/g, '') }); }} />
          </div>
          <p className={`mt-1 text-xs ${avail === 'taken' || avail === 'format' ? 'text-rose-300' : 'text-slate-500'}`}>
            {avail === 'taken' ? 'That username is taken.' : avail === 'format' ? '3–30 letters, numbers, dots, dashes or underscores.' : avail === 'ok' ? 'Available. You can sign in with it or with your email.' : 'You can sign in with it or with your email.'}
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
    <FormShell title="Reset your password" sub="We'll email you a link to choose a new one.">
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
      {done ? <div className="card text-sm text-slate-300">Password changed. You've been signed out everywhere. <div className="mt-4"><Link to="/login" className="btn-primary w-full">Sign in</Link></div></div> : (
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
    <FormShell title="Confirm your email">
      <div className="card text-sm text-slate-300">
        {state === 'busy' ? 'Checking the link…' : state === 'ok' ? 'Thanks, your email is confirmed.' : <Alert>{state}</Alert>}
        <div className="mt-4"><Link to={user ? '/' : '/login'} className="btn-primary w-full">{user ? 'Go to your workspace' : 'Sign in'}</Link></div>
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
    <FormShell title={`Join ${info.workspace}`} sub={<>You've been invited as <b>{info.role}</b> ({info.email}).</>}>
      <div className="card space-y-4">
        {error && <Alert>{error}</Alert>}
        {user ? (wrongUser
          ? <Alert tone="warn">You're signed in as {user.email ?? user.username}. Sign out and sign in as {info.email} to accept.</Alert>
          : <button className="btn-primary w-full" disabled={busy} onClick={() => void accept()}>{busy ? 'Joining…' : `Join ${info.workspace}`}</button>)
          : info.hasAccount ? (
            <p className="text-sm text-slate-300">{info.email} already has an account. <Link to={`/login?next=${encodeURIComponent(`/invite?token=${token}`)}`} className="text-indigo-300 hover:underline">Sign in</Link> to accept.</p>
          ) : (
            <form className="space-y-4" onSubmit={accept}>
              <div><label className="label" htmlFor="ai-name">Your name</label><input id="ai-name" className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></div>
              <div><label className="label" htmlFor="ai-pw">Choose a password</label><input id="ai-pw" type="password" className="input" autoComplete="new-password" minLength={8} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required /></div>
              <button className="btn-primary w-full" disabled={busy || !f.name || f.password.length < 8}>{busy ? 'Joining…' : 'Create account and join'}</button>
            </form>
          )}
      </div>
    </FormShell>
  );
}
