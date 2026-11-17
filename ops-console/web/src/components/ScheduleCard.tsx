import { useState } from 'react';
import { api, ApiError, Schedule } from '../api';
import { useAuth } from '../auth';
import { usePoll } from '../usePoll';
import { Alert } from './ui';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const err = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong.');
const daysLabel = (d: number[] | null) => !d ? 'custom' : d.length === 7 ? 'every day' : d.join() === '1,2,3,4,5' ? 'weekdays' : d.join() === '0,6' ? 'weekends' : d.map((x) => DAYS[x]).join(', ');
const when = (iso: string | null, tz?: string) => iso ? new Date(iso).toLocaleString(undefined, { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
const until = (iso: string | null) => {
  if (!iso) return '';
  const m = Math.round((Date.parse(iso) - Date.now()) / 60_000);
  return m < 60 ? `in ${m} min` : m < 1440 ? `in ${Math.floor(m / 60)}h ${m % 60}m` : `in ${Math.round(m / 1440)}d`;
};

function Editor({ s, onSave, onCancel }: { s: Schedule; onSave: (b: { time: string; days: number[] }) => Promise<void>; onCancel: () => void }) {
  const [time, setTime] = useState(s.time ?? '06:00');
  const [days, setDays] = useState<number[]>(s.days ?? [0, 1, 2, 3, 4, 5, 6]);
  const [busy, setBusy] = useState(false);
  return (
    <div className="mt-3 space-y-3 rounded-lg border border-indigo-400/30 bg-indigo-500/[0.04] p-3">
      <div className="flex flex-wrap items-end gap-3">
        <div><label className="label" htmlFor={`t-${s.name}`}>Time ({s.timezone})</label><input id={`t-${s.name}`} type="time" className="input w-32" value={time} onChange={(e) => setTime(e.target.value)} /></div>
        <div>
          <span className="label">Days</span>
          <div className="flex gap-1">{DAYS.map((d, i) => (
            <button key={d} type="button" aria-pressed={days.includes(i)} onClick={() => setDays(days.includes(i) ? days.filter((x) => x !== i) : [...days, i])}
                    className={`rounded-md border px-2 py-1.5 text-xs ${days.includes(i) ? 'border-indigo-400/60 bg-indigo-500/20 text-indigo-100' : 'border-ink-600 text-slate-400'}`}>{d}</button>
          ))}</div>
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <button className="btn-ghost px-3 py-1.5 text-xs" onClick={onCancel} disabled={busy}>Cancel</button>
        <button className="btn-primary px-3 py-1.5 text-xs" disabled={busy || !days.length} onClick={async () => { setBusy(true); try { await onSave({ time, days }); } finally { setBusy(false); } }}>Save</button>
      </div>
    </div>
  );
}

export function ScheduleCard({ instanceId }: { instanceId: number }) {
  const { user } = useAuth();
  const { data, error, setData } = usePoll(() => api.schedule(instanceId), 60_000, [instanceId]);
  const [editing, setEditing] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const isAdmin = user?.role === 'admin' && !user.isDemo;
  const canSkip = !!user && !user.isDemo && (user.role === 'admin' || user.role === 'deployer');
  const act = async (fn: () => Promise<{ schedules: Schedule[] }>, text: string) => {
    setMsg(null);
    try { const r = await fn(); setData(r.schedules); setEditing(null); setMsg({ tone: 'ok', text }); } catch (e) { setMsg({ tone: 'bad', text: err(e) }); }
  };
  return (
    <section className="card">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-medium text-slate-100">Schedule</h2>
        <span className="text-xs text-slate-500">EventBridge Scheduler</span>
      </div>
      {error && !data && <div className="mt-3"><Alert tone="warn">{error}</Alert></div>}
      {data && data.length === 0 && <p className="mt-3 text-sm text-slate-500">No start/stop schedule: this instance runs around the clock.</p>}
      <ul className="mt-3 space-y-3">
        {data?.map((s) => (
          <li key={s.name} className="rounded-lg border border-ink-700 px-4 py-3">
            <div className="flex flex-wrap items-center gap-3">
              <span className={s.action === 'stop' ? 'pill-warn' : 'pill-ok'}>{s.action}</span>
              <span className="num text-lg text-slate-100">{s.time ?? '—'}</span>
              <span className="text-sm text-slate-400">{daysLabel(s.days)} · {s.timezone}</span>
              {!s.enabled && <span className="pill-mute">{s.skip ? 'skipped tonight' : 'paused'}</span>}
              <span className="ml-auto text-xs text-slate-500" title={s.next ?? ''}>{s.enabled && s.next ? <>next {when(s.next)} · {until(s.next)}</> : s.skip ? `resumes after ${when(s.skip.until)}` : '—'}</span>
            </div>
            {!s.editable && <p className="mt-1 num text-2xs text-slate-500">{s.expression}</p>}
            {s.instanceIds.length > 1 && <p className="mt-1 text-2xs text-amber-300">Also applies to {s.instanceIds.length - 1} other instance(s).</p>}
            {(canSkip || isAdmin) && editing !== s.name && (
              <div className="mt-2 flex flex-wrap gap-2">
                {canSkip && s.action === 'stop' && s.enabled && (
                  <button className="btn-secondary px-2.5 py-1 text-xs" onClick={() => void act(() => api.skipStop(instanceId, s.name), 'Tonight’s stop is skipped; the schedule switches itself back on afterwards.')}>Keep running tonight</button>
                )}
                {isAdmin && s.editable && <button className="btn-ghost px-2.5 py-1 text-xs" onClick={() => setEditing(s.name)}>Change time</button>}
                {isAdmin && (
                  <button className="btn-ghost px-2.5 py-1 text-xs" onClick={() => void act(() => api.editSchedule(instanceId, s.name, { enabled: !s.enabled }), s.enabled ? 'Schedule paused.' : 'Schedule resumed.')}>
                    {s.enabled ? 'Pause' : 'Resume'}
                  </button>
                )}
              </div>
            )}
            {editing === s.name && <Editor s={s} onCancel={() => setEditing(null)} onSave={(b) => act(() => api.editSchedule(instanceId, s.name, b), 'Schedule updated.')} />}
          </li>
        ))}
      </ul>
      {msg && <div className="mt-3"><Alert tone={msg.tone}>{msg.text}</Alert></div>}
    </section>
  );
}
