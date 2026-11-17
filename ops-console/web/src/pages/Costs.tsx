import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, CostSettings, CostSummary } from '../api';
import { useAuth } from '../auth';
import { Alert, Kpi, PageHeader, Skeleton } from '../components/ui';
import { usePoll } from '../usePoll';

/** Amount formatting in the chosen display currency (AWS bills in USD; ZAR uses the saved rate). */
export interface Money { fmt: (usd: number) => string; other: (usd: number) => string | undefined; zar: boolean; rate: number | null }
export function moneyFor(st: CostSettings): Money {
  const zar = st.currency === 'ZAR' && !!st.zarRate;
  const usd = (n: number) => `$${n.toFixed(2)}`;
  const rand = (n: number) => `R${(n * (st.zarRate ?? 0)).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return { fmt: zar ? rand : usd, other: (n) => (zar ? usd(n) : undefined), zar, rate: st.zarRate };
}

const err = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong.');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const longDate = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' });

/** Daily bars for last month and this month, month labels underneath, details on hover/focus. */
function Bars({ s, m }: { s: CostSummary; m: Money }) {
  const days = s.daily;
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(0.01, ...days.map((d) => d.total));
  const h = hover != null ? days[hover] : null;
  // month segments for the axis: [label, number of bars]
  const segs: [string, number][] = [];
  for (const d of days) {
    const label = `${MONTHS[Number(d.day.slice(5, 7)) - 1]} ${d.day.slice(0, 4)}`;
    if (segs.length && segs[segs.length - 1][0] === label) segs[segs.length - 1][1]++; else segs.push([label, 1]);
  }
  return (
    <div>
      <div className="mb-3 min-h-[3.25rem] rounded-lg border border-ink-700 bg-ink-850 px-3 py-2 text-sm">
        {h ? (
          <>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-slate-200">{longDate(h.day)}{h.day === s.period.today ? ' · today (so far)' : ''}</span>
              <span className="num font-medium text-slate-100">{m.fmt(h.total)}{m.other(h.total) ? <span className="ml-2 text-xs text-slate-400">{m.other(h.total)}</span> : null}</span>
            </div>
            <div className="mt-0.5 truncate text-xs text-slate-500">
              {h.top?.length ? h.top.map((t) => `${t.name.replace(/^Amazon |^AWS /, '')} ${m.fmt(t.amount)}`).join(' · ') : 'No breakdown for this day'}
            </div>
          </>
        ) : <span className="text-xs text-slate-500">Hover over (or tap) a bar to see that day&apos;s date, amount and what it was spent on.</span>}
      </div>
      <div className="flex h-36 items-end gap-[2px]" onMouseLeave={() => setHover(null)}>
        {days.map((d, i) => (
          <button key={d.day} type="button" aria-label={`${longDate(d.day)}: $${d.total.toFixed(2)}`}
                  onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onClick={() => setHover(i)}
                  className="group flex h-full min-w-0 flex-1 items-end focus:outline-none">
            <span className={`block w-full rounded-t-[2px] transition-colors ${hover === i ? 'bg-sky-300' : d.day >= s.period.monthStart ? 'bg-indigo-400/80 group-hover:bg-indigo-300' : 'bg-ink-500 group-hover:bg-slate-500'}`}
                  style={{ height: `${Math.max(2, (d.total / max) * 100)}%` }} />
          </button>
        ))}
      </div>
      <div className="mt-2 flex gap-[2px] text-2xs">
        {segs.map(([label, n], i) => (
          <div key={label} style={{ flex: n }} className={`truncate border-t pt-1.5 ${i === segs.length - 1 ? 'border-indigo-400/60 text-indigo-300' : 'border-ink-600 text-slate-500'}`}>{label}</div>
        ))}
      </div>
    </div>
  );
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)}
            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition ${on ? 'bg-indigo-500' : 'bg-ink-600'}`}>
      <span className={`inline-block h-4 w-4 rounded-full bg-white transition ${on ? 'translate-x-6' : 'translate-x-1'}`} />
    </button>
  );
}

/** The budget alert (amount entered in the display currency, kept in US dollars). Currency is chosen in Settings. */
function CostOptions({ settings, onSaved, onError }: { settings: CostSettings; onSaved: (s: CostSettings) => void; onError: (t: string) => void }) {
  const m = moneyFor(settings);
  const toShown = (usd: number) => (m.zar ? Math.round(usd * m.rate!) : usd);
  const [budgetOn, setBudgetOn] = useState(settings.monthlyBudget != null);
  const [budget, setBudget] = useState(String(toShown(settings.monthlyBudget ?? 20)));
  const [busy, setBusy] = useState(false);
  const budgetUsd = m.zar ? Math.round((Number(budget) / m.rate!) * 100) / 100 : Number(budget);
  const dirty = budgetOn !== (settings.monthlyBudget != null) || (budgetOn && String(toShown(settings.monthlyBudget ?? -1)) !== budget);
  return (
    <section className="card mt-5 space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-medium text-slate-100">Budget alert</h2>
        <span className="text-xs text-slate-500">Amounts in {m.zar ? `Rand ($1 = R${m.rate})` : 'US dollars'} · <Link to="/settings#costs" className="underline-offset-2 hover:underline">change currency in Settings</Link></span>
      </div>
      <div className="flex items-start gap-4 rounded-lg border border-ink-700 p-4">
        <Toggle on={budgetOn} onChange={setBudgetOn} label="Budget alert" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-slate-200">Email me about the AWS bill</div>
          <p className="mt-0.5 text-sm text-slate-500">When this month&apos;s bill is <i>forecast</i> to go over the amount (warning), and again if it actually does (critical). Off = no cost alerts.</p>
          {budgetOn && (
            <div className="mt-3 flex items-center gap-2">
              <span className="text-sm text-slate-400">Alert me above</span>
              <span className="text-sm text-slate-400">{m.zar ? 'R' : '$'}</span>
              <input type="number" min={1} step="1" className="input num w-28" value={budget} onChange={(e) => setBudget(e.target.value)} aria-label={`Monthly budget in ${m.zar ? 'Rand' : 'US dollars'}`} />
              <span className="text-sm text-slate-500">per month{m.zar && Number(budget) > 0 ? ` (≈ $${budgetUsd.toFixed(2)})` : ''}</span>
            </div>
          )}
        </div>
      </div>
      <div className="flex justify-end">
        <button className="btn-primary" disabled={busy || !dirty} onClick={async () => {
          setBusy(true);
          try {
            const r = await api.saveCostSettings({ monthlyBudget: budgetOn ? budgetUsd : null });
            onSaved(r.settings);
          } catch (e) { onError(err(e)); } finally { setBusy(false); }
        }}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </section>
  );
}

export function Costs() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin' && !user.isDemo;
  const { data, error, setData } = usePoll(api.costs, 10 * 60_000);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad' | 'warn'; text: string } | null>(null);
  if (error && !data) return <Alert>{error}</Alert>;
  if (!data) return <div className="space-y-3"><Skeleton className="h-12 w-60" /><Skeleton className="h-28" /><Skeleton className="h-64" /></div>;
  const { summary: s, settings } = data;
  const m = moneyFor(settings);
  const money = m.fmt;
  const zar = m.other;
  const vs = s.lastMonthSamePeriod ? Math.round(((s.monthToDate - s.lastMonthSamePeriod) / s.lastMonthSamePeriod) * 100) : null;
  const over = settings.monthlyBudget != null && s.forecast > settings.monthlyBudget;

  return (
    <div>
      <PageHeader title="Costs" subtitle={<>AWS Cost Explorer · updated {new Date(s.fetchedAt).toLocaleString()} · {m.zar ? <>amounts in Rand at $1 = R{m.rate} (AWS bills in {s.currency})</> : <>amounts in {s.currency}</>}, before tax and credits</>}
        actions={isAdmin && (
          <button className="btn-secondary" disabled={busy} title="Each refresh costs USD 0.02 (2 Cost Explorer requests); limited to once an hour"
                  onClick={async () => { setBusy(true); setMsg(null); try { const r = await api.refreshCosts(); setData({ summary: r.summary, settings: r.settings }); setMsg(r.fetched ? { tone: 'ok', text: 'Refreshed from Cost Explorer.' } : { tone: 'warn', text: 'Already refreshed in the last hour (Cost Explorer charges per request).' }); } catch (e) { setMsg({ tone: 'bad', text: err(e) }); } finally { setBusy(false); } }}>
            {busy ? 'Refreshing…' : 'Refresh'}
          </button>
        )} />
      {msg && <div className="mb-4"><Alert tone={msg.tone}>{msg.text}</Alert></div>}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Month to date" tone="info" value={money(s.monthToDate)} unit={zar(s.monthToDate)} sub={vs == null ? undefined : `${vs >= 0 ? '+' : ''}${vs}% vs same days last month`} />
        <Kpi label="Forecast" tone={over ? 'warn' : 'ok'} value={money(s.forecast)} unit={zar(s.forecast)} sub={settings.monthlyBudget != null ? `budget ${money(settings.monthlyBudget)}` : s.forecastSource === 'aws' ? 'AWS forecast' : 'straight-line estimate'} />
        <Kpi label="Last month" tone="info" value={money(s.lastMonth)} unit={zar(s.lastMonth)} className="hidden lg:block" />
        <Kpi label="Per day" tone="info" value={money(s.monthToDate / Math.max(1, Number(s.period.today.slice(8))))} unit="average this month" className="hidden lg:block" />
      </div>
      {settings.monthlyBudget != null && (
        <div className="card mt-5">
          <div className="flex items-baseline justify-between text-sm"><span className="text-slate-400">Budget</span><span className="num text-slate-200">{money(s.monthToDate)} spent · {money(s.forecast)} forecast · {money(settings.monthlyBudget)} budget</span></div>
          <div className="relative mt-3 h-2 overflow-hidden rounded-full bg-ink-700">
            <div className="absolute inset-y-0 left-0 bg-indigo-400/30" style={{ width: `${Math.min(100, (s.forecast / settings.monthlyBudget) * 100)}%` }} />
            <div className={`absolute inset-y-0 left-0 ${s.monthToDate > settings.monthlyBudget ? 'bg-rose-400' : 'bg-indigo-400'}`} style={{ width: `${Math.min(100, (s.monthToDate / settings.monthlyBudget) * 100)}%` }} />
          </div>
        </div>
      )}
      <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_420px] lg:items-start">
        <section className="card min-w-0"><h2 className="mb-3 font-medium text-slate-100">Daily spend</h2><Bars s={s} m={m} /></section>
        <section className="card overflow-hidden p-0">
          <h2 className="px-5 py-4 font-medium text-slate-100">By service</h2>
          <table className="tbl">
            <thead><tr><th>Service</th><th className="w-[24%] text-right">This month</th><th className="hidden w-[24%] text-right sm:table-cell">Last month</th></tr></thead>
            <tbody>{s.services.map((x) => (
              <tr key={x.name}><td title={x.name}>{x.name.replace(/^Amazon |^AWS /, '')}</td><td className="num text-right">{money(x.monthToDate)}</td><td className="num hidden text-right text-slate-500 sm:table-cell">{money(x.lastMonth)}</td></tr>
            ))}</tbody>
          </table>
        </section>
      </div>
      {isAdmin && <CostOptions settings={settings} onSaved={(st) => { setData({ summary: s, settings: st }); setMsg({ tone: 'ok', text: 'Saved.' }); }} onError={(t) => setMsg({ tone: 'bad', text: t })} />}
    </div>
  );
}
