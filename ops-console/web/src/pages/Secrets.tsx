import { useEffect, useState } from 'react';
import { api, ApiError, Instance } from '../api';
import { useAuth } from '../auth';
import { ago, Alert, DesktopOnly, Kpi, PageHeader, Skeleton } from '../components/ui';

type Kind = 'db' | 'jwt' | 'provider' | 'secret' | 'config';
interface Secret { name: string; key: string; type: string; version: number; lastModified: string | null; lastModifiedBy: string | null; kind: Kind; ageDays: number | null; stale: boolean }
interface Inv { apps: { project: string; service: string; dbRole: string | null; hasJwt: boolean; secrets: Secret[] }[]; dbRoles: { role: string; usedBy: string[] }[]; staleDays: number; dryRun: boolean }
const KIND: Record<Kind, [string, string]> = {
  db: ['pill-info', 'database'], jwt: ['pill-info', 'signing key'], provider: ['pill-warn', 'provider key'], secret: ['pill-warn', 'secret'], config: ['pill-mute', 'config'],
};
const err = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong.');

function Modal({ title, danger, children, onClose }: { title: string; danger?: boolean; children: React.ReactNode; onClose: () => void }) {
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); document.addEventListener('keydown', k); return () => document.removeEventListener('keydown', k); }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/60 p-4 backdrop-blur-sm" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" className={`w-full max-w-md rounded-2xl border bg-ink-850 p-5 shadow-2xl shadow-black/60 ${danger ? 'border-rose-500/40' : 'border-ink-600'}`}>
        <h2 className="text-base font-semibold text-slate-100">{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function Secrets() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin' && !user.isDemo;
  const [instances, setInstances] = useState<Instance[] | null>(null);
  const [instId, setInstId] = useState<number | null>(null);
  const [inv, setInv] = useState<Inv | null>(null);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad' | 'warn'; text: string } | null>(null);
  const [rotateT, setRotateT] = useState<{ kind: 'db-password' | 'jwt'; target: string; usedBy: string[] } | null>(null);
  const [editT, setEditT] = useState<{ service: string; key: string } | null>(null);
  const [confirm, setConfirm] = useState('');
  const [value, setValue] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [modalErr, setModalErr] = useState<string | null>(null);

  useEffect(() => { api.instances().then((xs) => { setInstances(xs); setInstId(xs.find((x) => x.status?.apps.length)?.id ?? xs[0]?.id ?? null); }).catch((e) => setMsg({ tone: 'bad', text: err(e) })); }, []);
  const load = async () => {
    if (instId == null) return;
    setLoading(true);
    try { setInv(await api.secrets(instId) as Inv); } catch (e) { setMsg({ tone: 'bad', text: err(e) }); } finally { setLoading(false); }
  };
  useEffect(() => { setInv(null); void load(); }, [instId]);   // eslint-disable-line react-hooks/exhaustive-deps

  const closeModals = () => { setRotateT(null); setEditT(null); setConfirm(''); setValue(''); setShow(false); setModalErr(null); };
  async function doRotate() {
    setBusy(true); setModalErr(null);
    try {
      const r = await api.rotateSecret(instId!, rotateT!.kind, rotateT!.target, confirm);
      closeModals();
      setMsg({ tone: 'ok', text: r.dryRun ? 'Dry run (local test mode): nothing was changed.' : `Rotated. Updated ${r.updated.length} parameter(s); restarted ${r.restarted.join(', ')}; all healthy.` });
      await load();
    } catch (e) { setModalErr(err(e)); } finally { setBusy(false); }
  }
  async function doUpdate() {
    setBusy(true); setModalErr(null);
    try {
      const r = await api.updateSecret(instId!, editT!.service, editT!.key, value);
      closeModals();
      setMsg({ tone: 'ok', text: r.dryRun ? 'Dry run (local test mode): nothing was written.' : `${r.name} updated; ${editT?.service ?? 'the app'} restarted and is healthy.` });
      await load();
    } catch (e) { setModalErr(err(e)); } finally { setBusy(false); }
  }

  const all = inv?.apps.flatMap((a) => a.secrets) ?? [];
  const stale = all.filter((s) => s.stale);
  return (
    <div>
      <PageHeader title="Secrets" subtitle="Names, versions and ages from AWS SSM Parameter Store. Values are never shown."
        actions={instances && instances.length > 1 && (
          <select aria-label="Instance" className="input w-auto" value={instId ?? ''} onChange={(e) => setInstId(Number(e.target.value))}>
            {instances.map((i) => <option key={i.id} value={i.id}>{i.name} ({i.region})</option>)}
          </select>
        )} />
      <DesktopOnly title="Secrets" />
      <div className="hidden space-y-5 md:block">
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        {inv?.dryRun && <Alert tone="warn">Local test mode: rotations and updates are simulated; nothing is written to AWS.</Alert>}
        {!inv ? (loading ? <Skeleton className="h-64" /> : null) : (
          <>
            <div className="grid grid-cols-4 gap-3">
              <Kpi label="Parameters" tone="info" value={all.length} unit={`${inv.apps.length} apps`} />
              <Kpi label="Overdue" tone={stale.length ? 'warn' : 'ok'} value={stale.length} unit={`secrets older than ${inv.staleDays} days`} />
              <Kpi label="Provider keys" tone="info" value={all.filter((s) => s.kind === 'provider').length} unit="rotated at the provider" />
              <Kpi label="Oldest secret" tone={stale.length ? 'warn' : 'ok'} value={`${Math.max(0, ...all.filter((s) => s.kind !== 'config').map((s) => s.ageDays ?? 0))}d`} unit="since last change" />
            </div>

            <section className="card">
              <h2 className="font-medium text-slate-100">Database passwords</h2>
              <p className="mt-1 text-sm text-slate-500">
                A rotation generates a new password on the instance, updates every app that uses the role, restarts them and checks their health.
                If any app fails, everything is put back automatically.
              </p>
              <ul className="mt-4 space-y-2">
                {inv.dbRoles.map((r) => {
                  const url = inv.apps.find((a) => a.dbRole === r.role)?.secrets.find((s) => s.key === 'DATABASE_URL');
                  return (
                    <li key={r.role} className="flex items-center gap-3 rounded-lg border border-ink-700 px-4 py-3">
                      <span className="num text-sm font-medium text-slate-100">{r.role}</span>
                      <span className="min-w-0 flex-1 truncate text-sm text-slate-400">used by {r.usedBy.join(', ')}</span>
                      <span className={`text-xs ${url?.stale ? 'text-amber-300' : 'text-slate-500'}`}>changed {ago(url?.lastModified)}</span>
                      {isAdmin && <button className="btn-secondary px-3 py-1.5 text-xs" onClick={() => setRotateT({ kind: 'db-password', target: r.role, usedBy: r.usedBy })}>Rotate</button>}
                    </li>
                  );
                })}
                {inv.dbRoles.length === 0 && <li className="text-sm text-slate-500">No app database roles found.</li>}
              </ul>
            </section>

            {inv.apps.map((a) => (
              <section key={a.service} className="card overflow-hidden p-0">
                <div className="flex items-baseline justify-between px-5 py-4">
                  <h2 className="font-medium text-slate-100">{a.project} <span className="num ml-1 text-xs font-normal text-slate-500">/apps/{a.service}/</span></h2>
                  <span className="text-xs text-slate-500">{a.secrets.length} parameters</span>
                </div>
                <table className="tbl">
                  <thead><tr><th className="w-[30%]">Name</th><th className="w-[14%]">Kind</th><th className="w-[8%] text-right">Ver.</th><th className="w-[22%]">Last changed</th><th className="w-[10%] text-right">Age</th><th className="text-right">{isAdmin ? 'Action' : ''}</th></tr></thead>
                  <tbody>{a.secrets.map((s) => (
                    <tr key={s.name}>
                      <td className="num text-xs text-slate-200" title={s.name}>{s.key}</td>
                      <td><span className={KIND[s.kind][0]}>{KIND[s.kind][1]}</span></td>
                      <td className="num text-right">v{s.version}</td>
                      <td title={s.lastModified ?? ''}>{ago(s.lastModified)}{s.lastModifiedBy ? <span className="text-slate-500"> · {s.lastModifiedBy}</span> : ''}</td>
                      <td className={`num text-right ${s.stale ? 'text-amber-300' : ''}`}>{s.ageDays ?? '—'}d</td>
                      <td className="text-right">
                        {isAdmin && (s.kind === 'jwt'
                          ? <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setRotateT({ kind: 'jwt', target: a.service, usedBy: [a.project] })}>Rotate</button>
                          : s.kind === 'db' ? <span className="text-2xs text-slate-500">via database password</span>
                          : <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setEditT({ service: a.service, key: s.key })}>Replace value</button>)}
                      </td>
                    </tr>
                  ))}</tbody>
                </table>
              </section>
            ))}
            <p className="text-xs text-slate-500">
              Provider keys (Paystack, Sentry, Mapbox…) are issued by the provider: create the new key there, then “Replace value” here.
              The app is restarted and health-checked; if it fails, the old value is restored. Revoke the old key at the provider afterwards.
            </p>
          </>
        )}
      </div>

      {rotateT && (
        <Modal title={rotateT.kind === 'jwt' ? `Rotate the JWT secret of ${rotateT.usedBy[0]}?` : `Rotate the password of ${rotateT.target}?`} danger onClose={closeModals}>
          <p className="mt-2 text-sm text-slate-300">
            {rotateT.kind === 'jwt'
              ? <>Everyone signed in to <b>{rotateT.usedBy[0]}</b> is signed out and must sign in again. The app restarts (a few seconds of downtime).</>
              : <>Generates a new password for <b>{rotateT.target}</b>, updates and restarts <b>{rotateT.usedBy.join(', ')}</b> (a few seconds of downtime each) and the server's backup credentials. Restored automatically if any app fails its health check.</>}
          </p>
          <label className="label mt-4" htmlFor="rot-confirm">Type <span className="font-mono text-slate-200">{rotateT.target}</span> to confirm</label>
          <input id="rot-confirm" className="input" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" spellCheck={false} autoFocus />
          {modalErr && <div className="mt-3"><Alert>{modalErr}</Alert></div>}
          <div className="mt-5 flex justify-end gap-2">
            <button className="btn-ghost" onClick={closeModals} disabled={busy}>Cancel</button>
            <button className="btn-danger" onClick={() => void doRotate()} disabled={busy || confirm !== rotateT.target}>{busy ? 'Rotating… (up to a minute)' : 'Rotate now'}</button>
          </div>
        </Modal>
      )}
      {editT && (
        <Modal title={`Replace ${editT.key}`} onClose={closeModals}>
          <p className="mt-1 num text-xs text-slate-500">/apps/{editT.service}/{editT.key}</p>
          <p className="mt-3 text-sm text-slate-300">The new value is saved to SSM (encrypted), then {editT.service} restarts and is health-checked. If it fails, the previous value is put back.</p>
          <label className="label mt-4" htmlFor="sec-value">New value</label>
          <div className="flex gap-2">
            <input id="sec-value" type={show ? 'text' : 'password'} className="input font-mono" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="off" spellCheck={false} autoFocus />
            <button type="button" className="btn-ghost px-3 text-xs" onClick={() => setShow((x) => !x)}>{show ? 'Hide' : 'Show'}</button>
          </div>
          {modalErr && <div className="mt-3"><Alert>{modalErr}</Alert></div>}
          <div className="mt-5 flex justify-end gap-2">
            <button className="btn-ghost" onClick={closeModals} disabled={busy}>Cancel</button>
            <button className="btn-primary" onClick={() => void doUpdate()} disabled={busy || !value}>{busy ? 'Saving and restarting…' : 'Save and restart'}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
