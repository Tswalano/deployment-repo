import { FormEvent, useEffect, useState } from 'react';
import { api, ApiError, DeployPolicy, EnvName, FreezeWindow } from '../api';
import { Alert } from './ui';

const ENVS: EnvName[] = ['production', 'staging', 'development'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const TZS = ['Africa/Johannesburg', 'UTC', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles', 'Asia/Singapore'];
const err = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong.');
const localInput = (iso?: string) => (iso ? new Date(new Date(iso).getTime() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : '');

function describe(f: FreezeWindow): string {
  if (f.kind === 'weekly') return `Every ${DAYS[f.startDay ?? 0]} ${f.startTime} → ${DAYS[f.endDay ?? 0]} ${f.endTime}`;
  const o: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' };
  return `${f.startAt ? new Date(f.startAt).toLocaleString(undefined, o) : '?'} → ${f.endAt ? new Date(f.endAt).toLocaleString(undefined, o) : '?'}`;
}

export function DeployPolicyForm() {
  const [p, setP] = useState<DeployPolicy | null>(null);
  const [frozen, setFrozen] = useState<Record<string, { name: string } | null>>({});
  const [draft, setDraft] = useState<FreezeWindow | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { api.policy().then((r) => { setP(r.policy); setFrozen(r.frozenNow); }).catch((e) => setMsg({ tone: 'bad', text: err(e) })); }, []);
  if (!p) return <section id="policy" className="card text-sm text-slate-500">{msg?.text ?? 'Loading deploy policy…'}</section>;

  async function save(next: DeployPolicy, text = 'Saved.') {
    setBusy(true); setMsg(null);
    try { const r = await api.savePolicy(next); setP(r.policy); setFrozen(r.frozenNow); setMsg({ tone: 'ok', text }); return true; }
    catch (e) { setMsg({ tone: 'bad', text: err(e) }); return false; } finally { setBusy(false); }
  }
  const submit = (e: FormEvent) => { e.preventDefault(); void save(p); };
  const newWindow = (kind: 'weekly' | 'once'): FreezeWindow => kind === 'weekly'
    ? { name: 'Weekend freeze', environments: ['production'], kind, startDay: 5, startTime: '15:00', endDay: 1, endTime: '06:00' }
    : { name: 'Launch freeze', environments: ['production'], kind, startAt: new Date(Date.now() + 86_400_000).toISOString(), endAt: new Date(Date.now() + 3 * 86_400_000).toISOString() };

  return (
    <form id="policy" onSubmit={submit} className="card space-y-5">
      <div>
        <h2 className="font-medium text-slate-100">Deploy policy</h2>
        <p className="mt-1 text-sm text-slate-500">
          Approvals need a second person: the requester can't approve their own deploy. Admins can always break glass with a written reason
          (logged and sent to the alert channels), which is how a single admin deploys while approvals are on.
        </p>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div>
          <div className="eyebrow mb-3">Require approval</div>
          <div className="space-y-2">
            {ENVS.map((e) => (
              <label key={e} className="flex cursor-pointer items-center justify-between rounded-lg border border-ink-700 px-3 py-2.5 hover:border-ink-600">
                <span className="text-sm capitalize text-slate-200">{e}{frozen[e] && <span className="pill-info ml-2 normal-case">frozen now: {frozen[e]!.name}</span>}</span>
                <input type="checkbox" className="h-4 w-4 accent-indigo-400" checked={p.approvals[e]} onChange={(ev) => setP({ ...p, approvals: { ...p.approvals, [e]: ev.target.checked } })} />
              </label>
            ))}
          </div>
        </div>
        <div className="space-y-3">
          <div className="eyebrow mb-3">Rules</div>
          <label className="flex cursor-pointer items-center gap-2.5 text-sm text-slate-300">
            <input type="checkbox" className="accent-indigo-400" checked={p.rollbackNeedsApproval} onChange={(e) => setP({ ...p, rollbackNeedsApproval: e.target.checked })} />
            Rollbacks need approval too
          </label>
          <label className="flex cursor-pointer items-center gap-2.5 text-sm text-slate-300">
            <input type="checkbox" className="accent-indigo-400" checked={p.rollbackAllowedInFreeze} onChange={(e) => setP({ ...p, rollbackAllowedInFreeze: e.target.checked })} />
            Allow rollbacks during a freeze
          </label>
          <div className="grid grid-cols-2 gap-3 pt-1">
            <div>
              <label className="label" htmlFor="pol-ttl">Requests expire after</label>
              <div className="flex items-center gap-2"><input id="pol-ttl" type="number" min={10} max={1440} className="input num" value={p.requestTtlMinutes} onChange={(e) => setP({ ...p, requestTtlMinutes: Number(e.target.value) })} /><span className="text-xs text-slate-500">min</span></div>
            </div>
            <div>
              <label className="label" htmlFor="pol-tz">Freeze timezone</label>
              <select id="pol-tz" className="input" value={p.timezone} onChange={(e) => setP({ ...p, timezone: e.target.value })}>
                {[...new Set([p.timezone, ...TZS])].map((t) => <option key={t}>{t}</option>)}
              </select>
            </div>
          </div>
        </div>
      </div>

      <div>
        <div className="mb-3 flex items-center justify-between">
          <div className="eyebrow">Freeze windows</div>
          <div className="flex gap-2">
            <button type="button" className="btn-ghost px-2.5 py-1 text-xs" onClick={() => setDraft(newWindow('weekly'))}>+ Weekly</button>
            <button type="button" className="btn-ghost px-2.5 py-1 text-xs" onClick={() => setDraft(newWindow('once'))}>+ One-off</button>
          </div>
        </div>
        {p.freezes.length === 0 && !draft && <p className="text-sm text-slate-500">No freeze windows. Deploys are allowed at any time the instance is running.</p>}
        <ul className="space-y-2">
          {p.freezes.map((f) => (
            <li key={f.id} className="flex items-center gap-3 rounded-lg border border-ink-700 px-3 py-2.5">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-slate-200">{f.name} <span className="text-xs text-slate-500">· {f.environments.join(', ')}</span></span>
                <span className="block truncate text-xs text-slate-500">{describe(f)}{f.kind === 'weekly' ? ` (${p.timezone})` : ''}</span>
              </span>
              <button type="button" className="btn-danger shrink-0 px-2.5 py-1 text-xs" disabled={busy}
                      onClick={() => void save({ ...p, freezes: p.freezes.filter((x) => x.id !== f.id) }, `Removed “${f.name}”.`)}>Remove</button>
            </li>
          ))}
        </ul>
        {draft && (
          <div className="mt-3 space-y-3 rounded-lg border border-indigo-400/30 bg-indigo-500/[0.04] p-4">
            <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto]">
              <div><label className="label" htmlFor="fz-name">Name</label><input id="fz-name" className="input" value={draft.name} maxLength={60} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></div>
              <div>
                <span className="label">Environments</span>
                <div className="flex gap-3 pt-2">{ENVS.map((e) => (
                  <label key={e} className="flex items-center gap-1.5 text-sm capitalize text-slate-300">
                    <input type="checkbox" className="accent-indigo-400" checked={draft.environments.includes(e)}
                           onChange={(ev) => setDraft({ ...draft, environments: ev.target.checked ? [...draft.environments, e] : draft.environments.filter((x) => x !== e) })} />{e}
                  </label>
                ))}</div>
              </div>
            </div>
            {draft.kind === 'weekly' ? (
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <div><label className="label" htmlFor="fz-sd">From</label><select id="fz-sd" className="input" value={draft.startDay} onChange={(e) => setDraft({ ...draft, startDay: Number(e.target.value) })}>{DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}</select></div>
                <div><label className="label" htmlFor="fz-st">at</label><input id="fz-st" type="time" className="input" value={draft.startTime} onChange={(e) => setDraft({ ...draft, startTime: e.target.value })} /></div>
                <div><label className="label" htmlFor="fz-ed">Until</label><select id="fz-ed" className="input" value={draft.endDay} onChange={(e) => setDraft({ ...draft, endDay: Number(e.target.value) })}>{DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}</select></div>
                <div><label className="label" htmlFor="fz-et">at</label><input id="fz-et" type="time" className="input" value={draft.endTime} onChange={(e) => setDraft({ ...draft, endTime: e.target.value })} /></div>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <div><label className="label" htmlFor="fz-sa">Starts</label><input id="fz-sa" type="datetime-local" className="input" value={localInput(draft.startAt)} onChange={(e) => setDraft({ ...draft, startAt: new Date(e.target.value).toISOString() })} /></div>
                <div><label className="label" htmlFor="fz-ea">Ends</label><input id="fz-ea" type="datetime-local" className="input" value={localInput(draft.endAt)} onChange={(e) => setDraft({ ...draft, endAt: new Date(e.target.value).toISOString() })} /></div>
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-ghost" onClick={() => setDraft(null)}>Cancel</button>
              <button type="button" className="btn-primary" disabled={busy} onClick={async () => { if (await save({ ...p, freezes: [...p.freezes, draft] }, `Added “${draft.name}”.`)) setDraft(null); }}>Add window</button>
            </div>
          </div>
        )}
      </div>

      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      <div className="flex justify-end border-t border-ink-700 pt-4"><button className="btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save policy'}</button></div>
    </form>
  );
}
