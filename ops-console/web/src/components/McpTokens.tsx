import { useEffect, useState } from 'react';
import { ChevronDown, Copy as CopyIcon, Plus } from 'lucide-react';
import { api, ApiError, McpToken, McpView } from '../api';
import { useDialog } from './Dialog';
import { smallIcon } from './icons';
import { ago, Alert } from './ui';

/**
 * AI Console → MCP server: how AI tools connect (address, sign-in, tokens), the personal tokens and connected apps
 * (tables), and what the tools can do. A token is shown once; tools act with the owner's role.
 */
type Client = 'claude-code' | 'claude-desktop' | 'json';
const CLIENTS: { id: Client; label: string }[] = [
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'claude-desktop', label: 'Claude Desktop' },
  { id: 'json', label: 'Cursor / VS Code / other' },
];
function snippet(client: Client, url: string, token: string): string {
  if (client === 'claude-code') return `claude mcp add --transport http ops-console ${url} \\\n  --header "Authorization: Bearer ${token}"`;
  if (client === 'claude-desktop') {
    return JSON.stringify({ mcpServers: { 'ops-console': { command: 'npx', args: ['-y', 'mcp-remote', url, '--header', 'Authorization:${OPS_CONSOLE_AUTH}'], env: { OPS_CONSOLE_AUTH: `Bearer ${token}` } } } }, null, 2);
  }
  return JSON.stringify({ mcpServers: { 'ops-console': { url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2);
}
const HINT: Record<Client, string> = {
  'claude-code': 'Run in a terminal. Then ask Claude Code, for example, "which of my apps had errors today?".',
  'claude-desktop': 'Settings → Developer → Edit config: add this to claude_desktop_config.json and restart Claude Desktop (needs Node.js for npx). Or add a custom connector with the address instead, which signs in without a token.',
  json: 'Add to the MCP settings of the editor or tool (for example .cursor/mcp.json or VS Code\'s mcp.json; some tools call the key "servers").',
};
const th = 'px-4 py-2.5 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500';
const td = 'px-4 py-3 align-top';
const date = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : 'Never');

function Copy({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={() => { void navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }); }}>
      {smallIcon(CopyIcon, 'h-3.5 w-3.5')}{done ? 'Copied' : label}
    </button>
  );
}

export function McpTokens() {
  const dialog = useDialog();
  const [view, setView] = useState<McpView | null>(null);
  const [all, setAll] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [days, setDays] = useState('90');
  const [created, setCreated] = useState<{ token: string; row: McpToken } | null>(null);
  const [client, setClient] = useState<Client>('claude-code');
  const [toolsOpen, setToolsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const load = (everyone = all) => api.mcpTokens(everyone).then(setView).catch((e) => setMsg({ tone: 'bad', text: e instanceof ApiError ? e.message : 'Could not load tokens.' }));
  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function create() {
    setBusy(true); setMsg(null);
    try {
      const r = await api.createMcpToken(name.trim(), days ? Number(days) : null);
      setCreated(r); setName(''); setCreating(false); await load();
    } catch (e) { setMsg({ tone: 'bad', text: e instanceof ApiError ? e.message : 'Creating the token failed.' }); }
    finally { setBusy(false); }
  }
  async function revoke(t: McpToken) {
    const app = t.kind === 'oauth';
    if (!(await dialog.confirm({ title: `${app ? 'Disconnect' : 'Revoke'} “${t.name}”?`, body: app ? 'The app loses access immediately and must be approved again to reconnect.' : 'Any AI tool using this token loses access immediately.', confirmLabel: app ? 'Disconnect' : 'Revoke', danger: true }))) return;
    try { await api.revokeMcpToken(t.id); if (created?.row.id === t.id) setCreated(null); await load(); setMsg({ tone: 'ok', text: `“${t.name}” ${app ? 'disconnected' : 'revoked'}.` }); }
    catch (e) { setMsg({ tone: 'bad', text: e instanceof ApiError ? e.message : 'That did not work.' }); }
  }

  const url = view?.url ?? '';
  const lookups = view?.tools.filter((t) => !t.proposes).length ?? 0;
  const proposals = view?.tools.filter((t) => t.proposes).length ?? 0;
  return (
    <div className="space-y-5">
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}

      {/* the address */}
      <section className="card">
        <h2 className="font-medium text-slate-100">MCP server address</h2>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 font-mono text-sm text-slate-100">{url || '…'}</code>
          {url && <Copy text={url} label="Copy address" />}
        </div>
        <p className="mt-2 text-xs text-slate-500">Paste it as a custom connector in ChatGPT, claude.ai or Claude Desktop (they sign in here), or use it with a personal token below in Claude Code, Cursor or VS Code.</p>
      </section>

      {/* the new token, shown once */}
      {created && (
        <section className="card space-y-3 border-emerald-500/30">
          <p className="text-sm text-slate-200"><b>Token “{created.row.name}” created.</b> Copy it now: it isn&rsquo;t shown again.</p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-ink-950 px-2 py-1.5 font-mono text-xs text-slate-100">{created.token}</code>
            <Copy text={created.token} />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {CLIENTS.map((c) => (
              <button key={c.id} type="button" onClick={() => setClient(c.id)}
                      className={`rounded-md border px-2 py-1 text-xs ${client === c.id ? 'border-indigo-400 bg-indigo-500/15 text-slate-100' : 'border-ink-600 text-slate-400 hover:border-ink-500'}`}>{c.label}</button>
            ))}
          </div>
          <div className="relative">
            <pre className="overflow-x-auto rounded-lg bg-ink-950 p-3 pr-20 font-mono text-xs leading-5 text-slate-200">{snippet(client, url, created.token)}</pre>
            <div className="absolute right-2 top-2"><Copy text={snippet(client, url, created.token)} /></div>
          </div>
          <p className="text-xs text-slate-500">{HINT[client]}</p>
          <button type="button" className="btn-ghost text-xs" onClick={() => setCreated(null)}>Done</button>
        </section>
      )}

      {/* tokens and connected apps */}
      <section className="card overflow-hidden p-0">
        <div className="flex flex-wrap items-center gap-3 px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 className="font-medium text-slate-100">{all ? 'Everyone\'s tokens and connected apps' : 'Your tokens and connected apps'}</h2>
            <p className="mt-0.5 text-sm text-slate-400">Each stops working when revoked or expired, or when its owner leaves the workspace.</p>
          </div>
          {view?.canSeeAll && (
            <label className="flex items-center gap-1.5 text-xs text-slate-400">
              <input type="checkbox" checked={all} onChange={(e) => { setAll(e.target.checked); void load(e.target.checked); }} /> Show everyone&rsquo;s
            </label>
          )}
          {!creating && <button className="btn-primary text-sm" onClick={() => { setCreating(true); setMsg(null); }}>{smallIcon(Plus)}Create token</button>}
        </div>
        {creating && (
          <form className="flex flex-wrap items-end gap-3 border-t border-ink-700 bg-ink-850 px-5 py-4" onSubmit={(e) => { e.preventDefault(); void create(); }}>
            <label className="min-w-[14rem] flex-1">
              <span className="label">Name</span>
              <input className="input" autoFocus placeholder="e.g. Claude Code on my laptop" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
            </label>
            <label>
              <span className="label">Expires</span>
              <select className="input" value={days} onChange={(e) => setDays(e.target.value)}>
                <option value="30">in 30 days</option><option value="90">in 90 days</option><option value="365">in a year</option><option value="">never</option>
              </select>
            </label>
            <button className="btn-primary" disabled={busy || name.trim().length < 2}>{busy ? 'Creating…' : 'Create'}</button>
            <button type="button" className="btn-ghost" onClick={() => setCreating(false)}>Cancel</button>
          </form>
        )}
        <div className="overflow-x-auto border-t border-ink-700">
          <table className="w-full min-w-[46rem] text-sm">
            <thead className="bg-ink-850">
              <tr><th className={th}>Name</th><th className={th}>Type</th>{all && <th className={th}>Owner</th>}<th className={th}>Created</th><th className={th}>Last used</th><th className={th}>Expires</th><th className={th}><span className="sr-only">Actions</span></th></tr>
            </thead>
            <tbody className="divide-y divide-ink-700">
              {view && !view.tokens.length && <tr><td className={`${td} text-slate-500`} colSpan={all ? 7 : 6}>No tokens or connected apps yet.</td></tr>}
              {view?.tokens.map((t) => (
                <tr key={t.id}>
                  <td className={`${td} text-slate-100`}>{t.name}{t.kind === 'pat' && <code className="ml-2 font-mono text-2xs text-slate-500">{t.prefix}…</code>}</td>
                  <td className={td}>{t.kind === 'oauth'
                    ? <span className="rounded border border-indigo-400/40 px-1.5 py-0.5 text-2xs text-indigo-300">Connected app</span>
                    : <span className="rounded border border-ink-600 px-1.5 py-0.5 text-2xs text-slate-400">Personal token</span>}</td>
                  {all && <td className={`${td} text-slate-400`}>{t.username}</td>}
                  <td className={`${td} text-slate-400`}>{date(t.createdAt)}</td>
                  <td className={`${td} text-slate-400`}>{t.lastUsedAt ? ago(t.lastUsedAt) : 'Never'}</td>
                  <td className={`${td} text-slate-400`}>{t.expiresAt ? `${t.kind === 'oauth' ? 'Renews; until ' : ''}${date(t.expiresAt)}` : 'No expiry'}</td>
                  <td className={`${td} text-right`}><button type="button" className="btn-ghost px-2 py-1 text-xs text-rose-300" onClick={() => void revoke(t)}>{t.kind === 'oauth' ? 'Disconnect' : 'Revoke'}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* tools */}
      {view && (
        <section className="card overflow-hidden p-0">
          <button type="button" className="flex w-full items-center gap-3 px-5 py-4 text-left" aria-expanded={toolsOpen} onClick={() => setToolsOpen((o) => !o)}>
            <div className="min-w-0 flex-1">
              <h2 className="font-medium text-slate-100">Tools</h2>
              <p className="mt-0.5 text-sm text-slate-400">{lookups} lookups, {proposals} proposals</p>
            </div>
            <ChevronDown className={`h-4 w-4 text-slate-500 transition-transform ${toolsOpen ? 'rotate-180' : ''}`} aria-hidden />
          </button>
          {toolsOpen && (
            <div className="overflow-x-auto border-t border-ink-700">
              <table className="w-full min-w-[40rem] text-sm">
                <thead className="bg-ink-850"><tr><th className={th}>Tool</th><th className={th}>Type</th><th className={th}>What it does</th></tr></thead>
                <tbody className="divide-y divide-ink-700">
                  {view.tools.map((t) => (
                    <tr key={t.name}>
                      <td className={`${td} whitespace-nowrap`}><code className="font-mono text-xs text-slate-200">{t.name}</code></td>
                      <td className={`${td} whitespace-nowrap`}>{t.proposes
                        ? <span className="rounded border border-amber-400/40 px-1.5 py-0.5 text-2xs text-amber-300">Proposal: you confirm</span>
                        : <span className="rounded border border-ink-600 px-1.5 py-0.5 text-2xs text-slate-400">Read-only</span>}</td>
                      <td className={`${td} text-slate-400`}>{t.description.split(' This only proposes it')[0]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
