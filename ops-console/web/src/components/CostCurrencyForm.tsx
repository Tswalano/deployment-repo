import { useEffect, useState } from 'react';
import { api, ApiError, CostSettings } from '../api';
import { Alert } from './ui';

/** Settings → Costs: show AWS costs in US dollars or Rand (at a rate you set). AWS itself always bills in USD. */
export function CostCurrencyForm() {
  const [st, setSt] = useState<CostSettings | null>(null);
  const [currency, setCurrency] = useState<'USD' | 'ZAR'>('USD');
  const [rate, setRate] = useState('18.50');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);

  useEffect(() => {
    api.costs().then((r) => {
      setSt(r.settings); setCurrency(r.settings.currency ?? 'USD');
      if (r.settings.zarRate) setRate(String(r.settings.zarRate));
    }).catch((e) => setMsg({ tone: 'bad', text: e instanceof ApiError ? e.message : 'Could not load cost settings.' }));
  }, []);

  const rateNum = Number(rate);
  const rateOk = Number.isFinite(rateNum) && rateNum > 0 && rateNum <= 1000;
  const dirty = !!st && (currency !== st.currency || (currency === 'ZAR' && rateNum !== st.zarRate));

  async function save() {
    setBusy(true); setMsg(null);
    try {
      const r = await api.saveCostSettings(currency === 'ZAR' ? { currency, zarRate: rateNum } : { currency });
      setSt(r.settings);
      setMsg({ tone: 'ok', text: currency === 'ZAR' ? `Costs now show in Rand at $1 = R${rateNum}.` : 'Costs now show in US dollars.' });
    } catch (e) { setMsg({ tone: 'bad', text: e instanceof ApiError ? e.message : 'Saving failed.' }); }
    finally { setBusy(false); }
  }

  return (
    <section id="costs" className="card space-y-4">
      <div>
        <h2 className="font-medium text-slate-100">Costs</h2>
        <p className="mt-1 text-sm text-slate-400">Which currency the Costs page and budget emails use. AWS always bills in US dollars; Rand amounts are converted at the rate entered here (update it periodically).</p>
      </div>
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <span className="label">Show costs in</span>
          <div className="flex gap-1 rounded-lg border border-ink-600 bg-ink-950 p-1 text-sm" role="radiogroup" aria-label="Currency">
            {(['USD', 'ZAR'] as const).map((c) => (
              <button key={c} role="radio" aria-checked={currency === c}
                className={`rounded-md px-3 py-1.5 ${currency === c ? 'bg-indigo-500/20 text-indigo-200' : 'text-slate-400 hover:text-slate-200'}`}
                onClick={() => setCurrency(c)}>{c === 'USD' ? 'US dollars ($)' : 'Rand (R)'}</button>
            ))}
          </div>
        </div>
        {currency === 'ZAR' && (
          <div>
            <label className="label" htmlFor="zar-rate">Exchange rate</label>
            <div className="flex items-center gap-2">
              <span className="text-sm text-slate-400">$1 = R</span>
              <input id="zar-rate" type="number" min={1} step="0.01" className="input num w-28" value={rate} onChange={(e) => setRate(e.target.value)} />
            </div>
          </div>
        )}
        <button className="btn-primary" disabled={busy || !dirty || (currency === 'ZAR' && !rateOk)} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </section>
  );
}
