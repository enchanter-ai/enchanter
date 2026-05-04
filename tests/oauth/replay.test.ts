/* tests/oauth/replay.test.ts — verifies v0.3 follow-up #1 OAuth replay
   defense (per IMPLEMENTATION_SUMMARY.md §v0.3 + README §v0.3 roadmap).

   Covers: mint+consume happy path, unknown nonce, replay, expired,
   cap-based FIFO eviction, persistent JSONL restart-survival, plus the
   bindReplayDefense / consumeReplayDefense composition layer. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  InMemoryReplayStore,
  PersistentReplayStore,
  MAX_ENTRIES,
} from '../../src/oauth/replay-store.js';
import {
  bindReplayDefense,
  consumeReplayDefense,
  ReplayDefenseError,
} from '../../src/oauth/resource-indicators.js';
import { generateNonce, encodeTimestamp, parseTimestamp, isFresh } from '../../src/oauth/nonce.js';

// ---------------------------------------------------------------------------
// In-memory store core contract
// ---------------------------------------------------------------------------

describe('InMemoryReplayStore — core contract', () => {
  it('mint + consume happy path', () => {
    const store = new InMemoryReplayStore();
    const { nonce, issuedAt } = store.mint();

    expect(nonce).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(nonce.length).toBeGreaterThanOrEqual(16);
    expect(issuedAt).toBeLessThanOrEqual(Date.now());
    expect(store.size()).toBe(1);

    const result = store.consume(nonce);
    expect(result).toEqual({ ok: true });
  });

  it('consume unknown nonce → { ok: false, reason: "unknown" }', () => {
    const store = new InMemoryReplayStore();
    const result = store.consume('not-a-real-nonce');
    expect(result).toEqual({ ok: false, reason: 'unknown' });
  });

  it('consume same nonce twice → second is { ok: false, reason: "replay" }', () => {
    const store = new InMemoryReplayStore();
    const { nonce } = store.mint();

    expect(store.consume(nonce)).toEqual({ ok: true });
    expect(store.consume(nonce)).toEqual({ ok: false, reason: 'replay' });
  });

  it('consume after freshness window → { ok: false, reason: "expired" }', () => {
    vi.useFakeTimers();
    try {
      const t0 = new Date('2026-05-04T12:00:00Z').getTime();
      vi.setSystemTime(t0);
      const store = new InMemoryReplayStore();
      const { nonce } = store.mint();

      // Advance past 300s freshness window.
      vi.setSystemTime(t0 + 301 * 1000);
      expect(store.consume(nonce)).toEqual({ ok: false, reason: 'expired' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('mint 10,001 nonces → oldest evicted (size stays at MAX_ENTRIES)', () => {
    const store = new InMemoryReplayStore();
    let firstNonce: string | undefined;
    for (let i = 0; i < MAX_ENTRIES + 1; i++) {
      const { nonce } = store.mint();
      if (i === 0) firstNonce = nonce;
    }
    expect(store.size()).toBe(MAX_ENTRIES);
    // First nonce evicted by FIFO cap → consume returns 'unknown'.
    expect(store.consume(firstNonce!)).toEqual({ ok: false, reason: 'unknown' });
  });
});

// ---------------------------------------------------------------------------
// Persistent store — restart survival
// ---------------------------------------------------------------------------

describe('PersistentReplayStore — restart survival', () => {
  let tmpDir: string;
  let storePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'enchanter-replay-'));
    storePath = join(tmpDir, 'replay.jsonl');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('survives a fresh instantiation against the same file', () => {
    const a = new PersistentReplayStore(storePath);
    const { nonce } = a.mint();
    expect(existsSync(storePath)).toBe(true);

    // Fresh process simulation — new instance, same path.
    const b = new PersistentReplayStore(storePath);
    expect(b.size()).toBe(1);
    // First consume on the second instance succeeds (nonce never consumed).
    expect(b.consume(nonce)).toEqual({ ok: true });

    // A third instance sees the consume as already-applied → replay.
    const c = new PersistentReplayStore(storePath);
    expect(c.consume(nonce)).toEqual({ ok: false, reason: 'replay' });
  });

  it('replays consume markers as already-consumed across restart', () => {
    const a = new PersistentReplayStore(storePath);
    const { nonce } = a.mint();
    expect(a.consume(nonce)).toEqual({ ok: true });

    const b = new PersistentReplayStore(storePath);
    expect(b.consume(nonce)).toEqual({ ok: false, reason: 'replay' });
  });

  it('tolerates a corrupt trailing line (crash mid-write)', () => {
    const a = new PersistentReplayStore(storePath);
    a.mint();
    // Append a corrupt fragment.
    const { appendFileSync } = require('node:fs') as typeof import('node:fs');
    appendFileSync(storePath, '{"op":"mint","nonce":"trun', 'utf8');

    // Should not throw on construction.
    const b = new PersistentReplayStore(storePath);
    expect(b.size()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Composition layer — bindReplayDefense / consumeReplayDefense
// ---------------------------------------------------------------------------

describe('bindReplayDefense / consumeReplayDefense', () => {
  it('round-trips a fresh request', () => {
    const store = new InMemoryReplayStore();
    const { nonce, request_ts } = bindReplayDefense(store);

    expect(parseTimestamp(request_ts)).not.toBeNull();
    expect(() => consumeReplayDefense(store, nonce)).not.toThrow();
  });

  it('throws ReplayDefenseError on replay', () => {
    const store = new InMemoryReplayStore();
    const { nonce } = bindReplayDefense(store);

    consumeReplayDefense(store, nonce);
    expect(() => consumeReplayDefense(store, nonce)).toThrowError(ReplayDefenseError);
  });

  it('throws ReplayDefenseError with reason="unknown" for never-minted nonce', () => {
    const store = new InMemoryReplayStore();
    try {
      consumeReplayDefense(store, 'never-minted');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ReplayDefenseError);
      expect((err as ReplayDefenseError).reason).toBe('unknown');
    }
  });
});

// ---------------------------------------------------------------------------
// Nonce + timestamp helpers
// ---------------------------------------------------------------------------

describe('nonce.ts helpers', () => {
  it('generateNonce returns base64url with ≥ 16-byte entropy', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const n = generateNonce();
      expect(n).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(n.length).toBeGreaterThanOrEqual(22); // 16 bytes → 22 base64url chars min
      seen.add(n);
    }
    expect(seen.size).toBe(100); // no duplicates
  });

  it('encodeTimestamp / parseTimestamp round-trip', () => {
    const ts = encodeTimestamp(1_700_000_000_000);
    expect(ts).toBe('2023-11-14T22:13:20.000Z');
    expect(parseTimestamp(ts)).toBe(1_700_000_000_000);
  });

  it('parseTimestamp rejects malformed input', () => {
    expect(parseTimestamp('not a timestamp')).toBeNull();
    expect(parseTimestamp('2026-13-01T00:00:00Z')).toBeNull();
  });

  it('isFresh respects the symmetric freshness window', () => {
    const now = 1_700_000_000_000;
    expect(isFresh(now - 100_000, 300, now)).toBe(true); // 100s old, OK
    expect(isFresh(now - 400_000, 300, now)).toBe(false); // 400s old, expired
    expect(isFresh(now + 400_000, 300, now)).toBe(false); // 400s future, rejected
  });
});
