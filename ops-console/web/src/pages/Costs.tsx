import { useState } from 'react';
import { api, ApiError, CostSummary } from '../api';
import { useAuth } from '../auth';
import { Alert, Kpi, PageHeader, Skeleton } from '../components/ui';
import { usePoll } from '../usePoll';

const err = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong.');

function Bars({ s }: { s: CostSummary }) {
  const days = s.daily.slice(-45);
  const max = Math.max(0.01, ...days.map((d) => d.total));
  return (
    <div>
      <div className="flex h-36 items-end gap-[3px]">
        {days.map((d) => (
          <div key={d.day} className="group relative flex h-full min-w-0 flex-1 items-end">
            <div className={`w-full rounded-t-[2px] ${d.day >= s.period.monthStart ? 'bg-indigo-400/80 group-hover:bg-indigo-300' : 'bg-ink-600 group-hover:bg-ink-500'}`}
                 style={{ height: `${Math.max(2, (d.total / max) * 100)}%` }} title={`${d.day}: ${s.currency} ${d.total.toFixed(2)}`} />
          </div>
        ))}
      </div>
      <div className="mt-2 flex justify-between text-2xs text-slate-500"><span>{days[0]?.day}</span><span>last month · <span className="text-indigo-300">this month</span></span><span>{days[days.length - 1]?.day}</span></div>
    </div>
  );
}

export function Costs() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin' && !user.isDemo;
  const { data, error, setData } = usePoll(api.costs, 10 * 60_000);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad' | 'warn'; text: string } | null>(null);
  const [budget, setBudget] = useState<string | null>(null);
  const [rate, setRate] = useState<string | null>(null);
  if (error && !data) return <Alert>{error}</Alert>;
  if (!data) return <div className="space-y-3"><Skeleton className="h-12 w-60" /><Skeleton className="h-28" /><Skeleton className="h-64" /></div>;
  const { summary: s, settings } = data;
  const money = (n: number) => `$${n.toFixed(2)}`;
  const zar = (n: number) => (settings.zarRate ? `≈ R${(n * settings.zarRate).toFixed(0)}` : undefined);
  const vs = s.lastMonthSamePeriod ? Math.round(((s.monthToDate - s.lastMonthSamePeriod) / s.lastMonthSamePeriod) * 100) : null;
  const over = settings.monthlyBudget != null && s.forecast > settings.monthlyBudget;

  return (
    <div>
      <PageHeader title="Costs" subtitle={<>AWS Cost Explorer · updated {new Date(s.fetchedAt).toLocaleString()} · amounts in {s.currency}, before tax and credits</>}
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
        <section className="card min-w-0"><h2 className="mb-4 font-medium text-slate-100">Daily spend</h2><Bars s={s} /></section>
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
      {isAdmin && (
        <section className="card mt-5">
          <h2 className="font-medium text-slate-100">Budget and currency</h2>
          <p className="mt-1 text-sm text-slate-500">With a monthly budget, the console raises a warning alert when the forecast goes over it, and a critical one when actual spend does.</p>
          <div className="mt-4 flex flex-wrap items-end gap-3">
            <div><label className="label" htmlFor="c-budget">Monthly budget (USD)</label><input id="c-budget" type="number" min={0} step="0.01" className="input num w-40" value={budget ?? settings.monthlyBudget ?? ''} onChange={(e) => setBudget(e.target.value)} placeholder="none" /></div>
            <div><label className="label" htmlFor="c-rate">Also show in Rand at (ZAR per USD)</label><input id="c-rate" type="number" min={0} step="0.01" className="input num w-40" value={rate ?? settings.zarRate ?? ''} onChange={(e) => setRate(e.target.value)} placeholder="off" /></div>
            <button className="btn-primary" disabled={busy} onClick={async () => {
              setMsg(null);
              try {
                const r = await api.saveCostSettings({ monthlyBudget: (budget ?? String(settings.monthlyBudget ?? '')) || null, zarRate: (rate ?? String(settings.zarRate ?? '')) || null });
                setData({ summary: s, settings: r.settings }); setBudget(null); setRate(null); setMsg({ tone: 'ok', text: 'Saved.' });
              } catch (e) { setMsg({ tone: 'bad', text: err(e) }); }
            }}>Save</button>
          </div>
        </section>
      )}
    </div>
  );
}
