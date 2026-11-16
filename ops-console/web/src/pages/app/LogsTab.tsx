import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { api, LogsResult } from '../../api';
import { Alert, ago } from '../../components/ui';
import { errMsg } from './shared';

const LEVELS = [['all', 'All'], ['warning', 'Warnings+'], ['error', 'Errors']] as const;
const SINCE = [['15m', '15 min'], ['1h', '1 hour'], ['6h', '6 hours'], ['24h', '24 hours'], ['7d', '7 days'], ['boot', 'Since boot']] as const;
const LEVEL_STYLE = { error: 'text-rose-300', warning: 'text-amber-200', info: 'text-slate-300', debug: 'text-slate-500' };
const LEVEL_TAG = { error: 'bg-rose-500/15 text-rose-300', warning: 'bg-amber-500/15 text-amber-300', info: 'bg-ink-700 text-slate-400', debug: 'bg-ink-800 text-slate-500' };
const Q_RE = /^[A-Za-z0-9 ._:/@#=-]{0,60}$/;

const time = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(5, 19);

export function LogsTab({ instanceId, project }: { instanceId: number; project: string }) {
  const [level, setLevel] = useState('all');
  const [since, setSince] = useState('1h');
  const [lines, setLines] = useState(300);
  const [q, setQ] = useState('');
  const [applied, setApplied] = useState('');
  const [follow, setFollow] = useState(false);
  const [data, setData] = useState<LogsResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try { setData(await api.appLogs(instanceId, project, { lines, level, since, q: applied })); } catch (err) { setError(errMsg(err)); } finally { setBusy(false); }
  }, [instanceId, project, lines, level, since, applied]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!follow) return;
    const t = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 15_000);
    return () => clearInterval(t);
  }, [follow, load]);
  useEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight; }, [data]);

  const search = (e: FormEvent) => { e.preventDefault(); if (Q_RE.test(q)) setApplied(q.trim()); };
  const download = () => {
    if (!data) return;
    const text = data.entries.map((x) => `${new Date(x.ts).toISOString()} ${x.level.toUpperCase().padEnd(7)} ${x.source}: ${x.message}`).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = `${project}-${since}-${level}.log`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const highlight = (m: string) => {
    if (!applied) return m;
    const i = m.toLowerCase().indexOf(applied.toLowerCase());
    if (i < 0) return m;
    return <>{m.slice(0, i)}<mark className="rounded bg-indigo-400/30 px-0.5 text-white">{m.slice(i, i + applied.length)}</mark>{m.slice(i + applied.length)}</>;
  };

  return (
    <section className="card overflow-hidden p-0">
      <div className="flex flex-wrap items-center gap-2 border-b border-ink-700 px-4 py-3">
        <div className="flex rounded-lg border border-ink-600 p-0.5" role="radiogroup" aria-label="Level">
          {LEVELS.map(([v, l]) => (
            <button key={v} role="radio" aria-checked={level === v} onClick={() => setLevel(v)}
                    className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${level === v ? 'bg-ink-700 text-slate-100' : 'text-slate-400 hover:text-slate-200'}`}>{l}</button>
          ))}
        </div>
        <label className="sr-only" htmlFor="lg-since">Time range</label>
        <select id="lg-since" className="input w-auto py-1.5 text-xs" value={since} onChange={(e) => setSince(e.target.value)}>
          {SINCE.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <label className="sr-only" htmlFor="lg-lines">Lines</label>
        <select id="lg-lines" className="input w-auto py-1.5 text-xs" value={lines} onChange={(e) => setLines(Number(e.target.value))}>
          {[100, 300, 1000].map((n) => <option key={n} value={n}>{n} lines</option>)}
        </select>
        <form onSubmit={search} className="flex min-w-[12rem] flex-1 items-center gap-2">
          <label className="sr-only" htmlFor="lg-q">Search</label>
          <input id="lg-q" className={`input py-1.5 text-xs ${Q_RE.test(q) ? '' : 'border-rose-500'}`} placeholder="Search, e.g. timeout or /api/loans" value={q}
                 onChange={(e) => setQ(e.target.value)} maxLength={60} spellCheck={false} />
          <button className="btn-secondary px-3 py-1.5 text-xs" disabled={!Q_RE.test(q)}>Search</button>
        </form>
        <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-400">
          <input type="checkbox" className="accent-indigo-400" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow
        </label>
        <button className="btn-ghost px-2.5 py-1.5 text-xs" onClick={() => void load()} disabled={busy}>{busy ? 'Loading…' : 'Refresh'}</button>
        <button className="btn-ghost px-2.5 py-1.5 text-xs" onClick={download} disabled={!data?.entries.length}>Download</button>
      </div>
      {error && <div className="p-4"><Alert>{error}</Alert></div>}
      <div className="flex flex-wrap gap-x-4 gap-y-1 px-4 py-2 text-2xs text-slate-500">
        {data ? <>
          <span>{data.entries.length} entries{data.truncated ? ' (oldest trimmed to fit)' : ''}</span>
          {Object.entries(data.byLevel).map(([k, v]) => <span key={k} className={LEVEL_STYLE[k as keyof typeof LEVEL_STYLE]}>{v} {k}</span>)}
          <span>fetched {ago(data.fetchedAt)}{follow ? ' · following every 15s' : ''}</span>
          <span>secrets are masked on the server</span>
        </> : <span>Loading…</span>}
      </div>
      <div ref={box} className="h-[32rem] overflow-y-auto border-t border-ink-800 bg-ink-950 py-2 font-mono text-[12px] leading-5">
        {data && data.entries.length === 0 && <p className="px-4 py-6 text-center font-sans text-sm text-slate-500">No entries match.</p>}
        {data?.entries.map((x, i) => (
          <div key={i} className="flex gap-3 px-4 hover:bg-ink-900">
            <span className="shrink-0 text-slate-600">{time(x.ts)}</span>
            <span className={`h-fit shrink-0 rounded px-1 text-[10px] font-semibold uppercase leading-5 ${LEVEL_TAG[x.level]}`}>{x.level.slice(0, 4)}</span>
            <span className={`min-w-0 whitespace-pre-wrap break-all ${LEVEL_STYLE[x.level]}`}>{highlight(x.message)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
