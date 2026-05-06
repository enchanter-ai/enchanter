/* src/observability/bridge.ts — TS-side event bridge to the Rust inspector.
 *
 * Subscribes to every topic on a Bus, serializes each EnchantedEvent into
 * the JSONL wire format documented in docs/event-schema.md, and forwards
 * one line per event to a sink (stdout / TCP / file). Importing this
 * module is side-effect-free — behavior only changes when a caller
 * explicitly constructs a Bridge and calls start().
 *
 * Failure mode: if the sink errors (TCP disconnect, file write failure)
 * the bridge logs via the injectable onError hook and, for TCP, retries
 * with exponential backoff. Producers never block on sink availability.
 */

import * as net from 'node:net';
import * as fs from 'node:fs';
import type { Bus } from '../bus/pubsub.js';
import type { EnchantedEvent, Subscription } from '../bus/event-types.js';
import {
  ControlDispatcher,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  type ApprovalResponse,
  type ControlChannel,
} from './control-protocol.js';
import { validate as validateEvent } from './schema.js';

/** Minimal one-line writer contract. Methods may return a Promise; the
 *  bridge awaits before writing the next line so backpressure is honored. */
export interface BridgeSink {
  write(line: string): void | Promise<void>;
  end(): void | Promise<void>;
}

/** Optional logger hook. Production code defaults to writing one line to
 *  process.stderr; tests inject a spy. */
export type ErrorLogger = (msg: string, err?: unknown) => void;

const defaultLogger: ErrorLogger = (msg, err) => {
  const tail = err === undefined ? '' : ` ${err instanceof Error ? err.message : String(err)}`;
  try {
    process.stderr.write(`[bridge] ${msg}${tail}\n`);
  } catch {
    /* swallow — logging must never throw */
  }
};

// ---------------------------------------------------------------------------
// Wire transform
// ---------------------------------------------------------------------------

/** Project an EnchantedEvent into the flat JSONL shape the Rust inspector
 *  expects. See docs/event-schema.md § "TS bridge transform". */
export function toWireRecord(event: EnchantedEvent): Record<string, unknown> {
  const record: Record<string, unknown> = {
    type: event.topic,
    time: event.ts / 1000,
  };

  // Splat payload first so it can be overridden by explicit type/time above.
  // (We already set type/time before this loop, so we splat AFTER and let
  //  payload-side fields populate slots the bridge didn't claim.)
  for (const [k, v] of Object.entries(event.payload)) {
    if (k === 'type' || k === 'time') continue; // never let payload override
    record[k] = v;
  }

  // Convenience: copy session_id / phase / plugin off the envelope when the
  // payload didn't already provide them. Rust's GenericPayload reads these
  // off the top level, and well-typed variants accept them too.
  if (record.session_id === undefined && event.session_id !== '') {
    record.session_id = event.session_id;
  }
  if (record.phase === undefined && event.phase !== undefined) {
    record.phase = event.phase;
  }
  if (record.plugin === undefined && event.source !== '') {
    record.plugin = event.source;
  }

  return record;
}

/** Serialize an event to a single JSONL line (no trailing newline added —
 *  callers append "\n"). Exposed for testing. */
export function serializeEvent(event: EnchantedEvent): string {
  return JSON.stringify(toWireRecord(event));
}

// ---------------------------------------------------------------------------
// Sinks
// ---------------------------------------------------------------------------

/** Write JSONL to process.stdout. Suitable for `runtime | inspector` pipes. */
export class StdoutSink implements BridgeSink {
  write(line: string): void {
    process.stdout.write(line);
  }
  end(): void {
    /* never end stdout — that would close the parent process's stdout */
  }
}

/** Append-only JSONL file. Errors during open propagate; per-write errors
 *  surface via the createWriteStream 'error' event, which we forward to the
 *  optional logger. */
export class FileSink implements BridgeSink {
  private readonly stream: fs.WriteStream;
  constructor(path: string, logger: ErrorLogger = defaultLogger) {
    this.stream = fs.createWriteStream(path, { flags: 'a' });
    this.stream.on('error', (err) => logger('file sink error', err));
  }
  write(line: string): Promise<void> {
    return new Promise((resolve) => {
      const ok = this.stream.write(line, () => resolve());
      // If the buffer is full, the callback still fires once drained; we
      // already resolved on the callback path so no extra await needed.
      if (!ok) {
        // Backpressure — caller's await keeps us from racing ahead.
      }
    });
  }
  end(): Promise<void> {
    return new Promise((resolve) => {
      this.stream.end(() => resolve());
    });
  }
}

/** Connect to a TCP `host:port` and stream JSONL lines. Retries on
 *  disconnect with exponential backoff capped at 30 s. While disconnected,
 *  events are dropped after a small bounded buffer fills — observability is
 *  advisory, not load-bearing, so we never block the producer. */
export class TcpSink implements BridgeSink {
  private socket: net.Socket | null = null;
  private connected = false;
  private closed = false;
  private retryDelay = 250; // ms
  private readonly retryCap = 30_000;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly buf: string[] = [];
  private readonly maxBuf = 200;

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly logger: ErrorLogger = defaultLogger,
  ) {
    this.connect();
  }

  private connect(): void {
    if (this.closed) return;
    const sock = net.connect({ host: this.host, port: this.port });
    this.socket = sock;
    sock.on('connect', () => {
      this.connected = true;
      this.retryDelay = 250;
      // Drain buffered lines; ignore write errors — onClose will retry.
      while (this.buf.length > 0 && this.connected) {
        const line = this.buf.shift();
        if (line === undefined) break;
        try {
          sock.write(line);
        } catch {
          break;
        }
      }
    });
    sock.on('close', () => this.onClose());
    sock.on('error', (err) => {
      this.logger('tcp sink error', err);
      // onClose follows automatically.
    });
  }

  private onClose(): void {
    this.connected = false;
    this.socket = null;
    if (this.closed) return;
    if (this.retryTimer) return;
    const delay = Math.min(this.retryDelay, this.retryCap);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.retryDelay = Math.min(this.retryDelay * 2, this.retryCap);
      this.connect();
    }, delay);
  }

  write(line: string): void | Promise<void> {
    if (this.closed) return;
    if (!this.connected || !this.socket) {
      this.buf.push(line);
      if (this.buf.length > this.maxBuf) this.buf.shift();
      return;
    }
    return new Promise((resolve) => {
      this.socket?.write(line, () => resolve());
    });
  }

  end(): Promise<void> {
    this.closed = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    return new Promise((resolve) => {
      const sock = this.socket;
      this.socket = null;
      if (!sock) return resolve();
      sock.end(() => resolve());
    });
  }
}

/**
 * Bidirectional TCP sink + control channel. Same as TcpSink for the outbound
 * (write JSONL events) half, but also reads inbound JSONL lines from the same
 * socket and feeds them into a ControlDispatcher.
 *
 * Producers use this exactly like TcpSink for emitting events; the
 * orchestrator's trust-gate consults `awaitDecision()` when a request.approval
 * needs a human verdict.
 *
 * Default-off contract: callers that don't need bidirectional behavior keep
 * using TcpSink. Constructing a TcpControlSink is the explicit opt-in.
 */
export class TcpControlSink implements BridgeSink, ControlChannel {
  private readonly host: string;
  private readonly port: number;
  private readonly logger: ErrorLogger;
  private socket: net.Socket | null = null;
  private connected = false;
  private closed = false;
  private retryDelay = 250;
  private readonly retryCap = 30_000;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly buf: string[] = [];
  private readonly maxBuf = 200;
  private readonly dispatcher = new ControlDispatcher();
  private readBuffer = '';

  constructor(host: string, port: number, logger: ErrorLogger = defaultLogger) {
    this.host = host;
    this.port = port;
    this.logger = logger;
    if (host !== '' && port !== 0) this.connect();
  }

  /** Inject a pre-paired socket. Used by tests with `net.createServer` so
   *  the suite never depends on a real listener. */
  static fromSocket(socket: net.Socket, logger: ErrorLogger = defaultLogger): TcpControlSink {
    const inst = new TcpControlSink('', 0, logger);
    inst.attachSocket(socket);
    inst.connected = true;
    return inst;
  }

  private connect(): void {
    if (this.closed) return;
    const sock = net.connect({ host: this.host, port: this.port });
    this.attachSocket(sock);
    sock.on('connect', () => {
      this.connected = true;
      this.retryDelay = 250;
      while (this.buf.length > 0 && this.connected) {
        const line = this.buf.shift();
        if (line === undefined) break;
        try {
          sock.write(line);
        } catch {
          break;
        }
      }
    });
  }

  private attachSocket(sock: net.Socket): void {
    this.socket = sock;
    sock.setEncoding('utf8');
    sock.on('data', (chunk: string | Buffer) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      this.readBuffer += text;
      // Split out complete lines; keep the trailing partial in readBuffer.
      let nl: number;
      while ((nl = this.readBuffer.indexOf('\n')) !== -1) {
        let line = this.readBuffer.slice(0, nl);
        this.readBuffer = this.readBuffer.slice(nl + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line.length === 0) continue;
        const dispatched = this.dispatcher.dispatch(line);
        if (!dispatched) {
          // Unknown control line — log once at debug level. Keep going so
          // future shapes don't break on first encounter.
          this.logger('control channel: unrecognized inbound line', line);
        }
      }
    });
    sock.on('close', () => this.onClose());
    sock.on('error', (err) => {
      this.logger('tcp control sink error', err);
    });
  }

  private onClose(): void {
    this.connected = false;
    this.socket = null;
    if (this.closed) return;
    if (this.retryTimer) return;
    const delay = Math.min(this.retryDelay, this.retryCap);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.retryDelay = Math.min(this.retryDelay * 2, this.retryCap);
      // Only auto-reconnect if we were configured with host:port (not
      // injected via fromSocket — those are owned by the test harness).
      if (this.host !== '' && this.port !== 0) this.connect();
    }, delay);
  }

  // BridgeSink ---------------------------------------------------------------
  write(line: string): void | Promise<void> {
    if (this.closed) return;
    if (!this.connected || !this.socket) {
      this.buf.push(line);
      if (this.buf.length > this.maxBuf) this.buf.shift();
      return;
    }
    return new Promise((resolve) => {
      this.socket?.write(line, () => resolve());
    });
  }

  end(): Promise<void> {
    this.closed = true;
    this.dispatcher.cancelAll('control channel closed');
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    return new Promise((resolve) => {
      const sock = this.socket;
      this.socket = null;
      if (!sock || sock.destroyed) return resolve();
      // Belt-and-suspenders: resolve on close OR end callback, whichever fires
      // first. If the peer already destroyed the socket the end callback may
      // never fire, but `close` will.
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      sock.once('close', finish);
      try {
        sock.end(finish);
      } catch {
        finish();
      }
    });
  }

  // ControlChannel -----------------------------------------------------------
  sendRequestApproval(req: {
    correlation_id: string;
    plugin: string;
    reason: string;
    phase: string;
    payload?: Record<string, unknown>;
    time?: number;
  }): void | Promise<void> {
    const record: Record<string, unknown> = {
      type: 'request.approval',
      time: req.time ?? Date.now() / 1000,
      correlation_id: req.correlation_id,
      plugin: req.plugin,
      reason: req.reason,
      phase: req.phase,
    };
    if (req.payload !== undefined) record.payload = req.payload;
    return this.write(JSON.stringify(record) + '\n');
  }

  awaitDecision(
    correlation_id: string,
    timeoutMs: number = DEFAULT_APPROVAL_TIMEOUT_MS,
  ): Promise<ApprovalResponse> {
    return this.dispatcher.awaitDecision(correlation_id, timeoutMs);
  }
}

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------

export interface BridgeOptions {
  /** Logger for sink errors. Defaults to a one-line stderr writer. */
  onError?: ErrorLogger;
}

export class Bridge {
  private subscription: Subscription | null = null;
  private writing: Promise<void> = Promise.resolve();
  private stopped = false;
  private readonly logger: ErrorLogger;

  constructor(
    private readonly bus: Bus,
    private readonly sink: BridgeSink,
    options: BridgeOptions = {},
  ) {
    this.logger = options.onError ?? defaultLogger;
  }

  /** Subscribe to every topic on the bus. Idempotent: a second start() with
   *  the bridge already running is a no-op. */
  start(): void {
    if (this.subscription !== null || this.stopped) return;
    this.subscription = this.bus.subscribe('*', (event) => {
      this.enqueue(event);
    });
  }

  /** Unsubscribe + flush in-flight writes + close the sink. Safe to call
   *  multiple times. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.subscription) {
      this.subscription.unsubscribe();
      this.subscription = null;
    }
    // Wait for queued writes to drain, then end the sink.
    try {
      await this.writing;
    } catch (err) {
      this.logger('bridge drain error', err);
    }
    try {
      await this.sink.end();
    } catch (err) {
      this.logger('bridge sink end error', err);
    }
  }

  private enqueue(event: EnchantedEvent): void {
    if (this.stopped) return;
    let record: Record<string, unknown>;
    try {
      record = toWireRecord(event);
    } catch (err) {
      this.logger('bridge serialize error', err);
      return;
    }
    // Schema-validate at the boundary. Drop on mismatch with a logged
    // warning — the bridge's contract is "every line on the wire is
    // schema-conformant" (see docs/event-schema.json).
    const verdict = validateEvent(record);
    if (!verdict.ok) {
      this.logger(
        `bridge schema validation failed for type=${String(record.type)}: ${verdict.reason} at /${verdict.path.join('/')}`,
      );
      return;
    }
    let line: string;
    try {
      line = JSON.stringify(record) + '\n';
    } catch (err) {
      this.logger('bridge serialize error', err);
      return;
    }
    // Chain on the writing promise so order is preserved and the sink sees
    // backpressure-aware awaits.
    this.writing = this.writing.then(async () => {
      try {
        const r = this.sink.write(line);
        if (r instanceof Promise) await r;
      } catch (err) {
        this.logger('bridge sink write error', err);
      }
    });
  }
}
