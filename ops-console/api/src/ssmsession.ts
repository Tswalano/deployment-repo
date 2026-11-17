/**
 * Client side of the SSM Session Manager data channel (what AWS's session-manager-plugin speaks), enough for an
 * interactive shell: open the stream with the session token, answer the agent's handshake, acknowledge every
 * output message in order, send keystrokes and terminal size.
 *
 * Wire format of every binary message (big-endian):
 *   0  HeaderLength uint32 (116)      4  MessageType 32 bytes, space-padded   36 SchemaVersion uint32
 *   40 CreatedDate uint64 (ms)       48 SequenceNumber int64                  56 Flags uint64
 *   64 MessageId 16 bytes (UUID, low 8 bytes first)   80 PayloadDigest 32 bytes (SHA-256 of the payload)
 *   112 PayloadType uint32           116 PayloadLength uint32                 120 Payload
 */
import { createHash, randomUUID } from 'crypto';
import WebSocket from 'ws';

export const HEADER_LENGTH = 116;
export const PayloadType = { Output: 1, Error: 2, Size: 3, Parameter: 4, HandshakeRequest: 5, HandshakeResponse: 6, HandshakeComplete: 7, Flag: 10, StdErr: 11, ExitCode: 12 } as const;
const CLIENT_VERSION = '1.2.0.0';

export interface ClientMessage {
    type: string; schemaVersion: number; createdDate: number; seq: number; flags: number;
    id: string; payloadType: number; payload: Buffer;
}

function uuidToWire(uuid: string): Buffer {
    const b = Buffer.from(uuid.replace(/-/g, ''), 'hex');
    return Buffer.concat([b.subarray(8, 16), b.subarray(0, 8)]);
}
function wireToUuid(w: Buffer): string {
    const h = Buffer.concat([w.subarray(8, 16), w.subarray(0, 8)]).toString('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function encodeMessage(m: { type: string; seq: number; flags: number; payloadType: number; payload: Buffer; id?: string }): Buffer {
    const buf = Buffer.alloc(HEADER_LENGTH + 4 + m.payload.length);
    buf.writeUInt32BE(HEADER_LENGTH, 0);
    buf.write(m.type.padEnd(32, ' ').slice(0, 32), 4, 32, 'utf8');
    buf.writeUInt32BE(1, 36);
    buf.writeBigUInt64BE(BigInt(Date.now()), 40);
    buf.writeBigInt64BE(BigInt(m.seq), 48);
    buf.writeBigUInt64BE(BigInt(m.flags), 56);
    uuidToWire(m.id ?? randomUUID()).copy(buf, 64);
    createHash('sha256').update(m.payload).digest().copy(buf, 80);
    buf.writeUInt32BE(m.payloadType, 112);
    buf.writeUInt32BE(m.payload.length, 116);
    m.payload.copy(buf, 120);
    return buf;
}

export function decodeMessage(buf: Buffer): ClientMessage {
    if (buf.length < 120) throw new Error('short message');
    const hl = buf.readUInt32BE(0);
    const len = buf.readUInt32BE(hl);
    return {
        type: buf.toString('utf8', 4, 36).replace(/[\s\0]+$/, '').replace(/^[\s\0]+/, ''),
        schemaVersion: buf.readUInt32BE(36),
        createdDate: Number(buf.readBigUInt64BE(40)),
        seq: Number(buf.readBigInt64BE(48)),
        flags: Number(buf.readBigUInt64BE(56)),
        id: wireToUuid(buf.subarray(64, 80)),
        payloadType: hl >= 116 ? buf.readUInt32BE(112) : 0,
        payload: buf.subarray(hl + 4, hl + 4 + len),
    };
}

export interface ShellStream {
    /** Keystrokes / pasted text. */
    input(data: string): void;
    resize(cols: number, rows: number): void;
    close(): void;
}

export interface StreamHandlers {
    onOutput(data: Buffer): void;
    /** The shell ended (exit, idle timeout on the instance, or an error). */
    onClose(reason: string): void;
    /** Handshake finished: the shell is ready for input. */
    onReady?(): void;
}

/** Connect to a StartSession stream and run the shell protocol over it. */
export function openShellStream(streamUrl: string, tokenValue: string, h: StreamHandlers, size: { cols: number; rows: number }): ShellStream {
    const ws = new WebSocket(streamUrl);
    let outSeq = 0;              // our input_stream_data sequence
    let expected = 0;            // next agent output sequence to deliver
    const pending = new Map<number, ClientMessage>();
    let closed = false;
    let ready = false;
    let cols = size.cols, rows = size.rows;

    const finish = (reason: string) => {
        if (closed) return;
        closed = true;
        try { ws.close(); } catch { /* already closed */ }
        h.onClose(reason);
    };
    const send = (payloadType: number, payload: Buffer) => {
        if (closed || ws.readyState !== WebSocket.OPEN) return;
        ws.send(encodeMessage({ type: 'input_stream_data', seq: outSeq++, flags: 0, payloadType, payload }));
    };
    const ack = (m: ClientMessage) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const content = { AcknowledgedMessageType: m.type, AcknowledgedMessageId: m.id, AcknowledgedMessageSequenceNumber: m.seq, IsSequentialMessage: true };
        ws.send(encodeMessage({ type: 'acknowledge', seq: 0, flags: 3, payloadType: 0, payload: Buffer.from(JSON.stringify(content)) }));
    };
    const sendSize = () => send(PayloadType.Size, Buffer.from(JSON.stringify({ cols, rows })));

    const deliver = (m: ClientMessage) => {
        switch (m.payloadType) {
            case PayloadType.HandshakeRequest: {
                let req: { RequestedClientActions?: { ActionType: string }[] } = {};
                try { req = JSON.parse(m.payload.toString('utf8')); } catch { /* empty request */ }
                const actions = (req.RequestedClientActions ?? []).map((a) => a.ActionType === 'SessionType'
                    ? { ActionType: a.ActionType, ActionStatus: 1 }
                    : { ActionType: a.ActionType, ActionStatus: 2, Error: `${a.ActionType} is not supported by the Ops Console terminal` });
                send(PayloadType.HandshakeResponse, Buffer.from(JSON.stringify({ ClientVersion: CLIENT_VERSION, ProcessedClientActions: actions, Errors: [] })));
                if (actions.some((a) => a.ActionStatus !== 1)) {
                    h.onOutput(Buffer.from('\r\nThis instance asks for KMS-encrypted sessions, which the browser terminal does not support yet.\r\n'));
                }
                break;
            }
            case PayloadType.HandshakeComplete:
                if (!ready) { ready = true; sendSize(); h.onReady?.(); }
                break;
            case PayloadType.Output:
            case PayloadType.StdErr:
                if (!ready) { ready = true; sendSize(); h.onReady?.(); }   // older agents skip the handshake
                h.onOutput(m.payload);
                break;
            default:
                break;   // Flag, ExitCode, ...: nothing to show
        }
    };

    ws.on('open', () => {
        ws.send(JSON.stringify({ MessageSchemaVersion: '1.0', RequestId: randomUUID(), TokenValue: tokenValue, ClientId: randomUUID(), ClientVersion: CLIENT_VERSION }));
    });
    ws.on('message', (data, isBinary) => {
        if (!isBinary) return;
        let m: ClientMessage;
        try { m = decodeMessage(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)); } catch { return; }
        if (m.type === 'output_stream_data') {
            if (m.seq < expected) { ack(m); return; }          // a resend of something already shown
            ack(m);
            pending.set(m.seq, m);
            while (pending.has(expected)) { const next = pending.get(expected)!; pending.delete(expected); expected++; deliver(next); }
            if (pending.size > 1000) finish('the session stream fell too far out of order');
        } else if (m.type === 'channel_closed') {
            let why = 'the session ended';
            try { const c = JSON.parse(m.payload.toString('utf8')); if (c.Output) why = String(c.Output); } catch { /* keep default */ }
            finish(why);
        }
        // acknowledge / start_publication / pause_publication: nothing to do over a reliable socket
    });
    ws.on('close', () => finish('the session stream closed'));
    ws.on('error', (err) => finish(`session stream error: ${err.message}`));

    return {
        input(data) {
            if (!ready) return;
            // like the plugin: a bare LF from the keyboard is Enter
            send(PayloadType.Output, Buffer.from(data === '\n' ? '\r' : data, 'utf8'));
        },
        resize(c, r) {
            cols = Math.max(10, Math.min(500, Math.floor(c))); rows = Math.max(5, Math.min(200, Math.floor(r)));
            if (ready) sendSize();
        },
        close() { finish('closed by the console'); },
    };
}

/** Local test mode: a pretend shell that never reaches the instance. */
export function simulatedShell(h: StreamHandlers, name: string): ShellStream {
    let line = '';
    let closed = false;
    const prompt = () => h.onOutput(Buffer.from(`\x1b[32mssm-user@${name}\x1b[0m:~$ `));
    setTimeout(() => {
        h.onReady?.();
        h.onOutput(Buffer.from(`\x1b[33mLocal test mode: this is a simulated shell. Nothing you type reaches ${name}.\x1b[0m\r\n` +
            `Try: whoami, uptime, date, help, exit\r\n\r\n`));
        prompt();
    }, 300);
    const answer = (cmd: string): string => {
        switch (cmd.trim()) {
            case '': return '';
            case 'whoami': return 'ssm-user';
            case 'date': return new Date().toUTCString();
            case 'uptime': return ` ${new Date().toTimeString().slice(0, 8)} up 3 days,  2 users,  load average: 0.08, 0.05, 0.01`;
            case 'help': return 'Simulated commands: whoami, uptime, date, echo <text>, exit';
            default: return cmd.startsWith('echo ') ? cmd.slice(5) : `${cmd.split(' ')[0]}: simulated (local test mode)`;
        }
    };
    return {
        input(data) {
            if (closed) return;
            for (const ch of data) {
                if (ch === '\r' || ch === '\n') {
                    const cmd = line; line = '';
                    h.onOutput(Buffer.from('\r\n'));
                    if (cmd.trim() === 'exit') { closed = true; h.onClose('exit'); return; }
                    const out = answer(cmd);
                    if (out) h.onOutput(Buffer.from(out + '\r\n'));
                    prompt();
                } else if (ch === '\x7f' || ch === '\b') {
                    if (line) { line = line.slice(0, -1); h.onOutput(Buffer.from('\b \b')); }
                } else if (ch === '\x03') {
                    line = ''; h.onOutput(Buffer.from('^C\r\n')); prompt();
                } else if (ch >= ' ') {
                    line += ch; h.onOutput(Buffer.from(ch));
                }
            }
        },
        resize() { /* nothing to do */ },
        close() { if (!closed) { closed = true; h.onClose('closed by the console'); } },
    };
}

