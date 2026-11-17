import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError, Role, TeamInvite, TeamMember } from '../api';
import { useAuth } from '../auth';
import { ago, Alert, PageHeader, Skeleton } from '../components/ui';

const err = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong.');
const ROLES: [Role, string][] = [['admin', 'Admin: everything, including team and settings'], ['deployer', 'Deployer: deploy, restart, back up'], ['viewer', 'Viewer: look only']];

/** Members and invitations of the current workspace (multi-customer mode). */
export function Team() {
  const { user, refresh } = useAuth();
  const navigate = useNavigate();
  const isAdmin = user?.role === 'admin';
  const [data, setData] = useState<{ members: TeamMember[]; invites: TeamInvite[] } | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('deployer');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api.team().then(setData).catch((e) => setMsg({ tone: 'bad', text: err(e) })), []);
  useEffect(() => { void load(); }, [load]);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true); setMsg(null);
    try { await fn(); setMsg({ tone: 'ok', text: ok }); await load(); } catch (e) { setMsg({ tone: 'bad', text: err(e) }); } finally { setBusy(false); }
  };

  if (!data) return msg ? <Alert>{msg.text}</Alert> : <Skeleton className="h-64" />;
  return (
    <div>
      <PageHeader title="Team" subtitle="Who can use this workspace, and what they may do." />
      {msg && <div className="mb-4"><Alert tone={msg.tone}>{msg.text}</Alert></div>}

      {isAdmin && (
        <section className="card mb-6">
          <h2 className="font-medium text-slate-100">Invite someone</h2>
          <p className="mt-1 text-sm text-slate-400">They get an email with a link that works for 7 days.</p>
          <form className="mt-4 grid gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,1.4fr)_auto] md:items-end"
                onSubmit={(e) => { e.preventDefault(); void act(() => api.invite(email.trim(), role), `Invitation sent to ${email.trim()}.`).then(() => setEmail('')); }}>
            <div><label className="label" htmlFor="inv-email">Email</label><input id="inv-email" type="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} required /></div>
            <div><label className="label" htmlFor="inv-role">Role</label>
              <select id="inv-role" className="input" value={role} onChange={(e) => setRole(e.target.value as Role)}>
                {ROLES.map(([r, d]) => <option key={r} value={r}>{d}</option>)}
              </select></div>
            <button className="btn-primary" disabled={busy || !email.trim()}>Send invitation</button>
          </form>
        </section>
      )}

      <section className="card overflow-hidden p-0">
        <h2 className="px-5 py-4 font-medium text-slate-100">Members ({data.members.length})</h2>
        <table className="tbl">
          <thead><tr><th>Name</th><th className="w-[30%]">Email</th><th className="w-[16%]">Role</th><th className="w-[14%]">Last sign-in</th><th className="w-[14%] text-right"></th></tr></thead>
          <tbody>
            {data.members.map((m) => (
              <tr key={m.id}>
                <td className="font-medium text-slate-100">{m.displayName || m.username}{m.id === user?.id && <span className="ml-2 text-xs text-slate-500">(signed in)</span>}</td>
                <td title={m.email ?? ''}>{m.email}{!m.emailVerified && <span className="pill-warn ml-2">unconfirmed</span>}</td>
                <td>{isAdmin && m.id !== user?.id ? (
                  <select className="input py-1 text-xs" value={m.role} disabled={busy} aria-label={`Role of ${m.email}`}
                          onChange={(e) => void act(() => api.setMemberRole(m.id, e.target.value as Role), `${m.email} is now ${e.target.value}.`)}>
                    {ROLES.map(([r]) => <option key={r} value={r}>{r}</option>)}
                  </select>) : <span className="capitalize">{m.role}</span>}</td>
                <td>{m.lastLoginAt ? ago(m.lastLoginAt) : '—'}</td>
                <td className="text-right">
                  {m.id === user?.id ? (
                    <button className="btn-ghost px-2.5 py-1 text-xs" disabled={busy} onClick={async () => {
                      if (!confirm('Leave this workspace? Access ends until a new invitation is accepted.')) return;
                      await act(() => api.removeMember(m.id), 'Left the workspace.'); await refresh(); navigate('/');
                    }}>Leave</button>
                  ) : isAdmin && (
                    <button className="btn-danger px-2.5 py-1 text-xs" disabled={busy} onClick={() => {
                      if (confirm(`Remove ${m.email} from this workspace? They lose access at once.`)) void act(() => api.removeMember(m.id), `${m.email} was removed.`);
                    }}>Remove</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {data.invites.length > 0 && (
        <section className="card mt-6 overflow-hidden p-0">
          <h2 className="px-5 py-4 font-medium text-slate-100">Pending invitations</h2>
          <table className="tbl">
            <thead><tr><th>Email</th><th className="w-[16%]">Role</th><th className="w-[18%]">Sent</th><th className="w-[14%] text-right"></th></tr></thead>
            <tbody>{data.invites.map((i) => (
              <tr key={i.id}>
                <td>{i.email}</td><td className="capitalize">{i.role}</td><td>{ago(i.createdAt)}</td>
                <td className="text-right">{isAdmin && <button className="btn-ghost px-2.5 py-1 text-xs" disabled={busy} onClick={() => void act(() => api.cancelInvite(i.id), 'Invitation cancelled.')}>Cancel</button>}</td>
              </tr>
            ))}</tbody>
          </table>
        </section>
      )}
    </div>
  );
}

/** Signed in, but not a member of any workspace (left, removed, or the invitation isn't accepted yet). */
export function NoWorkspace() {
  const { refresh, logout, user } = useAuth();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="grid min-h-screen place-items-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="text-center text-xl font-semibold text-slate-100">No workspace</h1>
        <p className="mt-2 text-center text-sm text-slate-400">This account isn't a member of any workspace. Ask an admin for an invitation{user?.email ? ` to ${user.email}` : ''}, or create a new workspace.</p>
        <form className="card mt-6 space-y-4" onSubmit={async (e) => {
          e.preventDefault(); setBusy(true); setError(null);
          try { await api.createWorkspace(name.trim()); await refresh(); } catch (e2) { setError(err(e2)); } finally { setBusy(false); }
        }}>
          {error && <Alert>{error}</Alert>}
          <div><label className="label" htmlFor="nw-name">Workspace name</label><input id="nw-name" className="input" placeholder="e.g. Acme" value={name} onChange={(e) => setName(e.target.value)} required /></div>
          <button className="btn-primary w-full" disabled={busy || name.trim().length < 2}>Create workspace</button>
        </form>
        <p className="mt-4 text-center text-xs"><button className="text-slate-400 hover:underline" onClick={() => void logout()}>Sign out</button></p>
      </div>
    </div>
  );
}
