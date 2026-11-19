import { Fragment, KeyboardEvent, PointerEvent as RPointerEvent, ReactNode, useEffect, useRef, useState } from 'react';
import { api, ApiError, askAssistant, AssistantAction, AssistantStatus, AssistantTurn } from '../api';
import { ActionCard } from './ActionCard';

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
const SparkIcon = ({ className = 'h-4 w-4' }: { className?: string }) => (
  <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" /><circle cx="12" cy="12" r="3" />
  </svg>
);

export function AskButton({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex items-center gap-1.5 rounded-lg border border-ink-600 px-2.5 py-1.5 text-sm text-slate-300 hover:border-ink-500 hover:text-slate-100" title="Ask Ops Console about this workspace">
      <SparkIcon /><span className="hidden sm:inline">Ask</span>
    </button>
  );
}

export function AskPanel({ open, signal = 0, onClose }: { open: boolean; signal?: number; onClose: () => void }) {
  const [status, setStatus] = useState<AssistantStatus | null>(null);
  const [convId, setConvId] = useState<string | null>(null);
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
        if (e.type === 'conversation') setConvId(e.id);
        else if (e.type === 'action') {
          setActions((m) => ({ ...m, [e.action.id]: e.action }));
          patch((l) => ({ ...l, actions: [...new Set([...(l.actions ?? []), e.action.id])] }));
          window.dispatchEvent(new Event('ops:actions-changed'));
        }
        else if (e.type === 'tool') patch((l) => ({ ...l, tools: [...new Set([...(l.tools ?? []), e.label])] }));
        else if (e.type === 'text') patch((l) => ({ ...l, text: l.text + e.delta }));
        else if (e.type === 'error') { setError(e.message); patch((l) => l); }
      }, abort.current.signal);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError(e instanceof ApiError ? e.message : 'The assistant could not answer right now.');
    } finally {
      setBusy(false); abort.current = null;
      setTurns((t) => (t.length && t[t.length - 1].role === 'assistant' && !t[t.length - 1].text ? t.slice(0, -1) : t));
    }
  }
  const newChat = () => { abort.current?.abort(); setConvId(null); setTurns([]); setActions({}); setError(null); void loadStatus(); box.current?.focus(); };
  const openConversation = async (id: string) => {
    try { const c = await api.assistantConversation(id); setConvId(c.id); setTurns(c.turns); setActions(Object.fromEntries(c.actions.map((a) => [a.id, a]))); setError(null); } catch (e) { setError(e instanceof ApiError ? e.message : 'Could not open that conversation.'); }
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(input); } };

  if (!open) return null;
  const place = wide ? { right: pos.right, bottom: pos.bottom } : undefined;
  if (minimised) {
    return (
      <button style={place} onClick={() => setMinimised(false)} aria-label="Open Ask Ops Console"
              className="fixed bottom-3 right-3 z-40 flex items-center gap-2 rounded-full border border-ink-600 bg-ink-900 px-3.5 py-2 text-sm text-slate-200 shadow-xl shadow-black/40 hover:border-ink-500">
        <SparkIcon className="h-4 w-4 text-indigo-300" />Ask Ops Console
        {busy && <span className="h-2 w-2 animate-pulse rounded-full bg-indigo-400 motion-reduce:animate-none" aria-label="answering" />}
      </button>
    );
  }
  const size = wide ? (large ? 'w-[min(44rem,calc(100vw-2.5rem))] h-[min(52rem,calc(100vh-5rem))]' : 'w-[26rem] h-[min(38rem,calc(100vh-5rem))]') : 'inset-x-2 bottom-2 h-[82vh]';
  return (
    <aside role="dialog" aria-label="Ask Ops Console" style={place} onKeyDown={(e) => { if (e.key === 'Escape') setMinimised(true); }}
           className={`fixed z-40 flex flex-col overflow-hidden rounded-2xl border border-ink-600 bg-ink-900 shadow-2xl shadow-black/50 ${size}`}>
        <header onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}
                className={`flex select-none items-center gap-2 border-b border-ink-700 px-4 py-3 ${wide ? 'cursor-move' : ''}`}>
          <span className="grid h-7 w-7 place-items-center rounded-lg border border-indigo-400/40 bg-indigo-500/15 text-indigo-300"><SparkIcon /></span>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-slate-100">Ask Ops Console</h2>
            <p className="truncate text-2xs text-slate-500">Answers about this workspace; changes only after you confirm{status?.providerName ? ` · ${status.providerName}` : ''}</p>
          </div>
          {turns.length > 0 && <button className="btn-ghost px-2 py-1 text-xs" onClick={newChat}>New chat</button>}
          {wide && <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setLarge((l) => !l)} aria-label={large ? 'Smaller' : 'Larger'} title={large ? 'Smaller' : 'Larger'}>{large ? '⤡' : '⤢'}</button>}
          <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setMinimised(true)} aria-label="Minimise" title="Minimise">–</button>
          <button className="btn-ghost px-2 py-1 text-xs" onClick={onClose} aria-label="Close" title="Close">✕</button>
        </header>

        <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-4 py-4 text-sm leading-6 text-slate-300">
          {status && !status.enabled ? (
            <div className="text-slate-400">
              <p>Ask Ops Console isn&rsquo;t set up for this workspace yet. It uses the workspace&rsquo;s own Claude (Anthropic) or ChatGPT (OpenAI) API key.</p>
              <p className="mt-2">{status.canConfigure ? <a className="text-indigo-300 hover:text-indigo-200" href="/ai/assistant" onClick={onClose}>Set it up on the AI page →</a> : 'A workspace admin can set it up on the AI page.'}</p>
            </div>
          ) : turns.length === 0 ? (
            <div>
              <p className="text-slate-400">Ask about servers, apps, deploys, alerts, uptime, backups or AWS costs. It looks things up for you, and can prepare a deploy, rollback or server restart for you to confirm.</p>
              <div className="mt-4 flex flex-col gap-2">
                {SUGGESTIONS.map((s) => <button key={s} className="rounded-lg border border-ink-700 px-3 py-2 text-left text-slate-300 hover:border-ink-500 hover:text-slate-100" onClick={() => void send(s)}>{s}</button>)}
              </div>
              {!!status?.conversations?.length && (
                <div className="mt-6">
                  <div className="text-2xs font-semibold uppercase tracking-wider text-slate-500">Recent</div>
                  <ul className="mt-2 space-y-1">{status.conversations.slice(0, 6).map((c) => (
                    <li key={c.id}><button className="w-full truncate rounded px-2 py-1 text-left text-slate-400 hover:bg-ink-800 hover:text-slate-200" onClick={() => void openConversation(c.id)}>{c.title}</button></li>
                  ))}</ul>
                </div>
              )}
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
            <textarea ref={box} rows={2} className="input min-h-[2.75rem] flex-1 resize-none" placeholder="Ask about this workspace…" value={input} maxLength={2000}
                      onChange={(e) => setInput(e.target.value)} onKeyDown={onKey} disabled={busy || (!!status && !status.enabled)} />
            <button className="btn-primary" disabled={busy || !input.trim() || (!!status && !status.enabled)} onClick={() => void send(input)}>{busy ? '…' : 'Ask'}</button>
          </div>
          <p className="mt-2 text-2xs text-slate-500">
            Answers come from live data but can be wrong: check the page before acting.
          </p>
        </footer>
    </aside>
  );
}
