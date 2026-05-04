/* enchanter/src/registry/trust-pin.ts — STUB for v0.3 follow-up #3
   (FM 10 full trust-pin / MCPoison full closure). Defines the intended API;
   bodies throw until v0.3.1 implementation. Design doc: docs/v0.3/trust-pinning.md.

   v0.2 closes part of FM 10 via per-tool schema-digest pinning in
   namespace.ts (SchemaDigestMismatchError on mutation). v0.3 extends this
   to a full trust digest covering the entire server identity:
     SHA-256( cmd
            ‖ args[]            (canonicalized JSON)
            ‖ binary_digest      (sha256 of the executable's bytes for stdio)
            ‖ env_allowlist[]    (canonical sort)
            ‖ url                (absolute, normalized)
            ‖ schema_digests[]   (sorted list of per-tool digests)
            )

   First connect → record. Subsequent connects → re-compute, compare. Any
   change requires explicit operator re-consent (a write to the pin store
   via approveTrustPinUpdate()). */

/** A trust pin = SHA-256 hex over the canonical server-identity tuple. */
export type TrustDigest = string;

export interface TrustPinInputs {
  /** stdio command (absent for HTTP transports). */
  readonly cmd?: string;
  /** stdio arguments. */
  readonly args?: readonly string[];
  /** SHA-256 of the binary file (stdio only). */
  readonly binaryDigest?: string;
  /** Allow-listed env var NAMES (not values — values are runtime-bound). */
  readonly envAllowlist?: readonly string[];
  /** Streamable-HTTP endpoint URL (absent for stdio). */
  readonly url?: string;
  /** Sorted list of per-tool schema digests from namespace.ts. */
  readonly schemaDigests: readonly string[];
}

export interface TrustPinEntry {
  readonly server_id: string;
  readonly digest: TrustDigest;
  readonly pinnedAt: number;
  /** Snapshot of the inputs at pin time, for diff display on mismatch. */
  readonly inputs: TrustPinInputs;
}

export class TrustPinMismatchError extends Error {
  constructor(
    public readonly server_id: string,
    public readonly pinnedDigest: TrustDigest,
    public readonly currentDigest: TrustDigest,
    public readonly diff: string,
  ) {
    super(
      `trust pin mismatch for server ${server_id}: pinned=${pinnedDigest} current=${currentDigest} (diff: ${diff}) — operator re-consent required`,
    );
    this.name = 'TrustPinMismatchError';
  }
}

export interface TrustPinStore {
  get(server_id: string): TrustPinEntry | undefined;
  set(entry: TrustPinEntry): void;
  remove(server_id: string): void;
  list(): readonly TrustPinEntry[];
}

/**
 * Compute the canonical trust digest. Canonicalization:
 *   - args sorted? NO — argv order is meaningful, preserve.
 *   - envAllowlist sorted lexicographically.
 *   - schemaDigests sorted lexicographically.
 *   - JSON.stringify with explicit field order: cmd, args, binaryDigest,
 *     envAllowlist, url, schemaDigests.
 */
export function computeTrustDigest(_inputs: TrustPinInputs): TrustDigest {
  // TODO(v0.3.1): implement
  throw new Error('TODO(v0.3.1): trust-pin.computeTrustDigest not implemented');
}

/**
 * Verify a server's current trust inputs against its stored pin.
 * - First-time server (no entry): TOFU populate, no error.
 * - Match: no-op.
 * - Mismatch: throw TrustPinMismatchError; operator must call
 *   approveTrustPinUpdate() to re-consent.
 */
export function verifyTrustPin(
  _store: TrustPinStore,
  _server_id: string,
  _inputs: TrustPinInputs,
): void {
  // TODO(v0.3.1): implement
  throw new Error('TODO(v0.3.1): trust-pin.verifyTrustPin not implemented');
}

/**
 * Operator-only re-consent flow. Overwrites the pin entry with the
 * supplied inputs after an explicit human-in-the-loop confirmation.
 */
export function approveTrustPinUpdate(
  _store: TrustPinStore,
  _server_id: string,
  _inputs: TrustPinInputs,
): TrustPinEntry {
  // TODO(v0.3.1): implement
  throw new Error('TODO(v0.3.1): trust-pin.approveTrustPinUpdate not implemented');
}

/**
 * In-memory trust-pin store. v0.3.1 will add a JSONL-backed persistent
 * variant mirroring the replay-store pattern.
 */
export class InMemoryTrustPinStore implements TrustPinStore {
  get(_server_id: string): TrustPinEntry | undefined {
    // TODO(v0.3.1): implement
    throw new Error('TODO(v0.3.1): InMemoryTrustPinStore.get not implemented');
  }
  set(_entry: TrustPinEntry): void {
    // TODO(v0.3.1): implement
    throw new Error('TODO(v0.3.1): InMemoryTrustPinStore.set not implemented');
  }
  remove(_server_id: string): void {
    // TODO(v0.3.1): implement
    throw new Error('TODO(v0.3.1): InMemoryTrustPinStore.remove not implemented');
  }
  list(): readonly TrustPinEntry[] {
    // TODO(v0.3.1): implement
    throw new Error('TODO(v0.3.1): InMemoryTrustPinStore.list not implemented');
  }
}
