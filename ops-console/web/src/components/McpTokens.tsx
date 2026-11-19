import { useEffect, useState } from 'react';
import { api, ApiError, McpToken, McpView } from '../api';
import { useDialog } from './Dialog';
import { ago, Alert } from './ui';

/**
 * AI → MCP server: connect Claude Code, Claude Desktop, Cursor or VS Code to this workspace with a personal
 * access token. The token is shown once; the tools get the owner's role, read-only.
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
  'claude-desktop': 'Settings → Developer → Edit config: add this to claude_desktop_config.json and restart Claude Desktop (needs Node.js for npx).',
  json: 'Add to the MCP settings of the editor or tool (for example .cursor/mcp.json or VS Code\'s mcp.json; some tools call the key "servers").',
};

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={() => { void navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }); }}>
      {done ? 'Copied' : 'Copy'}
    </button>
  );
}

export function McpTokens() {
  const dialog = useDialog();
  const [view, setView] = useState<McpView | null>(null);
  const [all, setAll] = useState(false);
  const [name, setName] = useState('');
  const [days, setDays] = useState('90');
  const [created, setCreated] = useState<{ token: string; row: McpToken } | null>(null);
  const [client, setClient] = useState<Client>('claude-code');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const load = (everyone = all) => api.mcpTokens(everyone).then(setView).catch((e) => setMsg({ tone: 'bad', text: e instanceof ApiError ? e.message : 'Could not load tokens.' }));
  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function create() {
    setBusy(true); setMsg(null);
    try {
      const r = await api.createMcpToken(name.trim(), days ? Number(days) : null);
      setCreated(r); setName(''); await load();
    } catch (e) { setMsg({ tone: 'bad', text: e instanceof ApiError ? e.message : 'Creating the token failed.' }); }
    finally { setBusy(false); }
  }
  async function revoke(t: McpToken) {
    if (!(await dialog.confirm({ title: `${t.kind === 'oauth' ? 'Disconnect' : 'Revoke'} “${t.name}”?`, body: t.kind === 'oauth' ? 'The app loses access immediately and must be approved again to reconnect.' : 'Any AI tool using this token loses access immediately.', confirmLabel: 'Revoke', danger: true }))) return;
    try { await api.revokeMcpToken(t.id); if (created?.row.id === t.id) setCreated(null); await load(); setMsg({ tone: 'ok', text: `“${t.name}” revoked.` }); }
    catch (e) { setMsg({ tone: 'bad', text: e instanceof ApiError ? e.message : 'Revoking failed.' }); }
  }

  const url = view?.url ?? '';
  const shown = created ? snippet(client, url, created.token) : null;
  return (
    <div className="space-y-4">
      <Status msg={msg} />
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-slate-500">MCP server address</span>
        <code className="rounded bg-ink-950 px-2 py-1 font-mono text-xs text-slate-200">{url || '…'}</code>
        {url && <Copy text={url} />}
      </div>

      <p className="text-sm text-slate-400">
        <b className="text-slate-200">ChatGPT, claude.ai and Claude Desktop connectors:</b> add a custom connector with the address above; the app sends you here to sign in and approve, with no token needed.
        For Claude Code, Cursor, VS Code or scripts, create a token below.
      </p>
      {created ? (
        <div className="space-y-3 rounded-lg border border-emerald-500/30 p-4">
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
            <pre className="overflow-x-auto rounded-lg bg-ink-950 p-3 pr-16 font-mono text-xs leading-5 text-slate-200">{shown}</pre>
            <div className="absolute right-2 top-2"><Copy text={shown!} /></div>
          </div>
          <p className="text-xs text-slate-500">{HINT[client]}</p>
          <button type="button" className="btn-ghost text-xs" onClick={() => setCreated(null)}>Done</button>
        </div>
      ) : (
        <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void create(); }}>
          <label className="min-w-[12rem] flex-1">
            <span className="label">New token name</span>
            <input className="input" placeholder="e.g. Claude Code on my laptop" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            <span className="label">Expires</span>
            <select className="input" value={days} onChange={(e) => setDays(e.target.value)}>
              <option value="30">in 30 days</option><option value="90">in 90 days</option><option value="365">in a year</option><option value="">never</option>
            </select>
          </label>
          <button className="btn-primary" disabled={busy || name.trim().length < 2}>{busy ? 'Creating…' : 'Create token'}</button>
        </form>
      )}

      <div>
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">{all ? 'Everyone\'s tokens and connected apps in this workspace' : 'Your tokens and connected apps'}</h3>
          {view?.canSeeAll && (
            <label className="flex items-center gap-1.5 text-xs text-slate-400">
              <input type="checkbox" checked={all} onChange={(e) => { setAll(e.target.checked); void load(e.target.checked); }} /> Show everyone&rsquo;s
            </label>
          )}
        </div>
        {view && !view.tokens.length ? <p className="mt-2 text-sm text-slate-500">No tokens yet.</p> : (
          <ul className="mt-2 divide-y divide-ink-700 rounded-lg border border-ink-700">
            {view?.tokens.map((t) => (
              <li key={t.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-slate-200">{t.name} {t.kind === 'oauth' ? <span className="ml-1 rounded border border-ink-600 px-1 text-2xs text-slate-400">connected app</span> : <code className="ml-1 font-mono text-2xs text-slate-500">{t.prefix}…</code>}{all && <span className="text-slate-500"> · {t.username}</span>}</div>
                  <div className="text-2xs text-slate-500">
                    {t.kind === 'oauth' ? 'Connected' : 'Created'} {ago(t.createdAt)} · {t.lastUsedAt ? `last used ${ago(t.lastUsedAt)}` : 'never used'} · {t.expiresAt ? `${t.kind === 'oauth' ? 'renews while used, until' : 'expires'} ${new Date(t.expiresAt).toLocaleDateString()}` : 'no expiry'}
                  </div>
                </div>
                <button type="button" className="btn-ghost px-2 py-1 text-xs text-rose-300" onClick={() => void revoke(t)}>{t.kind === 'oauth' ? 'Disconnect' : 'Revoke'}</button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {view && (
        <details className="text-sm text-slate-400">
          <summary className="cursor-pointer text-slate-300">What AI tools can read ({view.tools.length} read-only tools)</summary>
          <ul className="mt-2 space-y-1">{view.tools.map((t) => <li key={t.name}><code className="font-mono text-xs text-slate-200">{t.name}</code>: {t.description}</li>)}</ul>
        </details>
      )}
    </div>
  );
}

function Status({ msg }: { msg: { tone: 'ok' | 'bad'; text: string } | null }) {
  return msg ? <Alert tone={msg.tone}>{msg.text}</Alert> : null;
}
