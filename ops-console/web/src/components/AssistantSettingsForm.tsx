import { useEffect, useState } from 'react';
import { Check, KeyRound, Pencil, Plus, Power } from 'lucide-react';
import { api, ApiError, AssistantProvider, AssistantSettingsView, AssistantStatus } from '../api';
import { useAuth } from '../auth';
import { useDialog } from './Dialog';
import { smallIcon } from './icons';
import { ago, Alert } from './ui';

/**
 * AI Console → Ask Ops Console: what the workspace's assistant runs on (a table), and, for admins, a panel to set or
 * change it: provider (Claude or ChatGPT), API key (checked with the provider, stored in the workspace's AWS account,
 * never shown again) and model.
 */
const KEY_HELP: Record<AssistantProvider, { url: string; label: string; placeholder: string }> = {
  anthropic: { url: 'https://console.anthropic.com/settings/keys', label: 'console.anthropic.com → API keys', placeholder: 'sk-ant-…' },
  openai: { url: 'https://platform.openai.com/api-keys', label: 'platform.openai.com → API keys', placeholder: 'sk-…' },
};
const PROVIDERS: Record<AssistantProvider, string> = { anthropic: 'Claude (Anthropic)', openai: 'ChatGPT (OpenAI)' };
const fmt = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
const th = 'px-4 py-2.5 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500';
const td = 'px-4 py-3 align-top';

export function AssistantSettingsForm() {
  const { user } = useAuth();
  const admin = user?.role === 'admin';
  const dialog = useDialog();
  const [status, setStatus] = useState<AssistantStatus | null>(null);
  const [view, setView] = useState<AssistantSettingsView | null>(null);
  const [editing, setEditing] = useState(false);
  const [provider, setProvider] = useState<AssistantProvider>('anthropic');
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState<string[] | null>(null);
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const err = (e: unknown, fallback: string) => setMsg({ tone: 'bad', text: e instanceof ApiError ? e.message : fallback });

  const load = async () => {
    setStatus(await api.assistant().catch(() => ({ enabled: false })));
    if (admin) await api.assistantSettings().then(setView).catch((e) => err(e, 'Could not load the settings.'));
  };
  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const saved = view?.settings ?? null;
  const sameProvider = !!saved && saved.provider === provider;

  function startEdit() {
    setMsg(null); setApiKey(''); setEditing(true);
    if (saved) { setProvider(saved.provider); setModel(saved.model); } else { setProvider('anthropic'); setModel(''); setModels(null); }
  }
  // the saved provider: list its models with the stored key
  useEffect(() => {
    if (!editing) return;
    setModels(null);
    if (sameProvider) api.assistantModels(provider).then((r) => setModels(r.models)).catch(() => setModels([saved!.model]));
  }, [editing, provider, sameProvider]); // eslint-disable-line react-hooks/exhaustive-deps

  async function checkKey() {
    setBusy(true); setMsg(null);
    try {
      const r = await api.assistantModels(provider, apiKey.trim());
      setModels(r.models);
      setModel(r.suggested ?? (r.models.includes(model) ? model : ''));
      setMsg({ tone: 'ok', text: `Key accepted: ${r.models.length} model${r.models.length === 1 ? '' : 's'} available.` });
    } catch (e) { setModels(null); err(e, 'Checking the key failed.'); }
    finally { setBusy(false); }
  }
  async function save() {
    setBusy(true); setMsg(null);
    try {
      const s = await api.saveAssistantSettings({ provider, model, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) });
      setApiKey(''); setEditing(false); await load();
      setMsg({ tone: 'ok', text: `Ask Ops Console now uses ${PROVIDERS[s.provider]}, ${s.model}.` });
    } catch (e) { err(e, 'Saving failed.'); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!(await dialog.confirm({ title: 'Turn off Ask Ops Console?', body: 'The API key is deleted from the workspace\'s AWS account and nobody in the workspace can ask questions until a key is added again. Past chats are kept.', confirmLabel: 'Turn off', danger: true }))) return;
    setBusy(true); setMsg(null);
    try { await api.removeAssistantSettings(); setEditing(false); await load(); setMsg({ tone: 'ok', text: 'Ask Ops Console is off and the key was deleted.' }); }
    catch (e) { err(e, 'Removing failed.'); }
    finally { setBusy(false); }
  }

  const canSave = !!model && !!models?.includes(model) && (sameProvider || !!apiKey.trim()) && (!saved || model !== saved.model || provider !== saved.provider || !!apiKey.trim());
  const help = KEY_HELP[provider];
  const enabled = status?.enabled ?? false;
  return (
    <div className="space-y-5">
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}

      <section className="card overflow-hidden p-0">
        <div className="flex flex-wrap items-center gap-3 px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 className="font-medium text-slate-100">Configuration</h2>
            <p className="mt-0.5 text-sm text-slate-400">The AI provider account the chat uses. It bills usage directly; the key stays in this workspace&rsquo;s AWS account.</p>
          </div>
          {admin && !editing && (enabled
            ? <button className="btn-ghost text-sm" onClick={startEdit}>{smallIcon(Pencil)}Change</button>
            : <button className="btn-primary text-sm" onClick={startEdit}>{smallIcon(Plus)}Set up</button>)}
        </div>
        <div className="overflow-x-auto border-t border-ink-700">
          <table className="w-full min-w-[40rem] text-sm">
            <thead className="bg-ink-850">
              <tr><th className={th}>Status</th><th className={th}>Provider</th><th className={th}>Model</th>{admin && <th className={th}>API key</th>}{admin && <th className={th}>Set by</th>}{admin && <th className={th}>This month</th>}</tr>
            </thead>
            <tbody>
              {enabled ? (
                <tr>
                  <td className={td}><span className="inline-flex items-center gap-1.5 rounded border border-emerald-500/40 px-1.5 py-0.5 text-2xs text-emerald-300">{smallIcon(Check, 'h-3 w-3')}On</span></td>
                  <td className={`${td} text-slate-100`}>{status?.providerName}</td>
                  <td className={td}><code className="font-mono text-xs text-slate-200">{status?.model}</code></td>
                  {admin && <td className={td}><span className="inline-flex items-center gap-1.5 font-mono text-xs text-slate-300">{smallIcon(KeyRound, 'h-3.5 w-3.5 text-slate-500')}…{saved?.keyLast4}</span></td>}
                  {admin && <td className={`${td} text-slate-400`}>{saved ? <>{saved.updatedBy}<span className="block text-2xs text-slate-500">{ago(saved.updatedAt)}</span></> : '—'}</td>}
                  {admin && <td className={`${td} text-slate-400`}>{view ? <>{view.usage.questions} question{view.usage.questions === 1 ? '' : 's'}
                    <span className="block text-2xs text-slate-500">{fmt(view.usage.inputTokens + view.usage.cachedTokens)} in ({fmt(view.usage.cachedTokens)} cached) · {fmt(view.usage.outputTokens)} out</span></> : '—'}</td>}
                </tr>
              ) : (
                <tr><td className={`${td} text-slate-500`} colSpan={admin ? 6 : 3}>
                  Not set up yet. {admin ? 'Select Set up to choose Claude or ChatGPT and add an API key.' : 'A workspace admin can set it up here.'}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
        {admin && enabled && !editing && (
          <div className="flex justify-end border-t border-ink-700 px-5 py-3">
            <button className="btn-ghost text-xs text-rose-300" disabled={busy} onClick={() => void remove()}>{smallIcon(Power, 'h-3.5 w-3.5')}Turn off and delete key</button>
          </div>
        )}
      </section>

      {admin && editing && (
        <section className="card space-y-5">
          <div>
            <h2 className="font-medium text-slate-100">{saved ? 'Change the configuration' : 'Set up Ask Ops Console'}</h2>
            <p className="mt-0.5 text-sm text-slate-400">The key is checked with the provider before anything is saved.</p>
          </div>
          <div className="grid gap-5 md:grid-cols-3">
            <div>
              <span className="label">1 · Provider</span>
              <div className="grid gap-2">
                {(['anthropic', 'openai'] as const).map((p) => (
                  <button key={p} type="button" onClick={() => { setProvider(p); setApiKey(''); setMsg(null); if (saved?.provider === p) setModel(saved.model); else { setModels(null); setModel(''); } }}
                          className={`flex items-center justify-between rounded-lg border px-3 py-2 text-left text-sm ${provider === p ? 'border-indigo-400 bg-indigo-500/15 text-slate-100' : 'border-ink-600 text-slate-400 hover:border-ink-500'}`}>
                    {PROVIDERS[p]}{provider === p && <Check className="h-4 w-4 text-indigo-300" aria-hidden />}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="label" htmlFor="ai-key">2 · API key {sameProvider && <span className="text-slate-500">(empty keeps …{saved!.keyLast4})</span>}</label>
              <input id="ai-key" className="input font-mono" type="password" autoComplete="off" spellCheck={false} placeholder={help.placeholder} value={apiKey}
                     onChange={(e) => { setApiKey(e.target.value); if (!sameProvider) setModels(null); }} />
              <button type="button" className="btn-ghost mt-2 w-full text-sm" disabled={busy || !apiKey.trim()} onClick={() => void checkKey()}>Check key</button>
              <span className="mt-1.5 block text-xs text-slate-500">From <a className="text-indigo-300 hover:text-indigo-200" href={help.url} target="_blank" rel="noreferrer">{help.label}</a>. A key with a monthly spend limit is best.</span>
            </div>
            <div>
              <label className="label" htmlFor="ai-model">3 · Model</label>
              <select id="ai-model" className="input" value={model} disabled={!models} onChange={(e) => setModel(e.target.value)}>
                <option value="" disabled>{models ? 'Choose a model' : 'Check the key first'}</option>
                {models?.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
              <span className="mt-1.5 block text-xs text-slate-500">
                {provider === 'anthropic' ? 'Opus is the most capable; Haiku the fastest and cheapest.' : 'The models this key can use, newest first. Choose one that supports tool calling.'}
              </span>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 border-t border-ink-700 pt-4">
            <button className="btn-primary" disabled={busy || !canSave} onClick={() => void save()}>{busy ? 'Working…' : saved ? 'Save changes' : 'Turn on'}</button>
            <button className="btn-ghost" disabled={busy} onClick={() => { setEditing(false); setMsg(null); }}>Cancel</button>
          </div>
        </section>
      )}

      <p className="text-xs text-slate-500">
        Questions and the workspace data looked up to answer them go to the chosen provider. The chat opens from the floating button on every page; it can look things up and prepare changes for you to confirm under Proposals. Not available in the demo.
      </p>
    </div>
  );
}
