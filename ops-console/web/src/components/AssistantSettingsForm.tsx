import { useEffect, useState } from 'react';
import { api, ApiError, AssistantProvider, AssistantSettingsView } from '../api';
import { useDialog } from './Dialog';
import { Alert } from './ui';

/**
 * AI Console → Ask Ops Console: the workspace's own AI provider. An admin chooses Claude (Anthropic) or ChatGPT (OpenAI),
 * pastes an API key (checked with the provider, stored in the workspace's AWS account, never shown again) and picks a model.
 */
const KEY_HELP: Record<AssistantProvider, { url: string; label: string; placeholder: string }> = {
  anthropic: { url: 'https://console.anthropic.com/settings/keys', label: 'console.anthropic.com → API keys', placeholder: 'sk-ant-…' },
  openai: { url: 'https://platform.openai.com/api-keys', label: 'platform.openai.com → API keys', placeholder: 'sk-…' },
};
const fmt = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

export function AssistantSettingsForm() {
  const dialog = useDialog();
  const [view, setView] = useState<AssistantSettingsView | null>(null);
  const [provider, setProvider] = useState<AssistantProvider>('anthropic');
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState<string[] | null>(null);
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const err = (e: unknown, fallback: string) => setMsg({ tone: 'bad', text: e instanceof ApiError ? e.message : fallback });

  const load = () => api.assistantSettings().then((v) => {
    setView(v);
    if (v.settings) { setProvider(v.settings.provider); setModel(v.settings.model); }
  }).catch((e) => err(e, 'Could not load the assistant settings.'));
  useEffect(() => { void load(); }, []);

  const saved = view?.settings ?? null;
  const sameProvider = !!saved && saved.provider === provider;
  const needKey = !sameProvider;

  // a saved provider: list its models with the stored key
  useEffect(() => {
    setModels(null);
    if (sameProvider) api.assistantModels(provider).then((r) => setModels(r.models)).catch(() => setModels([saved!.model]));
  }, [provider, sameProvider]); // eslint-disable-line react-hooks/exhaustive-deps

  async function checkKey() {
    setBusy(true); setMsg(null);
    try {
      const r = await api.assistantModels(provider, apiKey.trim());
      setModels(r.models);
      setModel(r.suggested ?? (r.models.includes(model) ? model : ''));
      setMsg({ tone: 'ok', text: `Key accepted: ${r.models.length} model${r.models.length === 1 ? '' : 's'} available. Choose one and save.` });
    } catch (e) { setModels(null); err(e, 'Checking the key failed.'); }
    finally { setBusy(false); }
  }
  async function save() {
    setBusy(true); setMsg(null);
    try {
      const s = await api.saveAssistantSettings({ provider, model, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) });
      setApiKey('');
      await load();
      setMsg({ tone: 'ok', text: `Ask Ops Console now uses ${view?.providers[s.provider] ?? s.provider} (${s.model}).` });
    } catch (e) { err(e, 'Saving failed.'); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!(await dialog.confirm({ title: 'Turn off Ask Ops Console?', body: 'The API key is deleted from the workspace\'s AWS account and nobody in the workspace can ask questions until a key is added again. Past chats are kept.', confirmLabel: 'Turn off', danger: true }))) return;
    setBusy(true); setMsg(null);
    try { await api.removeAssistantSettings(); setModels(null); setModel(''); setApiKey(''); await load(); setMsg({ tone: 'ok', text: 'Ask Ops Console is off and the key was deleted.' }); }
    catch (e) { err(e, 'Removing failed.'); }
    finally { setBusy(false); }
  }

  const canSave = !!model && !!models?.includes(model) && (needKey ? !!apiKey.trim() : true) && (!saved || model !== saved.model || provider !== saved.provider || !!apiKey.trim());
  const help = KEY_HELP[provider];
  return (
    <section id="assistant" className="card space-y-4">
      <div>
        <h2 className="font-medium text-slate-100">Ask Ops Console</h2>
        <p className="mt-1 text-sm text-slate-400">
          The in-app assistant answers questions about this workspace using the workspace&rsquo;s own AI provider account, which bills usage directly.
          The key is checked with the provider, stored encrypted in the workspace&rsquo;s AWS account (Parameter Store) and never shown again.
        </p>
      </div>
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      {saved && (
        <p className="text-sm text-slate-300">
          On: <b className="text-slate-100">{view?.providers[saved.provider]}</b> · <code className="font-mono text-xs">{saved.model}</code> · key ending <code className="font-mono text-xs">…{saved.keyLast4}</code>
          <span className="text-slate-500"> · set by {saved.updatedBy}</span>
          {view && <span className="block text-xs text-slate-500">This month: {view.usage.questions} question{view.usage.questions === 1 ? '' : 's'}, {fmt(view.usage.inputTokens + view.usage.cachedTokens)} input tokens ({fmt(view.usage.cachedTokens)} cached), {fmt(view.usage.outputTokens)} output tokens.</span>}
        </p>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <span className="label">Provider</span>
          <div className="mt-1 flex gap-2">
            {(['anthropic', 'openai'] as const).map((p) => (
              <button key={p} type="button" className={`flex-1 rounded-lg border px-3 py-2 text-sm ${provider === p ? 'border-indigo-400 bg-indigo-500/15 text-slate-100' : 'border-ink-600 text-slate-400 hover:border-ink-500'}`}
                      onClick={() => { setProvider(p); setApiKey(''); setMsg(null); if (!(saved?.provider === p)) { setModels(null); setModel(''); } else setModel(saved.model); }}>
                {view?.providers[p] ?? p}
              </button>
            ))}
          </div>
        </div>
        <label className="block">
          <span className="label">API key {sameProvider && <span className="text-slate-500">(leave empty to keep …{saved!.keyLast4})</span>}</span>
          <div className="mt-1 flex gap-2">
            <input className="input flex-1 font-mono" type="password" autoComplete="off" spellCheck={false} placeholder={help.placeholder} value={apiKey}
                   onChange={(e) => { setApiKey(e.target.value); if (!sameProvider) setModels(null); }} />
            <button type="button" className="btn-ghost" disabled={busy || !apiKey.trim()} onClick={() => void checkKey()}>Check key</button>
          </div>
          <span className="mt-1 block text-xs text-slate-500">Create one at <a className="text-indigo-300 hover:text-indigo-200" href={help.url} target="_blank" rel="noreferrer">{help.label}</a>. A key limited to this use, with a monthly spend limit, is recommended.</span>
        </label>
      </div>
      {models && (
        <label className="block md:w-1/2">
          <span className="label">Model</span>
          <select className="input mt-1" value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="" disabled>Choose a model</option>
            {models.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          {provider === 'anthropic' && <span className="mt-1 block text-xs text-slate-500">Opus is the most capable; Haiku is the fastest and cheapest.</span>}
          {provider === 'openai' && <span className="mt-1 block text-xs text-slate-500">The models this key can use, newest first. Choose one that supports tool (function) calling.</span>}
        </label>
      )}
      <div className="flex flex-wrap gap-2">
        <button className="btn-primary" disabled={busy || !canSave} onClick={() => void save()}>{busy ? 'Working…' : saved ? 'Save changes' : 'Turn on'}</button>
        {saved && <button className="btn-ghost text-rose-300" disabled={busy} onClick={() => void remove()}>Turn off and delete key</button>}
      </div>
      <p className="text-xs text-slate-500">Questions and the workspace data looked up to answer them are sent to the chosen provider. Answers are read-only: the assistant can&rsquo;t change anything. Not available in the demo.</p>
    </section>
  );
}
