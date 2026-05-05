/* enchanter/src/plugins/gorgon/tarjan.ts — implements G1 Tarjan SCC for the
   gorgon adapter (v0.3.1, see docs/v0.3/gorgon-tarjan-python-ast.md).

   Iterative Tarjan to handle deep graphs without blowing the JS call stack.
   Returns SCCs in reverse topological order (leaves first), matching the
   classic Tarjan output order — callers that want topological order should
   reverse the result. */

export type NodeId = string;

interface Frame {
  v: NodeId;
  /** index into the successor list of v we have processed so far */
  i: number;
  successors: NodeId[];
}

/**
 * Tarjan's strongly-connected-components algorithm, iterative variant.
 *
 * Input is the same Map<file, file[]> shape as ImportGraph: a key maps to
 * the files it imports (out-edges). Nodes referenced as targets but absent
 * as keys are treated as terminal singletons.
 *
 * Output: array of SCCs. Tarjan emits SCCs in reverse topological order
 * (a node's SCC is emitted before its dependencies' SCCs in the source
 * order, but after them in the import direction). For the gorgon use case
 * we only care about cycle membership, so order is informational.
 */
export function tarjanScc(graph: Map<NodeId, NodeId[]>): NodeId[][] {
  // Collect every node — including ones only referenced as edge targets.
  const nodes = new Set<NodeId>();
  for (const [k, outs] of graph) {
    nodes.add(k);
    for (const o of outs) nodes.add(o);
  }

  const index = new Map<NodeId, number>();
  const lowlink = new Map<NodeId, number>();
  const onStack = new Set<NodeId>();
  const stack: NodeId[] = [];
  const result: NodeId[][] = [];
  let nextIndex = 0;

  const successorsOf = (v: NodeId): NodeId[] => graph.get(v) ?? [];

  for (const start of nodes) {
    if (index.has(start)) continue;

    // Iterative DFS replacing the textbook recursive call.
    const work: Frame[] = [{ v: start, i: 0, successors: successorsOf(start) }];
    index.set(start, nextIndex);
    lowlink.set(start, nextIndex);
    nextIndex++;
    stack.push(start);
    onStack.add(start);

    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      if (frame.i < frame.successors.length) {
        const w = frame.successors[frame.i]!;
        frame.i++;
        if (!index.has(w)) {
          index.set(w, nextIndex);
          lowlink.set(w, nextIndex);
          nextIndex++;
          stack.push(w);
          onStack.add(w);
          work.push({ v: w, i: 0, successors: successorsOf(w) });
        } else if (onStack.has(w)) {
          // back-edge to a node currently on the stack — tighten lowlink.
          lowlink.set(frame.v, Math.min(lowlink.get(frame.v)!, index.get(w)!));
        }
      } else {
        // Finished v's successors. Propagate lowlink upward and, if v is a
        // root of an SCC, pop the component.
        const v = frame.v;
        if (lowlink.get(v) === index.get(v)) {
          const component: NodeId[] = [];
          for (;;) {
            const w = stack.pop()!;
            onStack.delete(w);
            component.push(w);
            if (w === v) break;
          }
          result.push(component);
        }
        work.pop();
        if (work.length > 0) {
          const parent = work[work.length - 1]!;
          lowlink.set(
            parent.v,
            Math.min(lowlink.get(parent.v)!, lowlink.get(v)!),
          );
        }
      }
    }
  }

  return result;
}
