# Gorgon G1 — Tarjan SCC + Python AST Edge Extraction

**Status:** v0.3.1 design.
**Owner:** `src/plugins/gorgon.adapter.ts` (entry),
`src/plugins/gorgon/scc.ts` (new), `src/plugins/gorgon/python-ast.ts` (new).

## Problem statement

Gorgon v0.2 ships G3 (PageRank over a language-agnostic import graph) and
emits hotspot snapshots + change events. Two gaps remain:

1. **No cycle detection.** PageRank rewards mutually-importing nodes equally
   — a circular import (A → B → A) is invisible to hotspot ranking but is
   the single highest-impact refactor target. G1 Tarjan SCC surfaces these.
2. **Caller-supplied graphs only.** `setGraph()` receives a pre-built
   `Map<file, file[]>`. There is no enchanter-side extractor for any
   language; downstream tools like the inspector rely on host wiring. A
   Python AST extractor is the highest-leverage first language because the
   `gorgon` source plugin (`plugins/gorgon/shared/scripts/engines/g1_tarjan.py`)
   targets Python as the reference workload.

## Algorithm sketch

### G1 Tarjan (`scc.ts`)

Iterative Tarjan over the same `ImportGraph` already in module state. ~80
LOC. Outputs an array of SCCs, each with member files. Emits
`gorgon.cycle.detected` for every SCC of size > 1 with payload
`{members: string[], size: number}`. Wired in at the cross-session phase
*after* `computePageRank` so a single graph traversal feeds both engines
(rebuild the graph view in O(V+E) once, share it).

### Python AST extractor (`python-ast.ts`)

Pure regex/lexer walk over `.py` files — not a full AST. Targets:

- `^\s*import (\w+(?:\.\w+)*)`
- `^\s*from (\w+(?:\.\w+)*) import`

Resolves dotted module names against the project's `pyproject.toml` /
`setup.cfg` package roots if discoverable, else file-relative. Returns
`Map<file, file[]>` ready to feed `setGraph()`. Stdlib-only, no new deps;
the regex approach mirrors what the Python `g3_pagerank.py` reference does
in cross-checking.

## Dependencies

Stdlib only: `node:fs`, `node:path`. No new top-level deps. The Python AST
extractor explicitly does NOT shell out to a Python interpreter — that
would couple enchanter's runtime to the host having Python installed.

## Test strategy

- Unit: `tests/plugins/gorgon/scc.test.ts` with five fixtures: empty graph,
  acyclic, single 2-cycle, nested SCCs, large SCC (10+ nodes).
- Unit: `tests/plugins/gorgon/python-ast.test.ts` with fixture Python files
  covering plain imports, from-imports, relative imports, multi-line imports,
  and `__init__.py` package resolution.
- Integration: combine — feed a Python project fixture through the AST
  extractor, run the cross-session phase, assert both `gorgon.snapshot.ready`
  and `gorgon.cycle.detected` events fire correctly.

## Open questions

- Other languages: TypeScript and Go are obvious next targets. Defer to
  v0.3.2 — Python ships first because it has the reference engine in the
  source plugin, so ground truth exists.
