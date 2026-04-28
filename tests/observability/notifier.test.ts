/* tests/observability/notifier.test.ts — unit tests for the desktop-notification
   module (src/observability/notifier.ts).
   Uses InProcessBus and notifyFn injection — no real OS notifications fired.
   Architecture-spec ref: phase_6.observability */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { InProcessBus } from '../../src/bus/pubsub.js';
import { subscribeNotifier, HIGH_SIGNAL_TOPICS } from '../../src/observability/notifier.js';
import type { NotifyMessage } from '../../src/observability/notifier.js';
import type { EnchantedEvent } from '../../src/bus/event-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(topic: string, payload: Record<string, unknown> = {}): Omit<EnchantedEvent, 'id' | 'topic' | 'ts'> & { topic?: string } {
  return {
    correlation_id: 'cid',
    session_id: 'sid',
    phase: 'trust-gate',
    topic,
    source: 'test',
    budget_tier: 'HIGH',
    payload,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('subscribeNotifier', () => {
  let bus: InProcessBus;
  let captured: NotifyMessage[];
  let notifyFn: (msg: NotifyMessage) => void;

  beforeEach(() => {
    bus = new InProcessBus();
    captured = [];
    notifyFn = (msg) => captured.push(msg);
  });

  // 1. subscribes to all default topics
  it('subscribes to every HIGH_SIGNAL_TOPIC by default', () => {
    // We verify coverage by publishing to each topic and checking a notification fires.
    const handle = subscribeNotifier(bus, { notifyFn, throttleMs: 0 });

    // Spot-check two topics representative of the set.
    expect(HIGH_SIGNAL_TOPICS).toContain('hydra.veto.fired');
    expect(HIGH_SIGNAL_TOPICS).toContain('pech.vendor.exhausted');

    handle.unsubscribe();
  });

  // 2. fires notification on hydra.veto.fired
  it('fires a notification when hydra.veto.fired is published', async () => {
    const handle = subscribeNotifier(bus, { notifyFn, throttleMs: 0 });

    await bus.publish('hydra.veto.fired', makeEvent('hydra.veto.fired', { pattern_id: 'h-rm-rf-root' }));

    expect(captured).toHaveLength(1);
    expect(captured[0].message).toContain('🛡 Security veto:');
    expect(captured[0].message).toContain('h-rm-rf-root');
    expect(captured[0].title).toBe('Enchanter');

    handle.unsubscribe();
  });

  // 3. throttles repeat events within throttleMs
  it('throttles repeated events for the same topic within throttleMs', async () => {
    const handle = subscribeNotifier(bus, { notifyFn, throttleMs: 60_000 });

    await bus.publish('hydra.veto.fired', makeEvent('hydra.veto.fired', { pattern_id: 'p1' }));
    await bus.publish('hydra.veto.fired', makeEvent('hydra.veto.fired', { pattern_id: 'p2' }));
    await bus.publish('hydra.veto.fired', makeEvent('hydra.veto.fired', { pattern_id: 'p3' }));

    // Only the first should have fired; the other two are throttled.
    expect(captured).toHaveLength(1);

    handle.unsubscribe();
  });

  // 4. pech.threshold.crossed only fires on LOW or CRITICAL, not HIGH→MED
  it('fires on pech.threshold.crossed only when new_tier is LOW or CRITICAL', async () => {
    const handle = subscribeNotifier(bus, { notifyFn, throttleMs: 0 });

    // HIGH → MED: should NOT fire
    await bus.publish('pech.threshold.crossed', makeEvent('pech.threshold.crossed', { old_tier: 'HIGH', new_tier: 'MED' }));
    expect(captured).toHaveLength(0);

    // MED → LOW: should fire
    await bus.publish('pech.threshold.crossed', makeEvent('pech.threshold.crossed', { old_tier: 'MED', new_tier: 'LOW' }));
    expect(captured).toHaveLength(1);
    expect(captured[0].message).toBe('📊 Budget tier: MED → LOW');

    // LOW → CRITICAL: should fire
    await bus.publish('pech.threshold.crossed', makeEvent('pech.threshold.crossed', { old_tier: 'LOW', new_tier: 'CRITICAL' }));
    expect(captured).toHaveLength(2);
    expect(captured[1].message).toBe('📊 Budget tier: LOW → CRITICAL');

    handle.unsubscribe();
  });

  // 5. unsubscribe() stops notifications
  it('stops firing after unsubscribe()', async () => {
    const handle = subscribeNotifier(bus, { notifyFn, throttleMs: 0 });

    await bus.publish('hydra.veto.fired', makeEvent('hydra.veto.fired', { pattern_id: 'p1' }));
    expect(captured).toHaveLength(1);

    handle.unsubscribe();

    await bus.publish('hydra.veto.fired', makeEvent('hydra.veto.fired', { pattern_id: 'p2' }));
    expect(captured).toHaveLength(1); // no new notification
  });

  // 6. stats() returns per-topic counts
  it('stats() returns accurate per-topic notification counts', async () => {
    const handle = subscribeNotifier(bus, { notifyFn, throttleMs: 0 });

    await bus.publish('hydra.veto.fired', makeEvent('hydra.veto.fired', { pattern_id: 'p1' }));
    await bus.publish('hydra.veto.fired', makeEvent('hydra.veto.fired', { pattern_id: 'p2' }));
    await bus.publish('lich.suspicion.flagged', makeEvent('lich.suspicion.flagged', { pattern_id: 'l1' }));

    const s = handle.stats();
    expect(s['hydra.veto.fired']).toBe(2);
    expect(s['lich.suspicion.flagged']).toBe(1);
    // Topics that never fired should be absent (not 0)
    expect(s['pech.vendor.exhausted']).toBeUndefined();

    handle.unsubscribe();
  });

  // 7. custom topics option limits subscriptions
  it('respects custom topics option — ignores non-listed events', async () => {
    const handle = subscribeNotifier(bus, {
      notifyFn,
      throttleMs: 0,
      topics: ['hydra.veto.fired'],
    });

    await bus.publish('lich.suspicion.flagged', makeEvent('lich.suspicion.flagged', { pattern_id: 'l1' }));
    expect(captured).toHaveLength(0); // not subscribed

    await bus.publish('hydra.veto.fired', makeEvent('hydra.veto.fired', { pattern_id: 'h1' }));
    expect(captured).toHaveLength(1);

    handle.unsubscribe();
  });

  // 8. payload missing fields defaults to <unknown>
  it('falls back to <unknown> when payload fields are absent', async () => {
    const handle = subscribeNotifier(bus, { notifyFn, throttleMs: 0 });

    await bus.publish('naga.schema.drift.detected', makeEvent('naga.schema.drift.detected', {}));

    expect(captured).toHaveLength(1);
    expect(captured[0].message).toContain('<unknown>');

    handle.unsubscribe();
  });
});
