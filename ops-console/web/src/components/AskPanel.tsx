import { Fragment, KeyboardEvent, PointerEvent as RPointerEvent, ReactNode, useEffect, useRef, useState } from 'react';
import { api, ApiError, askAssistant, AssistantAction, AssistantChat, AssistantStatus, AssistantTurn } from '../api';
import { useDialog } from './Dialog';
import { ago } from './ui';
import { ActionCard } from './ActionCard';
import { History, Maximize2, Minimize2, Minus, Sparkles, SquarePen, Trash2, X } from 'lucide-react';

/** "Ask Ops Console": a side panel that answers questions about the workspace (read-only). */

// ------------------------------------------------------------------ a small, safe Markdown subset (no HTML is ever injected)
function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0; let m: RegExpExecArray | null; let n = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    out.push(t.startsWith('**') ? <b key={`${key}-${n++}`} className="font-semibold text-slate-100">{t.slice(2, -2)}</b>
      : <code key={`${key}-${n++}`} className="rounded bg-ink-950 px-1 py-0.5 font-mono text-[0.85em] text-slate-200">{t.slice(1, -1)}</code>);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  const flush = (k: number) => { if (list.length) { blocks.push(<ul key={`l${k}`} className="my-1.5 list-disc space-y-0.5 pl-5">{list.map((li, i) => <li key={i}>{inline(li, `li${k}-${i}`)}</li>)}</ul>); list = []; } };
  text.split('\n').forEach((line, i) => {
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    if (bullet) { list.push(bullet[1]); return; }
    flush(i);
    if (line.trim()) blocks.push(<p key={`p${i}`} className="my-1.5">{inline(line.replace(/^#+\s*/, ''), `p${i}`)}</p>);
  });
  flush(-1);
  return <>{blocks}</>;
}

const SUGGESTIONS = ['Are all my apps healthy?', 'Did any deploy fail this week?', 'When was the last backup of each database?', 'Which server is closest to running out of disk?', "What's the AWS bill so far this month?"];
const SparkIcon = ({ className = 'h-4 w-4' }: { className?: string }) => <Sparkles className={className} strokeWidth={1.75} aria-hidden />;

export function AskPanel({ open, signal = 0, onOpen, onClose }: { open: boolean; signal?: number; onOpen: () => void; onClose: () => void }) {
  const dialog = useDialog();
  const [status, setStatus] = useState<AssistantStatus | null>(null);
  const [convId, setConvId] = useState<string | null>(null);
  const [modelId, setModelId] = useState<string | null>(null);         // for a new chat (null: the default)
  const [chatModel, setChatModel] = useState<string | null>(null);     // the model of the open chat
  const [history, setHistory] = useState<AssistantChat[] | null>(null); // the History view (null: closed)
  const [turns, setTurns] = useState<AssistantTurn[]>([]);
  const [actions, setActions] = useState<Record<string, AssistantAction>>({});
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  // floating window: dragged by its title bar, normal or large, minimised to a pill; position remembered per browser
  const [pos, setPos] = useState<{ right: number; bottom: number }>(() => {
    try { const v = JSON.parse(localStorage.getItem('ask.pos') ?? 'null'); if (v && Number.isFinite(v.right) && Number.isFinite(v.bottom)) return v; } catch { /* no storage */ }
    return { right: 20, bottom: 20 };
  });
  const [large, setLarge] = useState(false);
  const [minimised, setMinimised] = useState(false);
  const [wide, setWide] = useState(() => window.matchMedia('(min-width: 640px)').matches);
  const scroller = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; right: number; bottom: number } | null>(null);
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 640px)');
    const on = () => setWide(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  const clamp = (p: { right: number; bottom: number }) => ({
    right: Math.min(Math.max(8, p.right), Math.max(8, window.innerWidth - 160)),
    bottom: Math.min(Math.max(8, p.bottom), Math.max(8, window.innerHeight - 56)),
  });
  const startDrag = (e: RPointerEvent<HTMLElement>) => {
    if (!wide || (e.target as HTMLElement).closest('button')) return;
    drag.current = { x: e.clientX, y: e.clientY, ...pos };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const moveDrag = (e: RPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (d) setPos(clamp({ right: d.right - (e.clientX - d.x), bottom: d.bottom - (e.clientY - d.y) }));
  };
  const endDrag = () => {
    if (!drag.current) return;
    drag.current = null;
    try { localStorage.setItem('ask.pos', JSON.stringify(pos)); } catch { /* no storage */ }
  };
  useEffect(() => { const r = () => setPos((p) => clamp(p)); window.addEventListener('resize', r); return () => window.removeEventListener('resize', r); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const loadStatus = () => api.assistant().then(setStatus).catch(() => setStatus({ enabled: false }));
  useEffect(() => { if (open) { setMinimised(false); void loadStatus(); setTimeout(() => box.current?.focus(), 50); } }, [open, signal]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const el = scroller.current; if (el) el.scrollTop = el.scrollHeight; }, [turns, minimised]);

  async function send(question: string) {
    const q = question.trim();
    if (!q || busy) return;
    setInput(''); setError(null); setBusy(true);
    setTurns((t) => [...t, { role: 'user', text: q }, { role: 'assistant', text: '', tools: [] }]);
    const patch = (f: (last: AssistantTurn) => AssistantTurn) => setTurns((t) => [...t.slice(0, -1), f(t[t.length - 1])]);
    abort.current = new AbortController();
    try {
      await askAssistant(q, convId, (e) => {
        if (e.type === 'conversation') { setConvId(e.id); setChatModel(e.model ?? null); }
        else if (e.type === 'action') {
          setActions((m) => ({ ...m, [e.action.id]: e.action }));
          patch((l) => ({ ...l, actions: [...new Set([...(l.actions ?? []), e.action.id])] }));
          window.dispatchEvent(new Event('ops:actions-changed'));
        }
        else if (e.type === 'tool') patch((l) => ({ ...l, tools: [...new Set([...(l.tools ?? []), e.label])] }));
        else if (e.type === 'text') patch((l) => ({ ...l, text: l.text + e.delta }));
        else if (e.type === 'error') { setError(e.message); patch((l) => l); }
      }, abort.current.signal, convId ? null : modelId);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError(e instanceof ApiError ? e.message : 'The assistant could not answer right now.');
    } finally {
      setBusy(false); abort.current = null;
      setTurns((t) => (t.length && t[t.length - 1].role === 'assistant' && !t[t.length - 1].text ? t.slice(0, -1) : t));
    }
  }
  const newChat = () => { abort.current?.abort(); setConvId(null); setChatModel(null); setHistory(null); setTurns([]); setActions({}); setError(null); void loadStatus(); box.current?.focus(); };
  const openConversation = async (id: string) => {
    try { const c = await api.assistantConversation(id); setHistory(null); setConvId(c.id); setChatModel(c.model); setTurns(c.turns); setActions(Object.fromEntries(c.actions.map((a) => [a.id, a]))); setError(null); } catch (e) { setError(e instanceof ApiError ? e.message : 'Could not open that conversation.'); }
  };
  const showHistory = async () => { setError(null); setHistory(await api.assistantChats().catch(() => [])); };
  const deleteChat = async (id: string) => {
    try { await api.deleteAssistantChat(id); setHistory((h) => h?.filter((c) => c.id !== id) ?? null); if (id === convId) newChat(); }
    catch (e) { setError(e instanceof ApiError ? e.message : 'Deleting failed.'); }
  };
  const clearChats = async () => {
    if (!(await dialog.confirm({ title: 'Clear all your chats?', body: 'Every chat of yours is deleted. Proposals made in them stay under AI Console → Proposals.', confirmLabel: 'Clear all', danger: true }))) return;
    try { await api.clearAssistantChats(); setHistory([]); newChat(); setHistory([]); } catch (e) { setError(e instanceof ApiError ? e.message : 'Clearing failed.'); }
  };
  // "Open" on AI Console → Ask Ops Console → Your chat history
  useEffect(() => {
    const on = (e: Event) => { const id = (e as CustomEvent<string>).detail; if (id) { onOpen(); setMinimised(false); void openConversation(id); } };
    window.addEventListener('ops:open-conversation', on);
    return () => window.removeEventListener('ops:open-conversation', on);
  }); // eslint-disable-line react-hooks/exhaustive-deps
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(input); } };

  const place = wide ? { right: pos.right, bottom: pos.bottom } : undefined;
  // closed or minimised: the floating button is always there (above the phone navigation bar)
  if (!open || minimised) {
    return (
      <button style={place} onClick={() => { if (!open) onOpen(); setMinimised(false); }} aria-label="Open Ask Ops Console"
              className="ask-window fixed bottom-20 right-3 z-40 flex items-center gap-2 rounded-full border border-ink-500 px-3.5 py-2 text-sm font-medium text-slate-100 shadow-xl shadow-black/40 hover:border-indigo-400 md:bottom-3">
        <SparkIcon className="h-4 w-4 text-indigo-300" />Ask Ops Console
        {busy && <span className="h-2 w-2 animate-pulse rounded-full bg-indigo-400 motion-reduce:animate-none" aria-label="answering" />}
      </button>
    );
  }
  const size = wide ? (large ? 'w-[min(44rem,calc(100vw-2.5rem))] h-[min(52rem,calc(100vh-5rem))]' : 'w-[26rem] h-[min(38rem,calc(100vh-5rem))]') : 'inset-x-2 bottom-2 h-[82vh]';
  return (
    <aside role="dialog" aria-label="Ask Ops Console" style={place} onKeyDown={(e) => { if (e.key === 'Escape') setMinimised(true); }}
           className={`ask-window fixed z-40 flex flex-col overflow-hidden rounded-2xl border border-ink-500 shadow-2xl shadow-black/60 ${size}`}>
        <header onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}
                className={`flex select-none items-center gap-2 border-b border-ink-700 px-4 py-3 ${wide ? 'cursor-move' : ''}`}>
          <span className="grid h-7 w-7 place-items-center rounded-lg border border-indigo-400/40 bg-indigo-500/15 text-indigo-300"><SparkIcon /></span>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-slate-100">Ask Ops Console</h2>
            <p className="truncate text-2xs text-slate-500">{history ? 'Your chats' : chatModel ? `This chat: ${chatModel}` : 'Answers about this workspace; changes only after you confirm'}</p>
          </div>
          {(turns.length > 0 || history) && <button className="btn-ghost px-2 py-1 text-xs" onClick={newChat} title="New chat"><SquarePen className="h-3.5 w-3.5" aria-hidden /><span className="hidden sm:inline">New</span></button>}
          {status?.enabled && <button className={`btn-ghost px-2 py-1 text-xs ${history ? 'text-indigo-300' : ''}`} onClick={() => (history ? setHistory(null) : void showHistory())} aria-label="Chat history" title="Chat history"><History className="h-3.5 w-3.5" aria-hidden /></button>}
          {wide && <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setLarge((l) => !l)} aria-label={large ? 'Smaller' : 'Larger'} title={large ? 'Smaller' : 'Larger'}>{large ? <Minimize2 className="h-3.5 w-3.5" aria-hidden /> : <Maximize2 className="h-3.5 w-3.5" aria-hidden />}</button>}
          <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setMinimised(true)} aria-label="Minimise" title="Minimise"><Minus className="h-3.5 w-3.5" aria-hidden /></button>
          <button className="btn-ghost px-2 py-1 text-xs" onClick={onClose} aria-label="Close" title="Close"><X className="h-3.5 w-3.5" aria-hidden /></button>
        </header>

        <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-4 py-4 text-sm leading-6 text-slate-300">
          {history ? (
            <div>
              <div className="mb-2 flex items-center justify-between">
                <span className="text-2xs font-semibold uppercase tracking-wider text-slate-500">{history.length} chat{history.length === 1 ? '' : 's'}</span>
                {history.length > 0 && <button className="text-xs text-rose-300 hover:text-rose-200" onClick={() => void clearChats()}>Clear all</button>}
              </div>
              {!history.length && <p className="text-slate-500">No chats yet.</p>}
              <ul className="divide-y divide-ink-700">{history.map((c) => (
                <li key={c.id} className="group flex items-center gap-2 py-1.5">
                  <button className="min-w-0 flex-1 text-left" onClick={() => void openConversation(c.id)}>
                    <span className={`block truncate ${c.id === convId ? 'text-indigo-200' : 'text-slate-200 group-hover:text-white'}`}>{c.title}</span>
                    <span className="block text-2xs text-slate-500">{ago(c.updatedAt)}{c.model ? ` · ${c.model}` : ''}{c.questions ? ` · ${c.questions} question${c.questions === 1 ? '' : 's'}` : ''}</span>
                  </button>
                  <button className="rounded p-1 text-slate-500 hover:bg-ink-800 hover:text-rose-300" onClick={() => void deleteChat(c.id)} aria-label={`Delete ${c.title}`} title="Delete"><Trash2 className="h-3.5 w-3.5" aria-hidden /></button>
                </li>
              ))}</ul>
            </div>
          ) : status && !status.enabled ? (
            <div className="text-slate-400">
              <p>Ask Ops Console isn&rsquo;t set up for this workspace yet. It uses the workspace&rsquo;s own Claude (Anthropic) or ChatGPT (OpenAI) API key.</p>
              <p className="mt-2">{status.canConfigure ? <a className="text-indigo-300 hover:text-indigo-200" href="/ai/assistant" onClick={onClose}>Set it up on the AI Console →</a> : 'A workspace admin can set it up on the AI Console.'}</p>
            </div>
          ) : turns.length === 0 ? (
            <div>
              <p className="text-slate-400">Ask about servers, apps, deploys, alerts, uptime, backups or AWS costs. It looks things up for you, and can prepare a deploy, rollback or server restart for you to confirm.</p>
              <div className="mt-4 flex flex-col gap-2">
                {SUGGESTIONS.map((s) => <button key={s} className="rounded-lg border border-ink-700 px-3 py-2 text-left text-slate-300 hover:border-ink-500 hover:text-slate-100" onClick={() => void send(s)}>{s}</button>)}
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {turns.map((t, i) => (
                <Fragment key={i}>
                  {t.role === 'user' ? (
                    <div className="ml-8 rounded-xl bg-indigo-500/15 px-3 py-2 text-slate-100">{t.text}</div>
                  ) : (
                    <div className="mr-4">
                      {!!t.tools?.length && <div className="mb-1 flex flex-wrap gap-1.5">{t.tools.map((l) => <span key={l} className="rounded-md border border-ink-700 px-1.5 py-0.5 text-2xs text-slate-500">✓ {l}</span>)}</div>}
                      {t.text ? <Markdown text={t.text} /> : busy && i === turns.length - 1 && <p className="animate-pulse text-slate-500 motion-reduce:animate-none">Looking it up…</p>}
                      {t.actions?.map((id) => actions[id] && <div key={id} className="mt-2"><ActionCard action={actions[id]} onChange={(a) => setActions((m) => ({ ...m, [a.id]: a }))} /></div>)}
                    </div>
                  )}
                </Fragment>
              ))}
            </div>
          )}
          {error && <p className="mt-3 rounded-lg border border-rose-500/30 px-3 py-2 text-rose-300">{error}</p>}
        </div>

        <footer className="border-t border-ink-700 p-3">
          <div className="flex items-end gap-2">
            <textarea ref={box} rows={2} className="input ask-field min-h-[2.75rem] flex-1 resize-none" placeholder="Ask about this workspace…" value={input} maxLength={2000}
                      onChange={(e) => setInput(e.target.value)} onKeyDown={onKey} disabled={busy || (!!status && !status.enabled)} />
            <button className="btn-primary" disabled={busy || !input.trim() || (!!status && !status.enabled)} onClick={() => void send(input)}>{busy ? '…' : 'Ask'}</button>
          </div>
          <div className="mt-2 flex items-center gap-2 text-2xs text-slate-500">
            {!convId && (status?.models?.length ?? 0) > 1 && (
              <select className="select-sm py-0.5 text-2xs" value={modelId ?? status?.defaultModelId ?? ''}
                      onChange={(e) => setModelId(e.target.value)} aria-label="Model for this chat">
                {status!.models!.map((m) => <option key={m.id} value={m.id}>{m.model}{m.isDefault ? ' (default)' : ''}</option>)}
              </select>
            )}
            <span className="min-w-0 flex-1">Answers come from live data but can be wrong: check the page before acting.</span>
          </div>
        </footer>
    </aside>
  );
}
