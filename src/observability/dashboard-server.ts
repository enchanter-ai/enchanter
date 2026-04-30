/* src/observability/dashboard-server.ts — WebSocket broadcaster — consumed by
   the VS Code extension webview. The browser dashboard that originally consumed
   this was dropped at v0.2.1 (see CHANGELOG).

   Wraps bus.subscribe() to forward every bus event to connected clients in
   real-time. Also monkey-patches bus.acks.ack() to emit structured ack messages.

   Protocol (message types):
     hello    — sent on connect: server time, phase list, plugin names
     snapshot — sent on connect: current ledger + counters
     event    — forwarded bus event
     ack      — wrapped bus.acks.ack() call

   ≤ 400 LOC. */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { Bus } from '../bus/pubsub.js';
import type { EnchantedEvent } from '../bus/event-types.js';
import type { LifecyclePhase } from '../orchestration/request-context.js';
import { LIFECYCLE_PHASES } from '../orchestration/request-context.js';

// ---------------------------------------------------------------------------
// Types — mirrored in dashboard/src/lib/types.ts
// ---------------------------------------------------------------------------

export interface PechLedgerEntry {
  ts: number;
  vendor: string;
  plugin: string;
  input_tokens: number;
  output_tokens: number;
}

type DashboardMessage =
  | { kind: 'event'; event: EnchantedEvent }
  | {
      kind: 'ack';
      correlation_id: string;
      phase: LifecyclePhase;
      plugin: string;
      status: 'ack' | 'veto' | 'error';
      degraded?: boolean;
      reason?: string;
    }
  | {
      kind: 'snapshot';
      ledger: PechLedgerEntry[];
      bus_event_count: number;
      veto_count: number;
      mask_count: number;
      active_correlations: string[];
    }
  | {
      kind: 'hello';
      server_time: number;
      phases: ReadonlyArray<LifecyclePhase>;
      plugins: string[];
    };

// ---------------------------------------------------------------------------
// Tracked topics — curated list covers all 9 plugins + lifecycle
// ---------------------------------------------------------------------------

const WATCHED_TOPICS = [
  'lifecycle.*',
  'mcp.tool.*',
  'hydra.*',
  'pech.*',
  'naga.*',
  'crow.*',
  'djinn.*',
  'emu.*',
  'gorgon.*',
  'lich.*',
  'sylph.*',
];

// ---------------------------------------------------------------------------
// DashboardServer
// ---------------------------------------------------------------------------

export interface DashboardServerOptions {
  port?: number;
  /** Callback that returns the current pech ledger. */
  getLedger: () => ReadonlyArray<{ ts: number; vendor: string; plugin: string; input_tokens: number; output_tokens: number }>;
  /** Known plugin names (populated from registry). */
  plugins?: string[];
}

export class DashboardServer {
  private readonly port: number;
  private readonly getLedger: DashboardServerOptions['getLedger'];
  private readonly pluginNames: string[];

  private httpServer: ReturnType<typeof createServer> | null = null;
  private wss: WebSocketServer | null = null;
  private subs: Array<{ unsubscribe(): void }> = [];

  // Counters accumulated from bus traffic
  private busEventCount = 0;
  private vetoCount = 0;
  private maskCount = 0;
  private readonly activeCorrelations = new Set<string>();

  // Monkey-patch state for acks
  private originalAck: ((cid: string, phase: LifecyclePhase, plugin: string, result: { status: 'ack' | 'veto' | 'error'; reason?: string; degraded?: boolean }) => void) | null = null;

  constructor(opts: DashboardServerOptions) {
    this.port = opts.port ?? 3001;
    this.getLedger = opts.getLedger;
    this.pluginNames = opts.plugins ?? [];
  }

  /** Start the HTTP+WS server and wire bus subscriptions. */
  start(bus: Bus): void {
    // ── HTTP server (health check + WS upgrade) ───────────────────────────
    this.httpServer = createServer(this.handleHttp.bind(this));
    this.wss = new WebSocketServer({ noServer: true });

    this.httpServer.on('upgrade', (req: IncomingMessage, socket, head) => {
      if (req.url === '/ws') {
        this.wss!.handleUpgrade(req, socket, head, (ws) => {
          this.wss!.emit('connection', ws, req);
        });
      } else {
        socket.destroy();
      }
    });

    this.wss.on('connection', (ws: WebSocket) => {
      this.onClientConnected(ws, bus);
      // Producer clients (enchanter mcp-wrap / watch / run) push events here.
      // Re-publish them onto the local bus so plugins evaluate, and broadcast
      // to other consumers. Format: { kind: 'event', event: EnchantedEvent }.
      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString()) as { kind?: string; event?: EnchantedEvent };
          if (msg.kind === 'event' && msg.event && typeof msg.event.topic === 'string') {
            void bus.publish(msg.event.topic, msg.event);
          }
        } catch { /* ignore malformed */ }
      });
    });

    // Listen silently — the inspector's TUI owns the screen; a stray
    // console.log would corrupt the frame buffer. The port + path are
    // already documented; no startup banner needed.
    this.httpServer.listen(this.port);
    this.httpServer.on('error', (err) => {
      // Port in-use is non-fatal: another inspector is already running.
      // Producer subprocesses will fan into THAT one. Stay quiet.
      void err;
    });

    // ── Bus subscriptions ─────────────────────────────────────────────────
    for (const topic of WATCHED_TOPICS) {
      const sub = bus.subscribe(topic, async (event: EnchantedEvent) => {
        this.busEventCount++;
        if (event.topic === 'hydra.veto.fired') this.vetoCount++;
        if (event.topic === 'hydra.secrets.masked') this.maskCount++;
        if (event.correlation_id) this.activeCorrelations.add(event.correlation_id);
        this.broadcast({ kind: 'event', event });
      });
      this.subs.push(sub);
    }

    // ── Wrap bus.acks.ack to capture ack traffic ──────────────────────────
    const acks = bus.acks;
    this.originalAck = acks.ack.bind(acks);
    const self = this;
    acks.ack = function (
      correlation_id: string,
      phase: LifecyclePhase,
      plugin: string,
      result: { status: 'ack' | 'veto' | 'error'; reason?: string; degraded?: boolean },
    ): void {
      self.originalAck!(correlation_id, phase, plugin, result);
      self.broadcast({
        kind: 'ack',
        correlation_id,
        phase,
        plugin,
        status: result.status,
        degraded: result.degraded,
        reason: result.reason,
      });
    };
  }

  /** Stop the server and clean up subscriptions. */
  stop(): void {
    for (const s of this.subs) s.unsubscribe();
    this.subs = [];
    this.wss?.close();
    this.httpServer?.close();
    this.httpServer = null;
    this.wss = null;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private handleHttp(_req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
  }

  private onClientConnected(ws: WebSocket, bus: Bus): void {
    // Send hello
    const hello: DashboardMessage = {
      kind: 'hello',
      server_time: Date.now(),
      phases: LIFECYCLE_PHASES,
      plugins: this.pluginNames,
    };
    this.sendTo(ws, hello);

    // Send snapshot of current state
    const rawLedger = this.getLedger();
    const ledger: PechLedgerEntry[] = rawLedger.map((e) => ({
      ts: e.ts,
      vendor: e.vendor,
      plugin: e.plugin,
      input_tokens: e.input_tokens,
      output_tokens: e.output_tokens,
    }));

    const snapshot: DashboardMessage = {
      kind: 'snapshot',
      ledger,
      bus_event_count: this.busEventCount,
      veto_count: this.vetoCount,
      mask_count: this.maskCount,
      active_correlations: Array.from(this.activeCorrelations).slice(-20),
    };
    this.sendTo(ws, snapshot);

    // Replay last 50 buffered bus events
    const buffered = bus.tap().slice(-50);
    for (const event of buffered) {
      this.sendTo(ws, { kind: 'event', event });
    }

    ws.on('error', () => { /* client disconnected abruptly — ignore */ });
  }

  private broadcast(msg: DashboardMessage): void {
    if (!this.wss) return;
    const payload = JSON.stringify(msg);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  private sendTo(ws: WebSocket, msg: DashboardMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }
}
