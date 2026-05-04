/* enchanter/src/transport/tls-pin.ts — STUB for v0.3 follow-up #2
   (FM 6 server spoofing). Defines the intended API; bodies throw until
   v0.3.1 implementation. Design doc: docs/v0.3/tls-pinning.md.

   Threat model: an attacker MITMing a streamable-HTTP MCP server presents
   a valid-but-attacker-controlled cert chain. PKI alone is insufficient
   because the trust anchor set is large and an attacker who compromises
   any one CA wins. Pinning fixes the leaf or intermediate per-origin.

   The pin store is keyed by URL origin (scheme + host + port). Each entry
   stores a SHA-256 over the leaf certificate's DER encoding. On every
   TLS handshake the connection's leaf cert is hashed and compared.

   Two policies (final design pending):
     - TOFU (trust-on-first-use): first connect populates the pin; later
       mismatches fail closed.
     - PINNED (config-supplied): pins are seeded from config; no TOFU. */

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

/**
 * Compute the SHA-256 fingerprint of a DER-encoded leaf certificate.
 * Returns hex-lowercase. Used by both TOFU populate and verify paths.
 */
export function computeCertFingerprint(_certDer: Buffer): CertFingerprint {
  // TODO(v0.3.1): implement via createHash('sha256').update(certDer).digest('hex')
  throw new Error('TODO(v0.3.1): tls-pin.computeCertFingerprint not implemented');
}

/**
 * Verify a connection's leaf cert against the pin store. On TOFU policy,
 * an unknown origin populates the pin and returns. On PINNED policy, an
 * unknown origin throws. On any policy, a fingerprint mismatch throws
 * TlsPinMismatchError.
 */
export function verifyTlsPin(
  _store: TlsPinStore,
  _origin: string,
  _certDer: Buffer,
  _policy: 'tofu' | 'pinned',
): void {
  // TODO(v0.3.1): implement
  throw new Error('TODO(v0.3.1): tls-pin.verifyTlsPin not implemented');
}

/**
 * In-memory pin store. v0.3.1 will add a JSONL-backed persistent variant
 * mirroring the replay-store pattern.
 */
export class InMemoryTlsPinStore implements TlsPinStore {
  get(_origin: string): TlsPinEntry | undefined {
    // TODO(v0.3.1): implement
    throw new Error('TODO(v0.3.1): InMemoryTlsPinStore.get not implemented');
  }
  set(_entry: TlsPinEntry): void {
    // TODO(v0.3.1): implement
    throw new Error('TODO(v0.3.1): InMemoryTlsPinStore.set not implemented');
  }
  remove(_origin: string): void {
    // TODO(v0.3.1): implement
    throw new Error('TODO(v0.3.1): InMemoryTlsPinStore.remove not implemented');
  }
  list(): readonly TlsPinEntry[] {
    // TODO(v0.3.1): implement
    throw new Error('TODO(v0.3.1): InMemoryTlsPinStore.list not implemented');
  }
}
