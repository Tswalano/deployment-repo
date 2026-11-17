import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, ApiError, BillingView } from '../api';
import { useAuth } from '../auth';
import { Alert, PageHeader, Skeleton } from '../components/ui';

const err = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong.');
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : '—');
const STATUS: Record<string, [string, string]> = {
  trialing: ['Free trial', 'pill-info'], active: ['Active', 'pill-ok'], past_due: ['Payment failed', 'pill-bad'],
  cancelling: ['Cancels at period end', 'pill-warn'], cancelled: ['Cancelled', 'pill-mute'], expired: ['Ended', 'pill-mute'],
};

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
  const isAdmin = user?.role === 'admin' && !user.isDemo;
  const [b, setB] = useState<BillingView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad' | 'warn'; text: string } | null>(null);
  const load = useCallback(() => api.billing().then(setB).catch((e) => setMsg({ tone: 'bad', text: err(e) })), []);
  useEffect(() => { void load(); }, [load]);
  if (!b) return msg ? <Alert>{msg.text}</Alert> : <Skeleton className="h-72" />;

  const trialLeft = b.plan === 'trial' && b.trialEndsAt ? Math.max(0, Math.ceil((Date.parse(b.trialEndsAt) - Date.now()) / 86400e3)) : null;
  const [statusLabel, statusPill] = b.plan === 'trial' ? (b.active ? [`${trialLeft} day${trialLeft === 1 ? '' : 's'} left`, 'pill-info'] : STATUS.expired) : STATUS[b.status] ?? [b.status, 'pill-mute'];
  const go = async (key: string, fn: () => Promise<void>) => { setBusy(key); setMsg(null); try { await fn(); } catch (e) { setMsg({ tone: 'bad', text: err(e) }); setBusy(null); } };

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="Billing" subtitle="Your plan and what it includes. Your AWS servers are billed by AWS, separately." />
      {msg && <div className="mb-4"><Alert tone={msg.tone}>{msg.text}</Alert></div>}
      {!b.active && <div className="mb-4"><Alert>{b.reason} Your servers and apps keep running; only changes through the console are paused.</Alert></div>}
      {!b.enabled && b.plan !== 'internal' && <div className="mb-4"><Alert tone="warn">Payments aren't set up on this platform yet.</Alert></div>}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <section className="card">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-lg font-semibold text-slate-100">{b.plan === 'trial' ? 'Free trial' : b.plan === 'internal' ? 'Platform workspace' : `${b.plan[0].toUpperCase()}${b.plan.slice(1)} plan`}</h2>
            <span className={statusPill}>{statusLabel}</span>
          </div>
          <p className="mt-2 text-sm text-slate-400">
            {b.plan === 'internal' ? 'This workspace runs the platform and is never billed.'
              : b.plan === 'trial' ? (trialLeft ? `${trialLeft} day${trialLeft === 1 ? '' : 's'} left, with everything in Pro. No card needed until you choose a plan.` : 'The trial has ended.')
              : b.status === 'past_due' ? `A payment failed. Update your card before ${day(b.graceUntil)} to keep making changes.`
              : b.status === 'cancelling' ? `Cancelled: everything keeps working until ${day(b.currentPeriodEnd)}.`
              : `Renews around ${day(b.currentPeriodEnd)}${b.billingEmail ? `; receipts go to ${b.billingEmail}` : ''}.`}
          </p>
          {isAdmin && b.hasSubscription && b.plan !== 'trial' && (
            <div className="mt-4 flex flex-wrap gap-2">
              <button className="btn-secondary" disabled={!!busy} onClick={() => go('card', async () => { window.location.assign((await api.billingManage()).url); })}>Update card</button>
              {b.status === 'active' && <button className="btn-ghost" disabled={!!busy} onClick={() => {
                if (confirm('Cancel the subscription? Everything keeps working until the end of the period you paid for.')) void go('cancel', async () => { await api.billingCancel(); await load(); setBusy(null); setMsg({ tone: 'ok', text: 'Cancelled at the end of the current period.' }); });
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

      {b.plan !== 'internal' && (
        <section className="mt-6 grid gap-4 sm:grid-cols-2">
          {b.plans.map((p) => {
            const current = b.plan === p.id && ['active', 'cancelling', 'past_due'].includes(b.status);
            return (
              <div key={p.id} className={`card flex flex-col ${p.id === 'pro' ? 'border-indigo-400/40' : ''}`}>
                <div className="flex items-baseline justify-between"><h3 className="font-medium text-slate-100">{p.name}</h3>{current && <span className="pill-ok">current</span>}</div>
                <p className="mt-3"><span className="num text-3xl font-semibold text-slate-100">R{p.price}</span><span className="text-sm text-slate-500"> / month</span></p>
                <ul className="mt-4 flex-1 space-y-1.5 text-sm text-slate-300">
                  <li>{p.limits.servers} server{p.limits.servers === 1 ? '' : 's'}</li><li>{p.limits.apps} apps</li><li>{p.limits.members} team members</li>
                  <li>{p.limits.approvals ? 'Deploy approvals and freeze windows' : 'Everything except deploy approvals'}</li>
                </ul>
                {isAdmin && !current && b.enabled && (
                  <button className={`${p.id === 'pro' ? 'btn-primary' : 'btn-secondary'} mt-5`} disabled={!!busy}
                          onClick={() => go(p.id, async () => { window.location.assign((await api.billingCheckout(p.id)).url); })}>
                    {busy === p.id ? 'Opening Paystack…' : b.plan === 'trial' || !b.active ? `Choose ${p.name}` : `Switch to ${p.name}`}
                  </button>
                )}
              </div>
            );
          })}
        </section>
      )}
      <p className="mt-4 text-xs text-slate-500">Payments are processed by Paystack. Prices in South African Rand, billed monthly.</p>
    </div>
  );
}

/** Paystack sends people back here: confirm the payment with Paystack (server-side) and show the result. */
export function BillingReturn() {
  const [q] = useSearchParams();
  const { refresh } = useAuth();
  const [state, setState] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  useEffect(() => {
    const ref = q.get('reference') ?? q.get('trxref') ?? '';
    api.billingConfirm(ref).then(async (r) => { await refresh(); setState({ tone: 'ok', text: `Thank you: you're on ${r.plan[0].toUpperCase()}${r.plan.slice(1)}.` }); })
      .catch((e) => setState({ tone: 'bad', text: err(e) }));
  }, [q, refresh]);
  return (
    <div className="mx-auto max-w-lg py-10">
      {state ? <Alert tone={state.tone}>{state.text}</Alert> : <p className="text-sm text-slate-400">Confirming your payment with Paystack…</p>}
      <Link to="/billing" className="btn-secondary mt-4">Back to Billing</Link>
    </div>
  );
}
