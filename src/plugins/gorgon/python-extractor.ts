/* enchanter/src/plugins/gorgon/python-extractor.ts — Python regex-AST
   extractor for the gorgon adapter (v0.3.1, see
   docs/v0.3/gorgon-tarjan-python-ast.md).

   Stdlib-only regex walk over .py source. NOT a real Python parser — we
   target the import / def / class lines that matter for the import graph
   and hotspot ranking, and accept that pathological cases (e.g. imports
   stuffed inside a string literal, exec()'d code) are out of scope. */

export interface PythonDef {
  name: string;
  /** 1-based line number of the def/class header */
  line: number;
  kind: 'def' | 'class';
}

/**
 * Optional resolver: maps a dotted Python module name to a filesystem path
 * (relative to the project root). When supplied, extractPythonImports
 * substitutes resolver hits for the verbatim module name in its output —
 * giving downstream graph consumers actual file targets instead of import
 * strings. See `pyproject-resolver.ts` for the production implementation.
 *
 * Returning `null` means "not in this project" — the verbatim module name
 * is preserved so callers can still distinguish (e.g.) third-party imports.
 */
export type PythonModuleResolver = (moduleName: string) => string | null;

export interface ExtractPythonImportsOptions {
  /** When provided, resolved module → file paths replace verbatim modules. */
  resolver?: PythonModuleResolver;
}

/**
 * extractPythonImports — returns the imported module names from a Python
 * source string.
 *
 * Matches:
 *   import foo
 *   import foo.bar
 *   import foo as f                  → "foo"
 *   import foo, bar                  → ["foo", "bar"]
 *   from foo import bar              → "foo"
 *   from foo.bar import baz          → "foo.bar"
 *   from . import sib                → "."
 *   from .pkg import x               → ".pkg"
 *
 * Multi-line tolerant in two senses:
 *   1. Each line is matched independently — preceding whitespace allowed.
 *   2. Continuation lines via parenthesised `from foo import (a, b, c)` are
 *      tolerated because we only capture the module name, not the bound
 *      names. The parens span doesn't affect the module-name match.
 *
 * Comments-only and string-only lines are ignored by the line-anchored
 * regex (a `#` before `import` makes the line not start with import).
 *
 * If `options.resolver` is supplied, each module name is passed through it.
 * A non-null return replaces the module name with that path (typical: a
 * project-relative `.py` filename); a null return preserves the verbatim
 * module name (typical: stdlib / third-party). Resolver-less callers behave
 * exactly as before this option existed — backwards compatible.
 */
export function extractPythonImports(
  source: string,
  options?: ExtractPythonImportsOptions,
): string[] {
  const out: string[] = [];

  // Strip leading whitespace, then either a `from X import …` or `import X[, Y]…`
  const fromRe = /^\s*from\s+(\.+\w*(?:\.\w+)*|\.+|\w+(?:\.\w+)*)\s+import\b/gm;
  const importRe = /^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/gm;

  for (const m of source.matchAll(fromRe)) {
    if (m[1]) out.push(m[1]);
  }

  for (const m of source.matchAll(importRe)) {
    const list = m[1];
    if (!list) continue;
    for (const part of list.split(',')) {
      const name = part.trim().split(/\s+/)[0]; // drop trailing `as alias`
      if (name) out.push(name);
    }
  }

  const resolver = options?.resolver;
  if (!resolver) return out;

  return out.map((name) => {
    try {
      const resolved = resolver(name);
      return resolved ?? name;
    } catch {
      // Resolver throws → treat as miss; never break extraction. Gorgon is
      // advisory and must fail-open per the adapter contract.
      return name;
    }
  });
}

/**
 * extractPythonDefs — returns top-level def / async def / class headers.
 *
 * Matches headers anchored at column 0 only — indented (nested) defs are
 * deliberately skipped. This keeps the output focused on the public surface
 * of a module. (Same convention chosen for the JS/TS extractor's top-level
 * declarations.)
 */
export function extractPythonDefs(source: string): PythonDef[] {
  const defs: PythonDef[] = [];

  // Iterate line-by-line so we can attach 1-based line numbers and enforce
  // the column-0 anchor. Splitting on \n is enough — \r\n becomes "\r" at
  // end-of-line which doesn't affect the leading-anchor check.
  const lines = source.split('\n');
  const defRe = /^(?:async\s+)?def\s+([A-Za-z_]\w*)/;
  const classRe = /^class\s+([A-Za-z_]\w*)/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const dm = defRe.exec(line);
    if (dm && dm[1]) {
      defs.push({ name: dm[1], line: i + 1, kind: 'def' });
      continue;
    }
    const cm = classRe.exec(line);
    if (cm && cm[1]) {
      defs.push({ name: cm[1], line: i + 1, kind: 'class' });
    }
  }

  return defs;
}
