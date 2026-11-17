import { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth';
import { PLANS } from '../plans';

const I = ({ d, className = 'h-5 w-5' }: { d: string; className?: string }) => (
  <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={d} /></svg>
);
const ICON = {
  logo: 'M12 3 3 20h18L12 3z',
  github: 'M9 19c-4 1.5-4-2-6-2.5M15 22v-3.5a3 3 0 0 0-.9-2.4c3-.3 6-1.5 6-6.6a5.2 5.2 0 0 0-1.4-3.6 4.8 4.8 0 0 0-.1-3.6s-1.1-.3-3.7 1.4a12.6 12.6 0 0 0-6.6 0C5.7 1 4.6 1.3 4.6 1.3a4.8 4.8 0 0 0-.1 3.6A5.2 5.2 0 0 0 3 8.5c0 5.1 3 6.3 6 6.6a3 3 0 0 0-.9 2.4V22',
  pulse: 'M3 12h4l3 8 4-16 3 8h4',
  db: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6',
  terminal: 'M4 5h16v14H4zM8 10l3 2-3 2M13 15h3',
  coins: 'M12 3v18M17 7.5c0-1.9-2.2-3-5-3s-5 1.1-5 3 2.2 2.7 5 3 5 1.1 5 3-2.2 3-5 3-5-1.1-5-3',
  users: 'M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 10a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 19v-1a4 4 0 0 0-3-3.9M16 2.1a4 4 0 0 1 0 7.8',
  shield: 'M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z',
  check: 'M20 6 9 17l-5-5',
  key: 'M15 7a4 4 0 1 1-3.9 5H3v3h3v3h3v-3h2.1A4 4 0 0 1 15 7z',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  unplug: 'M19 5 5 19M7 7l-3 3 4 4 3-3M17 17l3-3-4-4-3 3',
};

function Section({ id, eyebrow, title, sub, children }: { id?: string; eyebrow?: string; title: string; sub?: string; children: ReactNode }) {
  return (
    <section id={id} className="mx-auto max-w-6xl scroll-mt-20 px-4 py-20 sm:px-6">
      <div className="mx-auto max-w-2xl text-center">
        {eyebrow && <p className="text-xs font-semibold uppercase tracking-[0.14em] text-indigo-300">{eyebrow}</p>}
        <h2 className="mt-3 text-2xl font-semibold tracking-tight text-slate-100 sm:text-3xl">{title}</h2>
        {sub && <p className="mt-3 text-slate-400">{sub}</p>}
      </div>
      <div className="mt-12">{children}</div>
    </section>
  );
}

/** A static picture of the console (no data, no images): what the product looks like. */
function ConsolePreview() {
  const apps: [string, string, string, number][] = [['shop-api', 'shop.acme.com', '42 ms', 100], ['billing', 'billing.acme.com', '61 ms', 99.98], ['admin', 'admin.acme.com', '38 ms', 100]];
  return (
    <div className="rounded-2xl border border-ink-600 bg-ink-900 p-2 shadow-2xl shadow-black/30" aria-hidden>
      <div className="flex items-center gap-1.5 border-b border-ink-700 px-3 pb-2 pt-1">
        <span className="h-2.5 w-2.5 rounded-full bg-ink-600" /><span className="h-2.5 w-2.5 rounded-full bg-ink-600" /><span className="h-2.5 w-2.5 rounded-full bg-ink-600" />
        <span className="ml-3 text-2xs text-slate-500">Overview · Acme</span>
      </div>
      <div className="grid grid-cols-3 gap-2 p-3">
        {[['Health', '100', 'text-emerald-300'], ['Apps', '3/3', 'text-slate-100'], ['Month', 'R412', 'text-slate-100']].map(([k, v, c]) => (
          <div key={k} className="rounded-lg border border-ink-700 bg-ink-850 p-3"><div className="text-2xs uppercase tracking-wider text-slate-500">{k}</div><div className={`num mt-1 text-lg font-medium ${c}`}>{v}</div></div>
        ))}
      </div>
      <div className="mx-3 mb-3 overflow-hidden rounded-lg border border-ink-700">
        {apps.map(([n, d, ms, up]) => (
          <div key={n} className="flex items-center gap-3 border-b border-ink-800 bg-ink-900 px-3 py-2.5 text-xs last:border-b-0">
            <span className="h-2 w-2 rounded-full bg-emerald-400" />
            <span className="w-20 font-medium text-slate-200">{n}</span>
            <span className="hidden flex-1 truncate text-slate-500 sm:block">{d}</span>
            <span className="num text-slate-400">{ms}</span>
            <span className="num w-16 text-right text-slate-400">{up}%</span>
          </div>
        ))}
      </div>
      <div className="mx-3 mb-3 rounded-lg border border-ink-700 bg-ink-950 p-3 font-mono text-[11px] leading-5 text-slate-400">
        <div><span className="text-slate-500">09:41</span> push to <span className="text-slate-200">main</span> · shop-api <span className="text-slate-500">a1b2c3d</span></div>
        <div><span className="text-slate-500">09:42</span> built, health check <span className="text-emerald-300">200</span></div>
        <div><span className="text-slate-500">09:42</span> <span className="text-emerald-300">deployed</span> in 48 s</div>
      </div>
    </div>
  );
}

const FEATURES: [string, string, string][] = [
  [ICON.github, 'Deploy from GitHub', 'Pick a repository and a subdomain. It builds, gets HTTPS, and every push to the branch deploys automatically, rolling back if the new version is unhealthy.'],
  [ICON.pulse, 'Problems found before customers notice', 'Health checks every minute, uptime history and alerts for downtime, disk, memory, certificates and failed deploys, by email, Slack or Discord.'],
  [ICON.db, 'Verified backups', 'Nightly database backups, kept on the server for two weeks and restore-tested automatically.'],
  [ICON.terminal, 'Safe server access', 'A browser terminal with no open SSH port, and time-limited SSH from a laptop that closes automatically.'],
  [ICON.coins, 'Costs under control', "This month's AWS bill and forecast in Rand or dollars, budget alerts, and control of the schedules that start and stop servers."],
  [ICON.users, 'Built for teams', 'Roles, deploy approvals for production, freeze windows and a full audit log of who did what.'],
];

const FAQ: [string, string][] = [
  ['Who pays for the servers?', 'AWS bills the servers directly to the organisation\'s own account. The subscription covers the console only.'],
  ['What can the console access in the AWS account?', 'Only what the access role allows: running the console\'s published commands on added servers, reading their status and costs, and managing the apps\' DNS records. Every request uses a secret ID unique to the workspace, and deleting the role ends access at once.'],
  ['What happens when a subscription ends?', 'Servers and apps keep running, because they live in the organisation\'s AWS account. The workspace becomes read-only until a plan is chosen again.'],
  ['What can I deploy?', 'Node.js web apps on Amazon Linux servers today. Static front-ends and more runtimes are on the way.'],
  ['Is DevOps experience required?', 'No. Connecting the account takes one CloudFormation stack, and the console prepares servers, certificates, databases and backups automatically.'],
];

/** The public front page of the multi-customer product. Flat design, no gradients. */
export function Landing() {
  const { site } = useAuth();
  const nav: [string, string][] = [['#features', 'Features'], ['#how', 'How it works'], ['#security', 'Security'], ['#pricing', 'Pricing'], ['/docs', 'Docs']];
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-ink-700 bg-ink-950/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-4 sm:px-6">
          <Link to="/" className="flex items-center gap-2.5">
            <span className="grid h-8 w-8 place-items-center rounded-lg border border-indigo-400/40 bg-indigo-500/15 text-indigo-300"><I d={ICON.logo} className="h-4 w-4" /></span>
            <span className="font-semibold tracking-tight text-slate-100">{site.productName}</span>
          </Link>
          <nav className="hidden gap-6 text-sm text-slate-400 md:flex">{nav.map(([h, l]) => <a key={h} href={h} className="hover:text-slate-100">{l}</a>)}</nav>
          <div className="ml-auto flex items-center gap-2">
            <Link to="/login" className="px-3 py-2 text-sm text-slate-300 hover:text-slate-100">Sign in</Link>
            <Link to="/signup" className="btn-primary">Start free trial</Link>
          </div>
        </div>
      </header>

      {/* hero */}
      <section className="border-b border-ink-700">
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 py-16 sm:px-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:py-24">
          <div>
            <span className="inline-flex items-center gap-2 rounded-full border border-ink-600 px-3 py-1 text-xs text-slate-400"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> A self-hosted platform on AWS</span>
            <h1 className="mt-5 text-4xl font-semibold leading-tight tracking-tight text-slate-100 sm:text-5xl">Ship and run apps on AWS, without a DevOps team.</h1>
            <p className="mt-5 max-w-xl text-lg text-slate-400">Connect an AWS account, add a server and choose a GitHub repository. {site.productName} deploys, monitors, backs up and secures the app, while servers and data stay in the organisation's own account.</p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link to="/signup" className="btn-primary px-5 py-2.5 text-base">Start the {site.trialDays}-day free trial</Link>
              <a href="#how" className="btn-secondary px-5 py-2.5 text-base">See how it works</a>
            </div>
            <ul className="mt-6 flex flex-wrap gap-x-5 gap-y-2 text-sm text-slate-500">
              {['No card for the trial', 'Data stays in the AWS account', 'Cancel any time'].map((t) => <li key={t} className="flex items-center gap-1.5"><I d={ICON.check} className="h-4 w-4 text-emerald-300" />{t}</li>)}
            </ul>
          </div>
          <ConsolePreview />
        </div>
      </section>

      {/* built on */}
      <div className="border-b border-ink-700">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-center gap-x-10 gap-y-3 px-4 py-6 text-sm text-slate-500 sm:px-6">
          <span className="text-xs uppercase tracking-[0.14em]">Built on</span>
          {['Amazon EC2', 'AWS Systems Manager', 'GitHub', "Let's Encrypt", 'PostgreSQL', 'Paystack'].map((x) => <span key={x} className="font-medium text-slate-400">{x}</span>)}
        </div>
      </div>

      <Section id="features" eyebrow="Features" title="Everything a small team needs to run production" sub="The work of a platform team, done by the console, on servers the organisation owns.">
        <div className="grid gap-px overflow-hidden rounded-2xl border border-ink-700 bg-ink-700 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map(([icon, t, d]) => (
            <div key={t} className="bg-ink-900 p-6">
              <span className="grid h-9 w-9 place-items-center rounded-lg border border-ink-600 bg-ink-850 text-indigo-300"><I d={icon} className="h-[18px] w-[18px]" /></span>
              <h3 className="mt-4 font-medium text-slate-100">{t}</h3>
              <p className="mt-2 text-sm leading-6 text-slate-400">{d}</p>
            </div>
          ))}
        </div>
      </Section>

      <div className="border-y border-ink-700 bg-ink-900">
        <Section id="how" eyebrow="How it works" title="Live in three steps, in about ten minutes">
          <ol className="grid gap-6 md:grid-cols-3">
            {[['Connect AWS', 'One CloudFormation stack creates a narrowly scoped role in the account. Deleting it disconnects at any time.'],
              ['Add a server', 'Choose an existing EC2 server. The console prepares it: web server, Node.js, database, backups.'],
              ['Deploy from GitHub', 'Pick a repository and a subdomain. HTTPS, health checks and auto-deploy on push are configured automatically.']].map(([t, d], i) => (
              <li key={t} className="rounded-2xl border border-ink-700 bg-ink-950 p-6">
                <span className="num text-sm font-semibold text-indigo-300">0{i + 1}</span>
                <h3 className="mt-3 text-lg font-medium text-slate-100">{t}</h3>
                <p className="mt-2 text-sm leading-6 text-slate-400">{d}</p>
              </li>
            ))}
          </ol>
        </Section>
      </div>

      <Section id="security" eyebrow="Security" title="Access on the organisation's terms" sub="The console only does what the access role allows, and that access can be reviewed and revoked at any moment.">
        <div className="grid gap-4 sm:grid-cols-2">
          {[[ICON.key, 'A role the organisation owns', 'Created with CloudFormation in the organisation\'s account, scoped to added servers and the console\'s published commands. No access keys are ever shared.'],
            [ICON.shield, 'Isolated per workspace', 'Every request carries a secret ID unique to the workspace, and each workspace\'s data is separated by the database itself.'],
            [ICON.eye, 'Everything is audited', 'Deploys, terminal sessions, SSH access, key changes and settings: who did what, and when.'],
            [ICON.unplug, 'No lock-in', 'Deleting the stack disconnects the console. Servers, apps and data never leave the organisation\'s account.']].map(([icon, t, d]) => (
            <div key={t} className="flex gap-4 rounded-2xl border border-ink-700 bg-ink-900 p-6">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-ink-600 bg-ink-850 text-emerald-300"><I d={icon} className="h-[18px] w-[18px]" /></span>
              <div><h3 className="font-medium text-slate-100">{t}</h3><p className="mt-1.5 text-sm leading-6 text-slate-400">{d}</p></div>
            </div>
          ))}
        </div>
      </Section>

      <div className="border-y border-ink-700 bg-ink-900">
        <Section id="pricing" eyebrow="Pricing" title="Simple monthly plans" sub={`Start with a ${site.trialDays}-day free trial with everything in Pro. AWS usage is billed by AWS, separately.`}>
          <div className="mx-auto grid max-w-4xl gap-6 md:grid-cols-2">
            {PLANS.map((p) => {
              const hi = 'highlight' in p && p.highlight;
              return (
                <div key={p.id} className={`flex flex-col rounded-2xl border bg-ink-950 p-8 ${hi ? 'border-indigo-400/60' : 'border-ink-700'}`}>
                  <div className="flex items-center justify-between"><h3 className="text-lg font-medium text-slate-100">{p.name}</h3>{hi && <span className="text-xs font-medium text-indigo-300">Most popular</span>}</div>
                  <p className="mt-1 text-sm text-slate-400">{p.blurb}</p>
                  <p className="mt-6"><span className="num text-4xl font-semibold text-slate-100">R{p.price}</span><span className="text-sm text-slate-500"> per month</span></p>
                  <ul className="mt-6 flex-1 space-y-3 text-sm text-slate-300">
                    {p.features.map((f) => <li key={f} className="flex gap-2.5"><I d={ICON.check} className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" />{f}</li>)}
                  </ul>
                  <Link to={`/signup?plan=${p.id}`} className={`${hi ? 'btn-primary' : 'btn-secondary'} mt-8 py-2.5`}>Start free trial</Link>
                </div>
              );
            })}
          </div>
          <p className="mt-6 text-center text-xs text-slate-500">Prices in South African Rand. Payments by Paystack. Cancel any time.</p>
        </Section>
      </div>

      <Section id="faq" eyebrow="FAQ" title="Questions, answered">
        <div className="mx-auto max-w-3xl divide-y divide-ink-700 rounded-2xl border border-ink-700 bg-ink-900">
          {FAQ.map(([q, a]) => (
            <details key={q} className="group px-6 py-5">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-medium text-slate-100">
                {q}<span className="text-slate-500 transition group-open:rotate-45">+</span>
              </summary>
              <p className="mt-3 text-sm leading-6 text-slate-400">{a}</p>
            </details>
          ))}
        </div>
      </Section>

      <section className="mx-auto max-w-6xl px-4 pb-20 sm:px-6">
        <div className="flex flex-col items-start justify-between gap-6 rounded-2xl border border-ink-700 bg-ink-900 p-8 sm:flex-row sm:items-center sm:p-10">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight text-slate-100">Ready to stop babysitting servers?</h2>
            <p className="mt-2 text-slate-400">Connect an AWS account and deploy the first app today.</p>
          </div>
          <Link to="/signup" className="btn-primary shrink-0 px-5 py-2.5 text-base">Start free trial</Link>
        </div>
      </section>

      <footer className="border-t border-ink-700">
        <div className="mx-auto grid max-w-6xl gap-8 px-4 py-12 sm:px-6 md:grid-cols-[2fr_1fr_1fr_1fr]">
          <div>
            <div className="flex items-center gap-2.5">
              <span className="grid h-7 w-7 place-items-center rounded-lg border border-indigo-400/40 bg-indigo-500/15 text-indigo-300"><I d={ICON.logo} className="h-4 w-4" /></span>
              <span className="font-semibold text-slate-100">{site.productName}</span>
            </div>
            <p className="mt-3 max-w-sm text-sm text-slate-500">Deploy, monitor and secure apps on servers in the organisation's own AWS account.</p>
          </div>
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">Product</h3>
            <ul className="mt-3 space-y-2 text-sm text-slate-500">{nav.slice(0, 4).map(([h, l]) => <li key={h}><a href={h} className="hover:text-slate-300">{l}</a></li>)}</ul>
          </div>
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">Legal</h3>
            <ul className="mt-3 space-y-2 text-sm text-slate-500">
              <li><Link to="/terms" className="hover:text-slate-300">Terms of Service</Link></li>
              <li><Link to="/privacy" className="hover:text-slate-300">Privacy Policy</Link></li>
              <li><Link to="/security" className="hover:text-slate-300">Security</Link></li>
              {site.supportEmail && <li><a href={`mailto:${site.supportEmail}`} className="hover:text-slate-300">Contact</a></li>}
            </ul>
          </div>
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">Account</h3>
            <ul className="mt-3 space-y-2 text-sm text-slate-500">
              <li><Link to="/signup" className="hover:text-slate-300">Start free trial</Link></li>
              <li><Link to="/login" className="hover:text-slate-300">Sign in</Link></li>
              <li><Link to="/forgot-password" className="hover:text-slate-300">Reset password</Link></li>
            </ul>
          </div>
        </div>
        <div className="border-t border-ink-700">
          <p className="mx-auto max-w-6xl px-4 py-5 text-xs text-slate-500 sm:px-6">© {new Date().getFullYear()} {site.legalEntity ?? site.productName}. Prices in ZAR; AWS usage is billed by AWS.</p>
        </div>
      </footer>
    </div>
  );
}
