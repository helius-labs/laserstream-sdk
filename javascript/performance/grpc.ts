/* ------------------------------------------------------------------------- */
/* Author: Koen Rijpstra                                                     */
/* A lightweight opinionated gRPC client for the Solana Geyser stream.       */
/* Requires Node.js v22 or higher                                           */
/* ------------------------------------------------------------------------- */
'use strict';
 
import http2 from 'http2';
import net from 'net';
import tls from 'tls';
import { URL } from 'url';
import { EventEmitter } from 'events';
import {
  SubscribeRequest,
  SubscribeUpdate,
  CommitmentLevel,
} from '@triton-one/yellowstone-grpc';

/* ------------------------------------------------------------------------- */
/* Constants                                                                 */
/* ------------------------------------------------------------------------- */
/* Settings rationale:                                                       */
/* - MAX_FRAME_SIZE (16 MiB - 1): largest legal HTTP/2 frame size;           */
/*   batches protobuf messages efficiently with minimal fragmentation.       */
/* - MAX_WINDOW (2 GiB ‑ 1): maximum flow-control window to reduce           */
/*   back-pressure and sustain high-throughput streaming workloads.          */
/* - No compression (grpc-encoding: identity): avoids CPU cost and latency   */
/*   for already efficient protobuf payloads.                                */
/* ------------------------------------------------------------------------- */
const MAX_FRAME_SIZE = 16_777_215;      // 16 MiB ‑ 1 (HTTP/2 limit)
const MAX_WINDOW = 0x7fffffff;          // 2 GiB ‑ 1
const GRPC_PATH = '/geyser.Geyser/Subscribe';

/* ------------------------------------------------------------------------- */
/* gRPC framing helpers                                                      */
/* ------------------------------------------------------------------------- */
function encodeGrpcFrame(buf: Buffer): Buffer {
    const frame = Buffer.allocUnsafe(buf.length + 5);
    frame[0] = 0; // no compression
    frame.writeUInt32BE(buf.length, 1);
    buf.copy(frame, 5);
    return frame;
}

class GrpcFrameParser {
    buf = Buffer.allocUnsafe(0);
    offset = 0;
    cb: (payload: Buffer) => void;

    constructor(cb: (payload: Buffer) => void) {
        this.cb = cb;
    }

    feed(chunk: Buffer): void {
        if (this.offset === this.buf.length) {
            this.buf = chunk;
            this.offset = 0;
        }
        else {
            this.buf = Buffer.concat([this.buf.slice(this.offset), chunk]);
            this.offset = 0;
        }
        this.process();
    }

    process(): void {
        while (this.buf.length - this.offset >= 5) {
            const compressed = this.buf[this.offset];
            const len = this.buf.readUInt32BE(this.offset + 1);
            if (this.buf.length - this.offset - 5 < len)
                break;
            const start = this.offset + 5;
            const end = start + len;
            const payload = this.buf.slice(start, end);
            this.offset = end;
            if (compressed !== 0)
                continue;               // ignore (and flag, if you prefer) unsupported compressed frames
            this.cb(payload);
        }
        if (this.offset === this.buf.length) {
            this.buf = Buffer.allocUnsafe(0);
            this.offset = 0;
        }
    }
}

/* ------------------------------------------------------------------------- */
/* GrpcStream – lightweight Duplex-like wrapper                               */
/* ------------------------------------------------------------------------- */
export class GrpcStream extends EventEmitter {
    req: http2.ClientHttp2Stream;
    _parser: GrpcFrameParser | null = null;
    _hdr: Buffer;

    constructor(req: http2.ClientHttp2Stream) {
        super();
        this.req = req;
        this._hdr = Buffer.allocUnsafe(5);
        this._hdr[0] = 0;          // compression flag – never changes
    }

    /** gRPC payload writer */
    write(msg: any): void {
        const ui8 = SubscribeRequest.encode(msg).finish();
        // Ensure we have a Buffer view without copy (protobufjs returns Uint8Array)
        const payload = Buffer.from(ui8.buffer, ui8.byteOffset, ui8.byteLength);

        this.req.write(encodeGrpcFrame(payload));        
    }

    /** Close the request half */
    end(): void {
        this.req.end();
    }

    /** Allow external error handling */
    close(): void {
        try {
            this.req.close();
        } catch {
            /* ignore */
        }
    }

    /** Internal – set by subscribe() */
    _setParser(p: GrpcFrameParser): void {
        this._parser = p;
    }

    /** Bytes currently buffered in the parser */
    size(): number {
        if (this._parser) {
            // raw buffer minus processed offset
            return this._parser.buf.length - this._parser.offset;
        }
        return 0;
    }
}

/* ------------------------------------------------------------------------- */
/* Client                                                                    */
/* ------------------------------------------------------------------------- */
export default class Client {
    endpoint: string;
    apiKey: string;
    opts: any;
    session: http2.ClientHttp2Session | undefined;

    constructor(endpoint: string, apiKey: string, opts: any = {}) {
        this.endpoint = endpoint;
        this.apiKey = apiKey;
        this.opts = opts;
    }

    async createSession(): Promise<http2.ClientHttp2Session> {
        if (this.session && !this.session.destroyed)
            return this.session;
        const url = new URL(this.endpoint);
        const tcp = await new Promise<net.Socket>((res, rej) => {
            const sock = net.connect(+url.port || 443, url.hostname, () => res(sock));
            sock.once('error', rej);
        });
        // Disable Nagle's algorithm (TCP_NODELAY)
        tcp.setNoDelay(true);
        tcp.setKeepAlive(true, 30_000);
        const tlsSock = await new Promise<tls.TLSSocket>((res, rej) => {
            const s = tls.connect({ socket: tcp, servername: url.hostname, ALPNProtocols: ['h2'] }, () => res(s));
            s.once('error', rej);
        });
        const _session = http2.connect(this.endpoint, {
            createConnection: () => tlsSock,
            settings: {
                initialWindowSize: MAX_WINDOW,
                maxFrameSize: MAX_FRAME_SIZE,
            },
        });
        // Maximise local window (~2 GiB) if supported
        try {
            _session.setLocalWindowSize(MAX_WINDOW);
        }
        catch { }
        this.session = _session;
        return _session;
    }

    async subscribe(): Promise<GrpcStream> {
        const session = await this.createSession();
        const req = session.request({
            ':method': 'POST',
            ':path': GRPC_PATH,
            ':scheme': 'https',
            'content-type': 'application/grpc',
            'grpc-encoding': 'identity',
            'grpc-accept-encoding': 'identity',
            'x-token': this.apiKey,
            'te': 'trailers',
            'user-agent': 'helius-geyser-client/0.1.0',
        });
        const stream = new GrpcStream(req);
        // Hook low-level events and forward
        req.on('error', (e: Error) => stream.emit('error', e));
        req.on('end', () => stream.emit('end'));
        const parser = new GrpcFrameParser((payload: Buffer) => {
            try {
                const update = SubscribeUpdate.decode(payload) as any;
                // Attach raw payload size (in bytes) so callers can measure real throughput
                update.__payloadLength = payload.length;
                stream.emit('data', update);
            }
            catch (e) {
                // decoding errors forwarded as error events
                stream.emit('error', e);
            }
        });
        req.on('data', (chunk: Buffer) => {
            parser.feed(chunk);
        });
        // expose parser size to consumers
        stream._setParser(parser);
        return stream;
    }

    close(): void { 
        this.session?.close(); 
    }
}

export { CommitmentLevel, SubscribeRequest }; 