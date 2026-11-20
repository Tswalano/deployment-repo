import { useEffect, useState } from 'react';
import { Check, KeyRound, MessageSquare, Plus, Star, Trash2 } from 'lucide-react';
import { api, ApiError, AssistantChat, AssistantProvider, AssistantSettingsView, AssistantStatus } from '../api';
import { useAuth } from '../auth';
import { useDialog } from './Dialog';
import { smallIcon } from './icons';
import { ago, Alert } from './ui';

/**
 * AI Console → Ask Ops Console:
 *  - Models: what people can chat with (admins add models, choose the default, remove them)
 *  - API keys: one per provider (admins add, change or remove; checked with the provider, kept in the workspace's AWS account)
 *  - This month's usage (admins)
 *  - Your chat history: open, delete, clear all (everyone, their own chats only)
 */
const PROVIDERS: AssistantProvider[] = ['anthropic', 'openai'];
const NAMES: Record<AssistantProvider, string> = { anthropic: 'Claude (Anthropic)', openai: 'ChatGPT (OpenAI)' };
const KEY_HELP: Record<AssistantProvider, { url: string; label: string; placeholder: string }> = {
  anthropic: { url: 'https://console.anthropic.com/settings/keys', label: 'console.anthropic.com', placeholder: 'sk-ant-…' },
  openai: { url: 'https://platform.openai.com/api-keys', label: 'platform.openai.com', placeholder: 'sk-…' },
};
const fmt = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
const th = 'px-4 py-2.5 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500';
const td = 'px-4 py-3 align-middle';
export const openChat = (id: string) => window.dispatchEvent(new CustomEvent('ops:open-conversation', { detail: id }));

function Card({ title, sub, action, children }: { title: string; sub?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="card overflow-hidden p-0">
      <div className="flex flex-wrap items-center gap-3 px-5 py-4">
        <div className="min-w-0 flex-1"><h2 className="font-medium text-slate-100">{title}</h2>{sub && <p className="mt-0.5 text-sm text-slate-400">{sub}</p>}</div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function AssistantSettingsForm() {
  const { user } = useAuth();
  const admin = user?.role === 'admin';
  const dialog = useDialog();
  const [status, setStatus] = useState<AssistantStatus | null>(null);
  const [cfg, setCfg] = useState<AssistantSettingsView | null>(null);
  const [chats, setChats] = useState<AssistantChat[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  // add-model panel
  const [adding, setAdding] = useState(false);
  const [addProvider, setAddProvider] = useState<AssistantProvider>('anthropic');
  const [available, setAvailable] = useState<string[] | null>(null);
  const [addModel, setAddModel] = useState('');
  // key editing (one provider at a time)
  const [keyFor, setKeyFor] = useState<AssistantProvider | null>(null);
  const [keyValue, setKeyValue] = useState('');

  const fail = (e: unknown, fallback: string) => setMsg({ tone: 'bad', text: e instanceof ApiError ? e.message : fallback });
  const load = async () => {
    setStatus(await api.assistant().catch(() => ({ enabled: false })));
    setChats(await api.assistantChats().catch(() => []));
    if (admin) await api.assistantSettings().then(setCfg).catch((e) => fail(e, 'Could not load the configuration.'));
  };
  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const run = async (fn: () => Promise<unknown>, ok: string, fallback: string) => {
    setBusy(true); setMsg(null);
    try { await fn(); await load(); setMsg({ tone: 'ok', text: ok }); return true; } catch (e) { fail(e, fallback); return false; } finally { setBusy(false); }
  };

  const keyed = PROVIDERS.filter((p) => cfg?.keys[p]);
  // the add-model panel lists what the provider's stored key can use (models already added are left out)
  useEffect(() => {
    if (!adding) return;
    setAvailable(null); setAddModel('');
    if (!cfg?.keys[addProvider]) return;
    api.assistantModels(addProvider).then((r) => {
      const have = new Set(cfg.models.filter((m) => m.provider === addProvider).map((m) => m.model));
      const list = r.models.filter((m) => !have.has(m));
      setAvailable(list); setAddModel(r.suggested && list.includes(r.suggested) ? r.suggested : list[0] ?? '');
    }).catch((e) => { setAvailable([]); fail(e, 'Could not list the models.'); });
  }, [adding, addProvider]); // eslint-disable-line react-hooks/exhaustive-deps

  const models = admin ? cfg?.models ?? [] : status?.models ?? [];
  return (
    <div className="space-y-5">
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}

      {/* models */}
      <Card title="Models" sub={admin ? 'What people can chat with. New chats use the default; the chat window can start one with another model.' : 'What this workspace can chat with.'}
            action={admin && !adding && (
              <button className="btn-primary text-sm" disabled={!keyed.length} title={keyed.length ? undefined : 'Add an API key first'}
                      onClick={() => { setAdding(true); setAddProvider(keyed[0]); setMsg(null); }}>{smallIcon(Plus)}Add model</button>)}>
        {admin && adding && (
          <form className="flex flex-wrap items-end gap-3 border-t border-ink-700 bg-ink-850 px-5 py-4"
                onSubmit={(e) => { e.preventDefault(); void run(async () => { await api.addAssistantModel(addProvider, addModel); setAdding(false); }, `${addModel} added.`, 'Adding the model failed.'); }}>
            <label>
              <span className="label">Provider</span>
              <select className="input" value={addProvider} onChange={(e) => setAddProvider(e.target.value as AssistantProvider)}>
                {keyed.map((p) => <option key={p} value={p}>{NAMES[p]}</option>)}
              </select>
            </label>
            <label className="min-w-[14rem] flex-1">
              <span className="label">Model</span>
              <select className="input" value={addModel} disabled={!available?.length} onChange={(e) => setAddModel(e.target.value)}>
                {!available && <option>Loading the models…</option>}
                {available && !available.length && <option>Every model this key can use is added</option>}
                {available?.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </label>
            <button className="btn-primary" disabled={busy || !addModel || !available?.includes(addModel)}>{busy ? 'Adding…' : 'Add'}</button>
            <button type="button" className="btn-ghost" onClick={() => setAdding(false)}>Cancel</button>
          </form>
        )}
        <div className="overflow-x-auto border-t border-ink-700">
          <table className="w-full min-w-[36rem] text-sm">
            <thead className="bg-ink-850"><tr><th className={th}>Model</th><th className={th}>Provider</th><th className={th}>Default</th>{admin && <th className={th}>Added</th>}{admin && <th className={th}><span className="sr-only">Actions</span></th>}</tr></thead>
            <tbody className="divide-y divide-ink-700">
              {!models.length && <tr><td className={`${td} text-slate-500`} colSpan={admin ? 5 : 3}>
                {admin ? (keyed.length ? 'No models yet: select Add model.' : 'Add an API key below, then add a model.') : 'Not set up yet: a workspace admin can set it up here.'}
              </td></tr>}
              {models.map((m) => (
                <tr key={m.id}>
                  <td className={td}><code className="font-mono text-xs text-slate-100">{m.model}</code>{m.usable === false && <span className="ml-2 rounded border border-amber-400/40 px-1.5 py-0.5 text-2xs text-amber-300">needs its key</span>}</td>
                  <td className={`${td} text-slate-300`}>{m.providerName}</td>
                  <td className={td}>{m.isDefault
                    ? <span className="inline-flex items-center gap-1 rounded border border-emerald-500/40 px-1.5 py-0.5 text-2xs text-emerald-300">{smallIcon(Check, 'h-3 w-3')}Default</span>
                    : admin && <button className="btn-ghost px-2 py-1 text-xs" disabled={busy} onClick={() => void run(() => api.defaultAssistantModel(m.id), `${m.model} is now the default.`, 'That did not work.')}>{smallIcon(Star, 'h-3.5 w-3.5')}Make default</button>}</td>
                  {admin && <td className={`${td} text-slate-400`}>{m.addedBy}<span className="block text-2xs text-slate-500">{ago(m.addedAt)}</span></td>}
                  {admin && <td className={`${td} text-right`}><button className="btn-ghost px-2 py-1 text-xs text-rose-300" disabled={busy} onClick={async () => {
                    if (!(await dialog.confirm({ title: `Remove ${m.model}?`, body: 'People can no longer start chats with it. Existing chats move to another model of the same provider, if there is one.', confirmLabel: 'Remove', danger: true }))) return;
                    void run(() => api.removeAssistantModel(m.id), `${m.model} removed.`, 'Removing failed.');
                  }}>Remove</button></td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* API keys */}
      {admin && cfg && (
        <Card title="API keys" sub="One key per provider, billed by that provider. Checked before it is saved, kept encrypted in this workspace's AWS account (Parameter Store) and never shown again.">
          <div className="overflow-x-auto border-t border-ink-700">
            <table className="w-full min-w-[36rem] text-sm">
              <thead className="bg-ink-850"><tr><th className={th}>Provider</th><th className={th}>Key</th><th className={th}>Updated</th><th className={th}><span className="sr-only">Actions</span></th></tr></thead>
              <tbody className="divide-y divide-ink-700">
                {PROVIDERS.map((p) => {
                  const k = cfg.keys[p];
                  return (
                    <tr key={p}>
                      <td className={`${td} text-slate-100`}>{NAMES[p]}</td>
                      <td className={td}>{keyFor === p ? (
                        <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); void run(async () => { await api.setAssistantKey(p, keyValue.trim()); setKeyFor(null); setKeyValue(''); }, `${NAMES[p]} key ${k ? 'changed' : 'added'}.`, 'Saving the key failed.'); }}>
                          <input className="input w-64 font-mono" type="password" autoFocus autoComplete="off" spellCheck={false} placeholder={KEY_HELP[p].placeholder} value={keyValue} onChange={(e) => setKeyValue(e.target.value)} />
                          <button className="btn-primary px-3 py-1.5 text-xs" disabled={busy || !keyValue.trim()}>{busy ? 'Checking…' : 'Save'}</button>
                          <button type="button" className="btn-ghost px-3 py-1.5 text-xs" onClick={() => { setKeyFor(null); setKeyValue(''); }}>Cancel</button>
                          <span className="w-full text-2xs text-slate-500">Create one at <a className="text-indigo-300 hover:text-indigo-200" href={KEY_HELP[p].url} target="_blank" rel="noreferrer">{KEY_HELP[p].label}</a>; a monthly spend limit is a good idea.</span>
                        </form>
                      ) : k ? <span className="inline-flex items-center gap-1.5 font-mono text-xs text-slate-300">{smallIcon(KeyRound, 'h-3.5 w-3.5 text-slate-500')}…{k.last4}</span>
                        : <span className="text-slate-500">Not added</span>}</td>
                      <td className={`${td} text-slate-400`}>{k ? <>{k.updatedBy}<span className="block text-2xs text-slate-500">{ago(k.updatedAt)}</span></> : '—'}</td>
                      <td className={`${td} whitespace-nowrap text-right`}>{keyFor !== p && <>
                        <button className="btn-ghost px-2 py-1 text-xs" onClick={() => { setKeyFor(p); setKeyValue(''); setMsg(null); }}>{k ? 'Change key' : 'Add key'}</button>
                        {k && <button className="btn-ghost ml-1 px-2 py-1 text-xs text-rose-300" disabled={busy} onClick={async () => {
                          if (!(await dialog.confirm({ title: `Remove the ${NAMES[p]} key?`, body: `The key is deleted from the workspace's AWS account and its ${cfg.models.filter((m) => m.provider === p).length} model(s) are removed. Past chats are kept.`, confirmLabel: 'Remove', danger: true }))) return;
                          void run(() => api.removeAssistantKey(p), `${NAMES[p]} key removed.`, 'Removing failed.');
                        }}>Remove</button>}
                      </>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* usage */}
      {admin && cfg && (
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="card"><div className="text-2xs uppercase tracking-wider text-slate-500">Questions this month</div><div className="mt-1 text-xl font-semibold text-slate-100">{cfg.usage.questions}</div></div>
          <div className="card"><div className="text-2xs uppercase tracking-wider text-slate-500">Input tokens</div><div className="mt-1 text-xl font-semibold text-slate-100">{fmt(cfg.usage.inputTokens + cfg.usage.cachedTokens)}</div><div className="text-2xs text-slate-500">{fmt(cfg.usage.cachedTokens)} from the cache</div></div>
          <div className="card"><div className="text-2xs uppercase tracking-wider text-slate-500">Output tokens</div><div className="mt-1 text-xl font-semibold text-slate-100">{fmt(cfg.usage.outputTokens)}</div></div>
        </div>
      )}

      {/* chat history */}
      <Card title="Your chat history" sub="Only you see your chats. Open one to carry on in the chat window."
            action={!!chats?.length && <button className="btn-ghost text-sm text-rose-300" disabled={busy} onClick={async () => {
              if (!(await dialog.confirm({ title: 'Clear all your chats?', body: `All ${chats.length} of your chats are deleted. Proposals made in them stay under Proposals.`, confirmLabel: 'Clear all', danger: true }))) return;
              void run(() => api.clearAssistantChats(), 'Your chats were cleared.', 'Clearing failed.');
            }}>{smallIcon(Trash2)}Clear all</button>}>
        <div className="overflow-x-auto border-t border-ink-700">
          <table className="w-full min-w-[36rem] text-sm">
            <thead className="bg-ink-850"><tr><th className={th}>Chat</th><th className={th}>Model</th><th className={th}>Questions</th><th className={th}>Last activity</th><th className={th}><span className="sr-only">Actions</span></th></tr></thead>
            <tbody className="divide-y divide-ink-700">
              {chats && !chats.length && <tr><td className={`${td} text-slate-500`} colSpan={5}>No chats yet. Use the Ask Ops Console button at the bottom right of any page.</td></tr>}
              {chats?.map((c) => (
                <tr key={c.id}>
                  <td className={`${td} max-w-[22rem] truncate text-slate-100`} title={c.title}>{c.title}</td>
                  <td className={td}>{c.model ? <code className="font-mono text-xs text-slate-300">{c.model}</code> : <span className="text-slate-500">{NAMES[c.provider]}</span>}</td>
                  <td className={`${td} text-slate-400`}>{c.questions ?? '—'}</td>
                  <td className={`${td} text-slate-400`}>{ago(c.updatedAt)}</td>
                  <td className={`${td} whitespace-nowrap text-right`}>
                    <button className="btn-ghost px-2 py-1 text-xs" onClick={() => openChat(c.id)}>{smallIcon(MessageSquare, 'h-3.5 w-3.5')}Open</button>
                    <button className="btn-ghost ml-1 px-2 py-1 text-xs text-rose-300" disabled={busy} aria-label={`Delete ${c.title}`}
                            onClick={() => void run(() => api.deleteAssistantChat(c.id), 'Chat deleted.', 'Deleting failed.')}>{smallIcon(Trash2, 'h-3.5 w-3.5')}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <p className="text-xs text-slate-500">Questions and the workspace data looked up to answer them go to the chosen model&rsquo;s provider. Not available in the demo.</p>
    </div>
  );
}
