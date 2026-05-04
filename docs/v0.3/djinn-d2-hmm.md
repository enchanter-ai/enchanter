# Djinn D2 — HMM Per-Turn Drift Labelling

**Status:** v0.3.1 design.
**Owner:** `src/plugins/djinn.adapter.ts` (entry), `src/plugins/djinn/hmm.ts` (new).

## Problem statement

Djinn v0.2 ships D1: Hunt-Szymanski LCS ratio between the session anchor and
the current prompt, with a single hard threshold (`ratio < 0.3`) emitting
`djinn.drift.detected`. That works for the steady-state case (long-running
session shifts topic), but it misses two patterns:

1. **Slow drift across many turns** — each turn has LCS > 0.3 vs. the anchor,
   but cumulative path takes the session two topics away.
2. **Recoverable side-quests** — one turn drops below 0.3 (a tangent), the
   next returns to the anchor; v0.2 fires a false-positive on the dip.

D2 adds a per-turn hidden-state label — `ON_TASK`, `SIDEQUEST`, `LOST` — so
the orchestrator can react to *patterns* of drift, not single-turn dips.

## Algorithm sketch

A 3-state Hidden Markov Model over per-turn LCS observations:

- **States:** `ON_TASK`, `SIDEQUEST`, `LOST`.
- **Observations:** discretized LCS bucket (`high` ≥ 0.6, `mid` 0.3-0.6,
  `low` < 0.3).
- **Transition matrix:** seeded from `plugins/djinn/shared/scripts/engines/c2_hmm.py`
  (the same source D1's threshold mirrors). ON_TASK is sticky; SIDEQUEST has
  high return-to-ON_TASK probability; LOST is absorbing relative to a single
  recovery turn.
- **Inference:** Viterbi over the session's turn sequence on every
  `post-session` event, returning the most likely state for the latest turn.
- **Learning:** Baum-Welch updates the transition matrix at session end if
  the user confirms the labels (advisory, fail-open — never blocks).

LCS stays as the cheap pre-filter: if the current turn's LCS > 0.6, skip the
HMM entirely (clearly ON_TASK) and short-circuit at the existing D1 path.

## Dependencies

Stdlib only. The HMM is small (3 states, 3 emissions) — pure-TS Viterbi is
~40 LOC. No matrix library.

## Test strategy

- Unit: `tests/plugins/djinn/hmm.test.ts` with five fixture sequences:
  steady ON_TASK, single SIDEQUEST dip, sustained drift to LOST, recoverable
  SIDEQUEST → ON_TASK, oscillating mid-bucket sequence.
- Verify D1 LCS-only path is unchanged for sessions that never invoke the
  HMM (back-compat with v0.2 tests).
- Boundary: HMM only fires when session has ≥ 3 turns; below that, fall back
  to D1.

## Open questions

- Where to persist per-session HMM state across restarts. v0.3.1 keeps it
  in-memory; v0.3.2 may share the pech file-backed approach.
