/* tests/plugins/djinn/hmm.test.ts — D2 HMM unit tests (v0.3.1).
   Covers IntentHmm forward recursion + adapter wiring per the design in
   docs/v0.3/djinn-d2-hmm.md. */

import { describe, it, expect, beforeEach } from 'vitest';
import { IntentHmm, DEFAULT_CONFIG } from '../../../src/plugins/djinn/hmm.js';
import { djinnAdapter, clearAnchor } from '../../../src/plugins/djinn.adapter.js';
import type { EnchantedEvent } from '../../../src/bus/event-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _seq = 0;
function makeEvent(
  overrides: Partial<EnchantedEvent> & { phase: EnchantedEvent['phase'] },
): EnchantedEvent {
  _seq += 1;
  return {
    id: `hmm-test-${_seq}`,
    correlation_id: `hmm-corr-${_seq}`,
    session_id: 'hmm-session',
    topic: `lifecycle.${overrides.phase}`,
    source: 'test',
    budget_tier: 'HIGH',
    ts: Date.now(),
    payload: {},
    ...overrides,
  };
}

const CTX = {
  correlation_id: 'ctx-corr',
  session_id: 'hmm-session',
  phase: 'anchor' as const,
  budget_tier: 'HIGH' as const,
  sampling_depth: 0,
  deadline_ms: 30_000,
  started_ms: Date.now(),
  degraded_findings: [],
};

const FLOAT_TOL = 1e-9;

function postSum(p: { ON_TASK: number; SIDEQUEST: number; LOST: number }): number {
  return p.ON_TASK + p.SIDEQUEST + p.LOST;
}

// ---------------------------------------------------------------------------
// IntentHmm — pure unit tests
// ---------------------------------------------------------------------------

describe('IntentHmm — initial state', () => {
  it('starts in ON_TASK with high posterior after a single high observation', () => {
    const hmm = new IntentHmm();
    const step = hmm.update(0.9); // clearly `high`

    expect(step.observation).toBe('high');
    expect(step.state).toBe('ON_TASK');
    expect(step.posterior.ON_TASK).toBeGreaterThan(0.9);
    expect(step.posterior.LOST).toBeLessThan(0.05);
  });

  it('reflects the prior on `current()` before any observation', () => {
    const hmm = new IntentHmm();
    const cur = hmm.current();
    expect(cur.state).toBe('ON_TASK');
    expect(cur.posterior.ON_TASK).toBeCloseTo(DEFAULT_CONFIG.prior[0], 9);
  });
});

describe('IntentHmm — drift dynamics', () => {
  it('transitions ON_TASK -> SIDEQUEST -> LOST under sustained low similarity', () => {
    const hmm = new IntentHmm();
    // warm up on-task
    hmm.update(0.9);
    hmm.update(0.85);

    // sustained low observations
    const states: string[] = [];
    for (let i = 0; i < 8; i++) {
      const step = hmm.update(0.05);
      states.push(step.state);
    }

    // Expect SIDEQUEST appears before LOST, and LOST is reached.
    const firstSidequest = states.indexOf('SIDEQUEST');
    const firstLost = states.indexOf('LOST');
    expect(firstSidequest).toBeGreaterThanOrEqual(0);
    expect(firstLost).toBeGreaterThan(firstSidequest);
  });

  it('recovers from SIDEQUEST back to ON_TASK after returning to high similarity', () => {
    const hmm = new IntentHmm();
    hmm.update(0.9); // ON_TASK
    hmm.update(0.2); // dip into mid/low
    hmm.update(0.2); // sustained dip — likely SIDEQUEST
    const dipped = hmm.update(0.2);
    expect(dipped.state).not.toBe('ON_TASK');

    // Recovery
    hmm.update(0.9);
    const recovered = hmm.update(0.9);
    expect(recovered.state).toBe('ON_TASK');
    expect(recovered.posterior.ON_TASK).toBeGreaterThan(0.7);
  });
});

describe('IntentHmm — invariants', () => {
  it('keeps posteriors summing to 1 across many varied observations', () => {
    const hmm = new IntentHmm();
    const obs = [0.9, 0.7, 0.4, 0.1, 0.2, 0.5, 0.8, 0.95, 0.05, 0.35, 0.65];
    for (const o of obs) {
      const step = hmm.update(o);
      expect(Math.abs(postSum(step.posterior) - 1)).toBeLessThan(FLOAT_TOL);
      // Each marginal in [0, 1]
      expect(step.posterior.ON_TASK).toBeGreaterThanOrEqual(0);
      expect(step.posterior.ON_TASK).toBeLessThanOrEqual(1);
      expect(step.posterior.SIDEQUEST).toBeGreaterThanOrEqual(0);
      expect(step.posterior.LOST).toBeGreaterThanOrEqual(0);
    }
  });

  it('reset() returns the HMM to its prior', () => {
    const hmm = new IntentHmm();
    for (let i = 0; i < 5; i++) hmm.update(0.05);
    hmm.reset();
    const cur = hmm.current();
    expect(cur.posterior.ON_TASK).toBeCloseTo(DEFAULT_CONFIG.prior[0], 9);
  });
});

// ---------------------------------------------------------------------------
// Adapter wiring — D2 flag default-off, on-state forwards into the event
// ---------------------------------------------------------------------------

beforeEach(() => {
  clearAnchor('hmm-session-a');
  clearAnchor('hmm-session-b');
});

describe('djinn adapter — D2 wiring', () => {
  it('default-off: drift event has no hmm_* fields when d2_hmm is absent', async () => {
    await djinnAdapter.onPhase(
      makeEvent({
        session_id: 'hmm-session-a',
        phase: 'anchor',
        payload: { user_prompt: 'Add dark-mode support with a11y keyboard-trap tests' },
      }),
      { ...CTX, session_id: 'hmm-session-a' },
    );

    const ack = await djinnAdapter.onPhase(
      makeEvent({
        session_id: 'hmm-session-a',
        phase: 'post-session',
        payload: { user_prompt: 'Configure CI pipeline to deploy docker on merge' },
      }),
      { ...CTX, session_id: 'hmm-session-a', phase: 'post-session' },
    );

    expect(ack.derived_events).toBeDefined();
    const drift = ack.derived_events!.find((e) => e.topic === 'djinn.drift.detected');
    expect(drift).toBeDefined();
    expect(drift!.payload['hmm_state']).toBeUndefined();
    expect(drift!.payload['hmm_posterior']).toBeUndefined();
  });

  it('d2_hmm: true attaches hmm_state and posterior to the drift event', async () => {
    await djinnAdapter.onPhase(
      makeEvent({
        session_id: 'hmm-session-b',
        phase: 'anchor',
        payload: { user_prompt: 'Add dark-mode support with a11y keyboard-trap tests' },
      }),
      { ...CTX, session_id: 'hmm-session-b' },
    );

    const ack = await djinnAdapter.onPhase(
      makeEvent({
        session_id: 'hmm-session-b',
        phase: 'post-session',
        payload: {
          user_prompt: 'Configure CI pipeline to deploy docker on merge',
          d2_hmm: true,
        },
      }),
      { ...CTX, session_id: 'hmm-session-b', phase: 'post-session' },
    );

    const drift = ack.derived_events!.find((e) => e.topic === 'djinn.drift.detected');
    expect(drift).toBeDefined();
    expect(drift!.payload['hmm_state']).toBeDefined();
    expect(['ON_TASK', 'SIDEQUEST', 'LOST']).toContain(drift!.payload['hmm_state']);
    const post = drift!.payload['hmm_posterior'] as {
      ON_TASK: number;
      SIDEQUEST: number;
      LOST: number;
    };
    expect(post).toBeDefined();
    expect(Math.abs(postSum(post) - 1)).toBeLessThan(FLOAT_TOL);
    expect(drift!.payload['hmm_observation']).toBe('low');
  });
});
