import { FormEvent, ReactNode, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, Role, Workspace } from '../api';
import { useAuth } from '../auth';
import { Alert } from '../components/ui';

/** Small inline icon. */
const I = ({ d, className = 'h-5 w-5' }: { d: string; className?: string }) => (
  <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={d} /></svg>
);
const ICON = {
  check: 'M20 6 9 17l-5-5',
  cloud: 'M17.5 19a4.5 4.5 0 1 0-1.4-8.8A6 6 0 0 0 4.5 12 3.5 3.5 0 0 0 6 19z',
  server: 'M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01',
  rocket: 'M5 15c-1.5 1.5-2 5-2 5s3.5-.5 5-2m4-12c3-3 7-3 9-3 0 2 0 6-3 9l-6 6-6-6zM9 9 4 10l3 3M15 15l-1 5-3-3',
  users: 'M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 10a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 19v-1a4 4 0 0 0-3-3.9M16 2.1a4 4 0 0 1 0 7.8',
  shield: 'M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z',
  lock: 'M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  github: 'M9 19c-4 1.5-4-2-6-2.5M15 22v-3.5a3 3 0 0 0-.9-2.4c3-.3 6-1.5 6-6.6a5.2 5.2 0 0 0-1.4-3.6 4.8 4.8 0 0 0-.1-3.6s-1.1-.3-3.7 1.4a12.6 12.6 0 0 0-6.6 0C5.7 1 4.6 1.3 4.6 1.3a4.8 4.8 0 0 0-.1 3.6A5.2 5.2 0 0 0 3 8.5c0 5.1 3 6.3 6 6.6a3 3 0 0 0-.9 2.4V22',
};

type StepState = 'done' | 'current' | 'locked';

function Step({ n, state, title, children, icon, last }: { n: number; state: StepState; title: string; children: ReactNode; icon: string; last?: boolean }) {
  const dot = state === 'done' ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
    : state === 'current' ? 'border-indigo-400/60 bg-indigo-500/20 text-indigo-200 shadow-[0_0_0_4px_rgba(99,102,241,0.12)]'
    : 'border-ink-600 bg-ink-850 text-slate-500';
  return (
    <li className="relative flex gap-4">
      {!last && <span className={`absolute left-[19px] top-11 h-[calc(100%-2.25rem)] w-px ${state === 'done' ? 'bg-emerald-500/40' : 'bg-ink-700'}`} aria-hidden />}
      <span className={`relative z-10 grid h-10 w-10 shrink-0 place-items-center rounded-full border ${dot}`}>
        {state === 'done' ? <I d={ICON.check} /> : state === 'locked' ? <I d={icon} className="h-[18px] w-[18px]" /> : <I d={icon} />}
      </span>
      <div className={`min-w-0 flex-1 pb-8 ${state === 'locked' ? 'opacity-70' : ''}`}>
        <div className="flex flex-wrap items-center gap-2 pt-2">
          <span className="text-2xs font-semibold uppercase tracking-[0.12em] text-slate-500">Step {n}</span>
          {state === 'done' && <span className="pill-ok">done</span>}
          {state === 'current' && <span className="pill-info">next</span>}
        </div>
        <h3 className={`mt-1 text-base font-medium ${state === 'locked' ? 'text-slate-400' : 'text-slate-100'}`}>{title}</h3>
        <div className="mt-2">{children}</div>
      </div>
    </li>
  );
}

/** Access diagram: your account ⇄ a role only the console can use ⇄ the console. */
function AccessDiagram({ product }: { product: string }) {
  const Box = ({ icon, title, sub, tone }: { icon: string; title: string; sub: string; tone: string }) => (
    <div className={`flex min-w-0 flex-1 flex-col items-center rounded-xl border px-3 py-4 text-center ${tone}`}>
      <I d={icon} className="h-6 w-6" />
      <div className="mt-2 text-sm font-medium text-slate-100">{title}</div>
      <div className="mt-0.5 text-2xs text-slate-400">{sub}</div>
    </div>
  );
  const Arrow = () => <span className="hidden shrink-0 text-slate-500 sm:block"><I d={ICON.arrow} /></span>;
  return (
    <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
      <Box icon={ICON.cloud} title="Your AWS account" sub="your servers, your bill" tone="border-ink-600 bg-ink-850 text-amber-300" />
      <Arrow />
      <Box icon={ICON.shield} title="Access role" sub="created by you, deletable any time" tone="border-indigo-400/40 bg-indigo-500/[0.08] text-indigo-300" />
      <Arrow />
      <Box icon={ICON.rocket} title={product} sub="deploys, watches, backs up" tone="border-ink-600 bg-ink-850 text-emerald-300" />
    </div>
  );
}

function InviteCard() {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('deployer');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setMsg(null);
    try { await api.invite(email.trim(), role); setMsg({ tone: 'ok', text: `Invitation sent to ${email.trim()}.` }); setEmail(''); }
    catch (e2) { setMsg({ tone: 'bad', text: e2 instanceof ApiError ? e2.message : 'Could not send it.' }); }
    finally { setBusy(false); }
  }
  return (
    <section className="card">
      <div className="flex items-center gap-2 text-slate-100"><I d={ICON.users} className="h-[18px] w-[18px] text-sky-300" /><h2 className="font-medium">Bring your team</h2></div>
      <p className="mt-1 text-sm text-slate-400">They can join now and help with setup.</p>
      <form className="mt-4 space-y-2" onSubmit={submit}>
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        <input type="email" className="input" placeholder="colleague@company.com" aria-label="Email to invite" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <div className="flex gap-2">
          <select className="input" aria-label="Role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="admin">Admin</option><option value="deployer">Deployer</option><option value="viewer">Viewer</option>
          </select>
          <button className="btn-secondary shrink-0" disabled={busy || !email.trim()}>{busy ? 'Sending…' : 'Invite'}</button>
        </div>
      </form>
      <Link to="/team" className="mt-3 inline-block text-xs text-slate-400 hover:text-slate-200">Manage the team →</Link>
    </section>
  );
}

/**
 * First-run screen of a new workspace (multi-customer mode), shown full-width with no app navigation until the
 * workspace is set up. Step 2 (Connect AWS) ships in Phase 12b.
 */
export function Onboarding() {
  const { user, site } = useAuth();
  const [ws, setWs] = useState<Workspace | null>(null);
  const [showAccess, setShowAccess] = useState(false);
  useEffect(() => { api.workspaces().then((r) => setWs(r.workspaces.find((w) => w.id === r.current) ?? null)).catch(() => undefined); }, []);
  const first = (user?.displayName || user?.username || '').split(/[\s@]/)[0];
  const isAdmin = user?.role === 'admin';
  const trialLeft = ws?.trialEndsAt ? Math.max(0, Math.ceil((Date.parse(ws.trialEndsAt) - Date.now()) / 86400e3)) : null;
  const done = 1, total = 4;

  return (
    <div className="mx-auto max-w-6xl">
      {/* hero */}
      <section className="card px-6 py-8 sm:px-10 sm:py-10">
        <div>
          <p className="eyebrow text-indigo-300">{ws?.name ?? 'Your workspace'}</p>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight text-slate-100 sm:text-3xl">Welcome{first ? `, ${first}` : ''}. Let's get your apps running.</h1>
          <p className="mt-2 max-w-2xl text-sm text-slate-400 sm:text-base">Three steps and about ten minutes: connect your AWS account, pick a server, deploy from GitHub. You stay in control of everything in your account.</p>
          <div className="mt-6 flex max-w-md items-center gap-3">
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-ink-700" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} aria-label="Setup progress">
              <div className="h-full rounded-full bg-indigo-500" style={{ width: `${(done / total) * 100}%` }} />
            </div>
            <span className="num text-xs text-slate-400">{done} of {total} done</span>
          </div>
        </div>
      </section>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        {/* the steps */}
        <section className="card px-6 pb-0 pt-6 sm:px-8">
          <ol>
            <Step n={1} state="done" icon={ICON.check} title="Create your workspace">
              <p className="text-sm text-slate-400">{ws ? <><b className="font-medium text-slate-300">{ws.name}</b> is ready{trialLeft != null ? `, with ${trialLeft} days of free trial left` : ''}.</> : 'Done.'}</p>
            </Step>

            <Step n={2} state="current" icon={ICON.cloud} title="Connect your AWS account">
              <p className="text-sm text-slate-400">One click opens AWS CloudFormation in your own account and creates an access role that only {site.productName} can use. You can see exactly what it allows, and deleting it disconnects us at once.</p>
              <div className="mt-4"><AccessDiagram product={site.productName} /></div>
              <div className="mt-5 flex flex-wrap items-center gap-3">
                <button className="btn-primary" disabled title="Arrives in the next update">
                  <I d={ICON.cloud} className="h-4 w-4" /> Connect AWS account
                </button>
                <span className="pill-mute">arriving in the next update</span>
                <button className="text-sm text-slate-400 underline-offset-2 hover:text-slate-200 hover:underline" onClick={() => setShowAccess((v) => !v)} aria-expanded={showAccess}>
                  {showAccess ? 'Hide' : 'What can the role do?'}
                </button>
              </div>
              {showAccess && (
                <ul className="mt-4 grid gap-2 rounded-xl border border-ink-700 bg-ink-950/40 p-4 text-sm sm:grid-cols-2">
                  {[['Allowed', 'Run our fixed, published commands on servers you tag (deploy, health, logs, backups)', true],
                    ['Allowed', 'Read your instances, costs and the DNS records of your apps', true],
                    ['Allowed', 'Open a browser terminal and time-limited SSH on tagged servers only', true],
                    ['Never', 'Run arbitrary commands, read your other data, or touch untagged resources', false]].map(([k, t, ok], i) => (
                    <li key={i} className="flex gap-2">
                      <span className={ok ? 'text-emerald-300' : 'text-rose-300'}><I d={ok ? ICON.check : ICON.lock} className="h-4 w-4" /></span>
                      <span className="text-slate-300"><b className="font-medium">{k as string}:</b> {t as string}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Step>

            <Step n={3} state="locked" icon={ICON.server} title="Add your first server">
              <p className="text-sm text-slate-400">Choose an EC2 server you already have, or let us start a small one with everything installed (web server, Node.js, Postgres, backups).</p>
            </Step>

            <Step n={4} state="locked" icon={ICON.github} title="Deploy an app from GitHub" last>
              <p className="text-sm text-slate-400">Pick a repository and a subdomain: it builds, gets HTTPS and redeploys on every push.</p>
            </Step>
          </ol>
        </section>

        {/* side */}
        <aside className="space-y-6">
          {isAdmin && <InviteCard />}
          <section className="card">
            <div className="flex items-center gap-2 text-slate-100"><I d={ICON.check} className="h-[18px] w-[18px] text-emerald-300" /><h2 className="font-medium">What you'll need</h2></div>
            <ul className="mt-3 space-y-2.5 text-sm text-slate-400">
              <li>An AWS account where you can create a role (once).</li>
              <li>Your code on GitHub (private repositories are fine).</li>
              <li>Optional: your own domain for your apps.</li>
            </ul>
          </section>
          {trialLeft != null && (
            <section className="card border-indigo-400/30 bg-indigo-500/[0.06]">
              <h2 className="font-medium text-slate-100">Free trial</h2>
              <p className="mt-1 text-sm text-slate-400"><span className="num text-2xl font-semibold text-slate-100">{trialLeft}</span> days left. No card needed until you choose a plan.</p>
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}
