/* enchanter/src/transport/streamable-http.ts — implements architecture-spec
   phase_3.transports.streamable_http (MCP MUSTs: server MUST provide single
   endpoint supporting POST + GET; client MUST POST to send JSON-RPC messages;
   client MUST send Accept: application/json, text/event-stream) and
   phase_4 failure-mode 5 (unbounded resources — 8MB body cap) and
   failure-mode 8 (session hijacking — resume disabled by default). */

import { Agent, buildConnector, request as undiciRequest, type Dispatcher } from 'undici';
import type { TLSSocket } from 'node:tls';
import { parseJsonRpc, serializeJsonRpc, type JsonRpcMessage } from '../protocol/jsonrpc.js';
import { BodyTooLargeError, PER_MESSAGE_BODY_MAX_BYTES } from './stdio.js';
import {
  TlsPinMismatchError,
  TlsPinUnknownError,
  verifyTlsPin,
  type TlsPinStore,
} from './tls-pin.js';

// ---------------------------------------------------------------------------
// Backoff constants — [author judgment]:
//   initialMs=500, factor=2, maxMs=30_000 match the reconnect.ts pattern
//   referenced in the directory blueprint.  Jitter ±20% spreads reconnect
//   thundering herds across concurrent SSE consumers.  maxAttempts=10 gives
//   ~10 minutes of retry before giving up (~500+1000+2000+…+30000*5).
// ---------------------------------------------------------------------------
const BACKOFF_INITIAL_MS = 500;
const BACKOFF_FACTOR = 2;
const BACKOFF_MAX_MS = 30_000;
const BACKOFF_JITTER_FRACTION = 0.2; // ±20%
const BACKOFF_MAX_ATTEMPTS = 10;

// MCP normative Accept header
// MCP MUST: client MUST send Accept: application/json, text/event-stream
const ACCEPT_HEADER = 'application/json, text/event-stream';

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class TlsPinTransportError extends Error {
  constructor(public readonly origin: string, public readonly cause: Error) {
    super(`TLS pin verification failed for ${origin}: ${cause.message}`);
    this.name = 'TlsPinTransportError';
  }
}

export class StreamableHttpResumeError extends Error {
  constructor() {
    super(
      'GET resume is disabled by default (architecture-spec phase_4 failure-mode 8). ' +
        'Pass allowResume: true and a sessionNonce to opt in.',
    );
    this.name = 'StreamableHttpResumeError';
  }
}

export class StreamableHttpMaxRetriesError extends Error {
  constructor(public readonly attempts: number) {
    super(`SSE stream reconnect gave up after ${attempts} attempts`);
    this.name = 'StreamableHttpMaxRetriesError';
  }
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface StreamableHttpTransportOptions {
  /**
   * Resume disabled by default (failure-mode 8 mitigation). When true a
   * sessionNonce MUST be supplied via setSessionNonce().
   * [author judgment]: nonce binding is the minimal viable resume guard until
   * the full stream-session.ts nonce-bound session manager exists.
   */
  allowResume?: boolean;
  /** Custom dispatcher (used by tests via undici MockAgent). */
  dispatcher?: Dispatcher;
  /**
   * Optional TLS pin store (FM 6 server-spoofing mitigation). When supplied
   * AND `dispatcher` is NOT supplied, the transport builds a TLS-pinning
   * Agent that hashes the leaf cert on every TLS handshake and runs
   * verifyTlsPin() before any request bytes are sent.
   *
   * If `dispatcher` is also supplied, the explicit dispatcher wins (test
   * MockAgent path); the pin store is ignored. This keeps the existing
   * MockAgent-based tests working unchanged.
   */
  tlsPinStore?: TlsPinStore;
  /** TLS pin policy. Defaults to 'tofu' when tlsPinStore is supplied. */
  tlsPinPolicy?: 'tofu' | 'pinned';
  /**
   * Optional callback for security events emitted by the transport. Fires
   * on TLS pin mismatch / unknown-pin (PINNED policy). Hooked into the
   * existing event-bus by callers; the transport itself stays bus-agnostic.
   */
  onSecurityEvent?: (event: {
    topic: 'tls-pin.mismatch' | 'tls-pin.unknown';
    origin: string;
    detail: Record<string, unknown>;
  }) => void;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export class StreamableHttpTransport {
  private readonly endpoint: string;
  private readonly origin: string;
  private readonly options: StreamableHttpTransportOptions;
  private authToken: string | undefined;
  private sessionNonce: string | undefined;
  private pinningDispatcher: Dispatcher | undefined;

  // Buffer of server-push messages received via the GET SSE stream.
  // recv() drains this queue as a shared async source.
  private readonly queue: JsonRpcMessage[] = [];
  private queueResolve: ((msg: JsonRpcMessage) => void) | undefined;

  constructor(endpoint: string, options: StreamableHttpTransportOptions = {}) {
    this.endpoint = endpoint;
    this.options = options;
    // Origin: scheme + host + port — see tls-pin.ts pin-key contract.
    const u = new URL(endpoint);
    this.origin = u.origin;
  }

  /**
   * Returns the dispatcher to use for an outgoing request. Resolution order:
   *   1. Explicit options.dispatcher (test MockAgent path) — wins.
   *   2. tlsPinStore present → build (once, memoized) a TLS-pinning Agent.
   *   3. undefined → undici uses the global default agent.
   */
  private getDispatcher(): Dispatcher | undefined {
    if (this.options.dispatcher) return this.options.dispatcher;
    if (!this.options.tlsPinStore) return undefined;
    if (!this.pinningDispatcher) {
      this.pinningDispatcher = this.buildPinningAgent();
    }
    return this.pinningDispatcher;
  }

  private buildPinningAgent(): Dispatcher {
    const store = this.options.tlsPinStore!;
    const policy = this.options.tlsPinPolicy ?? 'tofu';
    const origin = this.origin;
    const onSecurityEvent = this.options.onSecurityEvent;

    // allowH2: false keeps the connector single-protocol — h2 introduces a
    // second TLS handshake path the pin check would have to cover separately.
    const baseConnector = buildConnector({ allowH2: false });

    const pinningConnector: typeof baseConnector = (opts, callback) => {
      baseConnector(opts, (err, socket) => {
        if (err || !socket) {
          callback(err as Error, null);
          return;
        }

        // Only TLS sockets carry a peer cert; plaintext HTTP gets passed through.
        const tls = socket as TLSSocket;
        if (typeof tls.getPeerCertificate !== 'function') {
          callback(null, socket);
          return;
        }

        try {
          const peer = tls.getPeerCertificate(true);
          // peer.raw is a Buffer of the DER-encoded leaf cert.
          if (!peer || !peer.raw || peer.raw.length === 0) {
            const e = new Error('TLS handshake produced no peer certificate');
            socket.destroy(e);
            callback(e, null);
            return;
          }

          verifyTlsPin(store, origin, peer.raw, policy);
          callback(null, socket);
        } catch (verifyErr) {
          const e = verifyErr as Error;
          if (onSecurityEvent) {
            if (e instanceof TlsPinMismatchError) {
              onSecurityEvent({
                topic: 'tls-pin.mismatch',
                origin,
                detail: { expected: e.expected, seen: e.seen },
              });
            } else if (e instanceof TlsPinUnknownError) {
              onSecurityEvent({
                topic: 'tls-pin.unknown',
                origin,
                detail: {},
              });
            }
          }
          // Abort the connection — fail closed per tls-pinning.md.
          socket.destroy(e);
          callback(new TlsPinTransportError(origin, e), null);
        }
      });
    };

    return new Agent({ connect: pinningConnector });
  }

  /** OAuth Bearer token support. Call before send(). */
  setAuthToken(token: string): void {
    this.authToken = token;
  }

  /**
   * Session-nonce binding for resume (failure-mode 8 opt-in).
   * Must be called when allowResume: true.
   */
  setSessionNonce(nonce: string): void {
    this.sessionNonce = nonce;
  }

  // ---------------------------------------------------------------------------
  // send() — MCP MUST: client MUST POST to send JSON-RPC messages
  // ---------------------------------------------------------------------------

  /**
   * POST a single JSON-RPC message to the endpoint.
   * Reads either an application/json response (single message) or a
   * text/event-stream response (stream of messages from SSE data: lines).
   * Any yielded messages are pushed to the shared recv() queue.
   */
  async send(msg: JsonRpcMessage): Promise<void> {
    const body = serializeJsonRpc(msg);
    const bodyBytes = Buffer.byteLength(body, 'utf8');
    // failure-mode 5: 8MB cap before transport buffer parse
    if (bodyBytes > PER_MESSAGE_BODY_MAX_BYTES) {
      throw new BodyTooLargeError(bodyBytes);
    }

    const headers = this.buildHeaders({ contentType: 'application/json' });

    // MCP MUST: client MUST POST; MCP MUST: send Accept: application/json, text/event-stream
    const res = await undiciRequest(this.endpoint, {
      method: 'POST',
      headers,
      body,
      dispatcher: this.getDispatcher(),
    });

    const contentType = (res.headers['content-type'] ?? '').toString();

    if (contentType.includes('text/event-stream')) {
      // Server chose to stream — drain all SSE data: lines into the queue
      await this.drainSse(res.body);
    } else {
      // application/json — single message response
      const raw = await this.readBody(res.body);
      if (raw.trim().length > 0) {
        this.enqueue(parseJsonRpc(raw));
      }
    }
  }

  // ---------------------------------------------------------------------------
  // recv() — async iterator yielding parsed JSON-RPC messages
  // ---------------------------------------------------------------------------

  /**
   * Async iterator over all inbound messages. Sources:
   *   1. Messages buffered from POST responses (JSON or SSE).
   *   2. Messages from the long-lived GET SSE stream (server-initiated).
   *
   * Callers should call openGetStream() to start receiving server-initiated
   * messages; without it recv() yields only POST-response messages.
   */
  async *recv(): AsyncIterableIterator<JsonRpcMessage> {
    while (true) {
      const msg = await this.dequeue();
      yield msg;
    }
  }

  // ---------------------------------------------------------------------------
  // openGetStream() — long-lived SSE for server-initiated messages
  // ---------------------------------------------------------------------------

  /**
   * Opens the long-lived GET SSE stream. Runs an auto-reconnect loop with
   * exponential backoff (initial 500ms, factor 2, max 30s, jitter ±20%).
   * Resume disabled by default (failure-mode 8); pass allowResume + nonce to
   * opt in.
   *
   * [author judgment]: max 10 reconnect attempts before throwing
   * StreamableHttpMaxRetriesError.  Callers managing their own lifecycle can
   * abort the stream via the AbortController they own.
   */
  async openGetStream(signal?: AbortSignal): Promise<void> {
    // MCP failure-mode 8: resume disabled by default
    if (this.options.allowResume && !this.sessionNonce) {
      throw new StreamableHttpResumeError();
    }

    let attempt = 0;
    let delayMs = BACKOFF_INITIAL_MS;

    while (true) {
      if (signal?.aborted) return;
      try {
        const headers = this.buildHeaders({});
        if (this.options.allowResume && this.sessionNonce) {
          // Bind nonce per failure-mode 8 mitigation
          headers['x-session-nonce'] = this.sessionNonce;
        }

        // MCP MUST: client MUST send Accept: application/json, text/event-stream
        const res = await undiciRequest(this.endpoint, {
          method: 'GET',
          headers,
          dispatcher: this.getDispatcher(),
          signal,
        });

        // Reset attempts on successful connection
        attempt = 0;
        delayMs = BACKOFF_INITIAL_MS;

        // Drain SSE stream; returns when the server closes the connection
        await this.drainSse(res.body, signal);
      } catch (err) {
        if (signal?.aborted) return;

        attempt++;
        if (attempt >= BACKOFF_MAX_ATTEMPTS) {
          throw new StreamableHttpMaxRetriesError(attempt);
        }

        // Exponential backoff with ±20% jitter
        const jitter = 1 + (Math.random() * 2 - 1) * BACKOFF_JITTER_FRACTION;
        const wait = Math.min(delayMs * jitter, BACKOFF_MAX_MS);
        await sleep(wait);
        delayMs = Math.min(delayMs * BACKOFF_FACTOR, BACKOFF_MAX_MS);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private buildHeaders(opts: { contentType?: string }): Record<string, string> {
    const h: Record<string, string> = {
      // MCP MUST: client MUST send Accept: application/json, text/event-stream
      accept: ACCEPT_HEADER,
    };
    if (opts.contentType) {
      h['content-type'] = opts.contentType;
    }
    if (this.authToken) {
      h['authorization'] = `Bearer ${this.authToken}`;
    }
    return h;
  }

  /**
   * Reads the entire response body with an 8MB cap (failure-mode 5).
   */
  private async readBody(body: Dispatcher.ResponseData['body']): Promise<string> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of body) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer);
      total += buf.length;
      if (total > PER_MESSAGE_BODY_MAX_BYTES) {
        throw new BodyTooLargeError(total);
      }
      chunks.push(buf);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  /**
   * Drains a text/event-stream body, parsing SSE data: lines into JSON-RPC
   * messages and enqueuing them.  Handles multi-line events (spec: event ends
   * on blank line; data: lines within one event are concatenated).
   */
  private async drainSse(
    body: Dispatcher.ResponseData['body'],
    signal?: AbortSignal,
  ): Promise<void> {
    let lineBuffer = '';
    let eventData = '';
    let totalBytes = 0;

    const flush = () => {
      if (eventData.trim().length > 0) {
        this.enqueue(parseJsonRpc(eventData));
      }
      eventData = '';
    };

    for await (const chunk of body) {
      if (signal?.aborted) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer);
      totalBytes += buf.length;
      // failure-mode 5: 8MB cap applies to SSE stream body as well
      if (totalBytes > PER_MESSAGE_BODY_MAX_BYTES) {
        throw new BodyTooLargeError(totalBytes);
      }

      lineBuffer += buf.toString('utf8');

      let newlineIdx: number;
      while ((newlineIdx = lineBuffer.indexOf('\n')) !== -1) {
        const line = lineBuffer.slice(0, newlineIdx).replace(/\r$/, '');
        lineBuffer = lineBuffer.slice(newlineIdx + 1);

        if (line === '') {
          // Blank line = end of SSE event
          flush();
        } else if (line.startsWith('data:')) {
          const payload = line.slice(5).replace(/^ /, '');
          // SSE multi-line: concatenate data: lines (rare in practice)
          eventData = eventData ? eventData + payload : payload;
        }
        // Other SSE fields (event:, id:, retry:) are silently skipped — v1
      }
    }
    // Tail flush if stream closed without trailing blank line
    flush();
  }

  private enqueue(msg: JsonRpcMessage): void {
    if (this.queueResolve) {
      const resolve = this.queueResolve;
      this.queueResolve = undefined;
      resolve(msg);
    } else {
      this.queue.push(msg);
    }
  }

  private dequeue(): Promise<JsonRpcMessage> {
    if (this.queue.length > 0) {
      // non-null assertion safe: length > 0
      return Promise.resolve(this.queue.shift()!);
    }
    return new Promise<JsonRpcMessage>((resolve) => {
      this.queueResolve = resolve;
    });
  }
}

// ---------------------------------------------------------------------------
// Internal utility
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
