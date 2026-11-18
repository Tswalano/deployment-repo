import { ReactNode, useEffect, useMemo, useState } from 'react';
import { Link, Navigate, NavLink, useParams } from 'react-router-dom';
import { api, ApiError, PlatformDetail, PlatformHealth, PlatformOverview, PlatformWorkspace } from '../api';
import { useAuth } from '../auth';
import { ago, Alert, Kpi, PageHeader, Skeleton } from '../components/ui';

/** Platform owner portal: every customer workspace, cross-customer health and the platform's audit trail. */
const err = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong.');
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const rand = (n: number) => `R${n.toLocaleString('en-ZA')}`;
const DOT: Record<string, string> = {
  platform: 'bg-indigo-400', paying: 'bg-emerald-400', complimentary: 'bg-emerald-400', trial: 'bg-sky-400', cancelling: 'bg-amber-400',
  'payment failed': 'bg-rose-400', suspended: 'bg-rose-400', 'trial ended': 'bg-slate-500', ended: 'bg-slate-500', cancelled: 'bg-slate-500', 'no plan': 'bg-slate-500',
};
const Status = ({ s }: { s: string }) => (
  <span className="inline-flex items-center gap-2 capitalize text-slate-300"><span className={`h-2 w-2 rounded-full ${DOT[s] ?? 'bg-slate-500'}`} />{s}</span>
);
const PLAN: Record<string, string> = { trial: 'Trial', starter: 'Starter', pro: 'Pro', internal: 'Platform' };

function Guard({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  if (!user?.platformAdmin) return <Navigate to="/" replace />;
  return <>{children}</>;
}

function PlatformNav() {
  const item = ({ isActive }: { isActive: boolean }) => `rounded-md px-3 py-1 text-sm ${isActive ? 'bg-ink-800 text-slate-100' : 'text-slate-400 hover:text-slate-200'}`;
  return (
    <nav aria-label="Platform admin" className="mb-4 flex items-center gap-3">
      <span className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">Platform admin</span>
      <div className="flex gap-0.5 rounded-lg border border-ink-700 p-0.5">
        <NavLink end to="/platform" className={item}>Workspaces</NavLink>
        <NavLink to="/platform/health" className={item}>Health</NavLink>
        <NavLink to="/platform/audit" className={item}>Audit</NavLink>
      </div>
    </nav>
  );
}

// ------------------------------------------------------------------ overview + workspaces
export function Platform() {
  const [ov, setOv] = useState<PlatformOverview | null>(null);
  const [list, setList] = useState<PlatformWorkspace[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('all');
  useEffect(() => {
    Promise.all([api.platformOverview(), api.platformWorkspaces()]).then(([o, l]) => { setOv(o); setList(l); }).catch((e) => setError(err(e)));
  }, []);
  const statuses = useMemo(() => [...new Set((list ?? []).map((w) => w.status))].sort(), [list]);
  const shown = (list ?? []).filter((w) => (status === 'all' || w.status === status)
    && (!q || [w.name, w.slug, w.owner.email ?? '', w.owner.name ?? '', w.billingEmail ?? ''].some((x) => x.toLowerCase().includes(q.toLowerCase()))));
  return (
    <Guard>
      <PlatformNav />
      <PageHeader title="Workspaces" subtitle="Every customer on the platform: plan, status, servers and activity" />
      {error && <div className="mb-4"><Alert>{error}</Alert></div>}
      {!ov || !list ? <div className="space-y-3"><Skeleton className="h-24" /><Skeleton className="h-72" /></div> : (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <Kpi label="Customers" tone="info" value={ov.workspaces} unit={`${ov.signups30d} new in 30 days`} />
            <Kpi label="Paying" tone="ok" value={ov.byStatus.paying} unit={`${ov.byStatus.trial} on trial · ${ov.byStatus.complimentary} complimentary`} />
            <Kpi label="Monthly revenue" tone="ok" value={rand(ov.mrr)} unit="active subscriptions" />
            <Kpi label="Servers" tone={ov.serversDown ? 'warn' : 'ok'} value={ov.servers} unit={`${ov.serversDown} down · ${ov.apps} apps`} className="hidden md:block" />
            <Kpi label="Attention" tone={ov.byStatus.paymentFailed + ov.byStatus.suspended ? 'warn' : 'ok'} value={ov.byStatus.paymentFailed + ov.byStatus.suspended}
                 unit={`${ov.byStatus.paymentFailed} payment failed · ${ov.byStatus.suspended} suspended`} className="hidden md:block" />
          </div>

          <section className="card overflow-hidden p-0">
            <div className="flex flex-wrap items-center gap-3 px-5 py-4">
              <input className="input max-w-xs" placeholder="Search name, owner or email" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search workspaces" />
              <select className="input w-auto" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
                <option value="all">All statuses</option>
                {statuses.map((s) => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}
              </select>
              <span className="ml-auto text-xs text-slate-500">{shown.length} of {list.length}</span>
            </div>
            <div className="overflow-x-auto">
              <table className="tbl min-w-[56rem]">
                <thead><tr>
                  <th>Workspace</th><th className="w-[8%]">Plan</th><th className="w-[13%]">Status</th><th className="w-[9%] text-right">Servers</th>
                  <th className="w-[6%] text-right">Apps</th><th className="w-[8%] text-right">Members</th><th className="w-[12%]">Last activity</th><th className="w-[10%]">Joined</th>
                </tr></thead>
                <tbody>{shown.map((w) => (
                  <tr key={w.id}>
                    <td className="min-w-0">
                      <Link to={`/platform/workspaces/${w.id}`} className="font-medium text-slate-100 hover:text-indigo-300">{w.name}</Link>
                      <div className="truncate text-xs text-slate-500">{w.owner.email ?? w.billingEmail ?? '—'}</div>
                    </td>
                    <td>{PLAN[w.plan] ?? w.plan}</td>
                    <td><Status s={w.status} /></td>
                    <td className="num text-right">{w.servers}{w.serversDown ? <span className="text-rose-300"> ({w.serversDown} down)</span> : null}</td>
                    <td className="num text-right">{w.apps}</td>
                    <td className="num text-right">{w.members}</td>
                    <td className="text-slate-400">{w.lastActivity ? ago(w.lastActivity) : '—'}</td>
                    <td className="text-slate-400">{day(w.createdAt)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
            {!shown.length && <p className="px-5 pb-5 text-sm text-slate-500">No workspaces match.</p>}
          </section>
        </div>
      )}
    </Guard>
  );
}

// ------------------------------------------------------------------ one workspace
export function PlatformWorkspacePage() {
  const id = Number(useParams().id);
  const [d, setD] = useState<PlatformDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [days, setDays] = useState(14);
  const [compPlan, setCompPlan] = useState<'starter' | 'pro'>('pro');
  const [compUntil, setCompUntil] = useState('');
  const [emailFor, setEmailFor] = useState<number | null>(null);
  const [email, setEmail] = useState('');
  const load = () => api.platformWorkspace(id).then(setD).catch((e) => setError(err(e)));
  useEffect(() => { void load(); }, [id]);   // eslint-disable-line react-hooks/exhaustive-deps
  const run = async (key: string, fn: () => Promise<string>) => {
    setBusy(key); setMsg(null);
    try { setMsg({ tone: 'ok', text: await fn() }); await load(); } catch (e) { setMsg({ tone: 'bad', text: err(e) }); } finally { setBusy(null); }
  };
  const w = d?.workspace;
  const own = w?.plan === 'internal';

  return (
    <Guard>
      <PlatformNav />
      <div className="mb-2 text-xs text-slate-500"><Link to="/platform" className="hover:text-slate-300">Workspaces</Link> / <span className="text-slate-400">{w?.name ?? '…'}</span></div>
      {error && <Alert>{error}</Alert>}
      {!d || !w ? (!error && <div className="space-y-3"><Skeleton className="h-12 w-72" /><Skeleton className="h-64" /></div>) : (
        <div className="space-y-5">
          <PageHeader title={w.name} subtitle={<span className="flex flex-wrap items-center gap-x-3"><Status s={w.status} /><span className="text-slate-500">{w.slug} · joined {day(w.createdAt)}</span></span>} />
          {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
          {w.suspendedAt && <Alert tone="bad">Suspended {ago(w.suspendedAt)}: {w.suspendedReason}. The workspace is read-only; its servers and apps keep running.</Alert>}

          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
            <section className="card">
              <h2 className="font-medium text-slate-100">Account</h2>
              <dl className="mt-3 divide-y divide-ink-700 text-sm">
                {([
                  ['Plan', `${PLAN[w.plan] ?? w.plan}${w.complimentary ? ` (complimentary${w.compUntil ? ` until ${day(w.compUntil)}` : ''})` : ''}`],
                  ['Trial ends', w.plan === 'trial' ? day(w.trialEndsAt) : null],
                  ['Renews', w.hasSubscription ? day(w.currentPeriodEnd) : null],
                  ['Owner', w.owner.email ? `${w.owner.name ?? ''} ${w.owner.name ? '·' : ''} ${w.owner.email}` : '—'],
                  ['Billing email', w.billingEmail],
                  ['AWS account', d.aws ? `${d.aws.status}${d.aws.accountId ? ` · ${d.aws.accountId} · ${d.aws.region}` : ''}` : 'not connected'],
                  ['GitHub', d.github ? `${d.github.slug} (${d.github.owner})` : 'not connected'],
                  ['Invoices', d.invoices.count ? `${d.invoices.count} · ${rand(d.invoices.total)} in total` : 'none'],
                ] as [string, string | null][]).filter(([, v]) => v !== null).map(([k, v]) => (
                  <div key={k} className="grid grid-cols-[8rem_minmax(0,1fr)] gap-4 py-2.5"><dt className="text-slate-500">{k}</dt><dd className="truncate text-slate-200">{v}</dd></div>
                ))}
              </dl>
            </section>

            <section className="card space-y-5">
              <h2 className="font-medium text-slate-100">Actions</h2>
              {own ? <p className="text-sm text-slate-500">The platform&rsquo;s own workspace is not billed and can&rsquo;t be suspended.</p> : (<>
                <div className="space-y-2">
                  <div className="text-sm font-medium text-slate-200">{w.suspendedAt ? 'Reactivate' : 'Suspend'}</div>
                  {w.suspendedAt ? (
                    <button className="btn-secondary" disabled={!!busy} onClick={() => void run('reactivate', async () => { await api.platformReactivate(w.id); return `${w.name} is active again.`; })}>Reactivate workspace</button>
                  ) : (<>
                    <p className="text-xs text-slate-500">Read-only for the customer (shown with the reason). Servers and apps keep running.</p>
                    <input className="input" placeholder="Reason shown to the customer" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
                    <button className="btn-danger" disabled={!!busy || reason.trim().length < 5}
                            onClick={() => { if (window.confirm(`Suspend ${w.name}?`)) void run('suspend', async () => { await api.platformSuspend(w.id, reason.trim()); setReason(''); return `${w.name} is suspended.`; }); }}>Suspend workspace</button>
                  </>)}
                </div>
                {w.plan === 'trial' && (
                  <div className="space-y-2 border-t border-ink-700 pt-4">
                    <div className="text-sm font-medium text-slate-200">Extend trial</div>
                    <div className="flex gap-2">
                      <select className="input w-auto" value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Days">
                        {[7, 14, 30, 60].map((n) => <option key={n} value={n}>{n} days</option>)}
                      </select>
                      <button className="btn-secondary" disabled={!!busy} onClick={() => void run('trial', async () => { const r = await api.platformExtendTrial(w.id, days); return `Trial extended to ${day(r.trialEndsAt)}.`; })}>Extend</button>
                    </div>
                  </div>
                )}
                <div className="space-y-2 border-t border-ink-700 pt-4">
                  <div className="text-sm font-medium text-slate-200">Complimentary plan</div>
                  {w.complimentary ? (
                    <button className="btn-secondary" disabled={!!busy}
                            onClick={() => { if (window.confirm('End the complimentary plan? The workspace becomes read-only until a plan is chosen.')) void run('comp-end', async () => { await api.platformComplimentary(w.id, null); return 'Complimentary plan ended.'; }); }}>End complimentary plan</button>
                  ) : (<>
                    <p className="text-xs text-slate-500">A plan without payment; no end date means until it&rsquo;s ended here.</p>
                    <div className="flex flex-wrap gap-2">
                      <select className="input w-auto" value={compPlan} onChange={(e) => setCompPlan(e.target.value as 'starter' | 'pro')} aria-label="Plan">
                        <option value="starter">Starter</option><option value="pro">Pro</option>
                      </select>
                      <input type="date" className="input w-auto" value={compUntil} onChange={(e) => setCompUntil(e.target.value)} aria-label="Until (optional)" />
                      <button className="btn-secondary" disabled={!!busy || w.hasSubscription}
                              title={w.hasSubscription ? 'This workspace pays for a subscription' : undefined}
                              onClick={() => void run('comp', async () => { await api.platformComplimentary(w.id, compPlan, compUntil ? new Date(`${compUntil}T23:59:59`).toISOString() : undefined); return `${PLAN[compPlan]} given${compUntil ? ` until ${day(compUntil)}` : ''}.`; })}>Give plan</button>
                    </div>
                  </>)}
                </div>
              </>)}
            </section>
          </div>

          <section className="card overflow-hidden p-0">
            <h2 className="px-5 py-4 font-medium text-slate-100">Members</h2>
            <table className="tbl">
              <thead><tr><th>Name</th><th>Email</th><th className="w-[10%]">Role</th><th className="w-[14%]">Last sign-in</th><th className="w-[22%] text-right" /></tr></thead>
              <tbody>{d.members.map((m) => (
                <tr key={m.id}>
                  <td className="text-slate-200">{m.name || m.username}<div className="text-xs text-slate-500">@{m.username}</div></td>
                  <td>
                    {emailFor === m.id ? (
                      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void run(`email:${m.id}`, async () => { await api.platformChangeEmail(m.id, email); setEmailFor(null); return `Email changed to ${email}; a confirmation was sent there.`; }); }}>
                        <input className="input py-1 text-xs" type="email" value={email} onChange={(e) => setEmail(e.target.value.trim())} autoFocus aria-label="New email" />
                        <button className="btn-primary px-2.5 py-1 text-xs" disabled={!!busy || !email}>Save</button>
                        <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={() => setEmailFor(null)}>Cancel</button>
                      </form>
                    ) : <span className="text-slate-300">{m.email ?? '—'}{m.email && !m.verified && <span className="ml-2 text-xs text-slate-500">unconfirmed</span>}</span>}
                  </td>
                  <td className="capitalize text-slate-400">{m.role}</td>
                  <td className="text-slate-400">{m.lastLogin ? ago(m.lastLogin) : 'never'}</td>
                  <td className="text-right">{emailFor !== m.id && <button className="btn-ghost px-2 py-1 text-xs" onClick={() => { setEmailFor(m.id); setEmail(m.email ?? ''); }}>Change email</button>}</td>
                </tr>
              ))}</tbody>
            </table>
          </section>

          <section className="card overflow-hidden p-0">
            <h2 className="px-5 py-4 font-medium text-slate-100">Servers and apps</h2>
            {!d.servers.length ? <p className="px-5 pb-5 text-sm text-slate-500">No servers yet.</p> : (
              <table className="tbl">
                <thead><tr><th className="w-[22%]">Server</th><th className="w-[12%]">Region</th><th className="w-[16%]">State</th><th>Apps</th><th className="w-[14%]">Last reachable</th></tr></thead>
                <tbody>{d.servers.map((s) => (
                  <tr key={s.id}>
                    <td className="text-slate-200">{s.name}</td>
                    <td className="num text-slate-400">{s.region}</td>
                    <td title={s.error ?? undefined}><span className="inline-flex items-center gap-2"><span className={`h-2 w-2 rounded-full ${s.state === 'running' && !s.error ? 'bg-emerald-400' : s.state === 'stopped' ? 'bg-rose-400' : 'bg-amber-400'}`} />{s.error && s.state === 'running' ? 'Not responding' : s.state[0].toUpperCase() + s.state.slice(1)}</span></td>
                    <td className="text-slate-300">{s.apps.length ? s.apps.map((a) => <span key={a.project} className="mr-3 inline-flex items-center gap-1.5"><span className={`h-1.5 w-1.5 rounded-full ${a.healthy ? 'bg-emerald-400' : 'bg-rose-400'}`} />{a.project}</span>) : <span className="text-slate-500">none</span>}</td>
                    <td className="text-slate-400">{s.lastOkAt ? ago(s.lastOkAt) : 'never'}</td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </section>

          <section className="card overflow-hidden p-0">
            <h2 className="px-5 py-4 font-medium text-slate-100">Recent activity</h2>
            {!d.activity.length ? <p className="px-5 pb-5 text-sm text-slate-500">Nothing recorded yet.</p> : (
              <table className="tbl">
                <thead><tr><th className="w-[16%]">When</th><th className="w-[20%]">Who</th><th className="w-[22%]">Action</th><th>Target</th></tr></thead>
                <tbody>{d.activity.map((a, i) => (
                  <tr key={i}><td className="text-slate-400" title={a.at}>{ago(a.at)}</td><td className="text-slate-300">{a.username ?? 'system'}</td><td className="num text-slate-300">{a.action}</td><td className="truncate text-slate-400">{a.target ?? ''}</td></tr>
                ))}</tbody>
              </table>
            )}
          </section>
        </div>
      )}
    </Guard>
  );
}

// ------------------------------------------------------------------ cross-customer health
export function PlatformHealthPage() {
  const [h, setH] = useState<PlatformHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.platformHealth().then(setH).catch((e) => setError(err(e))); }, []);
  const ws = (id: number, name: string) => <Link to={`/platform/workspaces/${id}`} className="text-slate-200 hover:text-indigo-300">{name}</Link>;
  const Section = ({ title, empty, children, n }: { title: string; empty: string; children: ReactNode; n: number }) => (
    <section className="card overflow-hidden p-0">
      <h2 className="px-5 py-4 font-medium text-slate-100">{title} <span className="font-normal text-slate-500">({n})</span></h2>
      {n ? children : <p className="px-5 pb-5 text-sm text-slate-500">{empty}</p>}
    </section>
  );
  return (
    <Guard>
      <PlatformNav />
      <PageHeader title="Health" subtitle="Problems across all customers: servers down, failed deploys, failing backups and critical alerts" />
      {error && <Alert>{error}</Alert>}
      {!h ? <Skeleton className="h-72" /> : (
        <div className="space-y-5">
          <Section title="Servers down or not responding" n={h.servers.length} empty="Every server is running and reachable.">
            <table className="tbl"><thead><tr><th>Workspace</th><th>Server</th><th>Region</th><th>State</th><th>Last reachable</th></tr></thead>
              <tbody>{h.servers.map((s) => <tr key={s.id}><td>{ws(s.workspaceId, s.workspace)}</td><td>{s.name}</td><td className="num text-slate-400">{s.region}</td><td title={s.error ?? undefined} className="capitalize">{s.state}</td><td className="text-slate-400">{s.lastOkAt ? ago(s.lastOkAt) : 'never'}</td></tr>)}</tbody></table>
          </Section>
          <Section title="Failed deploys (last 7 days, not fixed since)" n={h.deploys.length} empty="No unresolved failed deploys.">
            <table className="tbl"><thead><tr><th>Workspace</th><th>App</th><th>Server</th><th>Action</th><th>When</th></tr></thead>
              <tbody>{h.deploys.map((d) => <tr key={d.id}><td>{ws(d.workspaceId, d.workspace)}</td><td className="num">{d.project}</td><td>{d.server}</td><td className="capitalize">{d.action}</td><td className="text-slate-400">{d.at ? ago(d.at) : '—'}</td></tr>)}</tbody></table>
          </Section>
          <Section title="Failing backups" n={h.backups.length} empty="Every server's last backup succeeded.">
            <table className="tbl"><thead><tr><th>Workspace</th><th>Server</th><th>Last run</th></tr></thead>
              <tbody>{h.backups.map((b) => <tr key={b.id}><td>{ws(b.workspaceId, b.workspace)}</td><td>{b.name}</td><td className="text-slate-400">{b.at ? ago(b.at) : '—'}</td></tr>)}</tbody></table>
          </Section>
          <Section title="Critical alerts" n={h.alerts.length} empty="No open critical alerts.">
            <table className="tbl"><thead><tr><th>Workspace</th><th>Alert</th><th>Open since</th></tr></thead>
              <tbody>{h.alerts.map((a) => <tr key={a.id}><td>{ws(a.workspaceId, a.workspace)}</td><td>{a.title}</td><td className="text-slate-400">{ago(a.openedAt)}</td></tr>)}</tbody></table>
          </Section>
        </div>
      )}
    </Guard>
  );
}

// ------------------------------------------------------------------ the platform's audit trail
export function PlatformAuditPage() {
  const [rows, setRows] = useState<Awaited<ReturnType<typeof api.platformAudit>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.platformAudit().then(setRows).catch((e) => setError(err(e))); }, []);
  const LABEL: Record<string, string> = {
    'platform.suspend': 'Suspended', 'platform.reactivate': 'Reactivated', 'platform.trial': 'Extended trial', 'platform.complimentary': 'Gave complimentary plan',
    'platform.complimentary_end': 'Ended complimentary plan', 'platform.email': 'Changed sign-in email',
  };
  return (
    <Guard>
      <PlatformNav />
      <PageHeader title="Audit" subtitle="Every action taken on customer accounts from this portal (also recorded in the customer's own audit log)" />
      {error && <Alert>{error}</Alert>}
      {!rows ? <Skeleton className="h-64" /> : (
        <section className="card overflow-hidden p-0">
          {!rows.length ? <p className="p-5 text-sm text-slate-500">No actions yet.</p> : (
            <table className="tbl">
              <thead><tr><th className="w-[16%]">When</th><th className="w-[16%]">Who</th><th className="w-[24%]">Action</th><th>On</th></tr></thead>
              <tbody>{rows.map((r, i) => (
                <tr key={i}>
                  <td className="text-slate-400" title={r.at}>{ago(r.at)}</td><td className="text-slate-300">{r.username}</td>
                  <td className="text-slate-200">{LABEL[r.action] ?? r.action}</td>
                  <td className="text-slate-400">{r.target}{typeof r.detail?.reason === 'string' ? ` · ${r.detail.reason}` : ''}{typeof r.detail?.to === 'string' ? ` · to ${r.detail.to}` : ''}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </section>
      )}
    </Guard>
  );
}
