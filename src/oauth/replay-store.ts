/* enchanter/src/oauth/replay-store.ts — implements v0.3 follow-up #1 OAuth
   replay defense (per IMPLEMENTATION_SUMMARY.md §v0.3 + README §v0.3 roadmap).

   ReplayStore contract:
     - mint() issues a fresh nonce + epoch-ms timestamp; nonce is recorded
       as { issuedAt, consumed: false }.
     - consume(nonce) validates four things:
         1. nonce was issued by mint() in this store ('unknown' otherwise),
         2. issuedAt is within freshnessSeconds of now ('expired' otherwise),
         3. nonce has not been consumed before ('replay' otherwise),
         4. transition to consumed: true only on success.
     - size() reports current entry count for tests + ops.

   Eviction:
     - Time-based: any entry older than 2× freshnessSeconds is purged on
       every mint and on every consume miss. Keeps the live set tight.
     - Cap-based: hard cap MAX_ENTRIES; FIFO eviction of oldest entries
       beyond cap. Insertion order is preserved by Map iteration.

   Persistence:
     - InMemoryReplayStore: in-process Map; all state lost on restart.
     - PersistentReplayStore: wraps in-memory + JSONL append-only log.
       Each mint and each successful consume writes one JSON line. On
       construction the JSONL is replayed to rebuild state — the store
       survives restart.
     - Atomic-ish: appendFileSync with O_APPEND is line-atomic on POSIX
       and good-enough on Windows for the v0.3.0 single-process default.
       Multi-process callers: out of scope for this slice.

   Counter: a per-process replay set without persistence drops on restart
   and lets a captured nonce replay-window straddle a quick crash + recover.
   The persistent fallback closes that hole when the env var is set. */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { generateNonce } from './nonce.js';

export const DEFAULT_FRESHNESS_SECONDS = 300;
export const MAX_ENTRIES = 10_000;

export type ConsumeFailure = 'unknown' | 'replay' | 'expired';
export type ConsumeResult = { ok: true } | { ok: false; reason: ConsumeFailure };

interface Entry {
  /** Epoch ms at mint. */
  issuedAt: number;
  /** True after successful consume; subsequent attempts return 'replay'. */
  consumed: boolean;
}

export interface ReplayStore {
  /** Mint a fresh nonce + record its issuedAt. */
  mint(): { nonce: string; issuedAt: number };
  /**
   * Consume a nonce. Default freshnessSeconds = 300 (5 minutes).
   * Returns { ok: true } on first valid consume; { ok: false, reason }
   * for unknown / replay / expired.
   */
  consume(nonce: string, freshnessSeconds?: number): ConsumeResult;
  /** Current entry count (after eviction). */
  size(): number;
}

// ---------------------------------------------------------------------------
// InMemoryReplayStore
// ---------------------------------------------------------------------------

export class InMemoryReplayStore implements ReplayStore {
  protected readonly entries = new Map<string, Entry>();

  // Override hooks for the persistent subclass — base class is no-op.
  protected onMint(_nonce: string, _entry: Entry): void {
    /* no-op for in-memory */
  }
  protected onConsume(_nonce: string, _entry: Entry): void {
    /* no-op for in-memory */
  }

  mint(): { nonce: string; issuedAt: number } {
    const now = Date.now();
    this.evictExpired(now, DEFAULT_FRESHNESS_SECONDS);

    const nonce = generateNonce();
    const entry: Entry = { issuedAt: now, consumed: false };
    this.entries.set(nonce, entry);

    // Cap-based FIFO eviction: trim oldest while above cap. Map preserves
    // insertion order, so the first key is the oldest.
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }

    this.onMint(nonce, entry);
    return { nonce, issuedAt: now };
  }

  consume(nonce: string, freshnessSeconds: number = DEFAULT_FRESHNESS_SECONDS): ConsumeResult {
    const now = Date.now();
    const entry = this.entries.get(nonce);
    if (!entry) {
      this.evictExpired(now, freshnessSeconds);
      return { ok: false, reason: 'unknown' };
    }

    if (entry.consumed) {
      return { ok: false, reason: 'replay' };
    }

    const ageMs = now - entry.issuedAt;
    if (ageMs > freshnessSeconds * 1000 || ageMs < -freshnessSeconds * 1000) {
      // Expired entries stay in the map until evictExpired sweeps; this
      // preserves the 'expired' signal for late callers within 2× window.
      return { ok: false, reason: 'expired' };
    }

    entry.consumed = true;
    this.onConsume(nonce, entry);
    return { ok: true };
  }

  size(): number {
    return this.entries.size;
  }

  /**
   * Evict any entry older than 2× freshnessSeconds. Anything older has
   * already returned 'expired' to any honest caller; keeping it pollutes
   * the cap budget.
   */
  protected evictExpired(nowMs: number, freshnessSeconds: number): void {
    const horizonMs = nowMs - 2 * freshnessSeconds * 1000;
    for (const [nonce, entry] of this.entries) {
      if (entry.issuedAt < horizonMs) {
        this.entries.delete(nonce);
      } else {
        // Map insertion order: once we hit a non-expired entry, all later
        // entries are newer (mint always appends). Bail early.
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// PersistentReplayStore — JSONL on disk for restart-survival
// ---------------------------------------------------------------------------

interface JsonlLine {
  op: 'mint' | 'consume';
  nonce: string;
  issuedAt: number;
  /** Present on consume lines for audit trail; absent on mint. */
  consumedAt?: number;
}

export class PersistentReplayStore extends InMemoryReplayStore {
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

  protected override onMint(nonce: string, entry: Entry): void {
    const line: JsonlLine = { op: 'mint', nonce, issuedAt: entry.issuedAt };
    appendFileSync(this.path, JSON.stringify(line) + '\n', { encoding: 'utf8' });
  }

  protected override onConsume(nonce: string, entry: Entry): void {
    const line: JsonlLine = { op: 'consume', nonce, issuedAt: entry.issuedAt, consumedAt: Date.now() };
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

      if (parsed.op === 'mint') {
        this.entries.set(parsed.nonce, { issuedAt: parsed.issuedAt, consumed: false });
      } else if (parsed.op === 'consume') {
        const existing = this.entries.get(parsed.nonce);
        if (existing) {
          existing.consumed = true;
        } else {
          // Defensive: consume-without-mint, treat as consumed sentinel so
          // a future replay attempt still returns 'replay' rather than
          // 'unknown'. Preserves the security invariant on partial logs.
          this.entries.set(parsed.nonce, { issuedAt: parsed.issuedAt, consumed: true });
        }
      }
    }
  }
}
