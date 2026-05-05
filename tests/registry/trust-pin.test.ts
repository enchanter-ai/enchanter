/* tests/registry/trust-pin.test.ts — verifies v0.3.1 follow-up #3 full
   trust-pin (FM 10 MCPoison closure).

   Covers: canonical digest (key order / set semantics), TOFU populate,
   mismatch with both digests in the error, approveTrustPinUpdate rotation,
   PersistentTrustPinStore restart-survival, orchestrator-style veto event
   emission via enforceTrustPin (mocked bus). */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  approveTrustPinUpdate,
  computeTrustDigest,
  enforceTrustPin,
  InMemoryTrustPinStore,
  PersistentTrustPinStore,
  TrustPinMismatchError,
  verifyTrustPin,
  type TrustPinBus,
  type TrustPinInputs,
} from '../../src/registry/trust-pin.js';

// ---------------------------------------------------------------------------
// computeTrustDigest — canonicalization
// ---------------------------------------------------------------------------

describe('computeTrustDigest', () => {
  it('is stable across envAllowlist key-order permutations (set semantics)', () => {
    const a: TrustPinInputs = {
      cmd: 'node',
      args: ['server.js'],
      envAllowlist: ['HOME', 'PATH', 'USER'],
      schemaDigests: ['s1', 's2'],
    };
    const b: TrustPinInputs = {
      cmd: 'node',
      args: ['server.js'],
      envAllowlist: ['USER', 'HOME', 'PATH'], // permuted
      schemaDigests: ['s1', 's2'],
    };
    expect(computeTrustDigest(a)).toBe(computeTrustDigest(b));
  });

  it('is stable across schemaDigests permutations', () => {
    const a: TrustPinInputs = { schemaDigests: ['x', 'y', 'z'] };
    const b: TrustPinInputs = { schemaDigests: ['z', 'y', 'x'] };
    expect(computeTrustDigest(a)).toBe(computeTrustDigest(b));
  });

  it('IS sensitive to args order (argv semantics)', () => {
    const a: TrustPinInputs = { args: ['--foo', '--bar'], schemaDigests: [] };
    const b: TrustPinInputs = { args: ['--bar', '--foo'], schemaDigests: [] };
    expect(computeTrustDigest(a)).not.toBe(computeTrustDigest(b));
  });

  it('omits missing fields entirely (digest stable across transports)', () => {
    // Two stdio-shape inputs — one with explicit-undefined url, one without.
    const a: TrustPinInputs = { cmd: 'x', schemaDigests: [] };
    const b: TrustPinInputs = { cmd: 'x', url: undefined, schemaDigests: [] };
    expect(computeTrustDigest(a)).toBe(computeTrustDigest(b));
  });

  it('binaryDigest change is reflected in the digest', () => {
    const a: TrustPinInputs = { cmd: 'x', binaryDigest: 'aaa', schemaDigests: [] };
    const b: TrustPinInputs = { cmd: 'x', binaryDigest: 'bbb', schemaDigests: [] };
    expect(computeTrustDigest(a)).not.toBe(computeTrustDigest(b));
  });
});

// ---------------------------------------------------------------------------
// verifyTrustPin — TOFU + mismatch
// ---------------------------------------------------------------------------

describe('verifyTrustPin', () => {
  it('TOFU populate on first registration', () => {
    const store = new InMemoryTrustPinStore();
    const inputs: TrustPinInputs = {
      cmd: 'node',
      args: ['server.js'],
      schemaDigests: ['s1'],
    };
    expect(() => verifyTrustPin(store, 'srv-A', inputs)).not.toThrow();
    const entry = store.get('srv-A');
    expect(entry).toBeDefined();
    expect(entry!.digest).toBe(computeTrustDigest(inputs));
  });

  it('match on subsequent registration is a no-op', () => {
    const store = new InMemoryTrustPinStore();
    const inputs: TrustPinInputs = { cmd: 'node', schemaDigests: [] };
    verifyTrustPin(store, 'srv-A', inputs);
    expect(() => verifyTrustPin(store, 'srv-A', inputs)).not.toThrow();
  });

  it('mismatch throws TrustPinMismatchError with both digests in the error', () => {
    const store = new InMemoryTrustPinStore();
    const pinned: TrustPinInputs = { cmd: 'node', schemaDigests: ['s1'] };
    const drifted: TrustPinInputs = { cmd: 'node', schemaDigests: ['s1', 's2-new'] };
    verifyTrustPin(store, 'srv-A', pinned);

    try {
      verifyTrustPin(store, 'srv-A', drifted);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TrustPinMismatchError);
      const e = err as TrustPinMismatchError;
      expect(e.pinnedDigest).toBe(computeTrustDigest(pinned));
      expect(e.currentDigest).toBe(computeTrustDigest(drifted));
      expect(e.diff).toContain('schemaDigests');
      expect(e.message).toContain(e.pinnedDigest);
      expect(e.message).toContain(e.currentDigest);
    }
  });
});

// ---------------------------------------------------------------------------
// approveTrustPinUpdate — operator re-consent
// ---------------------------------------------------------------------------

describe('approveTrustPinUpdate', () => {
  it('rotates the entry to the new inputs and digest', () => {
    const store = new InMemoryTrustPinStore();
    const a: TrustPinInputs = { cmd: 'node', schemaDigests: ['s1'] };
    const b: TrustPinInputs = { cmd: 'node', schemaDigests: ['s1', 's2'] };
    verifyTrustPin(store, 'srv-A', a);
    expect(() => verifyTrustPin(store, 'srv-A', b)).toThrowError(TrustPinMismatchError);

    const updated = approveTrustPinUpdate(store, 'srv-A', b);
    expect(updated.digest).toBe(computeTrustDigest(b));

    // After re-consent, b is the accepted state.
    expect(() => verifyTrustPin(store, 'srv-A', b)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// PersistentTrustPinStore — restart survival
// ---------------------------------------------------------------------------

describe('PersistentTrustPinStore', () => {
  let tmpDir: string;
  let storePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'enchanter-trust-pin-'));
    storePath = join(tmpDir, 'trust-pin.jsonl');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('replays pins after restart', () => {
    const a = new PersistentTrustPinStore(storePath);
    const inputs: TrustPinInputs = { cmd: 'node', schemaDigests: ['s1'] };
    verifyTrustPin(a, 'srv-A', inputs);
    expect(existsSync(storePath)).toBe(true);

    const b = new PersistentTrustPinStore(storePath);
    const entry = b.get('srv-A');
    expect(entry).toBeDefined();
    expect(entry!.digest).toBe(computeTrustDigest(inputs));

    // Same inputs → no throw on the fresh store instance.
    expect(() => verifyTrustPin(b, 'srv-A', inputs)).not.toThrow();
  });

  it('tolerates a corrupt trailing line', () => {
    const a = new PersistentTrustPinStore(storePath);
    verifyTrustPin(a, 'srv-A', { cmd: 'node', schemaDigests: ['s1'] });
    appendFileSync(storePath, '{"op":"set","server_id":"trun', 'utf8');

    const b = new PersistentTrustPinStore(storePath);
    expect(b.list()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// enforceTrustPin — orchestrator wire-up: emits security veto event on mismatch
// ---------------------------------------------------------------------------

describe('enforceTrustPin', () => {
  it('publishes hydra.trust-pin.mismatch on mismatch (mocked bus)', async () => {
    const store = new InMemoryTrustPinStore();
    const pinned: TrustPinInputs = { cmd: 'node', schemaDigests: ['s1'] };
    verifyTrustPin(store, 'srv-A', pinned);

    const published: Array<{ topic: string; event: unknown }> = [];
    const bus: TrustPinBus = {
      publish: (topic, event) => {
        published.push({ topic, event });
      },
    };

    const drifted: TrustPinInputs = { cmd: 'node', schemaDigests: ['s1', 's2-new'] };
    await expect(
      enforceTrustPin(store, 'srv-A', drifted, bus, {
        correlation_id: 'cid-1',
        session_id: 'sid-1',
        phase: 'trust-gate',
      }),
    ).rejects.toBeInstanceOf(TrustPinMismatchError);

    expect(published).toHaveLength(1);
    expect(published[0]!.topic).toBe('hydra.trust-pin.mismatch');
    const ev = published[0]!.event as { topic: string; payload: Record<string, unknown> };
    expect(ev.topic).toBe('hydra.trust-pin.mismatch');
    expect(ev.payload['server_id']).toBe('srv-A');
    expect(ev.payload['pinned_digest']).toBe(computeTrustDigest(pinned));
    expect(ev.payload['current_digest']).toBe(computeTrustDigest(drifted));
  });

  it('does not publish on TOFU populate or match', async () => {
    const store = new InMemoryTrustPinStore();
    const inputs: TrustPinInputs = { cmd: 'node', schemaDigests: ['s1'] };
    const published: Array<unknown> = [];
    const bus: TrustPinBus = { publish: (_t, e) => void published.push(e) };

    await enforceTrustPin(store, 'srv-A', inputs, bus, {
      correlation_id: 'cid-1',
      session_id: 'sid-1',
      phase: 'trust-gate',
    });
    await enforceTrustPin(store, 'srv-A', inputs, bus, {
      correlation_id: 'cid-2',
      session_id: 'sid-1',
      phase: 'trust-gate',
    });

    expect(published).toHaveLength(0);
  });
});
