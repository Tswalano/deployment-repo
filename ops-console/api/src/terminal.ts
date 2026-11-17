/**
 * Browser terminal: WebSocket at /api/instances/:id/terminal, relayed to an SSM Session Manager shell.
 * No inbound SSH port is needed: the instance's SSM agent connects out to AWS.
 *
 * WebSocket upgrades skip the Hono middleware, so this checks everything itself: an allowed Origin (CSRF), a
 * signed-in admin (never the demo), an instance tagged ops-console=managed and running. Sessions end after
 * 20 minutes without input or 2 hours in all; who/when/how long is recorded (never what was typed).
 *
 * Browser → console: text JSON {t:'i', d:'…'} (input), {t:'r', c:cols, r:rows} (resize).
 * Console → browser: binary frames (terminal output), text JSON {t:'ready'} / {t:'closed', reason}.
 */
import type { IncomingMessage, Server } from 'http';
import type { Duplex } from 'stream';
import { WebSocket, WebSocketServer } from 'ws';
import { audit } from './audit';
import { aws, dryRun } from './aws';
import { InstanceRow } from './collector';
import { config } from './config';
import { db } from './db';
import { originAllowed } from './middleware';
import { sessionUser } from './sessions';
import { openShellStream, ShellStream, simulatedShell } from './ssmsession';

const PATH_RE = /^\/api\/instances\/(\d+)\/terminal(?:\?.*)?$/;
export const IDLE_MS = Number(process.env.TERMINAL_IDLE_MS || 20 * 60_000);
export const MAX_MS = Number(process.env.TERMINAL_MAX_MS || 2 * 3600_000);
const PER_USER = 2, TOTAL = 6;
/** Local test mode uses a pretend shell unless OPS_TERMINAL_REAL=1 (then it is a real session on the instance). */
const simulate = () => dryRun && process.env.OPS_TERMINAL_REAL !== '1';

interface Live { instanceId: number; username: string; startedAt: number }
const live = new Map<number, Live>();   // terminal_sessions.id → session
export const activeTerminals = (instanceId: number) =>
    [...live.values()].filter((s) => s.instanceId === instanceId).map((s) => ({ username: s.username, startedAt: new Date(s.startedAt).toISOString() }));

function cookie(req: IncomingMessage, name: string): string | undefined {
    for (const part of (req.headers.cookie ?? '').split(';')) {
        const [k, ...v] = part.trim().split('=');
        if (k === name) return decodeURIComponent(v.join('='));
    }
    return undefined;
}
function ipOf(req: IncomingMessage): string | null {
    const fwd = req.headers['x-forwarded-for'];
    if (config.trustProxy && typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim().slice(0, 64);
    return req.socket.remoteAddress ?? null;
}
function refuse(socket: Duplex, code: number, text: string) {
    socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`);
    socket.destroy();
}

export function attachTerminal(server: Server): void {
    const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        const m = PATH_RE.exec(req.url ?? '');
        if (!m) { refuse(socket, 404, 'Not found'); return; }
        void (async () => {
            if (!originAllowed(req.headers.origin)) return refuse(socket, 403, 'Origin not allowed');
            const user = await sessionUser(cookie(req, config.cookieName)).catch(() => null);
            if (!user) return refuse(socket, 401, 'Not signed in');
            if (user.role !== 'admin' || user.isDemo) return refuse(socket, 403, 'Only admins can open a terminal');
            const { rows: [inst] } = await db().query<InstanceRow>('SELECT * FROM instances WHERE id = $1', [Number(m[1])]);
            if (!inst) return refuse(socket, 404, 'Instance not found');
            const mine = [...live.values()].filter((s) => s.username === user.username).length;
            if (mine >= PER_USER || live.size >= TOTAL) return refuse(socket, 429, `At most ${PER_USER} terminals per person (${TOTAL} in all): close one first`);
            const info = await aws().describeInstance(inst.region, inst.aws_instance_id).catch(() => null);
            if (!info) return refuse(socket, 409, 'The instance no longer exists in AWS');
            if (!info.managedTag) return refuse(socket, 403, 'The instance is not tagged ops-console=managed');
            if (info.state !== 'running') return refuse(socket, 409, `The instance is ${info.state}`);
            const url = new URL(req.url ?? '/', 'http://x');
            const cols = Number(url.searchParams.get('cols')) || 120, rows = Number(url.searchParams.get('rows')) || 32;
            wss.handleUpgrade(req, socket, head, (ws) => { void run(ws, inst, user.id, user.username, ipOf(req), { cols, rows }); });
        })().catch((err) => { console.error('terminal upgrade failed:', (err as Error).message); refuse(socket, 500, 'Internal error'); });
    });
}

async function run(ws: WebSocket, inst: InstanceRow, userId: number, username: string, ip: string | null, size: { cols: number; rows: number }) {
    const sim = simulate();
    const { rows: [row] } = await db().query<{ id: number }>(
        'INSERT INTO terminal_sessions (instance_id, username, ip, simulated) VALUES ($1, $2, $3, $4) RETURNING id', [inst.id, username, ip, sim]);
    live.set(row.id, { instanceId: inst.id, username, startedAt: Date.now() });
    const startedAt = Date.now();
    let sessionId: string | null = null;
    let shell: ShellStream | null = null;
    let ended = false;
    let idle: NodeJS.Timeout;
    const toBrowser = (o: object) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o)); };

    const end = async (reason: string) => {
        if (ended) return;
        ended = true;
        clearTimeout(idle); clearTimeout(cap); clearInterval(ping);
        live.delete(row.id);
        shell?.close();
        if (sessionId) await aws().terminateSession?.(inst.region, sessionId).catch(() => undefined);
        toBrowser({ t: 'closed', reason });
        try { ws.close(1000, reason.slice(0, 100)); } catch { /* gone */ }
        await db().query('UPDATE terminal_sessions SET ended_at = now(), end_reason = $2 WHERE id = $1', [row.id, reason.slice(0, 200)]).catch(() => undefined);
        await audit({ id: userId, username }, 'terminal.close', `${inst.name} (${inst.aws_instance_id})`,
            { seconds: Math.round((Date.now() - startedAt) / 1000), reason: reason.slice(0, 120), sessionId, simulated: sim || undefined }, ip);
    };
    const bump = () => { clearTimeout(idle); idle = setTimeout(() => void end('closed after 20 minutes without input'), IDLE_MS); };
    bump();
    const cap = setTimeout(() => void end('closed after the 2-hour limit'), MAX_MS);
    const ping = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.ping(); }, 25_000);   // keeps proxies from timing out

    const handlers = {
        onOutput: (d: Buffer) => { if (ws.readyState === WebSocket.OPEN) ws.send(d, { binary: true }); },
        onClose: (reason: string) => void end(reason),
        onReady: () => toBrowser({ t: 'ready', simulated: sim, sessionId }),
    };

    ws.on('message', (data, isBinary) => {
        if (ended || isBinary) return;
        let msg: { t?: string; d?: unknown; c?: unknown; r?: unknown };
        try { msg = JSON.parse(data.toString()); } catch { return; }
        if (msg.t === 'i' && typeof msg.d === 'string') { bump(); shell?.input(msg.d.slice(0, 16_384)); }
        else if (msg.t === 'r') shell?.resize(Number(msg.c) || size.cols, Number(msg.r) || size.rows);
    });
    ws.on('close', () => void end('closed in the browser'));
    ws.on('error', () => void end('browser connection error'));

    await audit({ id: userId, username }, 'terminal.open', `${inst.name} (${inst.aws_instance_id})`, { simulated: sim || undefined }, ip);
    if (sim) { shell = simulatedShell(handlers, inst.name); return; }
    try {
        const s = await aws().startSession!(inst.region, inst.aws_instance_id);
        sessionId = s.sessionId;
        await db().query('UPDATE terminal_sessions SET session_id = $2 WHERE id = $1', [row.id, s.sessionId]);
        if (ended) { await aws().terminateSession?.(inst.region, s.sessionId).catch(() => undefined); return; }
        shell = openShellStream(s.streamUrl, s.tokenValue, handlers, size);
    } catch (err) {
        if (ws.readyState === WebSocket.OPEN) ws.send(Buffer.from(`\r\n\x1b[31mCouldn't start the session: ${(err as Error).message}\x1b[0m\r\n`), { binary: true });
        await end(`failed to start: ${(err as Error).message}`);
    }
}
