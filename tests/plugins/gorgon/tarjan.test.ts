/* tests/plugins/gorgon/tarjan.test.ts — G1 Tarjan SCC unit tests (v0.3.1).
   Verifies the iterative implementation in src/plugins/gorgon/tarjan.ts. */

import { describe, it, expect } from 'vitest';
import { tarjanScc, type NodeId } from '../../../src/plugins/gorgon/tarjan.js';

function sortComponents(scc: NodeId[][]): NodeId[][] {
  // Normalize: sort each component, then sort components by their first
  // member, so test assertions don't depend on traversal order.
  return scc
    .map((c) => [...c].sort())
    .sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0));
}

describe('tarjanScc — basic shapes', () => {
  it('detects a simple 2-cycle (A → B → A) as one SCC', () => {
    const graph = new Map<string, string[]>([
      ['A', ['B']],
      ['B', ['A']],
    ]);
    const scc = sortComponents(tarjanScc(graph));
    expect(scc).toEqual([['A', 'B']]);
  });

  it('returns N singletons for a DAG with no cycles', () => {
    const graph = new Map<string, string[]>([
      ['A', ['B', 'C']],
      ['B', ['D']],
      ['C', ['D']],
      ['D', []],
    ]);
    const scc = sortComponents(tarjanScc(graph));
    expect(scc).toEqual([['A'], ['B'], ['C'], ['D']]);
  });

  it('returns one component per node for a fully disconnected graph', () => {
    const graph = new Map<string, string[]>([
      ['x', []],
      ['y', []],
      ['z', []],
    ]);
    expect(tarjanScc(graph)).toHaveLength(3);
  });
});

describe('tarjanScc — nested + entry cycles', () => {
  it('groups a nested cycle reached via an entry node correctly', () => {
    // entry → A; A → B → C → A; D dangles off C.
    const graph = new Map<string, string[]>([
      ['entry', ['A']],
      ['A', ['B']],
      ['B', ['C']],
      ['C', ['A', 'D']],
      ['D', []],
    ]);
    const scc = sortComponents(tarjanScc(graph));
    expect(scc).toEqual([['A', 'B', 'C'], ['D'], ['entry']]);
  });

  it('handles two disjoint cycles in the same graph', () => {
    const graph = new Map<string, string[]>([
      ['A', ['B']],
      ['B', ['A']],
      ['X', ['Y']],
      ['Y', ['Z']],
      ['Z', ['X']],
    ]);
    const scc = sortComponents(tarjanScc(graph));
    expect(scc).toEqual([['A', 'B'], ['X', 'Y', 'Z']]);
  });

  it('treats nodes only referenced as targets as singletons', () => {
    // 'leaf' never appears as a key, only as an out-edge target.
    const graph = new Map<string, string[]>([['root', ['leaf']]]);
    const scc = sortComponents(tarjanScc(graph));
    expect(scc).toEqual([['leaf'], ['root']]);
  });

  it('returns an empty array for an empty graph', () => {
    expect(tarjanScc(new Map())).toEqual([]);
  });
});

describe('tarjanScc — deep graph (iterative correctness)', () => {
  it('handles a 5000-node chain without stack overflow', () => {
    // The recursive Tarjan would blow the JS stack here on most engines;
    // the iterative variant must succeed.
    const graph = new Map<string, string[]>();
    for (let i = 0; i < 5000; i++) {
      graph.set(`n${i}`, i + 1 < 5000 ? [`n${i + 1}`] : []);
    }
    const scc = tarjanScc(graph);
    expect(scc).toHaveLength(5000);
    // Every component is a singleton.
    for (const c of scc) expect(c.length).toBe(1);
  });
});
