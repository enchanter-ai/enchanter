/* enchanter/src/plugins/djinn/hmm.ts — D2 HMM drift labelling (v0.3.1).
   Implements the design in docs/v0.3/djinn-d2-hmm.md: a 3-state HMM over
   per-turn LCS observations with discrete emission buckets (high/mid/low).

   Inference uses the forward algorithm: posterior = P(state_t | obs_{1..t}).
   The forward variant (rather than Viterbi) gives a normalised distribution
   over states per turn, which the adapter forwards as the probabilistic
   drift signal. Most-likely state is the argmax of the posterior.

   [author judgment] Forward recursion picked over Viterbi for v0.3.1: the
   adapter only needs the latest-turn label + a confidence number, not the
   global best-path reconstruction. Posteriors are also easier to threshold
   and forward as event payload than max-product log-probs. */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HmmState = 'ON_TASK' | 'SIDEQUEST' | 'LOST';
export const STATES: readonly HmmState[] = ['ON_TASK', 'SIDEQUEST', 'LOST'];

export type Observation = 'high' | 'mid' | 'low';

/** Row-stochastic 3x3 transition matrix indexed by STATES. */
export type TransitionMatrix = readonly [
  readonly [number, number, number], // from ON_TASK -> [ON_TASK, SIDEQUEST, LOST]
  readonly [number, number, number], // from SIDEQUEST -> ...
  readonly [number, number, number], // from LOST -> ...
];

/** Per-state emission distribution over the three observation buckets. */
export interface EmissionTable {
  readonly ON_TASK: { readonly high: number; readonly mid: number; readonly low: number };
  readonly SIDEQUEST: { readonly high: number; readonly mid: number; readonly low: number };
  readonly LOST: { readonly high: number; readonly mid: number; readonly low: number };
}

export interface HmmConfig {
  readonly transitions: TransitionMatrix;
  readonly emissions: EmissionTable;
  readonly prior: readonly [number, number, number];
  /** observation bucket cutoffs — `>= highCutoff` is `high`, `>= midCutoff` is `mid`, else `low` */
  readonly highCutoff: number;
  readonly midCutoff: number;
}

export interface HmmStep {
  readonly state: HmmState;
  readonly posterior: { readonly ON_TASK: number; readonly SIDEQUEST: number; readonly LOST: number };
  readonly observation: Observation;
}

/**
 * State-shape schema version for the persisted HMM snapshot. Bump this any
 * time the *shape* of the dynamic state changes — i.e. the state set
 * (`STATES`), observation buckets, or `posterior` length — so that older
 * stored snapshots hard-reset rather than silently rehydrate against a
 * mismatched current model. (v0.5 #2)
 *
 * Forward-compat protocol — when bumping:
 *   1. Increment `HMM_STATE_VERSION` to N+1.
 *   2. Update `DEFAULT_TRANSITIONS` / `DEFAULT_EMISSIONS` / `STATES` etc. to
 *      the new shape.
 *   3. Existing on-disk JSONL records with `version <= N` will be detected by
 *      the load path and trigger a fresh build (with a warning).
 *   4. Document the change in `docs/v0.5/djinn-versioning.md` (or the
 *      release-specific note) including the wire-format delta.
 *
 * Snapshots WITHOUT a `version` field (pre-v0.5 records) are treated as
 * version `0` and trigger a hard reset on load — they predate this protocol.
 */
export const HMM_STATE_VERSION = 1 as const;

/**
 * Serializable snapshot of an `IntentHmm`'s forward state. The transition
 * matrix and emission table are NOT serialised — those live in code as
 * `HmmConfig` and may be tuned across releases. Persisting only the dynamic
 * state lets us re-hydrate against the *current* config without committing
 * yesterday's transition probabilities to disk.
 *
 * [author judgment] If a future release retunes `DEFAULT_TRANSITIONS` /
 * `DEFAULT_EMISSIONS` *without changing the state shape*, a hydrated session
 * continues with the new matrix from the next observation onward. The
 * posterior at restoration is treated as a (possibly slightly stale) prior —
 * drift dynamics correct themselves within a few turns. This is preferable
 * to versioning the matrix on disk and refusing to hydrate on every nudge.
 *
 * Shape changes (state-set growth, posterior-length change, observation
 * bucket re-cut) are different — those bump `HMM_STATE_VERSION` and force a
 * hard reset at load time. See the constant's docblock for the protocol.
 */
export interface HmmStateSnapshot {
  /**
   * State-shape schema version. Must equal `HMM_STATE_VERSION` on load, else
   * the snapshot is rejected and a fresh HMM is built.
   */
  readonly version: number;
  /** Forward probabilities, length 3, ordered by `STATES`. */
  readonly posterior: readonly [number, number, number];
  /** True once at least one observation has folded in. */
  readonly initialized: boolean;
}

// ---------------------------------------------------------------------------
// Defaults — seeded from plugins/djinn/shared/scripts/engines/c2_hmm.py
// (the same source D1's threshold mirrors).
//
// [author judgment] ON_TASK is sticky (0.85 self-loop). SIDEQUEST has high
// return-to-ON_TASK (0.50) — recoverable side-quests. LOST is near-absorbing
// at 0.80 self-loop with a small recovery channel back to SIDEQUEST.
// Emissions reflect bucket boundaries: ON_TASK skews `high`, SIDEQUEST skews
// `mid`, LOST skews `low`. Prior strongly favours ON_TASK at session start.
// ---------------------------------------------------------------------------

export const DEFAULT_TRANSITIONS: TransitionMatrix = [
  [0.85, 0.149, 0.001], // from ON_TASK — SIDEQUEST is the gateway; direct -> LOST is near-zero
  [0.40, 0.55, 0.05], // from SIDEQUEST — LOST requires sustained drift, not one dip
  [0.05, 0.15, 0.80], // from LOST
];

export const DEFAULT_EMISSIONS: EmissionTable = {
  ON_TASK: { high: 0.75, mid: 0.20, low: 0.05 },
  SIDEQUEST: { high: 0.15, mid: 0.45, low: 0.40 },
  LOST: { high: 0.02, mid: 0.18, low: 0.80 },
};

export const DEFAULT_PRIOR: readonly [number, number, number] = [0.90, 0.08, 0.02];

export const DEFAULT_HIGH_CUTOFF = 0.6;
export const DEFAULT_MID_CUTOFF = 0.3;

export const DEFAULT_CONFIG: HmmConfig = {
  transitions: DEFAULT_TRANSITIONS,
  emissions: DEFAULT_EMISSIONS,
  prior: DEFAULT_PRIOR,
  highCutoff: DEFAULT_HIGH_CUTOFF,
  midCutoff: DEFAULT_MID_CUTOFF,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bucketize(similarity: number, cfg: HmmConfig): Observation {
  if (similarity >= cfg.highCutoff) return 'high';
  if (similarity >= cfg.midCutoff) return 'mid';
  return 'low';
}

function emissionProb(state: HmmState, obs: Observation, cfg: HmmConfig): number {
  return cfg.emissions[state][obs];
}

function argmaxState(p: readonly [number, number, number]): HmmState {
  let best = 0;
  let bestVal = p[0]!;
  for (let i = 1; i < 3; i++) {
    if (p[i]! > bestVal) {
      bestVal = p[i]!;
      best = i;
    }
  }
  return STATES[best]!;
}

// ---------------------------------------------------------------------------
// IntentHmm — incremental forward recursion
// ---------------------------------------------------------------------------

export class IntentHmm {
  private readonly cfg: HmmConfig;
  /** forward probabilities for each state, normalised so they sum to 1 */
  private alpha: [number, number, number];
  /** true once the first observation has folded in; before that, alpha = prior */
  private initialized: boolean;

  constructor(cfg: HmmConfig = DEFAULT_CONFIG) {
    this.cfg = cfg;
    this.alpha = [cfg.prior[0], cfg.prior[1], cfg.prior[2]];
    this.initialized = false;
  }

  /** Reset to the prior — equivalent to a fresh session. */
  reset(): void {
    this.alpha = [this.cfg.prior[0], this.cfg.prior[1], this.cfg.prior[2]];
    this.initialized = false;
  }

  /** Current posterior without folding a new observation in. */
  current(): HmmStep {
    const post = this.alpha;
    return {
      state: argmaxState(post),
      posterior: { ON_TASK: post[0], SIDEQUEST: post[1], LOST: post[2] },
      // No observation has been seen — report `high` as a neutral placeholder.
      observation: 'high',
    };
  }

  /**
   * Fold a new similarity observation in and return the updated posterior +
   * most-likely state.
   */
  update(similarity: number): HmmStep {
    const obs = bucketize(similarity, this.cfg);

    // Predict step: alpha_t = alpha_{t-1} * A (or alpha = prior on first call).
    let predicted: [number, number, number];
    if (!this.initialized) {
      predicted = [this.cfg.prior[0], this.cfg.prior[1], this.cfg.prior[2]];
      this.initialized = true;
    } else {
      predicted = [0, 0, 0];
      for (let j = 0; j < 3; j++) {
        let sum = 0;
        for (let i = 0; i < 3; i++) {
          sum += this.alpha[i]! * this.cfg.transitions[i]![j]!;
        }
        predicted[j] = sum;
      }
    }

    // Update step: multiply by emission likelihood, then normalise.
    const updated: [number, number, number] = [0, 0, 0];
    let total = 0;
    for (let j = 0; j < 3; j++) {
      const e = emissionProb(STATES[j]!, obs, this.cfg);
      updated[j] = predicted[j]! * e;
      total += updated[j]!;
    }

    if (total > 0) {
      updated[0] /= total;
      updated[1] /= total;
      updated[2] /= total;
    } else {
      // Pathological zero — fall back to prior so we never emit NaN.
      updated[0] = this.cfg.prior[0];
      updated[1] = this.cfg.prior[1];
      updated[2] = this.cfg.prior[2];
    }

    this.alpha = updated;

    return {
      state: argmaxState(updated),
      posterior: { ON_TASK: updated[0], SIDEQUEST: updated[1], LOST: updated[2] },
      observation: obs,
    };
  }

  /**
   * Capture the current forward state as a plain JSON-serialisable object.
   * The config (transitions, emissions, prior, cutoffs) is intentionally
   * excluded — see `HmmStateSnapshot` for the rationale.
   */
  serialize(): HmmStateSnapshot {
    return {
      version: HMM_STATE_VERSION,
      posterior: [this.alpha[0], this.alpha[1], this.alpha[2]],
      initialized: this.initialized,
    };
  }

  /**
   * Re-hydrate an HMM from a snapshot, optionally overriding the config.
   * The snapshot's posterior becomes the new starting `alpha`; subsequent
   * `update()` calls apply the *current* transition matrix on top of it.
   *
   * Returns `null` when the snapshot is shape-incompatible with the current
   * model — version mismatch (including pre-v0.5 snapshots that lack a
   * `version` field, treated as v0) or `posterior.length` mismatch with the
   * current state count. Callers must treat null as a cache miss and build
   * a fresh HMM.
   */
  static fromSnapshot(
    snap: HmmStateSnapshot,
    cfg: HmmConfig = DEFAULT_CONFIG,
  ): IntentHmm | null {
    // A pre-v0.5 snapshot that pre-dates this field reads as `undefined`;
    // coerce to 0 so the equality check below uniformly rejects it.
    const snapVersion = typeof snap.version === 'number' ? snap.version : 0;
    if (snapVersion !== HMM_STATE_VERSION) return null;
    if (!Array.isArray(snap.posterior) || snap.posterior.length !== STATES.length) {
      return null;
    }
    const hmm = new IntentHmm(cfg);
    hmm.alpha = [snap.posterior[0]!, snap.posterior[1]!, snap.posterior[2]!];
    hmm.initialized = snap.initialized;
    return hmm;
  }
}
