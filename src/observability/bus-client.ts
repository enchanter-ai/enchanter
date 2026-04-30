/* src/observability/bus-client.ts — producer-side event forwarder.
 *
 * Producer subprocesses (enchanter mcp-wrap / watch / run / hooks) own their
 * own in-process bus + plugins so veto decisions stay synchronous. This
 * helper opens a non-blocking connection to a running enchanter inspector's
 * broadcaster and forwards every locally-published event so the TUI sees
 * the full picture across all producers.
 *
 * Failure mode: if the inspector isn't running, every send is a no-op. We
 * never block the producer's main work on broadcaster availability — it's
 * advisory observability, not load-bearing.
 */

import { WebSocket } from 'ws';
import type { Bus } from '../bus/pubsub.js';
import type { EnchantedEvent } from '../bus/event-types.js';

export const DEFAULT_BROADCASTER_URL = 'ws://127.0.0.1:3001/ws';

export class BusClient {
  private ws: WebSocket | null = null;
  private connected = false;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private buf: EnchantedEvent[] = [];
  private readonly maxBuffer = 200;
  private closed = false;

  constructor(private readonly url: string = DEFAULT_BROADCASTER_URL) {}

  /** Open the WS connection. Reconnects with backoff if the broadcaster
   *  isn't reachable yet (user might launch the inspector after the
   *  producer). */
  connect(): void {
    if (this.closed) return;
    try {
      this.ws = new WebSocket(this.url);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws.on('open',  () => this.onOpen());
    this.ws.on('close', () => this.onClose());
    this.ws.on('error', () => { /* swallow — onClose retries */ });
  }

  /** Attach to a bus: forward every event the bus publishes to the broadcaster. */
  attach(bus: Bus): void {
    bus.subscribe('*', (e) => this.send(e));
  }

  send(event: EnchantedEvent): void {
    if (this.closed) return;
    if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.buf.push(event);
      if (this.buf.length > this.maxBuffer) this.buf.shift();
      return;
    }
    try {
      this.ws.send(JSON.stringify({ kind: 'event', event }));
    } catch {
      this.buf.push(event);
    }
  }

  close(): void {
    this.closed = true;
    if (this.retry) { clearTimeout(this.retry); this.retry = null; }
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = null;
  }

  private onOpen(): void {
    this.connected = true;
    // Drain anything buffered while disconnected.
    for (const e of this.buf) {
      try { this.ws?.send(JSON.stringify({ kind: 'event', event: e })); }
      catch { /* drop */ }
    }
    this.buf = [];
  }

  private onClose(): void {
    this.connected = false;
    this.ws = null;
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.closed || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      this.connect();
    }, 2_000);
  }
}
