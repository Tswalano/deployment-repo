import { FormEvent, useCallback, useEffect, useState } from 'react';
import { ago, api, ApiError, Role, ROLE_INFO, User } from '../api';
import { useAuth } from '../auth';
import { useDialog } from '../components/Dialog';

const ROLES: Role[] = ['admin', 'deployer', 'viewer'];
const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong.');

function CreateUser({ onCreated }: { onCreated: () => void }) {
  const [form, setForm] = useState({ username: '', displayName: '', role: 'viewer' as Role, password: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createUser(form);
      setForm({ username: '', displayName: '', role: 'viewer', password: '' });
      onCreated();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="card grid gap-3 sm:grid-cols-2 lg:grid-cols-5 lg:items-end">
      <div>
        <label className="label" htmlFor="nu-username">Username</label>
        <input id="nu-username" className="input" required minLength={3} maxLength={32} value={form.username}
               onChange={(e) => setForm({ ...form, username: e.target.value })} />
      </div>
      <div>
        <label className="label" htmlFor="nu-name">Display name</label>
        <input id="nu-name" className="input" maxLength={80} value={form.displayName}
               onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
      </div>
      <div>
        <label className="label" htmlFor="nu-role">Role</label>
        <select id="nu-role" className="input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
          {ROLES.map((r) => <option key={r} value={r}>{ROLE_INFO[r].label} — {ROLE_INFO[r].description}</option>)}
        </select>
      </div>
      <div>
        <label className="label" htmlFor="nu-pass">Initial password</label>
        <input id="nu-pass" type="password" autoComplete="new-password" className="input" required minLength={8}
               value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
      </div>
      <button className="btn-primary" disabled={busy || !form.username || form.password.length < 8}>
        {busy ? 'Creating…' : 'Add user'}
      </button>
      {error && <p role="alert" className="text-sm text-rose-300 sm:col-span-2 lg:col-span-5">{error}</p>}
    </form>
  );
}

export function Users() {
  const { user: me } = useAuth();
  const dialog = useDialog();
  const [users, setUsers] = useState<User[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setUsers(await api.users());
    } catch (err) {
      setError(errMsg(err));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function act(fn: () => Promise<unknown>, done?: string) {
    setError(null);
    setNotice(null);
    try {
      await fn();
      if (done) setNotice(done);
      await load();
    } catch (err) {
      setError(errMsg(err));
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-slate-100 sm:text-xl">Users</h1>
        <p className="mt-1 text-sm text-slate-500">
          Admins manage everything. Deployers can deploy applications. Viewers (and the public demo) are read-only.
        </p>
      </div>

      <CreateUser onCreated={() => void act(async () => undefined, 'User added.')} />

      {error && <p role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">{error}</p>}
      {notice && <p role="status" className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200">{notice}</p>}

      <div className="card overflow-hidden p-0">
        <table className="tbl">
          <thead>
            <tr>
              <th className="w-[30%] sm:w-[26%]">User</th>
              <th className="w-[26%] sm:w-[18%]">Role</th>
              <th className="hidden w-[14%] md:table-cell">Status</th>
              <th className="hidden w-[14%] md:table-cell">Last sign-in</th>
              <th className="w-[44%] text-right sm:w-[28%]">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users === null && <tr><td colSpan={5} className="text-slate-500">Loading…</td></tr>}
            {users?.map((u) => {
              const self = u.id === me?.id;
              const status = u.disabled ? 'Disabled' : u.locked ? 'Locked' : 'Active';
              return (
                <tr key={u.id}>
                  <td title={`${u.displayName} (${u.username})`}>
                    <div className="truncate font-medium text-slate-100">{u.displayName || u.username}</div>
                    <div className="truncate text-xs text-slate-500">@{u.username}{self && ' · signed in'}{u.isDemo && ' · public demo'}</div>
                  </td>
                  <td>
                    {u.isDemo || self ? (
                      <span className={ROLE_INFO[u.role].badge}
                            title={self ? "An account's own role can't be changed" : 'The demo account is always a viewer'}>
                        {ROLE_INFO[u.role].label}
                      </span>
                    ) : (
                      <select aria-label={`Role for ${u.username}`} className="input py-1" value={u.role}
                              onChange={(e) => void act(() => api.updateUser(u.id, { role: e.target.value as Role }), `${u.username} is now ${ROLE_INFO[e.target.value as Role].label}.`)}>
                        {ROLES.map((r) => <option key={r} value={r}>{ROLE_INFO[r].label}</option>)}
                      </select>
                    )}
                  </td>
                  <td className="hidden md:table-cell">
                    <span className={status === 'Active' ? 'pill-ok' : 'pill-warn'}>{status}</span>
                  </td>
                  <td className="hidden text-slate-500 md:table-cell" title={u.lastLoginAt ?? 'never'}>{ago(u.lastLoginAt)}</td>
                  <td className="whitespace-normal text-right">
                    <div className="flex flex-wrap justify-end gap-1.5 sm:gap-2">
                      {!u.isDemo && !self && (
                        <button className="btn-secondary px-2.5 py-1 text-xs" onClick={async () => {
                          const pw = await dialog.prompt({ title: `Reset the password of ${u.username}`, body: 'They are signed out everywhere and use the new password from their next sign-in.',
                            label: 'New password', type: 'password', minLength: 8, hint: 'At least 8 characters.', confirmLabel: 'Reset password' });
                          if (pw) void act(() => api.resetPassword(u.id, pw), `Password reset for ${u.username}.`);
                        }}><span className="sm:hidden">Reset</span><span className="hidden sm:inline">Reset password</span></button>
                      )}
                      {!self && (
                        <button className="btn-secondary px-2.5 py-1 text-xs"
                                onClick={() => void act(() => api.updateUser(u.id, { disabled: !u.disabled }), `${u.username} ${u.disabled ? 'enabled' : 'disabled'}.`)}>
                          {u.disabled ? 'Enable' : 'Disable'}
                        </button>
                      )}
                      {!self && !u.isDemo && (
                        <button className="btn-danger px-2.5 py-1 text-xs" onClick={async () => {
                          if (await dialog.confirm({ title: `Delete ${u.username}?`, body: "This can't be undone.", confirmLabel: 'Delete user', danger: true })) void act(() => api.deleteUser(u.id), `${u.username} deleted.`);
                        }}>Delete</button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
