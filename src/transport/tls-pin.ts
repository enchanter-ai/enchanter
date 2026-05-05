/* enchanter/src/transport/tls-pin.ts — implements v0.3.1 follow-up #2
   (FM 6 server spoofing). Pin store keyed by URL origin; each entry stores
   a SHA-256 over the leaf certificate's DER encoding (hex-lowercase) plus
   metadata. On every TLS handshake the connection's leaf cert is hashed
   and compared. Design doc: docs/v0.3/tls-pinning.md.

   Threat model: an attacker MITMing a streamable-HTTP MCP server presents
   a valid-but-attacker-controlled cert chain. PKI alone is insufficient
   because the trust anchor set is large and an attacker who compromises
   any one CA wins. Pinning fixes the leaf per-origin.

   Two policies:
     - TOFU (trust-on-first-use): first connect populates the pin; later
       mismatches fail closed. Default for v0.3.1.
     - PINNED (config-supplied): pins are seeded from config; an unknown
       origin throws TlsPinUnknownError (no implicit trust).

   Persistence: PersistentTlsPinStore mirrors PersistentReplayStore — a
   JSONL append-only log replayed on construction, corrupt-tail tolerant. */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

/** A pin = SHA-256 over the DER-encoded leaf certificate, hex-lowercase. */
export type CertFingerprint = string;

export interface TlsPinEntry {
  /** Origin: scheme + host + port (e.g., "https://mcp.example.com:443"). */
  readonly origin: string;
  /** SHA-256 of the leaf cert DER, hex-lowercase. */
  readonly fingerprint: CertFingerprint;
  /** Epoch ms when first pinned. */
  readonly pinnedAt: number;
  /** Source of the pin: 'tofu' (first-seen) or 'config' (operator-supplied). */
  readonly source: 'tofu' | 'config';
}

export interface TlsPinStore {
  /** Look up a pin by origin. */
  get(origin: string): TlsPinEntry | undefined;
  /** Add or update a pin (TOFU populate or operator config). */
  set(entry: TlsPinEntry): void;
  /** Remove a pin (operator rotation flow). */
  remove(origin: string): void;
  /** Enumerate all pins (audit). */
  list(): readonly TlsPinEntry[];
}

export class TlsPinMismatchError extends Error {
  constructor(
    public readonly origin: string,
    public readonly expected: CertFingerprint,
    public readonly seen: CertFingerprint,
  ) {
    super(`TLS pin mismatch for ${origin}: expected=${expected} seen=${seen}`);
    this.name = 'TlsPinMismatchError';
  }
}

export class TlsPinUnknownError extends Error {
  constructor(public readonly origin: string) {
    super(`TLS pin unknown for ${origin}: PINNED policy requires an operator-supplied pin`);
    this.name = 'TlsPinUnknownError';
  }
}

/**
 * Compute the SHA-256 fingerprint of a DER-encoded leaf certificate.
 * Returns hex-lowercase. Used by both TOFU populate and verify paths.
 */
export function computeCertFingerprint(certDer: Buffer): CertFingerprint {
  return createHash('sha256').update(certDer).digest('hex');
}

/**
 * Verify a connection's leaf cert against the pin store. On TOFU policy,
 * an unknown origin populates the pin and returns. On PINNED policy, an
 * unknown origin throws TlsPinUnknownError. On any policy, a fingerprint
 * mismatch throws TlsPinMismatchError.
 */
export function verifyTlsPin(
  store: TlsPinStore,
  origin: string,
  certDer: Buffer,
  policy: 'tofu' | 'pinned',
): void {
  const seen = computeCertFingerprint(certDer);
  const existing = store.get(origin);

  if (!existing) {
    if (policy === 'pinned') {
      throw new TlsPinUnknownError(origin);
    }
    // TOFU: populate the pin and proceed.
    store.set({ origin, fingerprint: seen, pinnedAt: Date.now(), source: 'tofu' });
    return;
  }

  if (existing.fingerprint !== seen) {
    throw new TlsPinMismatchError(origin, existing.fingerprint, seen);
  }
}

// ---------------------------------------------------------------------------
// InMemoryTlsPinStore
// ---------------------------------------------------------------------------

export class InMemoryTlsPinStore implements TlsPinStore {
  protected readonly entries = new Map<string, TlsPinEntry>();

  // Override hooks for the persistent subclass — base class is no-op.
  protected onSet(_entry: TlsPinEntry): void {
    /* no-op for in-memory */
  }
  protected onRemove(_origin: string): void {
    /* no-op for in-memory */
  }

  get(origin: string): TlsPinEntry | undefined {
    return this.entries.get(origin);
  }

  set(entry: TlsPinEntry): void {
    this.entries.set(entry.origin, entry);
    this.onSet(entry);
  }

  remove(origin: string): void {
    if (this.entries.delete(origin)) {
      this.onRemove(origin);
    }
  }

  list(): readonly TlsPinEntry[] {
    return [...this.entries.values()];
  }
}

// ---------------------------------------------------------------------------
// PersistentTlsPinStore — JSONL on disk for restart-survival
// ---------------------------------------------------------------------------

interface JsonlLine {
  op: 'set' | 'remove';
  origin: string;
  /** Present on set lines; absent on remove. */
  entry?: TlsPinEntry;
}

export class PersistentTlsPinStore extends InMemoryTlsPinStore {
  private readonly path: string;

  constructor(path: string) {
    super();
    this.path = path;
    const dir = dirname(path);
    if (dir && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.replayFromDisk();
  }

  protected override onSet(entry: TlsPinEntry): void {
    const line: JsonlLine = { op: 'set', origin: entry.origin, entry };
    appendFileSync(this.path, JSON.stringify(line) + '\n', { encoding: 'utf8' });
  }

  protected override onRemove(origin: string): void {
    const line: JsonlLine = { op: 'remove', origin };
    appendFileSync(this.path, JSON.stringify(line) + '\n', { encoding: 'utf8' });
  }

  private replayFromDisk(): void {
    if (!existsSync(this.path)) return;
    const raw = readFileSync(this.path, 'utf8');
    if (!raw) return;

    for (const rawLine of raw.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      let parsed: JsonlLine;
      try {
        parsed = JSON.parse(line) as JsonlLine;
      } catch {
        // Tolerate trailing/corrupt line at tail (e.g., crash mid-write).
        continue;
      }

      if (parsed.op === 'set' && parsed.entry) {
        // Direct map mutation — bypasses onSet to avoid re-appending during replay.
        this.entries.set(parsed.entry.origin, parsed.entry);
      } else if (parsed.op === 'remove') {
        this.entries.delete(parsed.origin);
      }
    }
  }
}
