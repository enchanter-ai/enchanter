/* enchanter/src/plugins/gorgon.adapter.ts — implements architecture-spec
   phase_1.gorgon (cross-session snapshot + post-response refresh).
   Source refs: plugins/gorgon source (G3 PageRank, G1 Tarjan deferred to v0.3).
   v0.2: language-agnostic import-graph PageRank only.
   Tarjan SCC (G1) is deferred to v0.3 per the spec boundary. [author judgment]
   Advisory — fail-open.

   TODO(v0.3.1): G1 Tarjan SCC + Python AST extraction —
   see docs/v0.3/gorgon-tarjan-python-ast.md. Tarjan lands as a sibling
   src/plugins/gorgon/scc.ts called from handleCrossSession after
   computePageRank; cycles emit a new gorgon.cycle.detected derived event.
   Python-AST edge extraction lands as src/plugins/gorgon/python-ast.ts —
   a stdlib regex/AST walker (no new deps) feeding setGraph(). */

import type { PluginAdapter } from './plugin-contract.js';
import type { EnchantedEvent, PluginAck } from '../bus/event-types.js';
import type { RequestContext } from '../orchestration/request-context.js';
import { tarjanScc } from './gorgon/tarjan.js';
import {
  extractPythonImports,
  extractPythonDefs,
  type PythonDef,
} from './gorgon/python-extractor.js';

export { tarjanScc } from './gorgon/tarjan.js';
export {
  extractPythonImports,
  extractPythonDefs,
  type PythonDef,
} from './gorgon/python-extractor.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** file → list of files it imports (any language; caller supplies edges). */
export type ImportGraph = Map<string, string[]>;

interface RankedNode {
  file: string;
  score: number;
  rank: number; // 1-based, ascending score order (rank 1 = highest)
}

interface HotspotState {
  rankedNodes: RankedNode[];
  /** snapshot taken at the previous cross-session tick, for delta comparison */
  previousRanks: Map<string, number>;
}

// ---------------------------------------------------------------------------
// PageRank — pure TS, no external graph lib [author judgment: d=0.85, standard]
// ---------------------------------------------------------------------------

/**
 * computePageRank — power-iteration PageRank (Brin & Page 1998).
 *
 * [author judgment] Damping d=0.85 is the canonical value from the original
 * paper and matches the G3 reference in plugins/gorgon/README.md. The value
 * is exposed via GorgonConfig so callers can override it during tests.
 *
 * [author judgment] language-agnostic: the graph is `Map<file, file[]>`;
 * Python-AST-specific edge extraction (gorgon-gaze) is deferred to v0.3.
 */
export function computePageRank(
  graph: ImportGraph,
  options: { dampingFactor?: number; maxIterations?: number; tolerance?: number } = {},
): Map<string, number> {
  const d = options.dampingFactor ?? 0.85; // [author judgment] canonical default
  const maxIter = options.maxIterations ?? 50;
  const tol = options.tolerance ?? 1e-6;

  const nodes = Array.from(graph.keys());
  const N = nodes.length;

  if (N === 0) return new Map();

  // Ensure every node mentioned as a dependency also exists in the map.
  for (const [, imports] of graph) {
    for (const dep of imports) {
      if (!graph.has(dep)) {
        nodes.push(dep);
        graph.set(dep, []);
      }
    }
  }

  const allNodes = Array.from(graph.keys());
  const n = allNodes.length;
  const idx = new Map(allNodes.map((f, i) => [f, i]));

  // Build reverse adjacency: inLinks[j] = files that import j.
  const inLinks: number[][] = Array.from({ length: n }, () => []);
  // outDegree[i] = how many files node i imports.
  const outDegree: number[] = new Array(n).fill(0);

  for (const [file, imports] of graph) {
    const i = idx.get(file)!;
    outDegree[i] = imports.length;
    for (const dep of imports) {
      const j = idx.get(dep);
      if (j !== undefined) inLinks[j]!.push(i);
    }
  }

  // Initialise scores uniformly.
  let scores = new Float64Array(n).fill(1 / n);
  let next = new Float64Array(n);

  for (let iter = 0; iter < maxIter; iter++) {
    // Dangling-node mass: nodes with out-degree 0 distribute evenly.
    let danglingMass = 0;
    for (let i = 0; i < n; i++) {
      if (outDegree[i]! === 0) danglingMass += scores[i]!;
    }

    let delta = 0;
    for (let j = 0; j < n; j++) {
      let inSum = 0;
      for (const i of inLinks[j]!) {
        inSum += scores[i]! / outDegree[i]!;
      }
      // Teleportation + damped rank + dangling redistribution.
      next[j] = (1 - d) / n + d * (inSum + danglingMass / n);
      delta += Math.abs(next[j]! - scores[j]!);
    }

    // Swap buffers.
    [scores, next] = [next, scores];

    if (delta < tol) break;
  }

  const result = new Map<string, number>();
  for (const [file, i] of idx) {
    result.set(file, scores[i]!);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Internal state (module-level; advisory plugin resets on setGraph)
// ---------------------------------------------------------------------------

interface GorgonState {
  graph: ImportGraph | null;
  dirtyPaths: Set<string>;
  hotspot: HotspotState | null;
}

const STATE: GorgonState = {
  graph: null,
  dirtyPaths: new Set(),
  hotspot: null,
};

// ---------------------------------------------------------------------------
// Public config surface
// ---------------------------------------------------------------------------

export interface GorgonConfig {
  /** [author judgment] Top-N hotspots emitted in snapshot.ready event. Default: 10. */
  topN?: number;
  dampingFactor?: number;
  maxIterations?: number;
  tolerance?: number;
}

const CONFIG: Required<GorgonConfig> = {
  topN: 10,           // [author judgment] ten hotspots; enough signal, not noise
  dampingFactor: 0.85,
  maxIterations: 50,
  tolerance: 1e-6,
};

export function configureGorgon(cfg: GorgonConfig): void {
  if (cfg.topN !== undefined) CONFIG.topN = cfg.topN;
  if (cfg.dampingFactor !== undefined) CONFIG.dampingFactor = cfg.dampingFactor;
  if (cfg.maxIterations !== undefined) CONFIG.maxIterations = cfg.maxIterations;
  if (cfg.tolerance !== undefined) CONFIG.tolerance = cfg.tolerance;
}

/** Supply the import graph before the cross-session phase runs. */
export function setGraph(graph: ImportGraph): void {
  STATE.graph = graph;
  STATE.dirtyPaths.clear();
}

/** Retrieve current PageRank scores (computed on demand if graph is set). */
export function getCurrentScores(): Map<string, number> | null {
  if (!STATE.graph) return null;
  return computePageRank(STATE.graph, CONFIG);
}

/**
 * setSourceMap — build (or augment) the import graph from a {file → source}
 * map. `.py` files route through the Python extractor; other extensions
 * are passed through unchanged (the caller is expected to supply edges for
 * those out-of-band via setGraph or to extend this surface in v0.3.2).
 *
 * [author judgment] This is a thin adapter-level convenience, not a build
 * system. It does NOT resolve dotted module names to filesystem paths —
 * the import target string is recorded verbatim. Resolution against
 * pyproject.toml package roots is deferred per the design doc.
 */
export function setSourceMap(sources: Map<string, string>): void {
  const graph: ImportGraph = new Map();
  for (const [file, source] of sources) {
    if (file.endsWith('.py')) {
      graph.set(file, extractPythonImports(source));
    } else {
      // No in-adapter extractor for other languages yet (v0.3.2). Record
      // the file as a node with no out-edges so it still appears in the
      // graph; callers can layer edges via setGraph.
      graph.set(file, []);
    }
  }
  setGraph(graph);
}

// ---------------------------------------------------------------------------
// Phase handlers
// ---------------------------------------------------------------------------

function handleCrossSession(event: EnchantedEvent, _ctx: RequestContext): PluginAck {
  if (!STATE.graph) {
    return { status: 'ack', degraded: true, reason: 'gorgon: no graph set; snapshot skipped' };
  }

  const scores = computePageRank(STATE.graph, CONFIG);

  // G1 Tarjan SCC: detect cycles in the same graph PageRank just walked.
  // [author judgment] Only emit SCCs of size > 1 — every node is trivially
  // its own SCC, so size-1 components are noise for the cycle-detection use case.
  const allScc = tarjanScc(STATE.graph);
  const cycles: string[][] = allScc.filter((c) => c.length > 1);

  // Build ranked list descending by score.
  const sorted: RankedNode[] = Array.from(scores.entries())
    .sort(([, a], [, b]) => b - a)
    .map(([file, score], i) => ({ file, score, rank: i + 1 }));

  // Detect hotspot.changed: did any dirty path shift rank by >= 3?
  let hotspotChanged = false;
  const changedFiles: string[] = [];

  if (STATE.hotspot && STATE.dirtyPaths.size > 0) {
    for (const path of STATE.dirtyPaths) {
      const prev = STATE.hotspot.previousRanks.get(path);
      const curr = sorted.find((n) => n.file === path)?.rank;
      if (prev !== undefined && curr !== undefined && Math.abs(curr - prev) >= 3) {
        hotspotChanged = true;
        changedFiles.push(path);
      }
    }
  }

  const previousRanks = new Map(sorted.map((n) => [n.file, n.rank]));

  STATE.hotspot = { rankedNodes: sorted, previousRanks };
  STATE.dirtyPaths.clear();

  const topN = sorted.slice(0, CONFIG.topN);

  const derived: EnchantedEvent[] = [];

  derived.push({
    id: `${event.correlation_id}::gorgon-snapshot`,
    correlation_id: event.correlation_id,
    session_id: event.session_id,
    phase: event.phase,
    topic: 'gorgon.snapshot.ready',
    source: 'gorgon',
    budget_tier: event.budget_tier,
    ts: Date.now(),
    payload: {
      file_count: scores.size,
      top_hotspots: topN.map((n) => ({ file: n.file, score: n.score, rank: n.rank })),
      cycles,
    },
  });

  if (hotspotChanged) {
    derived.push({
      id: `${event.correlation_id}::gorgon-hotspot-changed`,
      correlation_id: event.correlation_id,
      session_id: event.session_id,
      phase: event.phase,
      topic: 'gorgon.hotspot.changed',
      source: 'gorgon',
      budget_tier: event.budget_tier,
      ts: Date.now(),
      payload: { changed_files: changedFiles },
    });
  }

  return { status: 'ack', derived_events: derived };
}

function handlePostResponse(event: EnchantedEvent, _ctx: RequestContext): PluginAck {
  const writePath = (event.payload as { write_path?: unknown }).write_path;
  if (typeof writePath !== 'string') {
    return { status: 'ack' };
  }
  if (STATE.graph?.has(writePath)) {
    STATE.dirtyPaths.add(writePath);
  }
  return { status: 'ack' };
}

// ---------------------------------------------------------------------------
// Adapter export
// ---------------------------------------------------------------------------

export const gorgonAdapter: PluginAdapter = {
  name: 'gorgon',
  phases: ['cross-session', 'post-response'],
  required: false, // advisory — fail-open
  topics: {
    subscribes: ['session.start', 'filesystem.write.completed'],
    emits: ['gorgon.snapshot.ready', 'gorgon.hotspot.changed'],
  },
  budget_tier: 'high-only',

  async onPhase(event: EnchantedEvent, ctx: RequestContext): Promise<PluginAck> {
    try {
      if (event.phase === 'cross-session') return handleCrossSession(event, ctx);
      if (event.phase === 'post-response') return handlePostResponse(event, ctx);
      return { status: 'ack' };
    } catch (err) {
      // Fail-open: structural intelligence is advisory; never block the pipeline.
      return {
        status: 'ack',
        degraded: true,
        reason: `gorgon: unexpected error — ${String(err)}`,
      };
    }
  },
};
