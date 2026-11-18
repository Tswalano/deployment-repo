import { ThemeToggle } from '../components/ThemeToggle';
import { ReactNode, useEffect } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { useAuth } from '../auth';
import { LegalLinks } from './Legal';

/* Small typographic helpers so articles read well in both themes (flat, no gradients). */
const H = ({ children }: { children: ReactNode }) => <h2 className="mt-10 scroll-mt-20 text-lg font-semibold text-slate-100">{children}</h2>;
const P = ({ children }: { children: ReactNode }) => <p className="mt-3 leading-7 text-slate-300">{children}</p>;
const UL = ({ children }: { children: ReactNode }) => <ul className="mt-3 list-disc space-y-1.5 pl-5 leading-7 text-slate-300">{children}</ul>;
const OL = ({ children }: { children: ReactNode }) => <ol className="mt-3 list-decimal space-y-1.5 pl-5 leading-7 text-slate-300">{children}</ol>;
const C = ({ children }: { children: ReactNode }) => <code className="rounded border border-ink-700 bg-ink-900 px-1.5 py-0.5 font-mono text-[0.85em] text-slate-200">{children}</code>;
const Note = ({ children }: { children: ReactNode }) => <div className="mt-4 rounded-lg border border-ink-700 bg-ink-900 px-4 py-3 text-sm leading-6 text-slate-300">{children}</div>;
const A = ({ to, children }: { to: string; children: ReactNode }) => <Link className="text-indigo-300 hover:underline" to={to}>{children}</Link>;

interface Article { slug: string; group: string; title: string; summary: string; body: (p: { product: string }) => ReactNode }

const ARTICLES: Article[] = [
  { slug: 'getting-started', group: 'Start here', title: 'Getting started', summary: 'What the console does, and the three steps to the first live app.',
    body: ({ product }) => (<>
      <P>{product} runs web apps on servers in the organisation's <b>own AWS account</b>. It connects to that account through a dedicated access role, prepares the servers, deploys code from GitHub, and then monitors, backs up and secures everything. AWS bills the servers directly; {product} is a monthly subscription for the console.</P>
      <H>Requirements</H>
      <UL>
        <li>An AWS account with permission to create a CloudFormation stack (once).</li>
        <li>A Linux server in that account: Amazon Linux 2023, <C>t4g.small</C> or larger is recommended.</li>
        <li>Code on GitHub (private repositories are supported). Node.js web apps are supported today.</li>
        <li>Optional: a domain whose DNS is hosted in Route 53 in the same account, for app addresses.</li>
      </UL>
      <H>Three steps</H>
      <OL>
        <li><A to="/docs/connect-aws">Connect the AWS account</A> with one CloudFormation stack.</li>
        <li><A to="/docs/servers">Add and prepare a server</A>; the console installs what it needs.</li>
        <li><A to="/docs/deploy">Deploy an app from GitHub</A> by choosing a repository and a subdomain.</li>
      </OL>
      <P>The 14-day trial includes everything in the Pro plan; no card is required.</P>
    </>) },
  { slug: 'connect-aws', group: 'Start here', title: 'Connect the AWS account', summary: 'Create the access role with CloudFormation and connect it.',
    body: ({ product }) => (<>
      <P>The console never uses AWS access keys. Instead, a role in the AWS account can be used only by {product}, and only together with a secret ID unique to the workspace (the <b>external ID</b>).</P>
      <H>Steps</H>
      <OL>
        <li>On the getting-started page, choose the region of the servers.</li>
        <li>Open AWS CloudFormation, or download the template and upload it in CloudFormation. Keep the pre-filled values, acknowledge the IAM resources and create the stack.</li>
        <li>When the stack reaches <C>CREATE_COMPLETE</C> (about two minutes), copy <C>RoleArn</C> from its <b>Outputs</b> tab.</li>
        <li>Paste it into the console and select <b>Connect</b>. The console verifies the role and saves the connection.</li>
      </OL>
      <H>Permissions of the role</H>
      <UL>
        <li>Run {product}'s fixed, published commands on added servers (deploy, status, logs, backups). Arbitrary commands are not possible.</li>
        <li>Read servers, costs, schedules and the apps' DNS records; change those DNS records.</li>
        <li>Tag added servers, attach the console's instance profile, and start, stop or reboot those servers.</li>
        <li>Open a browser terminal and time-limited SSH rules on added servers; manage app settings under <C>/apps/</C> in Parameter Store.</li>
      </UL>
      <Note>If the account and region already contain <C>OpsConsole-*</C> documents, set <b>InstallDocuments</b> to <C>no</C> when creating the stack.</Note>
      <H>Disconnecting</H>
      <P>Settings → AWS account → <b>Disconnect</b> stops the console immediately. To remove access completely, delete the <C>OpsConsoleAccess</C> stack in CloudFormation. Servers and apps keep running in both cases.</P>
    </>) },
  { slug: 'servers', group: 'Servers and apps', title: 'Add and prepare a server', summary: 'Add an EC2 server and install what the console needs.',
    body: () => (<>
      <H>Adding a server</H>
      <P>After the AWS account is connected, the console lists the EC2 servers in the region. <b>Add</b> tags the server <C>ops-console=managed</C> (and its security groups) and, if it has no instance profile, attaches <C>OpsConsoleInstance-&lt;region&gt;</C> so the console can reach it through AWS Session Manager. No SSH port needs to be open.</P>
      <UL>
        <li>Linux only; Amazon Linux 2023 is required for server preparation.</li>
        <li>The server needs outbound internet access (HTTPS) for Session Manager.</li>
        <li>A newly added server can take a few minutes to become reachable.</li>
      </UL>
      <H>Preparing the server</H>
      <P>A new server shows <b>Prepare server</b>. Preparation installs nginx, git, certbot, Node.js, PostgreSQL 15, the console's read-only status agent, the deploy pipeline and nightly database backups. It can be run again safely: every step checks what is already in place. Select <b>Open web ports 80 and 443</b> to make the apps' websites reachable.</P>
      <H>Power</H>
      <P>Start, stop and reboot from the server's page. A stopped server keeps its data; its apps are offline until it is started again.</P>
    </>) },
  { slug: 'deploy', group: 'Servers and apps', title: 'Deploy from GitHub', summary: 'Connect GitHub, create an app and deploy on every push.',
    body: () => (<>
      <H>Connecting GitHub</H>
      <P>Settings → GitHub → <b>Connect GitHub</b> (optionally enter an organisation name first). GitHub creates a private app for the workspace in that account, with read-only access to code. Then select <b>Install on GitHub</b> and choose the repositories the app may read. Each workspace has its own app, so no other workspace can reach its repositories.</P>
      <H>Creating an app</H>
      <OL>
        <li>On a prepared server, select <b>New app</b>, then a repository and branch.</li>
        <li>The console reads <C>package.json</C>: a <C>start</C> script is required (or another script can be chosen), and a build script is used if present.</li>
        <li>Choose a name and subdomain. Optionally add a PostgreSQL database; its connection string is provided as <C>DATABASE_URL</C>.</li>
        <li>Create the app. Creation usually takes 2 to 5 minutes, and the page can be closed meanwhile.</li>
      </OL>
      <Note>The app must listen on the port in <C>process.env.PORT</C> and answer its health path (default <C>/</C>) with HTTP 200, for example <C>app.listen(process.env.PORT)</C>.</Note>
      <H>Automatic deploys</H>
      <P>Every push to the linked branch deploys that commit. If the new version fails its health check, the previous version is restored. Deploys, retries and rollbacks are on each app's <b>Deploy</b> tab; failures that were not fixed by a later deploy are listed under <b>Activity → Failed deployments</b>.</P>
    </>) },
  { slug: 'domains', group: 'Servers and apps', title: 'Domains and HTTPS', summary: 'App addresses under the organisation\'s domain, with certificates.',
    body: () => (<>
      <P>Settings → <b>Apps domain</b>: enter a domain (for example <C>acme.com</C> or <C>apps.acme.com</C>) whose DNS is a Route 53 hosted zone in the connected account. New apps receive an address under it, such as <C>shop.acme.com</C>; the console creates the DNS record and a free Let's Encrypt certificate.</P>
      <UL>
        <li>If HTTPS shows as pending, DNS was still propagating when the app was created; the certificate is issued on the next deploy.</li>
        <li>When an app creation fails, the DNS record the console created is removed again.</li>
      </UL>
    </>) },
  { slug: 'settings-env', group: 'Servers and apps', title: 'Environment variables', summary: 'App settings and secrets.',
    body: () => (<>
      <P>Each app's <b>Environment</b> tab lists its settings, stored encrypted in AWS Systems Manager Parameter Store under <C>/apps/&lt;app&gt;/</C>. Values can be added, changed or removed; the app is reloaded with the new values, and the change is reverted automatically if the app becomes unhealthy.</P>
      <P>Values stay hidden until revealed, and every change is recorded in the audit log.</P>
    </>) },
  { slug: 'monitoring', group: 'Operate', title: 'Monitoring, alerts and backups', summary: 'Health checks, uptime, notifications and database backups.',
    body: () => (<>
      <H>Health and uptime</H>
      <P>Each app's public address is checked every minute. The Overview and each app show uptime history, response times, memory, disk, and recent errors and warnings from the logs.</P>
      <H>Alerts</H>
      <P>Alerts cover apps that are down or slow, unreachable servers, disk and memory, expiring certificates, failed deploys, missing or unrestorable backups, stuck database sessions and the AWS budget. Notifications go by email, Slack or Discord (Settings).</P>
      <H>Backups</H>
      <P>Databases are backed up nightly and kept on the server for 14 days. The newest backup of each database is restore-tested automatically into a temporary copy to confirm it is usable.</P>
    </>) },
  { slug: 'access', group: 'Operate', title: 'Terminal and SSH access', summary: 'Secure access to servers.',
    body: () => (<>
      <H>Browser terminal</H>
      <P>Admins can open a shell on a server with its <b>Terminal</b> button. The session runs through AWS Session Manager, so no SSH port is needed, and it closes after 20 minutes without input or after 2 hours.</P>
      <H>SSH from a laptop</H>
      <P>Server → <b>Access</b> → <b>Connect from a laptop</b>: save a public key once, then allow it for 30 minutes to 8 hours, either directly from an IP address or through a Session Manager tunnel. The console installs the key with an expiry and removes it (and any port it opened) when the time is up.</P>
      <H>Also on the Access page</H>
      <UL>
        <li>The server's authorized SSH keys and when each was last used.</li>
        <li>Recent SSH logins and failed attempts.</li>
        <li>Pending operating-system updates and whether a reboot is required.</li>
      </UL>
    </>) },
  { slug: 'team', group: 'Account', title: 'Team and roles', summary: 'Invite people and set their permissions.',
    body: () => (<>
      <P>Administration → <b>Team</b> → invite by email. Invitations are valid for 7 days.</P>
      <div className="mt-4 overflow-hidden rounded-lg border border-ink-700">
        <table className="w-full text-sm">
          <thead className="bg-ink-900 text-left text-slate-400"><tr><th className="px-4 py-2 font-medium">Role</th><th className="px-4 py-2 font-medium">Permissions</th></tr></thead>
          <tbody className="divide-y divide-ink-700 text-slate-300">
            <tr><td className="px-4 py-2">Admin</td><td className="px-4 py-2">Everything, including team, billing, settings, AWS and GitHub connections, terminal and SSH access.</td></tr>
            <tr><td className="px-4 py-2">Deployer</td><td className="px-4 py-2">Deploy, roll back, restart, back up; view access and logs.</td></tr>
            <tr><td className="px-4 py-2">Viewer</td><td className="px-4 py-2">Read-only.</td></tr>
          </tbody>
        </table>
      </div>
      <P>A workspace always keeps at least one admin. One account can belong to several workspaces and switch between them from the profile menu.</P>
    </>) },
  { slug: 'billing', group: 'Account', title: 'Plans, billing and invoices', summary: 'Trial, plans, payments and lapsed subscriptions.',
    body: () => (<>
      <UL>
        <li><b>Trial</b>: 14 days with everything in Pro; no card required.</li>
        <li><b>Starter</b> R199/month: 1 server, 3 apps, 2 team members.</li>
        <li><b>Pro</b> R599/month: 5 servers, 20 apps, 10 team members, deploy approvals and freeze windows.</li>
      </UL>
      <P>Administration → <b>Billing</b> to choose or switch a plan (paid securely through Paystack), update the card or cancel. A cancelled subscription keeps working until the end of the paid period.</P>
      <H>Invoices</H>
      <P>Every payment produces an invoice on the Billing page. Each can be downloaded as a PDF, and the last six months as a single PDF or a CSV.</P>
      <H>Failed payments and lapsed subscriptions</H>
      <P>After a failed payment there is a 7-day grace period to update the card. After that, or when a trial or cancelled plan ends, the workspace becomes read-only: everything stays visible, but changes are paused. Servers and apps keep running, because they are in the organisation's AWS account.</P>
    </>) },
  { slug: 'security', group: 'Account', title: 'Security and data', summary: 'How access, isolation and auditing work.',
    body: ({ product }) => (<>
      <UL>
        <li><b>Access on the organisation's terms</b>: {product} reaches AWS only through the role created for it, with short-lived credentials and the workspace's secret external ID. Deleting the stack removes access.</li>
        <li><b>Isolation</b>: each workspace's data is separated by the database itself; no customer can see another customer's servers, apps or settings.</li>
        <li><b>Least privilege on servers</b>: the console runs only its fixed, published commands, and only on added servers.</li>
        <li><b>Audit log</b>: deploys, terminal sessions, SSH access, and key and setting changes are recorded with the person and time (Administration → Audit log).</li>
        <li><b>Data ownership</b>: code, databases, backups and secrets stay on the organisation's servers and in its AWS account.</li>
      </UL>
    </>) },
  { slug: 'troubleshooting', group: 'Help', title: 'Troubleshooting', summary: 'Common problems and their fixes.',
    body: () => (<>
      <H>The server is not reachable</H>
      <P>Session Manager requires the server to be running, to have the <C>OpsConsoleInstance</C> profile (or <C>AmazonSSMManagedInstanceCore</C>), and outbound HTTPS. A newly added server can take a few minutes.</P>
      <H>The first deploy fails its health check</H>
      <P>Confirm that the app listens on <C>process.env.PORT</C> and that its health path returns HTTP 200. The failure output is under Activity → Failed deployments.</P>
      <H>A repository is not listed</H>
      <P>Grant the GitHub App access to it: Settings → GitHub → <b>Change repository access</b>.</P>
      <H>An email did not arrive</H>
      <P>Check the spam folder, then resend from the banner at the top of the console. Invitations expire after 7 days; an admin can send a new one.</P>
      <H>A change was refused as read-only</H>
      <P>The trial or subscription has ended, or a payment failed more than 7 days ago. An admin can resolve it on the Billing page.</P>
    </>) },
];
const GROUPS = [...new Set(ARTICLES.map((a) => a.group))];

/** Public documentation: /docs and /docs/:slug, with previous and next links. */
export function Docs() {
  const { site, user } = useAuth();
  const { slug } = useParams();
  const article = ARTICLES.find((a) => a.slug === (slug ?? 'getting-started'));
  useEffect(() => { window.scrollTo(0, 0); }, [slug]);
  if (!article) return <Navigate to="/docs" replace />;
  const idx = ARTICLES.indexOf(article);
  const prev = ARTICLES[idx - 1];
  const next = ARTICLES[idx + 1];
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-ink-700 bg-ink-950/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4 sm:px-6">
          <Link to="/" className="flex items-center gap-2.5">
            <span className="grid h-7 w-7 place-items-center rounded-lg border border-indigo-400/40 bg-indigo-500/15 text-indigo-300">
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M12 3 3 20h18L12 3z" /></svg>
            </span>
            <span className="font-semibold text-slate-100">{site.productName}</span>
          </Link>
          <span className="text-sm text-slate-500">Docs</span>
          <div className="ml-auto flex items-center gap-2"><ThemeToggle />{user ? <Link to="/" className="btn-secondary">Open the console</Link> : <Link to="/login" className="btn-ghost">Sign in</Link>}</div>
        </div>
      </header>
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-10 sm:px-6 md:grid-cols-[13rem_minmax(0,1fr)]">
        <nav aria-label="Documentation" className="md:sticky md:top-24 md:self-start">
          {GROUPS.map((g) => (
            <div key={g} className="mb-6">
              <div className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">{g}</div>
              <ul className="mt-2 space-y-1">
                {ARTICLES.filter((a) => a.group === g).map((a) => (
                  <li key={a.slug}>
                    <Link to={`/docs/${a.slug}`} aria-current={a.slug === article.slug ? 'page' : undefined}
                          className={`block rounded-md px-2 py-1 text-sm ${a.slug === article.slug ? 'bg-ink-800 text-slate-100' : 'text-slate-400 hover:text-slate-200'}`}>{a.title}</Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <article className="min-w-0 max-w-3xl">
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-indigo-300">{article.group}</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-100">{article.title}</h1>
          <p className="mt-2 text-slate-400">{article.summary}</p>
          <div className="mt-2">{article.body({ product: site.productName })}</div>
          <nav aria-label="Previous and next" className="mt-12 grid gap-3 border-t border-ink-700 pt-6 sm:grid-cols-2">
            {prev ? (
              <Link to={`/docs/${prev.slug}`} className="rounded-xl border border-ink-700 px-5 py-4 hover:border-ink-500">
                <span className="block text-xs text-slate-500">← Previous</span><span className="text-slate-100">{prev.title}</span>
              </Link>
            ) : <span />}
            {next && (
              <Link to={`/docs/${next.slug}`} className="rounded-xl border border-ink-700 px-5 py-4 text-right hover:border-ink-500">
                <span className="block text-xs text-slate-500">Next →</span><span className="text-slate-100">{next.title}</span>
              </Link>
            )}
          </nav>
        </article>
      </div>
      <LegalLinks />
    </div>
  );
}
