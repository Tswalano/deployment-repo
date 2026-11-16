import { FormEvent, useState } from 'react';
import { api, ApiError, ROLE_INFO } from '../api';
import { useAuth } from '../auth';

export function Account() {
  const { user } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (!user) return null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (next !== confirm) return setMsg({ ok: false, text: "The new passwords don't match." });
    setBusy(true);
    setMsg(null);
    try {
      await api.changePassword(current, next);
      setCurrent(''); setNext(''); setConfirm('');
      setMsg({ ok: true, text: 'Password changed. Your other sessions were signed out.' });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof ApiError ? err.message : 'Something went wrong.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Account</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          @{user.username} · <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${ROLE_INFO[user.role].badge}`}>{ROLE_INFO[user.role].label}</span>
        </p>
      </div>
      <form onSubmit={submit} className="card space-y-4">
        <h2 className="font-medium">Change password</h2>
        <div>
          <label className="label" htmlFor="cur">Current password</label>
          <input id="cur" type="password" autoComplete="current-password" className="input" required value={current} onChange={(e) => setCurrent(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="new">New password</label>
          <input id="new" type="password" autoComplete="new-password" className="input" required minLength={8} value={next} onChange={(e) => setNext(e.target.value)} />
          <p className="mt-1 text-xs text-slate-500">At least 8 characters. A long passphrase is best.</p>
        </div>
        <div>
          <label className="label" htmlFor="conf">Confirm new password</label>
          <input id="conf" type="password" autoComplete="new-password" className="input" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </div>
        {msg && (
          <p role={msg.ok ? 'status' : 'alert'} className={`rounded-lg px-3 py-2 text-sm ${msg.ok
            ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300'
            : 'bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300'}`}>{msg.text}</p>
        )}
        <button className="btn-primary" disabled={busy || !current || next.length < 8 || !confirm}>
          {busy ? 'Saving…' : 'Change password'}
        </button>
      </form>
    </div>
  );
}
