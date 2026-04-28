/* enchanter/src/observability/notifier.ts — implements architecture-spec
   phase_6.observability (desktop notification surface).
   Surfaces high-signal bus events as native OS notifications via node-notifier
   (Windows Toast / macOS NotificationCenter / Linux libnotify).

   Failure-mode triggers covered:
   - hydra.veto.fired       → F10-class destructive ops blocked by security veto
   - sylph.destructive.veto → F10-class destructive write ops blocked
   - naga.schema.drift.detected → F14-class version/schema drift in tool defs
   - lich.suspicion.flagged → F02-class tool-poisoning / fabricated tool identity
   - pech.vendor.exhausted  → budget exhaustion (cost contract broken)
   - pech.threshold.crossed → BudgetTier transition to LOW or CRITICAL
*/

import type { Bus } from '../bus/pubsub.js';
import type { EnchantedEvent } from '../bus/event-types.js';
import type { BudgetTier } from '../orchestration/request-context.js';
import type { Subscription } from '../bus/event-types.js';

// ---------------------------------------------------------------------------
// Public API types
// ---------------------------------------------------------------------------

export interface NotifierOptions {
  /** Title prefix for all notifications. Default: "Enchanter". */
  title?: string;
  /** Whether to play a sound on notification. Default: true. */
  sound?: boolean;
  /** Topics to subscribe to. Default: HIGH_SIGNAL_TOPICS. */
  topics?: ReadonlyArray<string>;
  /** Throttle: minimum ms between notifications for the same topic. Default: 2000. */
  throttleMs?: number;
  /** Plug a custom notify function (used by tests; defaults to node-notifier). */
  notifyFn?: (msg: NotifyMessage) => void;
}

export interface NotifyMessage {
  title: string;
  message: string;
  sound?: boolean;
}

export interface NotifierHandle {
  unsubscribe(): void;
  /** Stats: counts per-topic since start. */
  stats(): Record<string, number>;
}

// ---------------------------------------------------------------------------
// Default high-signal topics
// ---------------------------------------------------------------------------

export const HIGH_SIGNAL_TOPICS: ReadonlyArray<string> = [
  'hydra.veto.fired',
  'sylph.destructive.veto',
  'naga.schema.drift.detected',
  'lich.suspicion.flagged',
  'pech.vendor.exhausted',
  'pech.threshold.crossed',
];

// Budget tiers that warrant user notification on a threshold crossing.
const ALERT_TIERS = new Set<BudgetTier>(['LOW', 'CRITICAL']);

// ---------------------------------------------------------------------------
// Payload extraction helpers — defensive, all fields optional in practice
// ---------------------------------------------------------------------------

function str(payload: Readonly<Record<string, unknown>>, key: string): string {
  const v = payload[key];
  return typeof v === 'string' && v.length > 0 ? v : '<unknown>';
}

// ---------------------------------------------------------------------------
// Message formatters per topic
// ---------------------------------------------------------------------------

type Formatter = (event: EnchantedEvent) => string | null;

const FORMATTERS: Record<string, Formatter> = {
  'hydra.veto.fired': (e) =>
    `🛡 Security veto: ${str(e.payload, 'pattern_id')}`,

  'sylph.destructive.veto': (e) =>
    `⚠ Destructive op blocked: ${str(e.payload, 'pattern_name')}`,

  'naga.schema.drift.detected': (e) =>
    `📐 Schema drift detected: ${str(e.payload, 'tool')}`,

  'lich.suspicion.flagged': (e) =>
    `🔍 Tool poisoning suspected: ${str(e.payload, 'pattern_id')}`,

  'pech.vendor.exhausted': (e) =>
    `💰 Vendor budget exhausted: ${str(e.payload, 'vendor')}`,

  'pech.threshold.crossed': (e) => {
    const next = e.payload['new_tier'] as BudgetTier | undefined;
    if (!next || !ALERT_TIERS.has(next)) return null; // skip HIGH→MED transitions
    const prev = str(e.payload, 'old_tier');
    return `📊 Budget tier: ${prev} → ${next}`;
  },
};

// ---------------------------------------------------------------------------
// Lazy node-notifier loader — never imported at module top-level so the
// module is safely importable in test environments where notifyFn is injected.
// ---------------------------------------------------------------------------

let _nodeNotify: ((msg: NotifyMessage) => void) | undefined;

async function getDefaultNotifyFn(): Promise<(msg: NotifyMessage) => void> {
  if (_nodeNotify) return _nodeNotify;
  // Dynamic import keeps node-notifier out of the module graph for tests.
  const mod = await import('node-notifier');
  const notifier = mod.default ?? mod;
  _nodeNotify = (msg: NotifyMessage) => {
    (notifier as { notify(opts: unknown): void }).notify({
      title: msg.title,
      message: msg.message,
      sound: msg.sound ?? true,
    });
  };
  return _nodeNotify;
}

// ---------------------------------------------------------------------------
// subscribeNotifier — main export
// ---------------------------------------------------------------------------

export function subscribeNotifier(bus: Bus, options: NotifierOptions = {}): NotifierHandle {
  const title       = options.title      ?? 'Enchanter';
  const sound       = options.sound      ?? true;
  const topics      = options.topics     ?? HIGH_SIGNAL_TOPICS;
  const throttleMs  = options.throttleMs ?? 2_000;
  const injectedFn  = options.notifyFn;  // undefined → use node-notifier lazily

  const counts: Record<string, number> = {};
  const lastFired: Record<string, number> = {};
  const subscriptions: Subscription[] = [];

  async function handleEvent(event: EnchantedEvent): Promise<void> {
    const topic = event.topic;
    const formatter = FORMATTERS[topic];
    if (!formatter) return;

    const message = formatter(event);
    if (message === null) return; // filtered (e.g. non-alert budget tier)

    const now = Date.now();
    const last = lastFired[topic] ?? 0;
    if (now - last < throttleMs) return; // throttle
    lastFired[topic] = now;

    counts[topic] = (counts[topic] ?? 0) + 1;

    const msg: NotifyMessage = { title, message, sound };

    if (injectedFn) {
      injectedFn(msg);
    } else {
      const notifyFn = await getDefaultNotifyFn();
      notifyFn(msg);
    }
  }

  for (const topic of topics) {
    subscriptions.push(bus.subscribe(topic, handleEvent));
  }

  return {
    unsubscribe(): void {
      for (const sub of subscriptions) sub.unsubscribe();
      subscriptions.length = 0;
    },
    stats(): Record<string, number> {
      return { ...counts };
    },
  };
}
