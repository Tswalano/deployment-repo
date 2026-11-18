import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, ApiError, BillingView, Invoice } from '../api';
import { useAuth } from '../auth';
import { Alert, PageHeader, Skeleton } from '../components/ui';
import { useDialog } from '../components/Dialog';

const err = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong.');
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : '—');
function Usage({ label, used, max }: { label: string; used: number; max: number | null }) {
  const pct = max ? Math.min(100, (used / max) * 100) : 0;
  return (
    <div>
      <div className="flex items-baseline justify-between text-sm"><span className="text-slate-400">{label}</span><span className="num text-slate-200">{used}{max != null ? ` / ${max}` : ''}</span></div>
      {max != null && <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-ink-700"><div className={`h-full rounded-full ${used >= max ? 'bg-amber-400' : 'bg-indigo-500'}`} style={{ width: `${pct}%` }} /></div>}
    </div>
  );
}

/** Plan, usage, upgrade (Paystack checkout), card and cancellation. */
export function Billing() {
  const { user } = useAuth();
  const dialog = useDialog();
  const isAdmin = user?.role === 'admin' && !user.isDemo;
  const [b, setB] = useState<BillingView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad' | 'warn'; text: string } | null>(null);
  const load = useCallback(() => api.billing().then(setB).catch((e) => setMsg({ tone: 'bad', text: err(e) })), []);
  useEffect(() => { void load(); }, [load]);
  if (!b) return msg ? <Alert>{msg.text}</Alert> : <Skeleton className="h-72" />;

  const trialLeft = b.plan === 'trial' && b.trialEndsAt ? Math.max(0, Math.ceil((Date.parse(b.trialEndsAt) - Date.now()) / 86400e3)) : null;
  const subscribed = (b.plan === 'starter' || b.plan === 'pro') && ['active', 'past_due', 'cancelling'].includes(b.status);
  const planName = (id: string) => `${id[0].toUpperCase()}${id.slice(1)}`;
  const price = (id: string) => b.plans.find((p) => p.id === id)?.price ?? '';
  const other = subscribed ? b.plans.find((p) => p.id !== b.plan) : undefined;
  const [statusText, tone] = b.plan === 'internal' ? ['Not billed', 'bg-slate-500']
    : b.suspended ? ['Suspended by the platform; contact support', 'bg-rose-400']
    : b.complimentary && b.active ? [`Complimentary, provided by the platform${b.compUntil ? ` until ${day(b.compUntil)}` : ''}`, 'bg-emerald-400']
    : b.plan === 'trial' ? (b.active ? [`Trial, ${trialLeft} day${trialLeft === 1 ? '' : 's'} left; no card needed until a plan is chosen`, 'bg-indigo-400'] : ['Trial ended', 'bg-rose-400'])
    : b.status === 'active' ? ['Active', 'bg-emerald-400']
    : b.status === 'past_due' ? [`Payment failed; update the card before ${day(b.graceUntil)}`, 'bg-rose-400']
    : b.status === 'cancelling' ? [`Cancelled; active until ${day(b.currentPeriodEnd)}`, 'bg-amber-400']
    : ['Ended', 'bg-slate-500'];
  const go = async (key: string, fn: () => Promise<void>) => { setBusy(key); setMsg(null); try { await fn(); } catch (e) { setMsg({ tone: 'bad', text: err(e) }); setBusy(null); } };

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="Billing" subtitle="Plan, usage and invoices. AWS servers are billed by AWS, separately." />
      {msg && <div className="mb-4"><Alert tone={msg.tone}>{msg.text}</Alert></div>}
      {!b.active && <div className="mb-4"><Alert>{b.reason} Servers and apps keep running; only changes through the console are paused.</Alert></div>}
      {!b.enabled && b.plan !== 'internal' && <div className="mb-4"><Alert tone="warn">Payments aren't set up on this platform yet.</Alert></div>}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <section className="card">
          <h2 className="font-medium text-slate-100">Subscription</h2>
          <dl className="mt-4 divide-y divide-ink-700 text-sm">
            <div className="grid grid-cols-[9rem_minmax(0,1fr)] gap-4 py-3">
              <dt className="text-slate-500">Plan</dt>
              <dd className="text-slate-100">{b.plan === 'internal' ? 'Platform workspace (not billed)' : b.plan === 'trial' ? 'Free trial (Pro features)' : `${planName(b.plan)}, R${price(b.plan)} per month`}</dd>
            </div>
            <div className="grid grid-cols-[9rem_minmax(0,1fr)] gap-4 py-3">
              <dt className="text-slate-500">Status</dt>
              <dd className="flex items-center gap-2 text-slate-200"><span className={`h-1.5 w-1.5 rounded-full ${tone}`} />{statusText}</dd>
            </div>
            {subscribed && !b.complimentary && b.status === 'active' && (
              <div className="grid grid-cols-[9rem_minmax(0,1fr)] gap-4 py-3"><dt className="text-slate-500">Next renewal</dt><dd className="text-slate-200">{day(b.currentPeriodEnd)}</dd></div>
            )}
            {b.status === 'past_due' && b.lastChargeError && (
              <div className="grid grid-cols-[9rem_minmax(0,1fr)] gap-4 py-3"><dt className="text-slate-500">Last payment</dt><dd className="text-rose-300">{b.lastChargeError}</dd></div>
            )}
            {b.card && (
              <div className="grid grid-cols-[9rem_minmax(0,1fr)] gap-4 py-3"><dt className="text-slate-500">Card</dt><dd className="text-slate-200">{b.card}</dd></div>
            )}
            {!!b.credit && b.credit > 0 && (
              <div className="grid grid-cols-[9rem_minmax(0,1fr)] gap-4 py-3"><dt className="text-slate-500">Credit</dt><dd className="text-slate-200">R{b.credit.toFixed(2)} <span className="text-slate-500">· used before the card at the next renewal</span></dd></div>
            )}
            {b.billingEmail && (
              <div className="grid grid-cols-[9rem_minmax(0,1fr)] gap-4 py-3"><dt className="text-slate-500">Billing email</dt><dd className="truncate text-slate-200">{b.billingEmail}</dd></div>
            )}
          </dl>
          {isAdmin && subscribed && !b.complimentary && (
            <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-ink-700 pt-5">
              {other && b.status === 'active' && (
                <button className="btn-primary" disabled={!!busy} onClick={async () => {
                  if (await dialog.confirm({ title: `Switch to ${planName(other.id)}?`, body: b.card && !b.legacySubscription
                    ? `R${other.price} per month, starting today. Unused time on the current plan is credited, and the rest is charged to ${b.card}.`
                    : `R${other.price} per month, starting today through Paystack checkout. The current subscription stops renewing.`, confirmLabel: `Switch to ${planName(other.id)}` })) void go(other.id, async () => { window.location.assign((await api.billingCheckout(other.id)).url); });
                }}>{busy === other.id ? 'Opening Paystack…' : `Switch to ${planName(other.id)}`}</button>
              )}
              {(b.hasSubscription || b.status === 'past_due') && <button className={b.status === 'past_due' ? 'btn-primary' : 'btn-secondary'} disabled={!!busy}
                      title={b.card && !b.legacySubscription ? 'A R5 card check on Paystack, kept as credit' : undefined}
                      onClick={() => go('card', async () => { window.location.assign((await api.billingManage()).url); })}>{b.card || b.legacySubscription ? 'Update card' : 'Add a card'}</button>}
              {b.status === 'cancelling' && !b.legacySubscription && <button className="btn-secondary" disabled={!!busy}
                      onClick={() => go('resume', async () => { await api.billingResume(); await load(); setBusy(null); setMsg({ tone: 'ok', text: 'The subscription continues; it renews as usual.' }); })}>Resume subscription</button>}
              {b.status === 'active' && <button className="btn-ghost ml-auto" disabled={!!busy} onClick={async () => {
                if (await dialog.confirm({ title: 'Cancel the subscription?', body: 'Everything keeps working until the end of the paid period.', confirmLabel: 'Cancel subscription', cancelLabel: 'Keep it', danger: true })) void go('cancel', async () => { await api.billingCancel(); await load(); setBusy(null); setMsg({ tone: 'ok', text: 'The subscription ends at the end of the current period.' }); });
              }}>Cancel subscription</button>}
            </div>
          )}
        </section>
        <section className="card space-y-4">
          <h2 className="font-medium text-slate-100">Usage</h2>
          <Usage label="Servers" used={b.usage.servers} max={b.limits.servers} />
          <Usage label="Apps" used={b.usage.apps} max={b.limits.apps} />
          <Usage label="Team members" used={b.usage.members} max={b.limits.members} />
          <p className="text-xs text-slate-500">Deploy approvals: {b.limits.approvals ? 'included' : 'Pro only'}</p>
        </section>
      </div>

      {b.plan !== 'internal' && !subscribed && (
        <section className="mt-6 grid gap-4 sm:grid-cols-2">
          {b.plans.map((p) => (
            <div key={p.id} className={`card flex flex-col ${p.id === 'pro' ? 'border-indigo-400/40' : ''}`}>
              <h3 className="font-medium text-slate-100">{p.name}</h3>
              <p className="mt-3"><span className="num text-3xl font-semibold text-slate-100">R{p.price}</span><span className="text-sm text-slate-500"> per month</span></p>
              <ul className="mt-4 flex-1 space-y-1.5 text-sm text-slate-300">
                <li>{p.limits.servers} server{p.limits.servers === 1 ? '' : 's'}</li><li>{p.limits.apps} apps</li><li>{p.limits.members} team members</li>
                <li>{p.limits.approvals ? 'Deploy approvals and freeze windows' : 'Everything except deploy approvals'}</li>
              </ul>
              {isAdmin && b.enabled && (
                <button className={`${p.id === 'pro' ? 'btn-primary' : 'btn-secondary'} mt-5`} disabled={!!busy}
                        onClick={() => go(p.id, async () => { window.location.assign((await api.billingCheckout(p.id)).url); })}>
                  {busy === p.id ? 'Opening Paystack…' : `Choose ${p.name}`}
                </button>
              )}
            </div>
          ))}
        </section>
      )}
      {b.plan !== 'internal' && isAdmin && <Invoices />}
      <p className="mt-4 text-xs text-slate-500">Payments are processed by Paystack. Prices in South African Rand, billed monthly.</p>
    </div>
  );
}

/** Every invoice, with a PDF each, and the last 6 months as one PDF or a CSV. */
function Invoices() {
  const [list, setList] = useState<Invoice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.invoices().then(setList).catch((e) => setError(err(e))); }, []);
  const recent = (list ?? []).filter((i) => Date.parse(i.issuedAt) > Date.now() - 183 * 86400e3).length;
  return (
    <section className="card mt-6 overflow-hidden p-0">
      <div className="flex flex-wrap items-center gap-3 px-5 py-4">
        <div className="min-w-0 flex-1">
          <h2 className="font-medium text-slate-100">Invoices</h2>
          <p className="mt-0.5 text-sm text-slate-500">One for every payment, generated from Paystack's confirmed payments.</p>
        </div>
        {recent > 0 && (
          <div className="flex gap-2">
            <a className="btn-secondary px-3 py-1.5 text-xs" href="/api/billing/invoices/export?months=6" download>Download last 6 months (PDF)</a>
            <a className="btn-ghost px-3 py-1.5 text-xs" href="/api/billing/invoices/export?months=6&format=csv" download>CSV</a>
          </div>
        )}
      </div>
      {error ? <div className="px-5 pb-5"><Alert>{error}</Alert></div> : !list ? <div className="px-5 pb-5"><Skeleton className="h-16" /></div> : list.length === 0 ? (
        <p className="px-5 pb-5 text-sm text-slate-500">No invoices yet. Invoices appear here after each payment.</p>
      ) : (
        <table className="tbl">
          <thead><tr><th className="w-[16%]">Date</th><th className="w-[18%]">Invoice</th><th>Description</th><th className="w-[14%] text-right">Amount</th><th className="w-[10%]">Status</th><th className="w-[10%] text-right"></th></tr></thead>
          <tbody>{list.map((i) => (
            <tr key={i.id}>
              <td>{day(i.issuedAt)}</td>
              <td className="num text-xs">{i.number}</td>
              <td className="text-slate-400" title={i.card ?? ''}>{i.description}</td>
              <td className="num text-right">R{i.amount.toFixed(2)}{!!i.creditApplied && <div className="text-2xs text-slate-500">+ R{i.creditApplied.toFixed(2)} credit</div>}</td>
              <td className="capitalize text-slate-400">{i.status}</td>
              <td className="text-right"><a className="text-xs text-slate-300 underline-offset-2 hover:underline" href={`/api/billing/invoices/${i.id}/pdf`} download>PDF</a></td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </section>
  );
}

/** Paystack sends people back here: confirm the payment with Paystack (server-side) and show the result. */
export function BillingReturn() {
  const [q] = useSearchParams();
  const { refresh } = useAuth();
  const [state, setState] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  useEffect(() => {
    const ref = q.get('reference') ?? q.get('trxref') ?? '';
    api.billingConfirm(ref).then(async (r) => { await refresh(); setState({ tone: 'ok', text: `Done. Plan: ${r.plan[0].toUpperCase()}${r.plan.slice(1)}${r.status === 'active' ? ', active' : ''}.` }); })
      .catch((e) => setState({ tone: 'bad', text: err(e) }));
  }, [q, refresh]);
  return (
    <div className="mx-auto max-w-lg py-10">
      {state ? <Alert tone={state.tone}>{state.text}</Alert> : <p className="text-sm text-slate-400">Confirming the payment with Paystack…</p>}
      <Link to="/billing" className="btn-secondary mt-4">Back to Billing</Link>
    </div>
  );
}
