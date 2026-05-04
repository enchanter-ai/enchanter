/* enchanter/src/plugins/djinn.adapter.ts — v0.2 implementation.
   Implements architecture-spec phase_1.djinn (intent anchoring + drift detection
   at anchor + post-session phases) drawing from plugins/djinn source:
   shared/scripts/engines/c1_lcs.py (D1 Hunt-Szymanski LCS), plugins/intent-anchor
   (session anchor capture), and plugins/drift-aligner (per-turn alignment).

   [author judgment] Drift threshold set at LCS ratio < 0.3. The Python source
   (plugins/djinn/shared/scripts/engines/c2_hmm.py) uses a Baum-Welch HMM
   for per-turn ON_TASK/SIDEQUEST/LOST labelling; v0.2 ships D1 LCS-only as
   specified, keeping HMM (D2) as a v0.3 addition. The 0.3 threshold mirrors
   the anchor.py normalize() + difflib.SequenceMatcher behaviour: a ratio
   below 0.3 indicates fewer than ~30% shared tokens, consistent with the
   SIDEQUEST/LOST boundary in the HMM emission table. */

import type { PluginAdapter } from './plugin-contract.js';
import type { EnchantedEvent, PluginAck } from '../bus/event-types.js';
import type { RequestContext } from '../orchestration/request-context.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionAnchor {
  readonly intent: string;
  readonly set_at: number;
  readonly tokens: string[];
}

// ---------------------------------------------------------------------------
// Tokenisation (mirrors plugins/djinn/shared/scripts/engines/c1_lcs.py:normalize)
// ---------------------------------------------------------------------------

const TOKEN_RE = /\w+/g;
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'be',
]);

function tokenize(text: string): string[] {
  const matches = text.toLowerCase().match(TOKEN_RE) ?? [];
  return matches.filter((t) => !STOPWORDS.has(t));
}

// ---------------------------------------------------------------------------
// LCS ratio — O(m*n) DP, returns value in [0, 1].
// Reference: Hunt J.W. and Szymanski T.G. (1977), CACM 20(5):350-353.
// ---------------------------------------------------------------------------

function lcsRatio(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1.0;
  if (a.length === 0 || b.length === 0) return 0.0;

  const m = a.length;
  const n = b.length;
  // Single-row DP — space O(n).
  let prev = new Array<number>(n + 1).fill(0);
  let curr = new Array<number>(n + 1).fill(0);

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        curr[j] = (prev[j - 1] ?? 0) + 1;
      } else {
        curr[j] = Math.max(prev[j] ?? 0, curr[j - 1] ?? 0);
      }
    }
    // swap buffers
    [prev, curr] = [curr, prev];
    curr.fill(0);
  }

  const lcsLen = prev[n] ?? 0;
  return lcsLen / Math.max(m, n);
}

// ---------------------------------------------------------------------------
// In-memory anchor store — keyed by session_id.
// ---------------------------------------------------------------------------

// [author judgment] In-memory Map is appropriate for the enchanter process
// lifetime. Cross-process / cross-restart persistence is owned by the
// plugins/intent-anchor state files on disk; the enchanter adapter is the
// in-process representation only.
const ANCHORS = new Map<string, SessionAnchor>();

// TODO(v0.3.1): D2 HMM drift labelling — see docs/v0.3/djinn-d2-hmm.md.
// Lands as src/plugins/djinn/hmm.ts (Baum-Welch + Viterbi over the
// ON_TASK / SIDEQUEST / LOST emission table). Wires into a new per-turn
// phase handler invoked from handlePostSessionPhase; the LCS path stays
// as the cheap pre-filter (skip HMM if LCS already > 0.6 — clearly on
// task) and as the explainable signal in the derived event payload.

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Return the current anchor for the given session, or undefined. */
export function getAnchor(session_id: string): SessionAnchor | undefined {
  return ANCHORS.get(session_id);
}

/** Remove the anchor for the given session (e.g. on /reorient or test teardown). */
export function clearAnchor(session_id: string): void {
  ANCHORS.delete(session_id);
}

// ---------------------------------------------------------------------------
// Drift threshold
// [author judgment] 0.3: below this ratio the session shares fewer than ~30%
// of meaningful tokens with the original intent — consistent with the LOST /
// SIDEQUEST emission boundary in the D2 HMM table. Conservative enough to
// avoid false positives on natural paraphrase, tight enough to catch clear
// topic shifts.
// ---------------------------------------------------------------------------
const DRIFT_THRESHOLD = 0.3;

// ---------------------------------------------------------------------------
// Phase handlers
// ---------------------------------------------------------------------------

function handleAnchorPhase(event: EnchantedEvent): PluginAck {
  const { session_id } = event;

  // Anchor is immutable once set for a session — first prompt wins.
  if (ANCHORS.has(session_id)) {
    return { status: 'ack' };
  }

  const prompt = (event.payload['user_prompt'] as string | undefined) ?? '';
  const tokens = tokenize(prompt);

  ANCHORS.set(session_id, { intent: prompt, set_at: event.ts, tokens });

  return {
    status: 'ack',
    derived_events: [
      {
        id: `${event.correlation_id}::djinn-anchor`,
        correlation_id: event.correlation_id,
        session_id,
        phase: event.phase,
        topic: 'djinn.anchor.set',
        source: 'djinn',
        budget_tier: event.budget_tier,
        ts: Date.now(),
        payload: {
          intent: prompt,
          token_count: tokens.length,
        },
      },
    ],
  };
}

function handlePostSessionPhase(event: EnchantedEvent): PluginAck {
  const { session_id } = event;
  const anchor = ANCHORS.get(session_id);

  if (!anchor) {
    // No anchor means the session never set intent — nothing to compare.
    return { status: 'ack' };
  }

  const prompt = (event.payload['user_prompt'] as string | undefined) ?? '';
  const currentTokens = tokenize(prompt);
  const ratio = lcsRatio(anchor.tokens, currentTokens);

  if (ratio >= DRIFT_THRESHOLD) {
    return { status: 'ack' };
  }

  return {
    status: 'ack',
    derived_events: [
      {
        id: `${event.correlation_id}::djinn-drift`,
        correlation_id: event.correlation_id,
        session_id,
        phase: event.phase,
        topic: 'djinn.drift.detected',
        source: 'djinn',
        budget_tier: event.budget_tier,
        ts: Date.now(),
        payload: {
          lcs_ratio: ratio,
          threshold: DRIFT_THRESHOLD,
          anchor_intent: anchor.intent,
          current_prompt: prompt,
        },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const djinnAdapter: PluginAdapter = {
  name: 'djinn',
  phases: ['anchor', 'post-session'],
  required: false, // advisory — fail-open with degraded=true on errors
  topics: {
    subscribes: ['session.start', 'user.prompt.submit', 'compact.requested'],
    emits: ['djinn.anchor.set', 'djinn.drift.detected'],
  },
  budget_tier: 'med-or-higher',

  async onPhase(event: EnchantedEvent, _ctx: RequestContext): Promise<PluginAck> {
    try {
      if (event.phase === 'anchor') {
        return handleAnchorPhase(event);
      }
      if (event.phase === 'post-session') {
        return handlePostSessionPhase(event);
      }
      return { status: 'ack' };
    } catch (err) {
      // Fail-open: advisory plugin must not block the orchestrator.
      return {
        status: 'ack',
        degraded: true,
        reason: `djinn error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};
