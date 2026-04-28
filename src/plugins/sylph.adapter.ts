/* enchanter/src/plugins/sylph.adapter.ts — v0.2 working implementation.
   Cites: architecture-spec phase_1.sylph + plugins/sylph source (README.md §
   "The Decision-Gate Contract" for W5 destructive-op patterns; README.md §
   "The Science Behind Sylph" W2 for Jaccard-Cosine Boundary Segmentation).
   Required: true at trust-gate (W5 fail-closed). Advisory at post-session (W2). */

import type { PluginAdapter } from './plugin-contract.js';
import type { EnchantedEvent, PluginAck } from '../bus/event-types.js';
import type { RequestContext } from '../orchestration/request-context.js';

// ---------------------------------------------------------------------------
// W5 destructive-op pattern table (5+ entries, fail-closed at trust-gate)
// ---------------------------------------------------------------------------

export interface DestructiveOpPattern {
  readonly id: string;
  readonly name: string;
  readonly regex: RegExp;
  /** true = always veto; false = veto only on protected-branch context */
  readonly requires_consent: boolean;
}

export const DESTRUCTIVE_OP_PATTERNS: ReadonlyArray<DestructiveOpPattern> = [
  {
    id: 'w5-force-push',
    name: 'git push --force',
    regex: /git\s+push\b[^|&\n]*--force(?!-with-lease)/,
    requires_consent: true,
  },
  {
    id: 'w5-force-push-with-lease-protected',
    name: 'git push --force-with-lease to protected branch',
    regex: /git\s+push\b[^|&\n]*--force-with-lease/,
    requires_consent: true,
  },
  {
    id: 'w5-reset-hard',
    name: 'git reset --hard',
    regex: /git\s+reset\b[^|&\n]*--hard/,
    requires_consent: true,
  },
  {
    id: 'w5-branch-delete-force',
    name: 'git branch -D (force delete)',
    regex: /git\s+branch\b[^|&\n]*-D\b/,
    requires_consent: true,
  },
  {
    id: 'w5-rm-rf',
    name: 'rm -rf (irrecoverable delete)',
    regex: /\brm\b[^|&\n]*-[a-zA-Z]*r[a-zA-Z]*f\b|\brm\b[^|&\n]*-[a-zA-Z]*f[a-zA-Z]*r\b/,
    requires_consent: true,
  },
  {
    id: 'w5-git-push-bare',
    name: 'git push (plain, potential protected-branch push)',
    regex: /git\s+push\b(?![^|&\n]*--force)(?![^|&\n]*--delete)/,
    requires_consent: false, // advisory-only for plain push; force variants above take priority
  },
] as const;

// ---------------------------------------------------------------------------
// W2 Boundary Segmentation — sliding window + Jaccard similarity
// ---------------------------------------------------------------------------

export interface EditRecord {
  readonly file_path: string;
  readonly ts: number;
}

export interface Cluster {
  readonly id: string;
  readonly files: string[];
  lastEditTs: number;
  closed: boolean;
}

// [author judgment] 5-minute active-edit window for same-cluster grouping.
const CLUSTER_WINDOW_MS = 5 * 60 * 1000;
// [author judgment] 10-minute idle gap before a cluster is considered closed.
const CLUSTER_IDLE_MS = 10 * 60 * 1000;
// [author judgment] Jaccard similarity threshold of 0.4 for co-clustering.
const JACCARD_THRESHOLD = 0.4;

/** Jaccard similarity on the set of filename tokens (split on path separators + dots). */
function jaccardSim(a: string, b: string): number {
  const tokenize = (p: string): Set<string> =>
    new Set(p.split(/[/\\._-]+/).filter((t) => t.length > 0));
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 && tb.size === 0) return 1;
  const intersection = [...ta].filter((t) => tb.has(t)).length;
  const union = new Set([...ta, ...tb]).size;
  return union === 0 ? 0 : intersection / union;
}

let _clusterSeq = 0;
function nextClusterId(): string {
  return `sylph-cluster-${++_clusterSeq}`;
}

/** Module-level mutable state for the W2 boundary segmenter. */
const _clusters: Cluster[] = [];

/**
 * Record a file edit. Assigns the edit to an existing open cluster if the
 * time-delta < CLUSTER_WINDOW_MS and Jaccard sim with any cluster member > JACCARD_THRESHOLD,
 * otherwise opens a new cluster.
 */
export function recordEdit(file_path: string, ts: number = Date.now()): void {
  // Find the best matching open cluster within the time window.
  let bestCluster: Cluster | null = null;
  let bestSim = -1;

  for (const c of _clusters) {
    if (c.closed) continue;
    if (ts - c.lastEditTs > CLUSTER_WINDOW_MS) continue; // [author judgment] 5-min window
    const maxSim = Math.max(...c.files.map((f) => jaccardSim(f, file_path)));
    if (maxSim > JACCARD_THRESHOLD && maxSim > bestSim) {
      bestSim = maxSim;
      bestCluster = c;
    }
  }

  if (bestCluster !== null) {
    if (!bestCluster.files.includes(file_path)) {
      bestCluster.files.push(file_path);
    }
    bestCluster.lastEditTs = ts;
  } else {
    _clusters.push({
      id: nextClusterId(),
      files: [file_path],
      lastEditTs: ts,
      closed: false,
    });
  }
}

/** Returns all open (non-closed) clusters. */
export function getOpenClusters(): ReadonlyArray<Cluster> {
  return _clusters.filter((c) => !c.closed);
}

/** Internal: close clusters idle beyond CLUSTER_IDLE_MS and return them. */
function closeIdleClusters(now: number): Cluster[] {
  const closed: Cluster[] = [];
  for (const c of _clusters) {
    if (!c.closed && now - c.lastEditTs >= CLUSTER_IDLE_MS) { // [author judgment] 10-min idle
      c.closed = true;
      closed.push(c);
    }
  }
  return closed;
}

// ---------------------------------------------------------------------------
// W5 trust-gate guard
// ---------------------------------------------------------------------------

function guardW5TrustGate(event: EnchantedEvent): PluginAck {
  // Mirror hydra's defense: scan both the JSON-stringified payload AND
  // a reconstructed command line `<tool> <args>` so W5 patterns
  // (`git push --force`, `git reset --hard`, `git branch -D`) match even
  // when the MCP tool-call shape splits tool from args.
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const corpora: string[] = [JSON.stringify(payload)];
  const tool = typeof payload['tool'] === 'string' ? (payload['tool'] as string) : '';
  const args = payload['args'];
  const argString = Array.isArray(args) && args.every((a) => typeof a === 'string')
    ? (args as string[]).join(' ')
    : typeof args === 'string'
      ? args
      : '';
  if (tool || argString) {
    corpora.push(`${tool} ${argString}`.trim());
  }

  for (const pattern of DESTRUCTIVE_OP_PATTERNS) {
    // Reset stateful regex before testing.
    pattern.regex.lastIndex = 0;
    const hit = corpora.some((c) => pattern.regex.test(c));
    if (hit) {
      // Plain git push (requires_consent = false) is advisory only.
      if (!pattern.requires_consent) {
        return {
          status: 'ack',
          degraded: true,
          reason: `sylph-w5:${pattern.id} (advisory)`,
        };
      }
      return {
        status: 'veto',
        reason: `sylph-w5:${pattern.id}`,
        derived_events: [
          {
            id: `${event.correlation_id}::sylph-veto`,
            correlation_id: event.correlation_id,
            session_id: event.session_id,
            phase: event.phase,
            topic: 'sylph.destructive.veto',
            source: 'sylph',
            budget_tier: event.budget_tier,
            ts: Date.now(),
            payload: { pattern_id: pattern.id, pattern_name: pattern.name },
          },
        ],
      };
    }
  }

  return { status: 'ack' };
}

// ---------------------------------------------------------------------------
// W2 post-session boundary handler
// ---------------------------------------------------------------------------

function handleW2PostSession(event: EnchantedEvent): PluginAck {
  const now = event.ts ?? Date.now();
  const closedClusters = closeIdleClusters(now);

  if (closedClusters.length === 0) {
    return { status: 'ack' };
  }

  const derivedEvents: EnchantedEvent[] = closedClusters.map((c) => ({
    id: `${event.correlation_id}::sylph-boundary-${c.id}`,
    correlation_id: event.correlation_id,
    session_id: event.session_id,
    phase: event.phase,
    topic: 'sylph.boundary.closed',
    source: 'sylph',
    budget_tier: event.budget_tier,
    ts: now,
    payload: { cluster_id: c.id, files: c.files, closed_at: now },
  }));

  return {
    status: 'ack',
    reason: `sylph-w2: closed ${closedClusters.length} cluster(s)`,
    derived_events: derivedEvents,
  };
}

// ---------------------------------------------------------------------------
// PluginAdapter export
// ---------------------------------------------------------------------------

export const sylphAdapter: PluginAdapter = {
  name: 'sylph',
  phases: ['trust-gate', 'post-session'],
  required: true, // fail-closed on W5 destructive-op veto at trust-gate
  topics: {
    subscribes: ['filesystem.write.completed', 'mcp.tool.call.requested', 'lifecycle.trust-gate', 'lifecycle.post-session'],
    emits: ['sylph.boundary.closed', 'sylph.commit.drafted', 'sylph.destructive.veto'],
  },
  budget_tier: 'always',

  async onPhase(event: EnchantedEvent, _ctx: RequestContext): Promise<PluginAck> {
    if (event.phase === 'trust-gate') {
      return guardW5TrustGate(event);
    }
    if (event.phase === 'post-session') {
      return handleW2PostSession(event);
    }
    return { status: 'ack' };
  },
};
