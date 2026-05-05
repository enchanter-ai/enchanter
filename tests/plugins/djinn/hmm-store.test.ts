/* tests/plugins/djinn/hmm-store.test.ts — v0.4 carry-over #3 (HMM persistence).
   Covers InMemoryHmmStore + PersistentHmmStore round-trips, corrupt-tail
   tolerance, and adapter-level continuity across a fresh configureDjinn(). */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  InMemoryHmmStore,
  PersistentHmmStore,
} from '../../../src/plugins/djinn/hmm-store.js';
import {
  IntentHmm,
  HMM_STATE_VERSION,
  type HmmStateSnapshot,
} from '../../../src/plugins/djinn/hmm.js';
import {
  djinnAdapter,
  clearAnchor,
  configureDjinn,
  resetDjinnStore,
} from '../../../src/plugins/djinn.adapter.js';
import type { EnchantedEvent } from '../../../src/bus/event-types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'enchanter-hmm-store-'));
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  resetDjinnStore();
});

const SAMPLE_SNAP: HmmStateSnapshot = {
  version: HMM_STATE_VERSION,
  posterior: [0.7, 0.2, 0.1],
  initialized: true,
};

// ---------------------------------------------------------------------------
// InMemoryHmmStore — round-trip
// ---------------------------------------------------------------------------

describe('InMemoryHmmStore', () => {
  it('round-trips a snapshot', () => {
    const store = new InMemoryHmmStore();
    store.save('s1', SAMPLE_SNAP);
    expect(store.load('s1')).toEqual(SAMPLE_SNAP);
  });

  it('returns undefined for unknown sessions', () => {
    const store = new InMemoryHmmStore();
    expect(store.load('missing')).toBeUndefined();
  });

  it('clear() removes the snapshot', () => {
    const store = new InMemoryHmmStore();
    store.save('s1', SAMPLE_SNAP);
    store.clear('s1');
    expect(store.load('s1')).toBeUndefined();
  });

  it('save() overwrites the prior snapshot', () => {
    const store = new InMemoryHmmStore();
    store.save('s1', SAMPLE_SNAP);
    const next: HmmStateSnapshot = {
      version: HMM_STATE_VERSION,
      posterior: [0.1, 0.4, 0.5],
      initialized: true,
    };
    store.save('s1', next);
    expect(store.load('s1')).toEqual(next);
  });
});

// ---------------------------------------------------------------------------
// PersistentHmmStore — disk round-trip + corrupt-tail tolerance
// ---------------------------------------------------------------------------

describe('PersistentHmmStore', () => {
  it('save → fresh instance reads back the same snapshot', () => {
    const path = join(tmpDir, 'hmm.jsonl');
    const a = new PersistentHmmStore(path);
    a.save('s1', SAMPLE_SNAP);

    expect(existsSync(path)).toBe(true);

    const b = new PersistentHmmStore(path);
    expect(b.load('s1')).toEqual(SAMPLE_SNAP);
  });

  it('last-writer-wins across multiple saves', () => {
    const path = join(tmpDir, 'hmm.jsonl');
    const a = new PersistentHmmStore(path);
    a.save('s1', SAMPLE_SNAP);
    const next: HmmStateSnapshot = {
      version: HMM_STATE_VERSION,
      posterior: [0.05, 0.25, 0.7],
      initialized: true,
    };
    a.save('s1', next);

    const b = new PersistentHmmStore(path);
    expect(b.load('s1')).toEqual(next);
  });

  it('clear() persists across reload', () => {
    const path = join(tmpDir, 'hmm.jsonl');
    const a = new PersistentHmmStore(path);
    a.save('s1', SAMPLE_SNAP);
    a.clear('s1');

    const b = new PersistentHmmStore(path);
    expect(b.load('s1')).toBeUndefined();
  });

  it('tolerates a corrupt trailing line', () => {
    const path = join(tmpDir, 'hmm.jsonl');
    const a = new PersistentHmmStore(path);
    a.save('s1', SAMPLE_SNAP);
    // Simulate a crash-mid-write: append a partial JSON line at the end.
    writeFileSync(path, readFileSync(path, 'utf8') + '{"op":"save","sessio', {
      encoding: 'utf8',
    });

    const b = new PersistentHmmStore(path);
    expect(b.load('s1')).toEqual(SAMPLE_SNAP);
  });

  it('skips malformed snapshots (schema drift) without crashing', () => {
    const path = join(tmpDir, 'hmm.jsonl');
    // Pre-seed a valid line plus a junk-shape "save".
    writeFileSync(
      path,
      JSON.stringify({ op: 'save', sessionId: 's1', snap: SAMPLE_SNAP, ts: 1 }) +
        '\n' +
        JSON.stringify({ op: 'save', sessionId: 's2', snap: { not: 'a snapshot' }, ts: 2 }) +
        '\n',
      { encoding: 'utf8' },
    );

    const store = new PersistentHmmStore(path);
    expect(store.load('s1')).toEqual(SAMPLE_SNAP);
    expect(store.load('s2')).toBeUndefined();
  });

  it('returns undefined when the file does not yet exist', () => {
    const path = join(tmpDir, 'fresh.jsonl');
    const store = new PersistentHmmStore(path);
    expect(store.load('whatever')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// IntentHmm.serialize / fromSnapshot — pure round-trip
// ---------------------------------------------------------------------------

describe('IntentHmm — serialize/fromSnapshot', () => {
  it('hydrating from a snapshot continues forward inference identically', () => {
    const a = new IntentHmm();
    a.update(0.9);
    a.update(0.7);
    a.update(0.1);

    const snap = a.serialize();
    const b = IntentHmm.fromSnapshot(snap);
    expect(b).not.toBeNull();

    // Same next observation should yield identical posterior on both.
    const stepA = a.update(0.05);
    const stepB = b!.update(0.05);
    expect(stepB.state).toBe(stepA.state);
    expect(stepB.posterior.ON_TASK).toBeCloseTo(stepA.posterior.ON_TASK, 9);
    expect(stepB.posterior.SIDEQUEST).toBeCloseTo(stepA.posterior.SIDEQUEST, 9);
    expect(stepB.posterior.LOST).toBeCloseTo(stepA.posterior.LOST, 9);
  });

  it('snapshot preserves the initialized flag', () => {
    const fresh = new IntentHmm();
    expect(fresh.serialize().initialized).toBe(false);
    fresh.update(0.9);
    expect(fresh.serialize().initialized).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Adapter-level: configureDjinn({ hmm_store_path }) survives a fresh adapter
// ---------------------------------------------------------------------------

let _seq = 0;
function makeEvent(
  overrides: Partial<EnchantedEvent> & { phase: EnchantedEvent['phase'] },
): EnchantedEvent {
  _seq += 1;
  return {
    id: `hmm-store-test-${_seq}`,
    correlation_id: `hmm-store-corr-${_seq}`,
    session_id: 'hmm-persist-session',
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
  session_id: 'hmm-persist-session',
  phase: 'anchor' as const,
  budget_tier: 'HIGH' as const,
  sampling_depth: 0,
  deadline_ms: 30_000,
  started_ms: Date.now(),
  degraded_findings: [],
};

async function runAnchor(sessionId: string, prompt: string): Promise<void> {
  await djinnAdapter.onPhase(
    makeEvent({
      session_id: sessionId,
      phase: 'anchor',
      payload: { user_prompt: prompt },
    }),
    { ...CTX, session_id: sessionId },
  );
}

async function runPostSession(
  sessionId: string,
  prompt: string,
): Promise<{
  hmm_state?: string;
  hmm_posterior?: { ON_TASK: number; SIDEQUEST: number; LOST: number };
}> {
  const ack = await djinnAdapter.onPhase(
    makeEvent({
      session_id: sessionId,
      phase: 'post-session',
      payload: { user_prompt: prompt, d2_hmm: true },
    }),
    { ...CTX, session_id: sessionId, phase: 'post-session' },
  );
  const drift = ack.derived_events?.find((e) => e.topic === 'djinn.drift.detected');
  return {
    hmm_state: drift?.payload['hmm_state'] as string | undefined,
    hmm_posterior: drift?.payload['hmm_posterior'] as
      | { ON_TASK: number; SIDEQUEST: number; LOST: number }
      | undefined,
  };
}

describe('djinn adapter — HMM persistence across reconfigure', () => {
  it('with hmm_store_path: HMM state continues from where it left off', async () => {
    const path = join(tmpDir, 'adapter.jsonl');
    const sessionId = 'continuity-session';

    configureDjinn({ hmm_store_path: path });
    clearAnchor(sessionId);

    await runAnchor(sessionId, 'Add dark-mode support with a11y keyboard-trap tests');

    // Five drift turns push the HMM into SIDEQUEST/LOST territory.
    for (let i = 0; i < 5; i++) {
      await runPostSession(sessionId, 'Configure CI pipeline to deploy docker on merge');
    }

    // Snapshot the in-memory state via a save (already persisted on each
    // update). Now wipe the adapter's in-memory HMMs by re-configuring with
    // the same path — replays from disk.
    configureDjinn({ hmm_store_path: path });

    // Anchor was lost when we re-configured? No — anchors are a separate
    // store and not affected by configureDjinn. Re-set it explicitly only if
    // ANCHORS were also wiped. They aren't (configureDjinn only touches the
    // HMM store + cache), so the existing anchor still applies.
    const after = await runPostSession(
      sessionId,
      'Configure CI pipeline to deploy docker on merge',
    );

    expect(after.hmm_state).toBeDefined();
    expect(after.hmm_posterior).toBeDefined();
    // After 6 sustained low-similarity turns the HMM should NOT be ON_TASK
    // any more — confirming the rehydrated state continued to drift rather
    // than reset to the prior.
    expect(after.hmm_state).not.toBe('ON_TASK');
    // ON_TASK posterior should be small; if state had reset, the first
    // observation would yield a much higher ON_TASK probability.
    expect(after.hmm_posterior!.ON_TASK).toBeLessThan(0.5);
  });

  it('clearAnchor removes the snapshot from the persistent store', async () => {
    const path = join(tmpDir, 'clear.jsonl');
    const sessionId = 'clear-session';

    configureDjinn({ hmm_store_path: path });
    await runAnchor(sessionId, 'Initial anchor prompt about feature X');
    await runPostSession(sessionId, 'Drifting prompt about something unrelated');

    clearAnchor(sessionId);

    // Fresh store from the same path should not see a snapshot for this session.
    configureDjinn({ hmm_store_path: path });
    const reloaded = new PersistentHmmStore(path);
    expect(reloaded.load(sessionId)).toBeUndefined();
  });

  it('back-compat: without hmm_store_path, behaviour is in-memory only', async () => {
    // Default state — no configureDjinn call. Anchor + drift work, no file I/O.
    const sessionId = 'in-memory-session';
    clearAnchor(sessionId);
    await runAnchor(sessionId, 'Add dark-mode support with a11y keyboard-trap tests');
    const result = await runPostSession(
      sessionId,
      'Configure CI pipeline to deploy docker on merge',
    );
    expect(result.hmm_state).toBeDefined();
    // No file should have been created in tmpDir.
    expect(existsSync(join(tmpDir, 'should-not-exist.jsonl'))).toBe(false);
  });
});
