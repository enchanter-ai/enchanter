/* enchanter/src/plugins/lich/replay-cache.ts — v0.4 #1 (M5 tool-confirm-live).
   Refs: docs/v0.3/lich-m5-sandbox.md § "Sandbox cache" open question.
   Per-(schema_digest, args_digest) LRU keyed cache for tool-confirm replay
   results — avoids doubling latency on every below-veto-threshold tool call.
   Standard doubly-linked-list-via-Map LRU (Node-stdlib pattern). Stdlib only;
   no new top-level deps. Atomicity guarantee: get() promotes to MRU; set()
   evicts the LRU entry past `maxEntries`. Concurrency: single-threaded
   JS; not safe across workers (caller is the parent process). */

import type { ToolConfirmResult } from './sandbox.js';

export class ReplayCache {
  private readonly maxEntries: number;
  // [author judgment] Map preserves insertion order; we re-insert on get() to
  // promote MRU. This is the canonical Node-stdlib LRU pattern — no extra deps
  // and no separate doubly-linked-list bookkeeping.
  private readonly entries = new Map<string, ToolConfirmResult>();

  constructor(maxEntries: number = 256) {
    if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
      throw new Error('ReplayCache maxEntries must be a positive integer');
    }
    this.maxEntries = maxEntries;
  }

  /** Compose a cache key from a schema digest and an args digest. */
  key(schemaDigest: string, argsDigest: string): string {
    return `${schemaDigest}:${argsDigest}`;
  }

  /** Look up a cached result. Hit promotes the entry to MRU position. */
  get(key: string): ToolConfirmResult | undefined {
    const v = this.entries.get(key);
    if (v === undefined) return undefined;
    // Promote to MRU.
    this.entries.delete(key);
    this.entries.set(key, v);
    return v;
  }

  /** Store a result. Evicts the least-recently-used entry if over capacity. */
  set(key: string, result: ToolConfirmResult): void {
    if (this.entries.has(key)) {
      // Refresh MRU position by deleting first.
      this.entries.delete(key);
    }
    this.entries.set(key, result);
    if (this.entries.size > this.maxEntries) {
      // Map iteration order is insertion order — first key is the LRU entry.
      const lruKey = this.entries.keys().next().value;
      if (lruKey !== undefined) {
        this.entries.delete(lruKey);
      }
    }
  }

  /** Current number of cached entries (≤ maxEntries). */
  size(): number {
    return this.entries.size;
  }

  /** Test/runtime hook: drop all entries. */
  clear(): void {
    this.entries.clear();
  }
}
