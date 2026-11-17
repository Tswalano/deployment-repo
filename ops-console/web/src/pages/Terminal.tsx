import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { api, Instance } from '../api';
import { Alert, DesktopOnly, PageHeader, Skeleton } from '../components/ui';

type State = 'connecting' | 'ready' | 'closed';

/** Browser shell on an instance through SSM Session Manager (no SSH port needed). */
export function Terminal() {
  const id = Number(useParams().id);
  const [inst, setInst] = useState<Instance | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<State>('connecting');
  const [reason, setReason] = useState<string | null>(null);
  const [simulated, setSimulated] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<XTerm | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const sock = useRef<WebSocket | null>(null);

  useEffect(() => { api.instance(id).then((r) => setInst(r.instance)).catch((e) => setError((e as Error).message)); }, [id]);

  const connect = useCallback(() => {
    const t = term.current, f = fit.current;
    if (!t || !f) return;
    sock.current?.close();
    t.reset();
    setState('connecting'); setReason(null);
    f.fit();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/api/instances/${id}/terminal?cols=${t.cols}&rows=${t.rows}`);
    ws.binaryType = 'arraybuffer';
    sock.current = ws;
    let opened = false, closedWith: string | null = null;
    t.write('\x1b[90mStarting a Session Manager session…\x1b[0m\r\n');
    ws.onopen = () => { opened = true; };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') { t.write(new Uint8Array(ev.data as ArrayBuffer)); return; }
      try {
        const m = JSON.parse(ev.data) as { t: string; reason?: string; simulated?: boolean };
        if (m.t === 'ready') { setState('ready'); setSimulated(!!m.simulated); t.focus(); }
        if (m.t === 'closed') closedWith = m.reason ?? 'the session ended';
      } catch { /* ignore */ }
    };
    ws.onclose = () => {
      if (sock.current !== ws) return;
      setState('closed');
      const why = closedWith ?? (opened ? 'the connection was lost' : "couldn't connect: you may have been signed out, or the instance isn't running");
      setReason(why);
      t.write(`\r\n\x1b[90m[session closed: ${why}]\x1b[0m\r\n`);
    };
  }, [id]);

  // the terminal itself (once the instance is known)
  useEffect(() => {
    if (!inst || !host.current) return;
    const t = new XTerm({
      cursorBlink: true, fontSize: 13, scrollback: 5000, convertEol: false,
      fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      theme: { background: '#090b0f', foreground: '#e2e8f0', cursor: '#a5b4fc', selectionBackground: '#6366f155' },
    });
    const f = new FitAddon();
    t.loadAddon(f);
    t.open(host.current);
    term.current = t; fit.current = f;
    const sub = t.onData((d) => { const ws = sock.current; if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'i', d })); });
    const ro = new ResizeObserver(() => {
      try { f.fit(); } catch { return; }
      const ws = sock.current;
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'r', c: t.cols, r: t.rows }));
    });
    ro.observe(host.current);
    connect();
    return () => { ro.disconnect(); sub.dispose(); sock.current?.close(); sock.current = null; t.dispose(); term.current = null; };
  }, [inst, connect]);

  if (error) return <Alert>{error}</Alert>;
  if (!inst) return <Skeleton className="h-96" />;
  const pill = state === 'ready' ? <span className="pill-ok">connected</span> : state === 'connecting' ? <span className="pill-info">connecting…</span> : <span className="pill-mute">closed</span>;

  return (
    <div>
      <div className="mb-2 text-xs text-slate-500">
        <Link to="/instances" className="hover:text-slate-300">Instances</Link> / <Link to={`/instances/${inst.id}`} className="hover:text-slate-300">{inst.name}</Link> / <span className="text-slate-400">Terminal</span>
      </div>
      <PageHeader
        title={`Terminal · ${inst.name}`}
        subtitle="Session Manager shell as ssm-user (use sudo for admin commands). No SSH port needed."
        actions={<>
          {pill}
          {simulated && <span className="pill-warn">simulated (local test mode)</span>}
          <Link to={`/instances/${inst.id}/access`} className="btn-ghost">Access</Link>
          {state === 'closed'
            ? <button className="btn-primary" onClick={connect}>Reconnect</button>
            : <button className="btn-secondary" onClick={() => sock.current?.close()}>Disconnect</button>}
        </>}
      />
      <DesktopOnly title="The terminal" />
      <div className="hidden md:block">
        {state === 'closed' && reason && <div className="mb-3"><Alert tone="warn">Session closed: {reason}.</Alert></div>}
        <div className="card overflow-hidden p-2">
          <div ref={host} className="h-[calc(100vh-290px)] min-h-[320px] w-full" />
        </div>
        <p className="mt-3 text-xs text-slate-500">
          Closes after 20 minutes without typing and after 2 hours in all. Who opened a session and when is recorded in the audit log; what you type is not.
          Copy with the mouse selection; paste with Ctrl+Shift+V (or Cmd+V).
        </p>
      </div>
    </div>
  );
}
