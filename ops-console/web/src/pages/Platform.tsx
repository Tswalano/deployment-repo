import { ReactNode, useEffect, useState } from 'react';
import { Link, Navigate, NavLink, useParams } from 'react-router-dom';
import { api, ApiError, ConsoleHealth, PlatformDetail, PlatformOverview, PlatformWorkspace, Usage } from '../api';
import { useAuth } from '../auth';
import { useDialog } from '../components/Dialog';
import { ago, Alert, bytes, dur, Kpi, PageHeader, Skeleton } from '../components/ui';
import { Building2, HeartPulse, ScrollText } from 'lucide-react';
import { smallIcon } from '../components/icons';

/** Platform owner portal: the business (customers, subscriptions, payments, credits, limits) and the console's own health. */
const err = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong.');
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const rand = (n: number) => `R${n.toLocaleString('en-ZA', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
const DOT: Record<string, string> = {
  paying: 'bg-emerald-400', complimentary: 'bg-emerald-400', trial: 'bg-sky-400', cancelling: 'bg-amber-400',
  'payment failed': 'bg-rose-400', suspended: 'bg-rose-400', 'trial ended': 'bg-slate-500', ended: 'bg-slate-500', cancelled: 'bg-slate-500', 'no plan': 'bg-slate-500',
};
const Status = ({ s }: { s: string }) => (
  <span className="inline-flex items-center gap-2 capitalize text-slate-300"><span className={`h-2 w-2 rounded-full ${DOT[s] ?? 'bg-slate-500'}`} />{s}</span>
);
const PLAN: Record<string, string> = { trial: 'Trial', starter: 'Starter', pro: 'Pro' };
const usageTone = (u: Usage) => (u.over ? 'text-rose-300' : u.near ? 'text-amber-300' : 'text-slate-400');
const UsageCell = ({ w }: { w: PlatformWorkspace }) => (
  <span className="num text-xs">
    {(['servers', 'apps', 'members'] as const).map((k, i) => (
      <span key={k} className={usageTone(w.usage[k])}>{i ? ' · ' : ''}{w.usage[k].used}/{w.usage[k].max ?? '∞'} {k === 'members' ? 'seats' : k}</span>
    ))}
  </span>
);

function Guard({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  if (!user?.platformAdmin) return <Navigate to="/" replace />;
  return <>{children}</>;
}

function PlatformNav() {
  const item = ({ isActive }: { isActive: boolean }) => `flex items-center gap-1.5 rounded-md px-3 py-1 text-sm ${isActive ? 'bg-ink-800 text-slate-100' : 'text-slate-400 hover:text-slate-200'}`;
  return (
    <nav aria-label="Platform admin" className="mb-4 flex items-center gap-3">
      <span className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">Platform admin</span>
      <div className="flex gap-0.5 rounded-lg border border-ink-700 p-0.5">
        <NavLink end to="/platform" className={item}>{smallIcon(Building2)}Customers</NavLink>
        <NavLink to="/platform/console" className={item}>{smallIcon(HeartPulse)}Console health</NavLink>
        <NavLink to="/platform/audit" className={item}>{smallIcon(ScrollText)}Audit</NavLink>
      </div>
    </nav>
  );
}

// ------------------------------------------------------------------ customers
const FILTERS: [string, string, (w: PlatformWorkspace) => boolean][] = [
  ['all', 'All', () => true],
  ['paying', 'Paying', (w) => w.status === 'paying' || w.status === 'cancelling'],
  ['trial', 'Trial', (w) => w.status === 'trial'],
  ['failed', 'Payment failed', (w) => w.status === 'payment failed'],
  ['near', 'Near limits', (w) => w.nearLimit],
  ['comp', 'Complimentary', (w) => w.status === 'complimentary'],
  ['ended', 'Ended', (w) => ['ended', 'trial ended', 'cancelled', 'no plan'].includes(w.status)],
  ['suspended', 'Suspended', (w) => w.status === 'suspended'],
];

export function Platform() {
  const [ov, setOv] = useState<PlatformOverview | null>(null);
  const [list, setList] = useState<PlatformWorkspace[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all');
  useEffect(() => {
    Promise.all([api.platformOverview(), api.platformWorkspaces()]).then(([o, l]) => { setOv(o); setList(l); }).catch((e) => setError(err(e)));
  }, []);
  const test = FILTERS.find(([id]) => id === filter)![2];
  const shown = (list ?? []).filter((w) => test(w) && (!q || [w.name, w.slug, w.owner.email ?? '', w.owner.name ?? '', w.billingEmail ?? ''].some((x) => x.toLowerCase().includes(q.toLowerCase()))));
  const count = (id: string) => (list ?? []).filter(FILTERS.find(([f]) => f === id)![2]).length;
  return (
    <Guard>
      <PlatformNav />
      <PageHeader title="Customers" subtitle="Subscriptions, payments and usage of every company on the platform" />
      {error && <div className="mb-4"><Alert>{error}</Alert></div>}
      {!ov || !list ? <div className="space-y-3"><Skeleton className="h-24" /><Skeleton className="h-72" /></div> : (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Kpi label="Monthly revenue" tone="ok" value={rand(ov.mrr)} unit={`${ov.byStatus.paying + ov.byStatus.cancelling} paying`} />
            <Kpi label="Customers" tone="info" value={ov.customers} unit={`${ov.signups30d} new in 30 days`} />
            <Kpi label="On trial" tone="info" value={ov.byStatus.trial} unit={`${ov.byPlan.starter} Starter · ${ov.byPlan.pro} Pro`} />
            <Kpi label="Payment failed" tone={ov.byStatus.paymentFailed ? 'bad' : 'ok'} value={ov.byStatus.paymentFailed} unit={ov.amountDue ? `${rand(ov.amountDue)} due` : 'nothing due'} />
            <Kpi label="Near limits" tone={ov.nearLimit ? 'warn' : 'ok'} value={ov.nearLimit} unit="80% or more of a limit" />
            <Kpi label="Credit given" tone="info" value={rand(ov.creditOutstanding)} unit="not yet used" />
          </div>

          <section className="card overflow-hidden p-0">
            <div className="flex flex-wrap items-center gap-3 px-5 py-4">
              <div className="flex flex-wrap gap-0.5 rounded-lg border border-ink-700 p-0.5" role="tablist" aria-label="Filter customers">
                {FILTERS.map(([id, label]) => (
                  <button key={id} role="tab" aria-selected={filter === id} onClick={() => setFilter(id)}
                          className={`rounded-md px-2.5 py-1 text-xs ${filter === id ? 'bg-ink-800 text-slate-100' : 'text-slate-400 hover:text-slate-200'}`}>
                    {label}{id !== 'all' && <span className="num ml-1 text-slate-500">{count(id)}</span>}
                  </button>
                ))}
              </div>
              <input className="input ml-auto max-w-xs" placeholder="Search company, owner or email" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search customers" />
            </div>
            <div className="overflow-x-auto">
              <table className="tbl min-w-[64rem]">
                <thead><tr>
                  <th>Company</th><th className="w-[7%]">Plan</th><th className="w-[13%]">Status</th><th className="w-[8%] text-right">Monthly</th>
                  <th className="w-[12%]">Renews</th><th className="w-[7%] text-right">Credit</th><th className="w-[22%]">Usage</th><th className="w-[9%]">Joined</th>
                </tr></thead>
                <tbody>{shown.map((w) => (
                  <tr key={w.id}>
                    <td className="min-w-0">
                      <Link to={`/platform/workspaces/${w.id}`} className="font-medium text-slate-100 hover:text-indigo-300">{w.name}</Link>
                      <div className="truncate text-xs text-slate-500">{w.owner.email ?? w.billingEmail ?? '—'}</div>
                    </td>
                    <td>{PLAN[w.plan] ?? w.plan}</td>
                    <td><Status s={w.status} />{w.status === 'payment failed' && w.lastChargeError && <div className="truncate text-xs text-rose-300/80" title={w.lastChargeError}>{w.lastChargeError}</div>}</td>
                    <td className="num text-right">{w.monthly ? rand(w.monthly) : '—'}</td>
                    <td className="text-slate-400">
                      {w.status === 'payment failed' ? <span className="text-rose-300">grace to {day(w.graceUntil)}</span>
                        : w.plan === 'trial' ? `trial to ${day(w.trialEndsAt)}` : w.complimentary ? (w.compUntil ? `free to ${day(w.compUntil)}` : 'free') : day(w.currentPeriodEnd)}
                    </td>
                    <td className="num text-right">{w.credit ? rand(w.credit) : '—'}</td>
                    <td><UsageCell w={w} />{w.limitOverrides && <span className="ml-1.5 text-2xs text-indigo-300" title="Custom limits">custom</span>}</td>
                    <td className="text-slate-400">{day(w.createdAt)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
            {!shown.length && <p className="px-5 pb-5 text-sm text-slate-500">{list.length ? 'No companies match.' : 'No customers yet.'}</p>}
          </section>
        </div>
      )}
    </Guard>
  );
}

// ------------------------------------------------------------------ one customer
function Row({ k, v }: { k: string; v: ReactNode }) {
  if (v === null || v === undefined || v === '') return null;
  return <div className="grid grid-cols-[9rem_minmax(0,1fr)] gap-4 py-2.5"><dt className="text-slate-500">{k}</dt><dd className="min-w-0 text-slate-200">{v}</dd></div>;
}
function Action({ title, children, note }: { title: string; children: ReactNode; note?: ReactNode }) {
  return (
    <div className="space-y-2 border-t border-ink-700 pt-4 first:border-0 first:pt-0">
      <div className="text-sm font-medium text-slate-200">{title}</div>
      {note && <p className="text-xs text-slate-500">{note}</p>}
      {children}
    </div>
  );
}

export function PlatformWorkspacePage() {
  const id = Number(useParams().id);
  const dialog = useDialog();
  const [d, setD] = useState<PlatformDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [days, setDays] = useState(30);
  const [credit, setCredit] = useState({ amount: '', note: '' });
  const [lim, setLim] = useState({ servers: '', apps: '', members: '', until: '' });
  const [compPlan, setCompPlan] = useState<'starter' | 'pro'>('pro');
  const [compUntil, setCompUntil] = useState('');
  const load = () => api.platformWorkspace(id).then((r) => {
    setD(r);
    const o = r.workspace.limitOverrides;
    setLim({ servers: o?.servers?.toString() ?? '', apps: o?.apps?.toString() ?? '', members: o?.members?.toString() ?? '', until: o?.until ? o.until.slice(0, 10) : '' });
  }).catch((e) => setError(err(e)));
  useEffect(() => { void load(); }, [id]);   // eslint-disable-line react-hooks/exhaustive-deps
  const run = async (key: string, fn: () => Promise<string>) => {
    setBusy(key); setMsg(null);
    try { setMsg({ tone: 'ok', text: await fn() }); await load(); } catch (e) { setMsg({ tone: 'bad', text: err(e) }); } finally { setBusy(null); }
  };
  const w = d?.workspace;

  return (
    <Guard>
      <PlatformNav />
      <div className="mb-2 text-xs text-slate-500"><Link to="/platform" className="hover:text-slate-300">Customers</Link> / <span className="text-slate-400">{w?.name ?? '…'}</span></div>
      {error && <Alert>{error}</Alert>}
      {!d || !w ? (!error && <div className="space-y-3"><Skeleton className="h-12 w-72" /><Skeleton className="h-64" /></div>) : (
        <div className="space-y-5">
          <PageHeader title={w.name} subtitle={<span className="flex flex-wrap items-center gap-x-3"><Status s={w.status} /><span className="text-slate-500">{w.slug} · joined {day(w.createdAt)}</span></span>} />
          {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
          {w.suspendedAt && <Alert tone="bad">Suspended {ago(w.suspendedAt)}: {w.suspendedReason}. The workspace is read-only; its servers and apps keep running.</Alert>}

          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_24rem]">
            <div className="min-w-0 space-y-5">
              <section className="card">
                <h2 className="font-medium text-slate-100">Subscription</h2>
                <dl className="mt-3 divide-y divide-ink-700 text-sm">
                  <Row k="Plan" v={`${PLAN[w.plan] ?? w.plan}${w.monthly ? `, ${rand(w.monthly)} per month` : ''}${w.complimentary ? ` (complimentary${w.compUntil ? ` until ${day(w.compUntil)}` : ''})` : ''}`} />
                  <Row k={w.plan === 'trial' ? 'Trial ends' : 'Renews'} v={w.plan === 'trial' ? day(w.trialEndsAt) : w.complimentary ? null : day(w.currentPeriodEnd)} />
                  <Row k="Payment" v={w.status === 'payment failed' ? <span className="text-rose-300">Failed{w.lastChargeError ? `: ${w.lastChargeError}` : ''} · grace until {day(w.graceUntil)}</span> : null} />
                  <Row k="Card" v={w.card ?? (w.legacySubscription ? 'Paystack subscription (from before)' : null)} />
                  <Row k="Credit" v={w.credit ? `${rand(w.credit)} (used before the card at renewals)` : null} />
                  <Row k="Billing email" v={w.billingEmail} />
                  <Row k="Owner" v={w.owner.email ? `${w.owner.name ? `${w.owner.name} · ` : ''}${w.owner.email}` : null} />
                  <Row k="AWS" v={w.aws ?? 'not connected'} />
                </dl>
              </section>

              <section className="card overflow-hidden p-0">
                <h2 className="px-5 py-4 font-medium text-slate-100">Usage and limits {w.limitOverrides && <span className="ml-1 text-xs font-normal text-indigo-300">custom limits{w.limitOverrides.until ? ` until ${day(w.limitOverrides.until)}` : ''}</span>}</h2>
                <table className="tbl">
                  <thead><tr><th>Resource</th><th className="text-right">Used</th><th className="text-right">Limit</th><th className="w-[40%]" /></tr></thead>
                  <tbody>{(['servers', 'apps', 'members'] as const).map((k) => {
                    const u = w.usage[k]; const pctUsed = u.max ? Math.min(100, Math.round((u.used / u.max) * 100)) : 0;
                    return (
                      <tr key={k}>
                        <td className="capitalize">{k === 'members' ? 'Team members' : k}</td>
                        <td className={`num text-right ${usageTone(u)}`}>{u.used}</td>
                        <td className="num text-right">{u.max ?? '∞'}</td>
                        <td><div className="h-1.5 rounded-full bg-ink-800"><div className={`h-1.5 rounded-full ${u.over ? 'bg-rose-400' : u.near ? 'bg-amber-400' : 'bg-emerald-400'}`} style={{ width: `${pctUsed}%` }} /></div></td>
                      </tr>
                    );
                  })}</tbody>
                </table>
              </section>

              <section className="card overflow-hidden p-0">
                <h2 className="px-5 py-4 font-medium text-slate-100">Members</h2>
                <table className="tbl">
                  <thead><tr><th>Name</th><th>Email</th><th className="w-[12%]">Role</th><th className="w-[16%]">Last sign-in</th><th className="w-[18%] text-right" /></tr></thead>
                  <tbody>{d.members.map((m) => (
                    <tr key={m.id}>
                      <td className="text-slate-200">{m.name || m.username}<div className="text-xs text-slate-500">@{m.username}</div></td>
                      <td className="text-slate-300">{m.email ?? '—'}{m.email && !m.verified && <span className="ml-2 text-xs text-slate-500">unconfirmed</span>}</td>
                      <td className="capitalize text-slate-400">{m.role}</td>
                      <td className="text-slate-400">{m.lastLogin ? ago(m.lastLogin) : 'never'}</td>
                      <td className="text-right"><button className="btn-ghost px-2 py-1 text-xs" disabled={!!busy} onClick={async () => {
                        const email = await dialog.prompt({ title: `Change the sign-in email of ${m.name || m.username}`, body: 'They confirm the new address by email; their username keeps working.',
                          label: 'New email', type: 'email', defaultValue: m.email ?? '', confirmLabel: 'Change email' });
                        if (email) void run(`email:${m.id}`, async () => { await api.platformChangeEmail(m.id, email); return `Email changed to ${email}; a confirmation was sent there.`; });
                      }}>Change email</button></td>
                    </tr>
                  ))}</tbody>
                </table>
              </section>

              <section className="card overflow-hidden p-0">
                <h2 className="px-5 py-4 font-medium text-slate-100">Invoices and credit</h2>
                {!d.invoices.length && !d.credits.length ? <p className="px-5 pb-5 text-sm text-slate-500">No payments or credit yet.</p> : (
                  <table className="tbl">
                    <thead><tr><th className="w-[16%]">Date</th><th>What</th><th className="w-[14%] text-right">Paid</th><th className="w-[14%] text-right">Credit</th></tr></thead>
                    <tbody>
                      {[...d.invoices.map((i) => ({ at: i.issuedAt, what: `${i.number} · ${PLAN[i.plan] ?? i.plan}, ${day(i.periodStart)} – ${day(i.periodEnd)}`, paid: i.amount, credit: i.credit ? -i.credit : 0 })),
                        ...d.credits.filter((c) => c.kind !== 'renewal').map((c) => ({ at: c.at, what: `${({ grant: 'Credit given', adjust: 'Credit taken back', proration: 'Unused time from a plan change', card_check: 'Card check' } as Record<string, string>)[c.kind] ?? c.kind}${c.note ? ` · ${c.note}` : ''} (${c.by})`, paid: 0, credit: c.amount }))]
                        .sort((a, b) => b.at.localeCompare(a.at)).map((r, n) => (
                          <tr key={n}><td className="text-slate-400">{day(r.at)}</td><td className="truncate text-slate-300" title={r.what}>{r.what}</td>
                            <td className="num text-right">{r.paid ? rand(r.paid) : '—'}</td>
                            <td className={`num text-right ${r.credit > 0 ? 'text-emerald-300' : 'text-slate-400'}`}>{r.credit ? `${r.credit > 0 ? '+' : '−'}${rand(Math.abs(r.credit))}` : '—'}</td></tr>
                        ))}
                    </tbody>
                  </table>
                )}
              </section>
            </div>

            <section className="card h-fit space-y-4">
              <h2 className="font-medium text-slate-100">Actions</h2>
              {w.status === 'payment failed' && (
                <Action title="Retry the payment" note="Charges the card on file now (credit first), e.g. after the customer fixed their card.">
                  <button className="btn-primary" disabled={!!busy} onClick={() => void run('retry', async () => {
                    const r = await api.platformRetry(w.id);
                    return r.result === 'renewed' ? 'Paid: the subscription is active again.' : r.result === 'pending' ? 'The charge is still in progress at Paystack.' : 'The card was declined again.';
                  })}>Retry now</button>
                </Action>
              )}
              {!w.complimentary && (
                <Action title={w.plan === 'trial' ? 'Extend the trial' : 'Extend the subscription'} note={w.plan === 'trial' ? undefined : 'Free time: the next renewal moves out. A failed payment is forgiven.'}>
                  <div className="flex gap-2">
                    <select className="input w-auto" value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Days">
                      {[7, 14, 30, 60, 90].map((n) => <option key={n} value={n}>{n} days</option>)}
                    </select>
                    <button className="btn-secondary" disabled={!!busy} onClick={() => void run('extend', async () => { const r = await api.platformExtend(w.id, days); return `Extended to ${day(r.result)}.`; })}>Extend</button>
                  </div>
                </Action>
              )}
              <Action title="Give credit" note="Used before the card at the next renewals. A negative amount takes credit back.">
                <div className="flex gap-2">
                  <input className="input w-28" inputMode="decimal" placeholder="R amount" value={credit.amount} onChange={(e) => setCredit({ ...credit, amount: e.target.value })} aria-label="Amount in Rand" />
                  <input className="input min-w-0 flex-1" placeholder="Reason" value={credit.note} onChange={(e) => setCredit({ ...credit, note: e.target.value })} aria-label="Reason" />
                </div>
                <button className="btn-secondary" disabled={!!busy || !Number(credit.amount) || credit.note.trim().length < 3}
                        onClick={() => void run('credit', async () => { const a = Number(credit.amount); await api.platformCredit(w.id, a, credit.note.trim()); setCredit({ amount: '', note: '' }); return `${a > 0 ? 'Gave' : 'Took back'} ${rand(Math.abs(a))} credit.`; })}>Apply</button>
              </Action>
              <Action title="Custom limits" note="Raise this company above its plan (never lowers it). Empty keeps the plan's limit.">
                <div className="grid grid-cols-3 gap-2">
                  {(['servers', 'apps', 'members'] as const).map((k) => (
                    <label key={k} className="text-xs text-slate-500">{k === 'members' ? 'Seats' : k[0].toUpperCase() + k.slice(1)}
                      <input className="input mt-1" inputMode="numeric" placeholder={String(w.usage[k].max ?? '')} value={lim[k]} onChange={(e) => setLim({ ...lim, [k]: e.target.value.replace(/\D/g, '') })} />
                    </label>
                  ))}
                </div>
                <label className="block text-xs text-slate-500">Until (optional)<input type="date" className="input mt-1" value={lim.until} onChange={(e) => setLim({ ...lim, until: e.target.value })} /></label>
                <div className="flex gap-2">
                  <button className="btn-secondary" disabled={!!busy || (!lim.servers && !lim.apps && !lim.members)} onClick={() => void run('limits', async () => {
                    await api.platformLimits(w.id, { servers: lim.servers ? Number(lim.servers) : undefined, apps: lim.apps ? Number(lim.apps) : undefined, members: lim.members ? Number(lim.members) : undefined, until: lim.until ? new Date(`${lim.until}T23:59:59`).toISOString() : null });
                    return 'Custom limits saved.';
                  })}>Save limits</button>
                  {w.limitOverrides && <button className="btn-ghost" disabled={!!busy} onClick={() => void run('limits-clear', async () => { await api.platformLimits(w.id, { clear: true }); return "Back to the plan's limits."; })}>Back to plan limits</button>}
                </div>
              </Action>
              <Action title="Complimentary plan" note={w.complimentary ? undefined : 'A plan without payment (for companies that pay already, give credit instead).'}>
                {w.complimentary ? (
                  <button className="btn-secondary" disabled={!!busy} onClick={async () => {
                    if (await dialog.confirm({ title: 'End the complimentary plan?', body: 'The workspace becomes read-only until a plan is chosen.', confirmLabel: 'End plan', danger: true }))
                      void run('comp-end', async () => { await api.platformComplimentary(w.id, null); return 'Complimentary plan ended.'; });
                  }}>End complimentary plan</button>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    <select className="input w-auto" value={compPlan} onChange={(e) => setCompPlan(e.target.value as 'starter' | 'pro')} aria-label="Plan">
                      <option value="starter">Starter</option><option value="pro">Pro</option>
                    </select>
                    <input type="date" className="input w-auto" value={compUntil} onChange={(e) => setCompUntil(e.target.value)} aria-label="Until (optional)" />
                    <button className="btn-secondary" disabled={!!busy || w.monthly > 0}
                            onClick={() => void run('comp', async () => { await api.platformComplimentary(w.id, compPlan, compUntil ? new Date(`${compUntil}T23:59:59`).toISOString() : undefined); return `${PLAN[compPlan]} given${compUntil ? ` until ${day(compUntil)}` : ''}.`; })}>Give plan</button>
                  </div>
                )}
              </Action>
              <Action title={w.suspendedAt ? 'Reactivate' : 'Suspend'} note={w.suspendedAt ? undefined : 'Read-only for the customer, with the reason shown. Servers and apps keep running.'}>
                {w.suspendedAt ? (
                  <button className="btn-secondary" disabled={!!busy} onClick={() => void run('reactivate', async () => { await api.platformReactivate(w.id); return `${w.name} is active again.`; })}>Reactivate</button>
                ) : (
                  <button className="btn-danger" disabled={!!busy} onClick={async () => {
                    const reason = await dialog.prompt({ title: `Suspend ${w.name}?`, body: 'The workspace becomes read-only and its members see the reason. Servers and apps keep running.',
                      label: 'Reason shown to the customer', minLength: 5, maxLength: 200, confirmLabel: 'Suspend', danger: true });
                    if (reason) void run('suspend', async () => { await api.platformSuspend(w.id, reason); return `${w.name} is suspended.`; });
                  }}>Suspend</button>
                )}
              </Action>
            </section>
          </div>
        </div>
      )}
    </Guard>
  );
}

// ------------------------------------------------------------------ the console's own health
export function PlatformConsolePage() {
  const [h, setH] = useState<ConsoleHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => { setBusy(true); api.platformConsole().then((r) => { setH(r); setError(null); }).catch((e) => setError(err(e))).finally(() => setBusy(false)); };
  useEffect(() => { load(); const t = setInterval(load, 60_000); return () => clearInterval(t); }, []);
  const pct = (a: number, b: number) => Math.round((a / b) * 100);
  const dbOk = h && !('error' in h.database) ? h.database : null;
  return (
    <Guard>
      <PlatformNav />
      <PageHeader title="Console health" subtitle="The server the console runs on, its database and its background jobs"
                  actions={<button className="btn-secondary" disabled={busy} onClick={load}>{busy ? 'Checking…' : 'Check now'}</button>} />
      {error && <div className="mb-4"><Alert>{error}</Alert></div>}
      {!h ? <Skeleton className="h-72" /> : (
        <div className="space-y-5">
          <section className={`rounded-xl border px-5 py-4 ${h.concerns.some((c) => c.level === 'bad') ? 'border-rose-500/40' : h.concerns.length ? 'border-amber-500/40' : 'border-ink-700'}`}>
            {!h.concerns.length ? (
              <p className="flex items-center gap-2 text-sm text-slate-200"><span className="h-2 w-2 rounded-full bg-emerald-400" />Nothing needs attention. Checked {ago(h.checkedAt)}.</p>
            ) : (
              <ul className="space-y-1.5 text-sm">{h.concerns.map((c, i) => (
                <li key={i} className="flex items-start gap-2 text-slate-200"><span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${c.level === 'bad' ? 'bg-rose-400' : 'bg-amber-400'}`} />{c.text}</li>
              ))}</ul>
            )}
          </section>

          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Kpi label="CPU load" tone={h.host.load[1] > h.host.cpus ? 'warn' : 'ok'} value={h.host.load[0]} unit={`${h.host.cpus} CPU · 5 min ${h.host.load[1]}`} />
            <Kpi label="Memory" tone={pct(h.host.mem.total - h.host.mem.available, h.host.mem.total) > 85 ? 'warn' : 'ok'} value={`${pct(h.host.mem.total - h.host.mem.available, h.host.mem.total)}%`} unit={`${bytes(h.host.mem.available)} available`} />
            <Kpi label="Disk" tone={h.host.disk && pct(h.host.disk.total - h.host.disk.free, h.host.disk.total) > 80 ? 'warn' : 'ok'} value={h.host.disk ? `${pct(h.host.disk.total - h.host.disk.free, h.host.disk.total)}%` : '—'} unit={h.host.disk ? `${bytes(h.host.disk.free)} free` : undefined} />
            <Kpi label="Server up" tone="info" value={dur(h.host.uptimeSeconds)} unit={`console ${dur(h.process.uptimeSeconds)}`} />
            <Kpi label="Requests (15 min)" tone={h.requests.last15m.errorRate > 2 ? 'bad' : 'ok'} value={h.requests.last15m.requests} unit={`${h.requests.last15m.errorRate}% errors`} />
            <Kpi label="Response time" tone={(h.requests.last15m.p95 ?? 0) > 2000 ? 'warn' : 'ok'} value={h.requests.last15m.p50 != null ? `${h.requests.last15m.p50} ms` : '—'} unit={h.requests.last15m.p95 != null ? `95% within ${h.requests.last15m.p95} ms` : 'no requests yet'} />
            <Kpi label="Database" tone="info" value={dbOk ? bytes(dbOk.size) : '—'} unit={dbOk ? `${dbOk.connections} connections` : 'unavailable'} />
            <Kpi label="Console process" tone={h.process.eventLoopP99Ms > 200 ? 'warn' : 'ok'} value={bytes(h.process.rss)} unit={`Node ${h.process.node} · delay ${h.process.eventLoopP99Ms} ms`} />
          </div>

          <section className="card overflow-hidden p-0">
            <h2 className="px-5 py-4 font-medium text-slate-100">Background jobs</h2>
            {!h.jobs.length ? <p className="px-5 pb-5 text-sm text-slate-500">No runs recorded since the console started {dur(h.process.uptimeSeconds)} ago.</p> : (
              <table className="tbl">
                <thead><tr><th>Job</th><th className="w-[16%]">Runs every</th><th className="w-[18%]">Last run</th><th className="w-[30%]">Status</th></tr></thead>
                <tbody>{h.jobs.map((j) => (
                  <tr key={j.name}>
                    <td className="text-slate-200">{j.name}</td><td className="text-slate-400">{dur(j.everySeconds)}</td><td className="text-slate-400">{ago(j.lastRun)}</td>
                    <td><span className="inline-flex items-center gap-2" title={j.error ?? undefined}><span className={`h-2 w-2 rounded-full ${j.late ? 'bg-rose-400' : j.ok ? 'bg-emerald-400' : 'bg-amber-400'}`} />{j.late ? 'Late' : j.ok ? 'OK' : `Failed: ${j.error}`}</span></td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </section>

          <section className="card overflow-hidden p-0">
            <h2 className="px-5 py-4 font-medium text-slate-100">Recent emails</h2>
            {!h.emails.length ? <p className="px-5 pb-5 text-sm text-slate-500">No emails recorded yet.</p> : (
              <table className="tbl">
                <thead><tr><th className="w-[13%]">When</th><th className="w-[13%]">Kind</th><th className="w-[24%]">To</th><th>Subject</th><th className="w-[22%]">Result</th></tr></thead>
                <tbody>{h.emails.map((e, i) => (
                  <tr key={i}>
                    <td className="text-slate-400" title={e.at}>{ago(e.at)}</td>
                    <td className="text-slate-300">{({ verify_email: 'Confirm email', reset_password: 'Password reset', invite: 'Invitation', alert: 'Alert', test: 'Test' } as Record<string, string>)[e.kind] ?? e.kind}</td>
                    <td className="truncate text-slate-300" title={e.recipients}>{e.recipients}</td>
                    <td className="truncate text-slate-400" title={e.subject}>{e.subject}</td>
                    <td title={e.error ?? undefined}><span className="inline-flex min-w-0 items-center gap-2"><span className={`h-2 w-2 shrink-0 rounded-full ${e.ok ? 'bg-emerald-400' : 'bg-rose-400'}`} /><span className="truncate">{e.ok ? 'Sent' : `Failed: ${e.error}`}</span></span></td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </section>

          <section className="card">
            <h2 className="font-medium text-slate-100">Data and email</h2>
            <dl className="mt-3 divide-y divide-ink-700 text-sm">
              {([
                ['Console database backup', h.backups ? `${h.backups.consoleDb?.ok ? 'in' : 'NOT in'} the last nightly backup (${ago(h.backups.at)})` : 'no backup status on this server'],
                ['Off-site copies', h.backups?.offsite ? (h.backups.offsite.configured ? (h.backups.offsite.ok ? `copied ${ago(h.backups.offsite.at)}` : `failing: ${h.backups.offsite.error}`) : 'off') : '—'],
                ['Email (24 hours)', dbOk ? `${dbOk.emailsSent24h} sent · ${dbOk.emailFailures24h ? `${dbOk.emailFailures24h} failed` : 'none failed'}` : '—'],
                ['HTTPS certificate', h.certificateDaysLeft != null ? `${h.certificateDaysLeft} days left` : '—'],
              ] as [string, string][]).map(([k, v]) => (
                <div key={k} className="grid grid-cols-[12rem_minmax(0,1fr)] gap-4 py-2.5"><dt className="text-slate-500">{k}</dt><dd className="text-slate-200">{v}</dd></div>
              ))}
            </dl>
          </section>
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
    'platform.suspend': 'Suspended', 'platform.reactivate': 'Reactivated', 'platform.extend': 'Extended', 'platform.credit': 'Credit',
    'platform.limits': 'Set custom limits', 'platform.limits_clear': 'Back to plan limits', 'platform.retry': 'Retried a payment',
    'platform.complimentary': 'Gave complimentary plan', 'platform.complimentary_end': 'Ended complimentary plan', 'platform.email': 'Changed sign-in email',
  };
  const detail = (d: Record<string, unknown>) => [
    typeof d.reason === 'string' ? d.reason : null, typeof d.days === 'number' ? `${d.days} days` : null,
    typeof d.amount === 'number' ? rand(d.amount) : null, typeof d.note === 'string' ? d.note : null, typeof d.to === 'string' ? `to ${d.to}` : null,
    typeof d.plan === 'string' ? PLAN[d.plan] : null, typeof d.result === 'string' ? d.result : null,
  ].filter(Boolean).join(' · ');
  return (
    <Guard>
      <PlatformNav />
      <PageHeader title="Audit" subtitle="Every action taken on customer accounts from this portal (also recorded in the customer's own audit log)" />
      {error && <Alert>{error}</Alert>}
      {!rows ? <Skeleton className="h-64" /> : (
        <section className="card overflow-hidden p-0">
          {!rows.length ? <p className="p-5 text-sm text-slate-500">No actions yet.</p> : (
            <table className="tbl">
              <thead><tr><th className="w-[14%]">When</th><th className="w-[14%]">Who</th><th className="w-[20%]">Action</th><th className="w-[20%]">Company</th><th>Detail</th></tr></thead>
              <tbody>{rows.map((r, i) => (
                <tr key={i}>
                  <td className="text-slate-400" title={r.at}>{ago(r.at)}</td><td className="text-slate-300">{r.username}</td>
                  <td className="text-slate-200">{LABEL[r.action] ?? r.action}</td><td className="text-slate-300">{r.target}</td>
                  <td className="truncate text-slate-400">{detail(r.detail ?? {})}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </section>
      )}
    </Guard>
  );
}
