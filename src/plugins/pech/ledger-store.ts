/* enchanter/src/plugins/pech/ledger-store.ts — v0.3 file-backed ledger.
   Cites: architecture-spec phase_5.cost_attribution_unit + plugins/pech README
   (engine L0 ledger). v0.2 shipped in-memory only; v0.3 adds an opt-in
   append-only JSONL file backing so cost attribution survives restart and is
   consumable by downstream observability (the inspector tails the JSONL).

   Design notes:
   - Append-only: one JSON object per line, terminated with '\n'.
   - Path is opt-in via configurePech({ ledger_path }); absent → pure in-memory
     (preserves v0.2 behaviour and the existing test contract).
   - Replay on configure: the file is read once and parsed into the in-memory
     mirror so getLedger() returns a complete view across restarts.
   - I/O is best-effort: write failures surface a degradation flag to the
     caller but never throw. Pech is required (fail-closed) on the security /
     budget surface; the ledger is the observability surface and must not
     block a successful tool result.
   - Stdlib-only: node:fs + node:path. No new top-level deps. */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

import type { LedgerEntry } from '../pech.adapter.js';

export interface LedgerStore {
  /** Append one entry. Returns null on success or an error message on failure. */
  append(entry: LedgerEntry): string | null;
  /** Replay the file contents into a fresh array. Tolerates empty / missing files. */
  replay(): LedgerEntry[];
  /** Path the store writes to (for diagnostics / tests). */
  readonly path: string;
}

/** Build a JSONL-backed ledger store rooted at the given absolute file path. */
export function createFileLedgerStore(path: string): LedgerStore {
  // Ensure the parent directory exists; mkdir is idempotent with recursive=true.
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  return {
    path,

    append(entry: LedgerEntry): string | null {
      try {
        // appendFileSync with a single line is the simplest safe atomic-ish
        // write on a single-process JSONL log. Concurrent multi-process
        // appenders are out of scope — pech runs in-process inside the
        // enchanter runtime per architecture-spec phase_5.
        appendFileSync(path, JSON.stringify(entry) + '\n', { encoding: 'utf8' });
        return null;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    },

    replay(): LedgerEntry[] {
      if (!existsSync(path)) return [];
      let raw: string;
      try {
        raw = readFileSync(path, { encoding: 'utf8' });
      } catch {
        return [];
      }
      if (raw.length === 0) return [];

      const out: LedgerEntry[] = [];
      // Split on \n; tolerate trailing newline and partial last line (crash-safe).
      const lines = raw.split('\n');
      for (const line of lines) {
        if (line.length === 0) continue;
        try {
          const parsed = JSON.parse(line) as LedgerEntry;
          // Minimal shape check — must have ts + correlation_id + token counts.
          // Anything narrower would couple this module to evolving payload
          // shape; this is the smallest invariant the consumer relies on.
          if (
            typeof parsed.ts === 'number' &&
            typeof parsed.correlation_id === 'string' &&
            typeof parsed.input_tokens === 'number' &&
            typeof parsed.output_tokens === 'number'
          ) {
            out.push(parsed);
          }
          // Malformed lines are skipped, not raised — the file is observability,
          // not a transactional store. A truncated tail line should not poison
          // the replay of the prior 10k complete lines.
        } catch {
          // skip malformed line
        }
      }
      return out;
    },
  };
}
