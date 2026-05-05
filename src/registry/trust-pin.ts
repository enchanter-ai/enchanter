/* enchanter/src/registry/trust-pin.ts — implements v0.3.1 follow-up #3
   (FM 10 full trust-pin / MCPoison full closure). Design doc:
   docs/v0.3/trust-pinning.md.

   v0.2 closes part of FM 10 via per-tool schema-digest pinning in
   namespace.ts (SchemaDigestMismatchError on mutation). v0.3 extends this
   to a full trust digest covering the entire server identity:
     SHA-256( cmd
            ‖ args[]            (canonicalized JSON, order preserved)
            ‖ binary_digest      (sha256 of the executable's bytes for stdio)
            ‖ env_allowlist[]    (canonical sort)
            ‖ url                (absolute, normalized)
            ‖ schema_digests[]   (sorted list of per-tool digests)
            )

   First connect → record (TOFU). Subsequent connects → re-compute, compare.
   Any change requires explicit operator re-consent via approveTrustPinUpdate().

   Persistence: PersistentTrustPinStore mirrors PersistentReplayStore — a
   JSONL append-only log, replayed on construction, corrupt-tail tolerant. */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

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

// ---------------------------------------------------------------------------
// canonicalize + computeTrustDigest
// ---------------------------------------------------------------------------

/**
 * Build the canonical JSON payload for digest computation.
 * - Field order is fixed: cmd, args, binaryDigest, envAllowlist, url, schemaDigests.
 * - args order is preserved (argv semantics).
 * - envAllowlist + schemaDigests are sorted lexicographically (set semantics).
 * - Missing fields are OMITTED ENTIRELY (not present as null) so digest is
 *   stable across transport types (stdio vs HTTP).
 */
function canonicalize(inputs: TrustPinInputs): string {
  const ordered: Record<string, unknown> = {};
  if (inputs.cmd !== undefined) ordered['cmd'] = inputs.cmd;
  if (inputs.args !== undefined) ordered['args'] = [...inputs.args]; // order preserved
  if (inputs.binaryDigest !== undefined) ordered['binaryDigest'] = inputs.binaryDigest;
  if (inputs.envAllowlist !== undefined) ordered['envAllowlist'] = [...inputs.envAllowlist].sort();
  if (inputs.url !== undefined) ordered['url'] = inputs.url;
  // schemaDigests is required on the type; sort defensively.
  ordered['schemaDigests'] = [...inputs.schemaDigests].sort();
  return JSON.stringify(ordered);
}

/**
 * Compute the canonical trust digest. Hex-lowercase SHA-256 over the
 * canonicalized JSON of the inputs (see canonicalize()).
 */
export function computeTrustDigest(inputs: TrustPinInputs): TrustDigest {
  return createHash('sha256').update(canonicalize(inputs), 'utf8').digest('hex');
}

/**
 * Diff two TrustPinInputs and return a short human-readable summary of
 * which fields changed. Used in TrustPinMismatchError.diff to drive the
 * operator's re-consent decision.
 */
function diffInputs(pinned: TrustPinInputs, current: TrustPinInputs): string {
  const keys: (keyof TrustPinInputs)[] = [
    'cmd',
    'args',
    'binaryDigest',
    'envAllowlist',
    'url',
    'schemaDigests',
  ];
  const changed: string[] = [];
  for (const k of keys) {
    const a = pinned[k];
    const b = current[k];
    if (Array.isArray(a) || Array.isArray(b)) {
      const aJson = JSON.stringify(a ?? null);
      const bJson = JSON.stringify(b ?? null);
      if (aJson !== bJson) changed.push(String(k));
    } else if (a !== b) {
      changed.push(String(k));
    }
  }
  return changed.length === 0 ? '(no field-level diff — digest mismatch only)' : changed.join(', ');
}

// ---------------------------------------------------------------------------
// verify + approve
// ---------------------------------------------------------------------------

/**
 * Verify a server's current trust inputs against its stored pin.
 * - First-time server (no entry): TOFU populate, no error.
 * - Match: no-op.
 * - Mismatch: throw TrustPinMismatchError; operator must call
 *   approveTrustPinUpdate() to re-consent.
 */
export function verifyTrustPin(
  store: TrustPinStore,
  server_id: string,
  inputs: TrustPinInputs,
): void {
  const current = computeTrustDigest(inputs);
  const existing = store.get(server_id);

  if (!existing) {
    // TOFU populate: record digest + inputs snapshot.
    store.set({
      server_id,
      digest: current,
      pinnedAt: Date.now(),
      inputs,
    });
    return;
  }

  if (existing.digest !== current) {
    throw new TrustPinMismatchError(
      server_id,
      existing.digest,
      current,
      diffInputs(existing.inputs, inputs),
    );
  }
}

/**
 * Operator-only re-consent flow. Overwrites the pin entry with the
 * supplied inputs after an explicit human-in-the-loop confirmation.
 * Returns the new entry (with fresh pinnedAt timestamp).
 */
export function approveTrustPinUpdate(
  store: TrustPinStore,
  server_id: string,
  inputs: TrustPinInputs,
): TrustPinEntry {
  const entry: TrustPinEntry = {
    server_id,
    digest: computeTrustDigest(inputs),
    pinnedAt: Date.now(),
    inputs,
  };
  store.set(entry);
  return entry;
}

// ---------------------------------------------------------------------------
// InMemoryTrustPinStore
// ---------------------------------------------------------------------------

export class InMemoryTrustPinStore implements TrustPinStore {
  protected readonly entries = new Map<string, TrustPinEntry>();

  // Override hooks for the persistent subclass — base class is no-op.
  protected onSet(_entry: TrustPinEntry): void {
    /* no-op for in-memory */
  }
  protected onRemove(_server_id: string): void {
    /* no-op for in-memory */
  }

  get(server_id: string): TrustPinEntry | undefined {
    return this.entries.get(server_id);
  }

  set(entry: TrustPinEntry): void {
    this.entries.set(entry.server_id, entry);
    this.onSet(entry);
  }

  remove(server_id: string): void {
    if (this.entries.delete(server_id)) {
      this.onRemove(server_id);
    }
  }

  list(): readonly TrustPinEntry[] {
    return [...this.entries.values()];
  }
}

// ---------------------------------------------------------------------------
// PersistentTrustPinStore — JSONL on disk for restart-survival
// ---------------------------------------------------------------------------

interface JsonlLine {
  op: 'set' | 'remove';
  server_id: string;
  /** Present on set lines; absent on remove. */
  entry?: TrustPinEntry;
}

export class PersistentTrustPinStore extends InMemoryTrustPinStore {
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

  protected override onSet(entry: TrustPinEntry): void {
    const line: JsonlLine = { op: 'set', server_id: entry.server_id, entry };
    appendFileSync(this.path, JSON.stringify(line) + '\n', { encoding: 'utf8' });
  }

  protected override onRemove(server_id: string): void {
    const line: JsonlLine = { op: 'remove', server_id };
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
        this.entries.set(parsed.entry.server_id, parsed.entry);
      } else if (parsed.op === 'remove') {
        this.entries.delete(parsed.server_id);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Bus integration helper — emits a security veto event on mismatch.
// The orchestrator's trust-gate phase calls this; on TrustPinMismatchError,
// a veto event is published before the error propagates.
// ---------------------------------------------------------------------------

/**
 * Minimal bus-like surface used by enforceTrustPin to publish veto events.
 * Decoupled from the concrete Bus class so unit tests can pass a mock.
 */
export interface TrustPinBus {
  publish(topic: string, event: unknown): Promise<void> | void;
}

/**
 * Trust-gate-phase entry point. Verifies the pin; on mismatch, publishes
 * `hydra.trust-pin.mismatch` (security-veto family — see hydra.veto.fired
 * for the existing pattern) and rethrows TrustPinMismatchError so the
 * orchestrator's required-plugin path returns a SecurityVeto.
 *
 * On match or TOFU populate, no event is emitted (cost-attribution hygiene:
 * the steady-state path stays quiet).
 */
export async function enforceTrustPin(
  store: TrustPinStore,
  server_id: string,
  inputs: TrustPinInputs,
  bus: TrustPinBus | undefined,
  context: { correlation_id: string; session_id: string; phase: string; ts?: number } | undefined,
): Promise<void> {
  try {
    verifyTrustPin(store, server_id, inputs);
  } catch (err) {
    if (err instanceof TrustPinMismatchError && bus && context) {
      const event = {
        id: `${context.correlation_id}::trust-pin-mismatch`,
        correlation_id: context.correlation_id,
        session_id: context.session_id,
        phase: context.phase,
        topic: 'hydra.trust-pin.mismatch',
        source: 'orchestrator',
        ts: context.ts ?? Date.now(),
        payload: {
          server_id: err.server_id,
          pinned_digest: err.pinnedDigest,
          current_digest: err.currentDigest,
          diff: err.diff,
        },
      };
      await bus.publish('hydra.trust-pin.mismatch', event);
    }
    throw err;
  }
}
