/* tests/plugins/gorgon/pyproject-resolver.test.ts — pyproject.toml parsing +
   dotted-module → file path resolution for the gorgon Python extractor
   (v0.4 #4, lifts the v0.3.1 deferral). */

import { describe, it, expect, vi } from 'vitest';
import {
  parsePyprojectSource,
  resolveModule,
  createResolver,
  type FileSystemView,
} from '../../../src/plugins/gorgon/pyproject-resolver.js';

/**
 * Build a FileSystemView backed by a Set of paths. Path comparison is
 * platform-agnostic: we normalise both sides to forward slashes so tests
 * pass on Windows and POSIX alike.
 */
function fakeFs(paths: string[]): FileSystemView & { calls: string[] } {
  const norm = (p: string): string => p.replace(/\\/g, '/');
  const set = new Set(paths.map(norm));
  const calls: string[] = [];
  return {
    calls,
    existsSync(p: string): boolean {
      const n = norm(p);
      calls.push(n);
      return set.has(n);
    },
  };
}

describe('parsePyprojectSource', () => {
  it('extracts Poetry name + packages = [{include = "myproject"}]', () => {
    const toml = `
[tool.poetry]
name = "x"
version = "0.1.0"
packages = [{include = "myproject"}]
`;
    const meta = parsePyprojectSource(toml, '/repo');
    expect(meta.projectName).toBe('x');
    expect(meta.packageRoots).toEqual(['myproject']);
    expect(meta.baseDir).toBe('/repo');
  });

  it('extracts Poetry packages with from = "src" prefix', () => {
    const toml = `
[tool.poetry]
name = "x"
packages = [
  {include = "myproject", from = "src"},
  {include = "utils", from = "src"},
]
`;
    const meta = parsePyprojectSource(toml, '/repo');
    expect(meta.packageRoots).toEqual(['src/myproject', 'src/utils']);
  });

  it('extracts PEP 621 [project] name', () => {
    const toml = `
[project]
name = "modern_proj"
version = "1.0"
`;
    const meta = parsePyprojectSource(toml, '/repo');
    expect(meta.projectName).toBe('modern_proj');
    // Fallback heuristic: try <name>/ and src/<name>/ when no roots given.
    expect(meta.packageRoots).toEqual(['modern_proj', 'src/modern_proj']);
  });

  it('extracts setuptools package-dir = {"" = "src"}', () => {
    const toml = `
[project]
name = "z"

[tool.setuptools]
package-dir = {"" = "src"}
`;
    const meta = parsePyprojectSource(toml, '/repo');
    expect(meta.packageRoots).toContain('src');
  });

  it('handles comments and unknown keys without breaking', () => {
    const toml = `
# top-level comment
[tool.poetry]
name = "x"  # inline comment
description = "ignore me"
packages = [{include = "myproject"}]
weird-extra = "anything"

[unknown.section]
thing = 42
`;
    const meta = parsePyprojectSource(toml, '/repo');
    expect(meta.projectName).toBe('x');
    expect(meta.packageRoots).toEqual(['myproject']);
  });

  it('returns empty metadata for invalid TOML (fail-open)', () => {
    const meta = parsePyprojectSource('this is :: not :: toml = ;;;', '/repo');
    // No throw, no useful data — exactly what fail-open promises.
    expect(meta.baseDir).toBe('/repo');
    expect(meta.projectName).toBeNull();
    expect(meta.packageRoots).toEqual([]);
  });

  it('merges roots from Poetry + setuptools when both are present', () => {
    const toml = `
[tool.poetry]
name = "x"
packages = [{include = "from_poetry"}]

[tool.setuptools]
package-dir = {"" = "from_setuptools"}
`;
    const meta = parsePyprojectSource(toml, '/repo');
    expect(meta.packageRoots).toEqual(['from_poetry', 'from_setuptools']);
  });
});

describe('resolveModule', () => {
  const meta = parsePyprojectSource(
    `[tool.poetry]\nname = "x"\npackages = [{include = "myproject", from = "src"}]\n`,
    '/repo',
  );

  it('resolves foo.bar to src/myproject/foo/bar.py when that file exists', () => {
    const fs = fakeFs(['/repo/src/myproject/foo/bar.py']);
    const got = resolveModule('myproject.foo.bar', meta, fs);
    expect(got).toBe('src/myproject/foo/bar.py');
  });

  it('resolves foo to src/myproject/foo/__init__.py when only __init__ exists', () => {
    const fs = fakeFs(['/repo/src/myproject/foo/__init__.py']);
    const got = resolveModule('myproject.foo', meta, fs);
    expect(got).toBe('src/myproject/foo/__init__.py');
  });

  it('resolves a top-level module (no dots) via __init__.py', () => {
    const fs = fakeFs(['/repo/src/myproject/__init__.py']);
    const got = resolveModule('myproject', meta, fs);
    expect(got).toBe('src/myproject/__init__.py');
  });

  it('returns null for a nonexistent module', () => {
    const fs = fakeFs([]); // empty filesystem
    expect(resolveModule('does.not.exist', meta, fs)).toBeNull();
  });

  it('returns null for relative imports (no anchor file)', () => {
    const fs = fakeFs(['/repo/src/myproject/anything.py']);
    expect(resolveModule('.', meta, fs)).toBeNull();
    expect(resolveModule('.sibling', meta, fs)).toBeNull();
  });

  it('returns null for empty / malformed module names', () => {
    const fs = fakeFs([]);
    expect(resolveModule('', meta, fs)).toBeNull();
    expect(resolveModule('foo..bar', meta, fs)).toBeNull();
    expect(resolveModule('foo-bar', meta, fs)).toBeNull();
  });

  it('handles a package layout where root = "myproject" (no src/ prefix)', () => {
    const flatMeta = parsePyprojectSource(
      `[tool.poetry]\nname = "x"\npackages = [{include = "myproject"}]\n`,
      '/repo',
    );
    const fs = fakeFs(['/repo/myproject/foo/bar.py']);
    const got = resolveModule('myproject.foo.bar', flatMeta, fs);
    expect(got).toBe('myproject/foo/bar.py');
  });
});

describe('createResolver — caching', () => {
  it('does not re-stat a module on the second call', () => {
    const meta = parsePyprojectSource(
      `[tool.poetry]\nname = "x"\npackages = [{include = "myproject"}]\n`,
      '/repo',
    );
    const fs = fakeFs(['/repo/myproject/foo.py']);
    const existsSpy = vi.spyOn(fs, 'existsSync');

    const resolve = createResolver(meta, fs);

    const first = resolve('myproject.foo');
    expect(first).toBe('myproject/foo.py');
    const callsAfterFirst = existsSpy.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    const second = resolve('myproject.foo');
    expect(second).toBe('myproject/foo.py');
    // The cache short-circuits before any existsSync hits the fake fs.
    expect(existsSpy.mock.calls.length).toBe(callsAfterFirst);
  });

  it('caches null misses too', () => {
    const meta = parsePyprojectSource(
      `[tool.poetry]\nname = "x"\npackages = [{include = "myproject"}]\n`,
      '/repo',
    );
    const fs = fakeFs([]); // every existsSync misses
    const existsSpy = vi.spyOn(fs, 'existsSync');

    const resolve = createResolver(meta, fs);
    expect(resolve('myproject.missing')).toBeNull();
    const after1 = existsSpy.mock.calls.length;
    expect(resolve('myproject.missing')).toBeNull();
    expect(existsSpy.mock.calls.length).toBe(after1);
  });
});
