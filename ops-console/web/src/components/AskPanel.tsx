import { Fragment, KeyboardEvent, ReactNode, useEffect, useRef, useState } from 'react';
import { api, ApiError, askAssistant, AssistantStatus, AssistantTurn } from '../api';

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

export function AskPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [status, setStatus] = useState<AssistantStatus | null>(null);
  const [convId, setConvId] = useState<string | null>(null);
  const [turns, setTurns] = useState<AssistantTurn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  const loadStatus = () => api.assistant().then(setStatus).catch(() => setStatus({ enabled: false }));
  useEffect(() => { if (open) { void loadStatus(); setTimeout(() => box.current?.focus(), 50); } }, [open]);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [turns]);
  useEffect(() => {
    if (!open) return;
    const esc = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [open, onClose]);

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
        else if (e.type === 'tool') patch((l) => ({ ...l, tools: [...new Set([...(l.tools ?? []), e.label])] }));
        else if (e.type === 'text') patch((l) => ({ ...l, text: l.text + e.delta }));
        else if (e.type === 'done') setStatus((s) => (s ? { ...s, remaining: e.remaining } : s));
        else if (e.type === 'error') { setError(e.message); patch((l) => l); }
      }, abort.current.signal);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError(e instanceof ApiError ? e.message : 'The assistant could not answer right now.');
    } finally {
      setBusy(false); abort.current = null;
      setTurns((t) => (t.length && t[t.length - 1].role === 'assistant' && !t[t.length - 1].text ? t.slice(0, -1) : t));
    }
  }
  const newChat = () => { abort.current?.abort(); setConvId(null); setTurns([]); setError(null); void loadStatus(); box.current?.focus(); };
  const openConversation = async (id: string) => {
    try { const c = await api.assistantConversation(id); setConvId(c.id); setTurns(c.turns); setError(null); } catch (e) { setError(e instanceof ApiError ? e.message : 'Could not open that conversation.'); }
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(input); } };

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/40" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside role="dialog" aria-label="Ask Ops Console" className="flex h-full w-full max-w-md flex-col border-l border-ink-700 bg-ink-900 shadow-2xl shadow-black/50">
        <header className="flex items-center gap-2 border-b border-ink-700 px-4 py-3">
          <span className="grid h-7 w-7 place-items-center rounded-lg border border-indigo-400/40 bg-indigo-500/15 text-indigo-300"><SparkIcon /></span>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-slate-100">Ask Ops Console</h2>
            <p className="truncate text-2xs text-slate-500">Read-only answers about this workspace</p>
          </div>
          {turns.length > 0 && <button className="btn-ghost px-2 py-1 text-xs" onClick={newChat}>New chat</button>}
          <button className="btn-ghost px-2 py-1 text-xs" onClick={onClose} aria-label="Close">✕</button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 text-sm leading-6 text-slate-300">
          {status && !status.enabled ? (
            <p className="text-slate-400">The assistant isn&rsquo;t set up on this console.</p>
          ) : turns.length === 0 ? (
            <div>
              <p className="text-slate-400">Ask about servers, apps, deploys, alerts, uptime, backups or AWS costs. It looks things up for you and can&rsquo;t change anything.</p>
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
                    </div>
                  )}
                </Fragment>
              ))}
              <div ref={end} />
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
            {status?.remaining != null ? `${status.remaining} question${status.remaining === 1 ? '' : 's'} left this month · ` : ''}Answers come from live data but can be wrong: check the page before acting.
          </p>
        </footer>
      </aside>
    </div>
  );
}
