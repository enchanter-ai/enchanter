/* vscode-extension/src/ws-client.ts
   Architecture-spec: dashboard WebSocket protocol (hello/snapshot/event/ack).
   Uses VS Code's bundled Node runtime (Node 20+) which exposes a native
   `WebSocket` global — no `ws` npm dep needed. Reconnects with 2s/4s/8s
   exponential backoff (3 attempts). */

import type { EnchantedEvent, LifecyclePhase, BudgetTier } from './types.js';

// Node 20+ has a native global WebSocket (https://nodejs.org/api/globals.html#websocket).
// VS Code Electron embeds Node 20+ across all supported releases.
declare const WebSocket: typeof globalThis.WebSocket;

export type { LifecyclePhase, BudgetTier }; // re-export so consumers can import from ws-client

export interface PechLedgerEntry {
  ts: number; vendor: string; plugin: string;
  input_tokens: number; output_tokens: number;
}

export type DashboardMessage =
  | { kind: 'event'; event: EnchantedEvent }
  | { kind: 'ack'; correlation_id: string; phase: LifecyclePhase; plugin: string; status: 'ack' | 'veto' | 'error'; degraded?: boolean; reason?: string }
  | { kind: 'snapshot'; ledger: PechLedgerEntry[]; bus_event_count: number; veto_count: number; mask_count: number; active_correlations: string[] }
  | { kind: 'hello'; server_time: number; phases: ReadonlyArray<LifecyclePhase>; plugins: string[] };

export type MessageListener = (msg: DashboardMessage) => void;
export type StatusListener = (connected: boolean, url: string) => void;

const BACKOFF_MS = [2000, 4000, 8000] as const;

export class WsClient {
  private ws: WebSocket | null = null;
  private url: string;
  private attempt = 0;
  private destroyed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly msgListeners = new Set<MessageListener>();
  private readonly statusListeners = new Set<StatusListener>();

  constructor(url: string) {
    this.url = url;
  }

  connect(url?: string): void {
    if (url) { this.url = url; }
    this.destroyed = false;
    this.attempt = 0;
    this._open();
  }

  disconnect(): void {
    this.destroyed = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.ws?.close();
    this.ws = null;
    this._notifyStatus(false);
  }

  onMessage(listener: MessageListener): () => void {
    this.msgListeners.add(listener);
    return () => this.msgListeners.delete(listener);
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  get currentUrl(): string { return this.url; }
  get isConnected(): boolean { return this.ws?.readyState === WebSocket.OPEN; }

  private _open(): void {
    if (this.destroyed) { return; }
    try {
      const ws = new WebSocket(this.url);
      this.ws = ws;

      // Native WebSocket uses addEventListener; ws library used .on. Same logic.
      ws.addEventListener('open', () => {
        this.attempt = 0;
        this._notifyStatus(true);
      });

      ws.addEventListener('message', (ev: MessageEvent) => {
        try {
          const raw = typeof ev.data === 'string' ? ev.data : '';
          if (!raw) return;
          const msg = JSON.parse(raw) as DashboardMessage;
          this.msgListeners.forEach(l => l(msg));
        } catch { /* malformed — skip */ }
      });

      ws.addEventListener('close', () => {
        this._notifyStatus(false);
        this._scheduleReconnect();
      });

      ws.addEventListener('error', () => {
        try { ws.close(); } catch { /* already closed */ }
      });
    } catch {
      this._notifyStatus(false);
      this._scheduleReconnect();
    }
  }

  private _scheduleReconnect(): void {
    if (this.destroyed || this.attempt >= BACKOFF_MS.length) { return; }
    const delay = BACKOFF_MS[this.attempt++];
    this.reconnectTimer = setTimeout(() => { this._open(); }, delay);
  }

  private _notifyStatus(connected: boolean): void {
    this.statusListeners.forEach(l => l(connected, this.url));
  }
}
