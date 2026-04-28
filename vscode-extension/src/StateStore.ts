/* vscode-extension/src/StateStore.ts
   Architecture-spec: in-memory state cache fed by ws-client.ts DashboardMessages.
   Central hub: all consumers (status bar, tree providers, webview) read from here.
   Cleared on disconnect; bounded to last 50 events for tree views. */

import type { InspectorState, PluginState, EnchantedEvent, LifecyclePhase, BudgetTier } from './types.js';
import type { DashboardMessage, PechLedgerEntry } from './ws-client.js';
import { KNOWN_PLUGINS } from './types.js';

const MAX_EVENTS = 50;
const MAX_PLUGIN_EVENTS = 5;

export type StateChangeListener = (state: InspectorState) => void;

export class StateStore {
  private readonly listeners = new Set<StateChangeListener>();
  public readonly ledger: PechLedgerEntry[] = [];

  public state: InspectorState = {
    connected: false,
    wsUrl: 'ws://localhost:3001/ws',
    currentPhase: null,
    currentTier: null,
    vetoCount: 0,
    maskCount: 0,
    busEventCount: 0,
    plugins: this._initPlugins(),
    recentEvents: [],
    activeCorrelations: [],
  };

  private _initPlugins(): Map<string, PluginState> {
    const m = new Map<string, PluginState>();
    for (const name of KNOWN_PLUGINS) {
      m.set(name, { name, lastStatus: 'unknown', degraded: false, required: true, recentEvents: [] });
    }
    return m;
  }

  onChange(listener: StateChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  applyMessage(msg: DashboardMessage): void {
    switch (msg.kind) {
      case 'hello':
        for (const plugin of msg.plugins) {
          if (!this.state.plugins.has(plugin)) {
            this.state.plugins.set(plugin, { name: plugin, lastStatus: 'unknown', degraded: false, required: false, recentEvents: [] });
          }
        }
        break;

      case 'snapshot':
        this.state.vetoCount = msg.veto_count;
        this.state.maskCount = msg.mask_count;
        this.state.busEventCount = msg.bus_event_count;
        this.state.activeCorrelations = [...msg.active_correlations];
        this.ledger.splice(0, this.ledger.length, ...msg.ledger);
        break;

      case 'event': {
        const ev = msg.event;
        this.state.currentPhase = ev.phase as LifecyclePhase;
        this.state.currentTier = ev.budget_tier as BudgetTier;
        this.state.busEventCount++;
        this._pushEvent(ev);
        const plugin = this.state.plugins.get(ev.source);
        if (plugin) {
          plugin.recentEvents = [ev, ...plugin.recentEvents].slice(0, MAX_PLUGIN_EVENTS);
        }
        break;
      }

      case 'ack': {
        const p = this.state.plugins.get(msg.plugin) ?? {
          name: msg.plugin, lastStatus: 'unknown', degraded: false, required: false, recentEvents: []
        };
        p.lastStatus = msg.status;
        p.degraded = msg.degraded ?? false;
        this.state.plugins.set(msg.plugin, p);
        if (msg.status === 'veto') { this.state.vetoCount++; }
        this.state.currentPhase = msg.phase as LifecyclePhase;
        break;
      }
    }
    this._notify();
  }

  setConnected(connected: boolean, url: string): void {
    this.state.connected = connected;
    this.state.wsUrl = url;
    if (!connected) { this._reset(); }
    this._notify();
  }

  private _pushEvent(ev: EnchantedEvent): void {
    this.state.recentEvents = [ev, ...this.state.recentEvents].slice(0, MAX_EVENTS);
  }

  private _reset(): void {
    this.state.currentPhase = null;
    this.state.currentTier = null;
    this.state.recentEvents = [];
    this.state.activeCorrelations = [];
    this.state.plugins.forEach(p => { p.lastStatus = 'unknown'; p.degraded = false; p.recentEvents = []; });
  }

  private _notify(): void {
    this.listeners.forEach(l => l(this.state));
  }
}
