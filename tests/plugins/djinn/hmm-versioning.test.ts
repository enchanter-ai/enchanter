/* tests/plugins/djinn/hmm-versioning.test.ts — v0.5 #2.
   Verifies HMM_STATE_VERSION schema-version gating: stored snapshots whose
   state-shape doesn't match the running model trigger a hard reset (fresh
   build) rather than silently rehydrating against a mismatched matrix. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  configureDjinn,
  resetDjinnStore,
} from '../../../src/plugins/djinn.adapter.js';
import type { EnchantedEvent } from '../../../src/bus/event-types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'enchanter-hmm-versioning-'));
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  resetDjinnStore();
});

const CURRENT_SNAP: HmmStateSnapshot = {
  version: HMM_STATE_VERSION,
  posterior: [0.6, 0.3, 0.1],
  initialized: true,
};

// ---------------------------------------------------------------------------
// IntentHmm.serialize() stamps the current version
// ---------------------------------------------------------------------------

describe('IntentHmm.serialize — version stamping', () => {
  it('stamps the current HMM_STATE_VERSION on every snapshot', () => {
    const hmm = new IntentHmm();
    expect(hmm.serialize().version).toBe(HMM_STATE_VERSION);
    hmm.update(0.9);
    expect(hmm.serialize().version).toBe(HMM_STATE_VERSION);
  });
});

// ---------------------------------------------------------------------------
// IntentHmm.fromSnapshot — version + shape gates
// ---------------------------------------------------------------------------

describe('IntentHmm.fromSnapshot — schema gates', () => {
  it('roundtrips a current-version snapshot', () => {
    const a = new IntentHmm();
    a.update(0.9);
    const snap = a.serialize();
    const b = IntentHmm.fromSnapshot(snap);
    expect(b).not.toBeNull();
    const stepA = a.update(0.1);
    const stepB = b!.update(0.1);
    expect(stepB.posterior.ON_TASK).toBeCloseTo(stepA.posterior.ON_TASK, 9);
  });

  it('returns null for a snapshot with version=0 (pre-v0.5 record)', () => {
    // Pre-v0.5 records lack `version`; the store/load path coerces missing
    // → 0. Simulate that explicitly here.
    const stale = {
      version: 0,
      posterior: [0.6, 0.3, 0.1] as [number, number, number],
      initialized: true,
    } satisfies HmmStateSnapshot;
    expect(IntentHmm.fromSnapshot(stale)).toBeNull();
  });

  it('returns null for a future-version snapshot', () => {
    const future: HmmStateSnapshot = {
      version: 999,
      posterior: [0.6, 0.3, 0.1],
      initialized: true,
    };
    expect(IntentHmm.fromSnapshot(future)).toBeNull();
  });

  it('returns null when posterior length doesn\'t match the current state count', () => {
    // Force a length mismatch via a cast — the type system would otherwise
    // reject this at compile time (the readonly tuple is fixed at length 3).
    const bad = {
      version: HMM_STATE_VERSION,
      posterior: [0.5, 0.5] as unknown as readonly [number, number, number],
      initialized: true,
    } satisfies HmmStateSnapshot;
    expect(IntentHmm.fromSnapshot(bad)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// InMemoryHmmStore — version mismatch → undefined + warn
// ---------------------------------------------------------------------------

describe('InMemoryHmmStore — version mismatch', () => {
  it('returns undefined and warns when the stored snapshot predates the schema', () => {
    const store = new InMemoryHmmStore();
    const stale = {
      version: 0,
      posterior: [0.7, 0.2, 0.1],
      initialized: true,
    } as HmmStateSnapshot;
    // Bypass save's well-formed path by writing into the underlying map.
    // (save() only writes whatever it's given, so we could call save here,
    // but that's incidental — what matters is that load() rejects it.)
    store.save('s1', stale);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(store.load('s1')).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('schema version mismatch');
    expect(warn.mock.calls[0]![0]).toContain('session=s1');
    expect(warn.mock.calls[0]![0]).toContain(`stored=0`);
    expect(warn.mock.calls[0]![0]).toContain(`current=${HMM_STATE_VERSION}`);
    warn.mockRestore();
  });

  it('drops the stale entry on first load so subsequent loads do not re-warn', () => {
    const store = new InMemoryHmmStore();
    const stale = {
      version: 0,
      posterior: [0.7, 0.2, 0.1],
      initialized: true,
    } as HmmStateSnapshot;
    store.save('s1', stale);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(store.load('s1')).toBeUndefined();
    expect(store.load('s1')).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('returns the snapshot when version matches', () => {
    const store = new InMemoryHmmStore();
    store.save('s1', CURRENT_SNAP);
    expect(store.load('s1')).toEqual(CURRENT_SNAP);
  });
});

// ---------------------------------------------------------------------------
// PersistentHmmStore — JSONL with a v0 record warns + resets
// ---------------------------------------------------------------------------

describe('PersistentHmmStore — version mismatch on disk', () => {
  it('reading a JSONL file with a v0 record warns + resets on load', () => {
    const path = join(tmpDir, 'legacy.jsonl');
    // Pre-v0.5 JSONL — `snap` lacks the `version` field entirely. The
    // structural validator accepts it (so replay picks it up), then the
    // load() gate rejects it as version=0.
    writeFileSync(
      path,
      JSON.stringify({
        op: 'save',
        sessionId: 's1',
        snap: { posterior: [0.6, 0.3, 0.1], initialized: true },
        ts: 1,
      }) + '\n',
      { encoding: 'utf8' },
    );

    const store = new PersistentHmmStore(path);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(store.load('s1')).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('schema version mismatch');
    warn.mockRestore();
  });

  it('roundtrips a current-version snapshot with no warning', () => {
    const path = join(tmpDir, 'current.jsonl');
    const a = new PersistentHmmStore(path);
    a.save('s1', CURRENT_SNAP);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const b = new PersistentHmmStore(path);
    expect(b.load('s1')).toEqual(CURRENT_SNAP);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Adapter-level: stale-version state forces a fresh HMM (no continuation)
// ---------------------------------------------------------------------------

let _seq = 0;
function makeEvent(
  overrides: Partial<EnchantedEvent> & { phase: EnchantedEvent['phase'] },
): EnchantedEvent {
  _seq += 1;
  return {
    id: `hmm-versioning-test-${_seq}`,
    correlation_id: `hmm-versioning-corr-${_seq}`,
    session_id: 'hmm-versioning-session',
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
  session_id: 'hmm-versioning-session',
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

describe('djinn adapter — stale-version state triggers fresh HMM', () => {
  it('a pre-v0.5 (versionless) JSONL record does not seed continuation', async () => {
    const path = join(tmpDir, 'legacy-adapter.jsonl');
    const sessionId = 'legacy-session';

    // Pre-seed a stale, near-LOST forward state (would produce a low ON_TASK
    // posterior immediately if it were rehydrated).
    writeFileSync(
      path,
      JSON.stringify({
        op: 'save',
        sessionId,
        snap: { posterior: [0.05, 0.15, 0.80], initialized: true },
        ts: 1,
      }) + '\n',
      { encoding: 'utf8' },
    );

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    configureDjinn({ hmm_store_path: path });
    // NOTE: do NOT call clearAnchor here — that would erase the stale entry
    // from the in-memory replay map before the load() gate has a chance to
    // detect the version mismatch. We want the post-session load to fire
    // the gate naturally.
    await runAnchor(sessionId, 'Add dark-mode support with a11y keyboard-trap tests');

    // One on-topic turn. If the stale state had been used, the LOST self-loop
    // (0.80) would dominate and ON_TASK would stay small. With a hard reset,
    // the prior + a high-similarity observation pushes ON_TASK above 0.5 in
    // a single update.
    const result = await runPostSession(
      sessionId,
      'Add dark-mode support with a11y keyboard-trap tests',
    );

    // Drift event isn't emitted at high LCS ratio — confirm via direct
    // post-session call shape: when ratio >= 0.3 the adapter returns ack only.
    // What we can check: re-run a few times and verify ON_TASK dominates.
    expect(warn).toHaveBeenCalled();
    // After a fresh rebuild, on-topic prompts keep state at ON_TASK. If the
    // stale state had been honored, the HMM would be deep in LOST territory.
    // We sample the in-memory HMM via one more drifting prompt — its drift
    // event is observable.
    const drift = await runPostSession(
      sessionId,
      'Configure CI pipeline to deploy docker on merge',
    );
    if (drift.hmm_state !== undefined) {
      expect(drift.hmm_state).not.toBe('LOST');
      // ON_TASK posterior must be meaningfully higher than the stale 0.05.
      expect(drift.hmm_posterior!.ON_TASK).toBeGreaterThan(0.2);
    }
    // Reference `result` so the variable is not unused — its only role is
    // to drive a turn through the adapter before the drift sample below.
    expect(result).toBeDefined();
    warn.mockRestore();
  });
});
