/* tests/transport/tls-pin.test.ts — verifies v0.3.1 follow-up #2 TLS pin
   defense (FM 6 server spoofing).

   Covers: deterministic fingerprint, TOFU first-seen + mismatch, PINNED
   missing-entry + mismatch + match, PersistentTlsPinStore restart-survival,
   corrupt-tail tolerance. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeCertFingerprint,
  InMemoryTlsPinStore,
  PersistentTlsPinStore,
  TlsPinMismatchError,
  TlsPinUnknownError,
  verifyTlsPin,
} from '../../src/transport/tls-pin.js';

// ---------------------------------------------------------------------------
// computeCertFingerprint
// ---------------------------------------------------------------------------

describe('computeCertFingerprint', () => {
  it('is deterministic for the same input', () => {
    const der = Buffer.from('not-a-real-cert-but-deterministic-bytes', 'utf8');
    const a = computeCertFingerprint(der);
    const b = computeCertFingerprint(der);
    expect(a).toBe(b);
  });

  it('returns hex-lowercase of length 64 (SHA-256)', () => {
    const der = Buffer.from('hello', 'utf8');
    const fp = computeCertFingerprint(der);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it('different DER bytes produce different fingerprints', () => {
    const a = computeCertFingerprint(Buffer.from('cert-A'));
    const b = computeCertFingerprint(Buffer.from('cert-B'));
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// verifyTlsPin — TOFU
// ---------------------------------------------------------------------------

describe('verifyTlsPin — TOFU policy', () => {
  it('first-seen origin populates the pin and returns', () => {
    const store = new InMemoryTlsPinStore();
    const der = Buffer.from('leaf-1');
    expect(() => verifyTlsPin(store, 'https://a.example:443', der, 'tofu')).not.toThrow();

    const entry = store.get('https://a.example:443');
    expect(entry).toBeDefined();
    expect(entry!.fingerprint).toBe(computeCertFingerprint(der));
    expect(entry!.source).toBe('tofu');
  });

  it('second-seen-different cert throws TlsPinMismatchError', () => {
    const store = new InMemoryTlsPinStore();
    const der1 = Buffer.from('leaf-1');
    const der2 = Buffer.from('leaf-2');
    verifyTlsPin(store, 'https://a.example:443', der1, 'tofu');
    expect(() => verifyTlsPin(store, 'https://a.example:443', der2, 'tofu')).toThrowError(
      TlsPinMismatchError,
    );
  });

  it('second-seen-same cert is a no-op', () => {
    const store = new InMemoryTlsPinStore();
    const der = Buffer.from('leaf-1');
    verifyTlsPin(store, 'https://a.example:443', der, 'tofu');
    expect(() => verifyTlsPin(store, 'https://a.example:443', der, 'tofu')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// verifyTlsPin — PINNED
// ---------------------------------------------------------------------------

describe('verifyTlsPin — PINNED policy', () => {
  it('throws TlsPinUnknownError on missing entry', () => {
    const store = new InMemoryTlsPinStore();
    expect(() =>
      verifyTlsPin(store, 'https://a.example:443', Buffer.from('leaf-1'), 'pinned'),
    ).toThrowError(TlsPinUnknownError);
  });

  it('throws TlsPinMismatchError on mismatch', () => {
    const store = new InMemoryTlsPinStore();
    const der1 = Buffer.from('leaf-1');
    store.set({
      origin: 'https://a.example:443',
      fingerprint: computeCertFingerprint(der1),
      pinnedAt: Date.now(),
      source: 'config',
    });
    expect(() =>
      verifyTlsPin(store, 'https://a.example:443', Buffer.from('leaf-2'), 'pinned'),
    ).toThrowError(TlsPinMismatchError);
  });

  it('accepts on match', () => {
    const store = new InMemoryTlsPinStore();
    const der = Buffer.from('leaf-1');
    store.set({
      origin: 'https://a.example:443',
      fingerprint: computeCertFingerprint(der),
      pinnedAt: Date.now(),
      source: 'config',
    });
    expect(() => verifyTlsPin(store, 'https://a.example:443', der, 'pinned')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// InMemoryTlsPinStore — CRUD + list
// ---------------------------------------------------------------------------

describe('InMemoryTlsPinStore', () => {
  it('set / get / remove / list round-trip', () => {
    const store = new InMemoryTlsPinStore();
    const entry = {
      origin: 'https://a.example:443',
      fingerprint: 'a'.repeat(64),
      pinnedAt: 0,
      source: 'config' as const,
    };
    store.set(entry);
    expect(store.get('https://a.example:443')).toEqual(entry);
    expect(store.list()).toHaveLength(1);
    store.remove('https://a.example:443');
    expect(store.get('https://a.example:443')).toBeUndefined();
    expect(store.list()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// PersistentTlsPinStore — restart survival + corrupt-tail tolerance
// ---------------------------------------------------------------------------

describe('PersistentTlsPinStore', () => {
  let tmpDir: string;
  let storePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'enchanter-tls-pin-'));
    storePath = join(tmpDir, 'tls-pin.jsonl');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('replays pins after restart', () => {
    const a = new PersistentTlsPinStore(storePath);
    const der = Buffer.from('leaf-1');
    verifyTlsPin(a, 'https://a.example:443', der, 'tofu');
    expect(existsSync(storePath)).toBe(true);

    // Fresh instance, same path.
    const b = new PersistentTlsPinStore(storePath);
    const entry = b.get('https://a.example:443');
    expect(entry).toBeDefined();
    expect(entry!.fingerprint).toBe(computeCertFingerprint(der));

    // A second verify with the same cert is a no-op (should not throw).
    expect(() => verifyTlsPin(b, 'https://a.example:443', der, 'tofu')).not.toThrow();
  });

  it('replays remove markers across restart', () => {
    const a = new PersistentTlsPinStore(storePath);
    verifyTlsPin(a, 'https://a.example:443', Buffer.from('leaf-1'), 'tofu');
    a.remove('https://a.example:443');

    const b = new PersistentTlsPinStore(storePath);
    expect(b.get('https://a.example:443')).toBeUndefined();
  });

  it('tolerates a corrupt trailing line (crash mid-write)', () => {
    const a = new PersistentTlsPinStore(storePath);
    verifyTlsPin(a, 'https://a.example:443', Buffer.from('leaf-1'), 'tofu');
    appendFileSync(storePath, '{"op":"set","origin":"trun', 'utf8');

    // Construction must not throw.
    const b = new PersistentTlsPinStore(storePath);
    expect(b.list()).toHaveLength(1);
    expect(b.get('https://a.example:443')).toBeDefined();
  });
});
