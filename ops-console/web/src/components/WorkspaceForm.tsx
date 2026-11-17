import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { Alert } from './ui';

/** Settings → Workspace: its name (multi-customer mode). */
export function WorkspaceForm() {
  const [name, setName] = useState('');
  const [saved, setSaved] = useState('');
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  useEffect(() => {
    api.workspaces().then((r) => { const w = r.workspaces.find((x) => x.id === r.current); if (w) { setName(w.name); setSaved(w.name); } }).catch(() => undefined);
  }, []);
  return (
    <section className="card space-y-4">
      <div>
        <h2 className="font-medium text-slate-100">Workspace</h2>
        <p className="mt-1 text-sm text-slate-400">Shown to your team and in invitation emails.</p>
      </div>
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      <form className="flex flex-wrap items-end gap-3" onSubmit={async (e) => {
        e.preventDefault(); setMsg(null);
        try { const r = await api.renameWorkspace(name.trim()); setSaved(r.name); setMsg({ tone: 'ok', text: 'Saved.' }); }
        catch (e2) { setMsg({ tone: 'bad', text: e2 instanceof ApiError ? e2.message : 'Saving failed.' }); }
      }}>
        <div className="min-w-[16rem] flex-1"><label className="label" htmlFor="ws-name">Name</label><input id="ws-name" className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} /></div>
        <button className="btn-primary" disabled={name.trim() === saved || name.trim().length < 2}>Save</button>
      </form>
    </section>
  );
}
