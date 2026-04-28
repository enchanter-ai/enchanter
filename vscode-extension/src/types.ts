/* vscode-extension/src/types.ts
   Architecture-spec: EnchantedEvent shape (bus/event-types.ts) and shared
   in-memory state interfaces consumed by tree providers, status bar, and webview. */

export type LifecyclePhase =
  | 'anchor' | 'trust-gate' | 'pre-dispatch' | 'dispatch'
  | 'post-response' | 'post-session' | 'cross-session';

export type BudgetTier = 'HIGH' | 'MED' | 'LOW' | 'CRITICAL';

export interface EnchantedEvent {
  readonly id: string;
  readonly correlation_id: string;
  readonly session_id: string;
  readonly phase: LifecyclePhase;
  readonly topic: string;
  readonly source: string;
  readonly budget_tier: BudgetTier;
  readonly ts: number;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface PluginState {
  name: string;
  lastStatus: 'ack' | 'veto' | 'error' | 'unknown';
  degraded: boolean;
  required: boolean;
  recentEvents: EnchantedEvent[];
}

export interface InspectorState {
  connected: boolean;
  wsUrl: string;
  currentPhase: LifecyclePhase | null;
  currentTier: BudgetTier | null;
  vetoCount: number;
  maskCount: number;
  busEventCount: number;
  plugins: Map<string, PluginState>;
  recentEvents: EnchantedEvent[];          // last 50 for trees
  activeCorrelations: string[];
}

export const KNOWN_PLUGINS = [
  'hydra', 'lich', 'naga', 'pech', 'sylph', 'crow', 'djinn', 'emu', 'gorgon', 'wixie'
] as const;

export const LIFECYCLE_PHASES: ReadonlyArray<LifecyclePhase> = [
  'anchor', 'trust-gate', 'pre-dispatch', 'dispatch',
  'post-response', 'post-session', 'cross-session',
];
