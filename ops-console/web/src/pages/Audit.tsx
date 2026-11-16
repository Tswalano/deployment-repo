import { useEffect, useState } from 'react';
import { api, ApiError, AuditEntry } from '../api';

const LABELS: Record<string, string> = {
  'auth.login': 'Signed in',
  'auth.logout': 'Signed out',
  'auth.demo': 'Opened the demo',
  'auth.login_failed': 'Failed sign-in',
  'auth.login_locked': 'Sign-in while locked',
  'auth.account_locked': 'Account locked',
  'auth.password_change': 'Changed own password',
  'user.create': 'Created user',
  'user.update': 'Updated user',
  'user.password_reset': 'Reset password',
  'user.delete': 'Deleted user',
  'instance.add': 'Added instance',
  'instance.update': 'Updated instance',
  'instance.remove': 'Removed instance',
};

const tone = (action: string) =>
  /failed|locked/.test(action) ? 'text-rose-300'
    : action.startsWith('user.') ? 'text-violet-300' : action.startsWith('instance.') ? 'text-sky-300' : '';

export function Audit() {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.audit(200).then(setEntries).catch((e) => setError(e instanceof ApiError ? e.message : 'Failed to load'));
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-slate-100 sm:text-xl">Audit log</h1>
        <p className="mt-1 text-sm text-slate-500">Every sign-in and change, newest first.</p>
      </div>
      {error && <p role="alert" className="text-sm text-rose-300">{error}</p>}
      <div className="card overflow-hidden p-0">
        <table className="tbl">
          <thead>
            <tr>
              <th className="w-[22%]">When</th>
              <th className="w-[18%]">Who</th>
              <th className="w-[24%]">What</th>
              <th className="hidden w-[18%] sm:table-cell">Target</th>
              <th className="hidden w-[18%] md:table-cell">Details</th>
            </tr>
          </thead>
          <tbody>
            {entries === null && !error && <tr><td colSpan={5} className="text-slate-500">Loading…</td></tr>}
            {entries?.length === 0 && <tr><td colSpan={5} className="text-slate-500">No activity yet.</td></tr>}
            {entries?.map((e) => {
              const detail = Object.keys(e.detail).length ? JSON.stringify(e.detail) : '';
              return (
                <tr key={e.id}>
                  <td title={e.at}>{new Date(e.at).toLocaleString()}</td>
                  <td title={e.ip ? `${e.username ?? '—'} from ${e.ip}` : e.username ?? '—'}>{e.username ?? '—'}</td>
                  <td className={tone(e.action)} title={e.action}>{LABELS[e.action] ?? e.action}</td>
                  <td className="hidden sm:table-cell" title={e.target ?? ''}>{e.target ?? '—'}</td>
                  <td className="hidden font-mono text-xs text-slate-500 md:table-cell" title={detail}>{detail || '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
