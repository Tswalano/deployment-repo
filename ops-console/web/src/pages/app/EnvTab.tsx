import { FormEvent, useEffect, useState } from 'react';
import { api, EnvVar } from '../../api';
import { ago, Alert, Skeleton } from '../../components/ui';
import { errMsg } from './shared';
import { useDialog } from '../../components/Dialog';

const KIND: Record<EnvVar['kind'], [string, string]> = {
  db: ['pill-info', 'database'], jwt: ['pill-info', 'signing key'], provider: ['pill-warn', 'API key'], secret: ['pill-warn', 'secret'], config: ['pill-mute', 'setting'],
};

/** An app's environment variables: add, change, reveal, remove (saved to SSM; the app restarts; undone if it fails). */
export function EnvTab({ instanceId, project, isAdmin }: { instanceId: number; project: string; isAdmin: boolean }) {
  const dialog = useDialog();
  const [data, setData] = useState<Awaited<ReturnType<typeof api.env>> | null>(null);
  const [shown, setShown] = useState<Record<string, string>>({});
  const [edit, setEdit] = useState<string | null>(null);
  const [editVal, setEditVal] = useState('');
  const [newKey, setNewKey] = useState('');
  const [newVal, setNewVal] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const load = async () => { try { setData(await api.env(instanceId, project)); } catch (e) { setMsg({ tone: 'bad', text: errMsg(e) }); } };
  useEffect(() => { void load(); }, [instanceId, project]);   // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (key: string, fn: () => Promise<{ verb?: string; dryRun?: boolean }>, text: string) => {
    setBusy(key); setMsg(null);
    try { const r = await fn(); setMsg({ tone: 'ok', text: `${text}${r?.dryRun ? ' (local test mode: nothing was written)' : ''}` }); setShown({}); setEdit(null); await load(); }
    catch (e) { setMsg({ tone: 'bad', text: errMsg(e) }); } finally { setBusy(null); }
  };
  const add = (e: FormEvent) => {
    e.preventDefault();
    const key = newKey.trim().toUpperCase();
    void run('__new', () => api.setEnv(instanceId, project, key, newVal), `${key} added; ${project} restarted.`).then(() => { setNewKey(''); setNewVal(''); });
  };

  if (!data) return msg ? <Alert tone={msg.tone}>{msg.text}</Alert> : <Skeleton className="h-64" />;
  return (
    <div className="space-y-5">
      <section className="card overflow-hidden p-0">
        <div className="flex flex-wrap items-baseline justify-between gap-2 px-5 py-4">
          <div>
            <h2 className="font-medium text-slate-100">Environment variables</h2>
            <p className="text-xs text-slate-500">Encrypted in AWS SSM (/apps/{data.service}/). Saving a change restarts {project}; if it doesn't come back healthy, the change is undone.</p>
          </div>
          <span className="text-xs text-slate-500">{data.vars.length} variables</span>
        </div>
        <table className="tbl">
          <thead><tr><th className="w-[28%]">Name</th><th className="w-[12%]">Type</th><th>Value</th><th className="w-[16%]">Changed</th><th className="w-[20%] text-right">{isAdmin ? 'Actions' : ''}</th></tr></thead>
          <tbody>{data.vars.map((v) => (
            <tr key={v.key}>
              <td className="num text-xs text-slate-100" title={v.key}>{v.key}</td>
              <td><span className={KIND[v.kind][0]}>{KIND[v.kind][1]}</span></td>
              <td className="num text-xs">
                {edit === v.key ? (
                  <input className="input py-1 font-mono text-xs" value={editVal} onChange={(e) => setEditVal(e.target.value)} autoFocus spellCheck={false} />
                ) : shown[v.key] !== undefined ? (
                  <span className="flex items-center gap-2"><span className="truncate text-slate-200" title={shown[v.key]}>{shown[v.key]}</span>
                    <button className="btn-ghost shrink-0 px-2 py-0.5 text-2xs" onClick={() => void navigator.clipboard?.writeText(shown[v.key])}>copy</button></span>
                ) : <span className="text-slate-600">••••••••</span>}
              </td>
              <td title={v.lastModified ?? ''}>{ago(v.lastModified)}</td>
              <td className="text-right">
                {isAdmin && (edit === v.key ? (
                  <span className="flex justify-end gap-1.5">
                    <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setEdit(null)}>Cancel</button>
                    <button className="btn-primary px-2 py-1 text-xs" disabled={busy !== null || !editVal}
                            onClick={() => void run(v.key, () => api.setEnv(instanceId, project, v.key, editVal), `${v.key} changed; ${project} restarted.`)}>{busy === v.key ? 'Saving…' : 'Save'}</button>
                  </span>
                ) : (
                  <span className="flex justify-end gap-1.5">
                    {shown[v.key] === undefined
                      ? <button className="btn-ghost px-2 py-1 text-xs" onClick={async () => { try { const val = await api.revealEnv(instanceId, project, v.key); setShown({ ...shown, [v.key]: val }); } catch (e) { setMsg({ tone: 'bad', text: errMsg(e) }); } }}>Reveal</button>
                      : <button className="btn-ghost px-2 py-1 text-xs" onClick={() => { const n = { ...shown }; delete n[v.key]; setShown(n); }}>Hide</button>}
                    {v.generated ? (
                      <button className="btn-ghost px-2 py-1 text-xs" disabled={busy !== null || (v.kind === 'db' && !data.dbRole)} onClick={async () => {
                        const target = v.kind === 'db' ? data.dbRole! : data.service;
                        const ok = await dialog.prompt({
                          title: v.kind === 'jwt' ? 'Rotate the JWT secret?' : `Rotate the database password of ${target}?`,
                          body: v.kind === 'jwt' ? `Everyone signed in to ${project} is signed out.` : 'Every app using it restarts with the new password.',
                          label: `Type ${target} to confirm`, placeholder: target, confirmLabel: 'Rotate', danger: true });
                        if (ok === target) void run(v.key, () => api.rotateSecret(instanceId, v.kind === 'jwt' ? 'jwt' : 'db-password', target, ok) as Promise<{ dryRun?: boolean }>, 'Rotated; the apps restarted and are healthy.');
                      }}>Rotate</button>
                    ) : (
                      <>
                        <button className="btn-ghost px-2 py-1 text-xs" onClick={async () => { try { setEditVal(await api.revealEnv(instanceId, project, v.key)); setEdit(v.key); } catch (e) { setMsg({ tone: 'bad', text: errMsg(e) }); } }}>Edit</button>
                        <button className="btn-ghost px-2 py-1 text-xs text-rose-300" disabled={busy !== null} onClick={async () => {
                          if (await dialog.confirm({ title: `Remove ${v.key}?`, body: `${project} restarts without it.`, confirmLabel: 'Remove', danger: true })) void run(v.key, () => api.removeEnv(instanceId, project, v.key), `${v.key} removed; ${project} restarted.`);
                        }}>Remove</button>
                      </>
                    )}
                  </span>
                ))}
              </td>
            </tr>
          ))}</tbody>
        </table>
      </section>
      {isAdmin && (
        <form onSubmit={add} className="card">
          <h2 className="font-medium text-slate-100">Add a variable</h2>
          <div className="mt-3 grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] md:items-end">
            <div><label className="label" htmlFor="env-k">Name</label><input id="env-k" className="input font-mono" placeholder="PAYSTACK_SECRET_KEY" value={newKey} onChange={(e) => setNewKey(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'))} maxLength={64} /></div>
            <div><label className="label" htmlFor="env-v">Value</label><input id="env-v" type="password" className="input font-mono" value={newVal} onChange={(e) => setNewVal(e.target.value)} autoComplete="off" spellCheck={false} /></div>
            <button className="btn-primary" disabled={busy !== null || !/^[A-Z][A-Z0-9_]*$/.test(newKey) || !newVal}>{busy === '__new' ? 'Saving…' : 'Add and restart'}</button>
          </div>
        </form>
      )}
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
    </div>
  );
}
