/* enchanter/src/plugins/gorgon/pyproject-resolver.ts — resolve dotted
   Python module names to filesystem paths via a project's `pyproject.toml`.

   Lifts the v0.3.1 deferral noted in docs/v0.3/gorgon-tarjan-python-ast.md
   ("dotted-module path resolution against pyproject.toml is deferred").
   Hand-rolled minimal TOML scanner — we only need a tiny set of keys
   (project / package name and package roots), so depending on a real TOML
   parser would be overkill given the no-new-deps constraint.

   Tolerant by design: invalid TOML, missing fields, weird layouts → return
   an empty/zero metadata object. Callers fall back to recording verbatim
   module names. NEVER fail closed — gorgon is advisory. */

import {
  promises as fsPromises,
  existsSync as nodeExistsSync,
  readFileSync as nodeReadFileSync,
} from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PyprojectMetadata {
  /** Project name from `[project].name` / `[tool.poetry].name`, or `null`. */
  projectName: string | null;
  /**
   * Filesystem-relative roots that should be searched when resolving dotted
   * module names. Order matters — earlier roots win when a module exists in
   * more than one. Resolved relative to the directory containing pyproject.toml.
   *
   * Examples: `["src/myproject"]`, `["src", "lib"]`, `["myproject"]`.
   */
  packageRoots: string[];
  /** Absolute directory containing the parsed pyproject.toml (used as base). */
  baseDir: string;
}

/**
 * Minimal filesystem view used by the resolver. Defaults to `node:fs` but is
 * injectable so tests can avoid touching the real disk.
 */
export interface FileSystemView {
  existsSync(p: string): boolean;
}

const DEFAULT_FS: FileSystemView = {
  existsSync(p: string): boolean {
    return nodeExistsSync(p);
  },
};

// ---------------------------------------------------------------------------
// TOML parsing — minimal hand-rolled scanner
// ---------------------------------------------------------------------------

/**
 * Strip a `# comment` from the end of a TOML line, respecting `"..."` and
 * `'...'` strings (so a `#` inside a string isn't treated as a comment start).
 * Returns the line trimmed of trailing whitespace.
 */
function stripComment(line: string): string {
  let inDouble = false;
  let inSingle = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '#' && !inDouble && !inSingle) {
      return line.slice(0, i).trimEnd();
    }
  }
  return line.trimEnd();
}

/** Strip surrounding `"..."` or `'...'` (basic TOML strings only). */
function unquoteString(raw: string): string | null {
  const s = raw.trim();
  if (s.length < 2) return null;
  const first = s[0];
  const last = s[s.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return s.slice(1, -1);
  }
  return null;
}

/**
 * Parse a TOML inline-table-like string (`{include = "myproject", from = "src"}`)
 * into a plain object of string fields. We tolerate missing/extra fields and
 * ignore values we can't unquote — nothing here is load-bearing for failure.
 */
function parseInlineTable(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Strip surrounding braces.
  const trimmed = s.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return out;
  const body = trimmed.slice(1, -1);

  // Split on commas not inside quotes/nested brackets.
  const parts: string[] = [];
  let depth = 0;
  let inDouble = false;
  let inSingle = false;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (!inDouble && !inSingle) {
      if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') depth--;
      else if (c === ',' && depth === 0) {
        parts.push(body.slice(start, i));
        start = i + 1;
      }
    }
  }
  parts.push(body.slice(start));

  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const valueRaw = part.slice(eq + 1).trim();
    const value = unquoteString(valueRaw);
    if (key && value !== null) out[key] = value;
  }
  return out;
}

interface RawTomlSections {
  /** section name → key → raw value string (post-comment-strip, trimmed). */
  sections: Map<string, Map<string, string>>;
}

/**
 * Scan TOML source into sections and key/value pairs. Multi-line array values
 * (`packages = [\n  ...\n]`) are reassembled into a single value string. We do
 * NOT attempt full TOML compliance — only enough to read the keys we need.
 */
function scanTomlSections(source: string): RawTomlSections {
  const sections = new Map<string, Map<string, string>>();
  // Default "root" section for keys before any [section] header — unused for
  // our keys but we keep the slot consistent.
  sections.set('', new Map());
  let current = '';

  // Reassemble multi-line array values by tracking bracket depth. Same for
  // multi-line inline tables { ... } that span lines (rare but possible).
  const rawLines = source.split(/\r?\n/);
  let i = 0;
  while (i < rawLines.length) {
    const stripped = stripComment(rawLines[i]!).trim();
    i++;
    if (stripped === '') continue;

    // Section header: [name] or [[name]]. We don't distinguish array-of-tables
    // since none of our target keys live there. Treat [[x]] same as [x].
    const sectionMatch = /^\[\[?\s*([^\]]+?)\s*\]\]?$/.exec(stripped);
    if (sectionMatch) {
      current = sectionMatch[1]!.trim();
      if (!sections.has(current)) sections.set(current, new Map());
      continue;
    }

    // Key = value (possibly multi-line for arrays / inline tables).
    const eq = stripped.indexOf('=');
    if (eq === -1) continue;
    const key = stripped.slice(0, eq).trim();
    let value = stripped.slice(eq + 1).trim();

    // If the value opens a bracket/brace that doesn't close on this line, keep
    // gobbling lines until brackets/braces balance out.
    let bracketDepth = 0;
    let braceDepth = 0;
    const updateDepth = (chunk: string) => {
      let inDouble = false;
      let inSingle = false;
      for (const c of chunk) {
        if (c === '"' && !inSingle) inDouble = !inDouble;
        else if (c === "'" && !inDouble) inSingle = !inSingle;
        else if (!inDouble && !inSingle) {
          if (c === '[') bracketDepth++;
          else if (c === ']') bracketDepth--;
          else if (c === '{') braceDepth++;
          else if (c === '}') braceDepth--;
        }
      }
    };
    updateDepth(value);
    while ((bracketDepth > 0 || braceDepth > 0) && i < rawLines.length) {
      const next = stripComment(rawLines[i]!).trim();
      i++;
      if (next === '') continue;
      value += ' ' + next;
      updateDepth(next);
    }

    sections.get(current)!.set(key, value);
  }

  return { sections };
}

// ---------------------------------------------------------------------------
// Metadata extraction — Poetry / setuptools / PEP 621
// ---------------------------------------------------------------------------

/**
 * Parse a `packages = [...]` value into the list of package roots.
 *
 * Handles three common shapes:
 *   1. Poetry: `packages = [{include = "myproject"}, {include = "x", from = "src"}]`
 *      → ["myproject", "src/x"]
 *   2. setuptools find: `packages = ["pkg_a", "pkg_b"]` (PEP 621-ish manual list)
 *      → ["pkg_a", "pkg_b"]
 *   3. Anything else → []
 */
function parsePackagesValue(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return [];
  const inner = trimmed.slice(1, -1);

  // Split top-level entries on commas, respecting nested brackets/braces/quotes.
  const entries: string[] = [];
  let depth = 0;
  let inDouble = false;
  let inSingle = false;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (!inDouble && !inSingle) {
      if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') depth--;
      else if (c === ',' && depth === 0) {
        entries.push(inner.slice(start, i));
        start = i + 1;
      }
    }
  }
  entries.push(inner.slice(start));

  const roots: string[] = [];
  for (const entry of entries) {
    const e = entry.trim();
    if (e === '') continue;

    // Poetry inline-table form.
    if (e.startsWith('{')) {
      const tab = parseInlineTable(e);
      const include = tab.include;
      if (!include) continue;
      const from = tab.from;
      const root = from ? `${from}/${include}` : include;
      roots.push(root);
      continue;
    }

    // Plain string entry (setuptools-style explicit list).
    const s = unquoteString(e);
    if (s !== null) roots.push(s);
  }
  return roots;
}

/**
 * Parse a `package-dir = {...}` (setuptools) value into a list of roots,
 * favouring `""` (the default mapping). `package-dir = {"" = "src"}` means
 * "all packages live under src/", which we model as a `src` root.
 */
function parsePackageDirValue(raw: string): string[] {
  const tab = parseInlineTable(raw);
  const roots: string[] = [];
  // The "" key maps the default package directory.
  if ('""' in tab) roots.push(tab['""']!);
  else if ('' in tab) roots.push(tab['']!);
  // Named keys map subpackages to dirs — include them as roots too, keyed by
  // their target dir (not the package name).
  for (const [k, v] of Object.entries(tab)) {
    if (k === '""' || k === '') continue;
    if (v && !roots.includes(v)) roots.push(v);
  }
  return roots;
}

/**
 * Build PyprojectMetadata from already-scanned TOML sections. Pulls from all
 * three common config layouts (Poetry, PEP 621 `[project]`, setuptools).
 *
 * Multiple-config-keys policy: we *merge* roots from every configuration layout
 * we recognise. A repo that declares both `[tool.poetry]` and `[tool.setuptools]`
 * (rare but legal during a migration) gets the union of their package roots —
 * resolution still picks the first one that exists on disk, so the merge is
 * additive, not conflicting.
 */
function buildMetadata(
  raw: RawTomlSections,
  baseDir: string,
): PyprojectMetadata {
  const get = (section: string, key: string): string | undefined =>
    raw.sections.get(section)?.get(key);

  let projectName: string | null = null;

  // PEP 621 — [project] name = "..."
  const pep621Name = get('project', 'name');
  if (pep621Name) projectName = unquoteString(pep621Name) ?? projectName;

  // Poetry — [tool.poetry] name = "..."
  const poetryName = get('tool.poetry', 'name');
  if (!projectName && poetryName) projectName = unquoteString(poetryName) ?? null;

  const packageRoots: string[] = [];
  const pushUnique = (r: string): void => {
    const norm = r.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
    if (norm && !packageRoots.includes(norm)) packageRoots.push(norm);
  };

  // Poetry — [tool.poetry] packages = [...]
  const poetryPackages = get('tool.poetry', 'packages');
  if (poetryPackages) {
    for (const r of parsePackagesValue(poetryPackages)) pushUnique(r);
  }

  // PEP 621 — [tool.setuptools] packages = [...] (rare but legal)
  const setuptoolsPackages = get('tool.setuptools', 'packages');
  if (setuptoolsPackages) {
    for (const r of parsePackagesValue(setuptoolsPackages)) pushUnique(r);
  }

  // Setuptools — [tool.setuptools] package-dir = {"" = "src"}
  const packageDir = get('tool.setuptools', 'package-dir');
  if (packageDir) {
    for (const r of parsePackageDirValue(packageDir)) pushUnique(r);
  }

  // [tool.setuptools.packages.find] where = ["src"]
  const findWhere = get('tool.setuptools.packages.find', 'where');
  if (findWhere) {
    for (const r of parsePackagesValue(findWhere)) pushUnique(r);
  }

  // Last-resort fallback: if no roots discovered but we have a project name,
  // the canonical layouts to try are `<name>/` and `src/<name>/`.
  if (packageRoots.length === 0 && projectName) {
    pushUnique(projectName);
    pushUnique(`src/${projectName}`);
  }

  return { projectName, packageRoots, baseDir };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load and parse a pyproject.toml at `absPath`. Tolerant: missing file or
 * invalid contents → returns an empty metadata object pinned to the file's
 * containing directory.
 */
export async function loadPyproject(absPath: string): Promise<PyprojectMetadata> {
  const baseDir = path.dirname(absPath);
  let source: string;
  try {
    source = await fsPromises.readFile(absPath, 'utf8');
  } catch {
    return { projectName: null, packageRoots: [], baseDir };
  }
  return parsePyprojectSource(source, baseDir);
}

/**
 * Synchronous variant of loadPyproject — same tolerance contract, but blocks
 * on disk read. Used by configureGorgon so the resolver is ready by the time
 * the next setSourceMap call lands. Avoids an async race between configure
 * and setSourceMap that would otherwise force callers to await configure.
 */
export function loadPyprojectSync(absPath: string): PyprojectMetadata {
  const baseDir = path.dirname(absPath);
  let source: string;
  try {
    source = nodeReadFileSync(absPath, 'utf8');
  } catch {
    return { projectName: null, packageRoots: [], baseDir };
  }
  return parsePyprojectSource(source, baseDir);
}

/**
 * Parse a TOML source string into PyprojectMetadata. Used directly by tests
 * (no disk involved) and as the implementation core for the load* helpers.
 */
export function parsePyprojectSource(
  source: string,
  baseDir: string,
): PyprojectMetadata {
  try {
    const raw = scanTomlSections(source);
    return buildMetadata(raw, baseDir);
  } catch {
    // Defensive: scanTomlSections is permissive but defend against any
    // unexpected throw — gorgon is fail-open.
    return { projectName: null, packageRoots: [], baseDir };
  }
}

// ---------------------------------------------------------------------------
// Module resolution
// ---------------------------------------------------------------------------

/**
 * A resolver function: given a dotted module name (`foo.bar.baz`), return the
 * best matching filesystem path (`src/myproject/foo/bar/baz.py` or
 * `.../baz/__init__.py`), or `null` when no match is found.
 *
 * The returned path is RELATIVE to `meta.baseDir` (so it's portable across
 * machines); callers that need an absolute path should join it themselves.
 */
export type ModuleResolver = (moduleName: string) => string | null;

/** Internal resolution — exported via createResolver / resolveModule. */
function resolveModuleInner(
  moduleName: string,
  meta: PyprojectMetadata,
  fs: FileSystemView,
  cache: Map<string, string | null>,
): string | null {
  if (cache.has(moduleName)) return cache.get(moduleName)!;

  // Skip clearly-unresolvable inputs — relative imports (".", ".pkg") need
  // file context the resolver doesn't have, and stdlib/third-party modules
  // won't live under the project's package roots.
  if (!moduleName || moduleName.startsWith('.')) {
    cache.set(moduleName, null);
    return null;
  }

  const segments = moduleName.split('.');
  if (segments.some((s) => s === '' || /[^A-Za-z0-9_]/.test(s))) {
    // Defensive: a stray separator or punctuation means we can't form a path.
    cache.set(moduleName, null);
    return null;
  }

  const tryRoots: string[] = meta.packageRoots.length > 0
    ? meta.packageRoots.slice()
    : ['.', 'src'];

  for (const root of tryRoots) {
    const rootSegments = root.split('/').filter((s) => s !== '');
    const moduleSegments = segments;

    // Two layout variants:
    //   (a) The package root itself IS the first segment of the module path.
    //       e.g. root = "src/myproject", module = "myproject.foo" →
    //            we walk root + "foo" because "myproject" is already covered.
    //   (b) The package root is a parent dir under which segments live.
    //       e.g. root = "src", module = "myproject.foo" →
    //            we walk root + "myproject" + "foo".
    // We try (a) first when the leaf of root matches the head of module,
    // then (b) as a fallback.
    const variants: string[][] = [];
    const rootLeaf = rootSegments[rootSegments.length - 1];
    if (rootLeaf && rootLeaf === moduleSegments[0]) {
      // (a): drop the head of the module since it's the root leaf.
      variants.push([...rootSegments, ...moduleSegments.slice(1)]);
    }
    // (b): always try treating root as the parent.
    variants.push([...rootSegments, ...moduleSegments]);

    for (const segs of variants) {
      const baseRel = segs.join('/');
      const fileCandidate = `${baseRel}.py`;
      const initCandidate = `${baseRel}/__init__.py`;
      const fileAbs = path.join(meta.baseDir, fileCandidate);
      const initAbs = path.join(meta.baseDir, initCandidate);
      if (fs.existsSync(fileAbs)) {
        cache.set(moduleName, fileCandidate);
        return fileCandidate;
      }
      if (fs.existsSync(initAbs)) {
        cache.set(moduleName, initCandidate);
        return initCandidate;
      }
    }
  }

  cache.set(moduleName, null);
  return null;
}

/**
 * Resolve a single module name. For repeated lookups against the same
 * metadata, prefer `createResolver` — it amortises the cache.
 */
export function resolveModule(
  moduleName: string,
  meta: PyprojectMetadata,
  fileSystem: FileSystemView = DEFAULT_FS,
): string | null {
  // Fresh cache per call — cross-call caching is the resolver's job.
  return resolveModuleInner(moduleName, meta, fileSystem, new Map());
}

/**
 * Build a cached resolver bound to a particular metadata + filesystem view.
 * The cache lives in the closure; multiple calls with the same module name
 * hit the cache instead of stat'ing again.
 */
export function createResolver(
  meta: PyprojectMetadata,
  fileSystem: FileSystemView = DEFAULT_FS,
): ModuleResolver {
  const cache = new Map<string, string | null>();
  return (moduleName: string) =>
    resolveModuleInner(moduleName, meta, fileSystem, cache);
}
