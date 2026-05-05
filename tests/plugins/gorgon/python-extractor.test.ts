/* tests/plugins/gorgon/python-extractor.test.ts — Python regex-AST
   extractor unit tests (v0.3.1).
   Covers extractPythonImports + extractPythonDefs in
   src/plugins/gorgon/python-extractor.ts. */

import { describe, it, expect } from 'vitest';
import {
  extractPythonImports,
  extractPythonDefs,
} from '../../../src/plugins/gorgon/python-extractor.js';

describe('extractPythonImports', () => {
  it('matches "from foo import bar"', () => {
    expect(extractPythonImports('from foo import bar\n')).toEqual(['foo']);
  });

  it('matches "import foo"', () => {
    expect(extractPythonImports('import foo\n')).toEqual(['foo']);
  });

  it('matches dotted imports — "import foo.bar"', () => {
    expect(extractPythonImports('import foo.bar\n')).toEqual(['foo.bar']);
  });

  it('matches dotted from-imports — "from foo.bar import baz"', () => {
    expect(extractPythonImports('from foo.bar import baz\n')).toEqual(['foo.bar']);
  });

  it('matches multi-name "import foo, bar"', () => {
    const got = extractPythonImports('import foo, bar\n');
    expect(got).toEqual(['foo', 'bar']);
  });

  it('strips "as alias" suffix', () => {
    expect(extractPythonImports('import numpy as np\n')).toEqual(['numpy']);
  });

  it('matches relative imports — "from . import sib"', () => {
    expect(extractPythonImports('from . import sib\n')).toEqual(['.']);
  });

  it('matches relative-with-name "from .pkg import x"', () => {
    expect(extractPythonImports('from .pkg import x\n')).toEqual(['.pkg']);
  });

  it('is multi-line tolerant — finds every import in the source', () => {
    const src = [
      'import os',
      'import sys',
      '',
      'from collections import defaultdict',
      'from .helpers import h',
      'import numpy as np',
    ].join('\n');
    const got = extractPythonImports(src);
    expect(got).toEqual(['collections', '.helpers', 'os', 'sys', 'numpy']);
  });

  it('tolerates parenthesised "from foo import (a, b, c)"', () => {
    const src = 'from foo import (\n    a,\n    b,\n    c,\n)\n';
    expect(extractPythonImports(src)).toEqual(['foo']);
  });

  it('ignores commented-out imports', () => {
    const src = '# import shouldnotmatch\nimport real\n';
    expect(extractPythonImports(src)).toEqual(['real']);
  });

  it('returns an empty list for source with no imports', () => {
    expect(extractPythonImports('x = 1\nprint(x)\n')).toEqual([]);
  });
});

describe('extractPythonDefs', () => {
  it('matches a regular def at column 0', () => {
    const defs = extractPythonDefs('def foo():\n    pass\n');
    expect(defs).toEqual([{ name: 'foo', line: 1, kind: 'def' }]);
  });

  it('matches an async def at column 0', () => {
    const defs = extractPythonDefs('async def bar():\n    pass\n');
    expect(defs).toEqual([{ name: 'bar', line: 1, kind: 'def' }]);
  });

  it('matches a class definition at column 0', () => {
    const defs = extractPythonDefs('class Widget:\n    pass\n');
    expect(defs).toEqual([{ name: 'Widget', line: 1, kind: 'class' }]);
  });

  it('skips indented (nested) defs', () => {
    const src = 'class A:\n    def method(self):\n        pass\n';
    const defs = extractPythonDefs(src);
    // Only the class header at column 0 should appear.
    expect(defs).toEqual([{ name: 'A', line: 1, kind: 'class' }]);
  });

  it('emits 1-based line numbers', () => {
    const src = ['"""module doc"""', '', 'def first():', '    pass', '', 'class Second:', '    pass'].join('\n');
    const defs = extractPythonDefs(src);
    expect(defs).toEqual([
      { name: 'first', line: 3, kind: 'def' },
      { name: 'Second', line: 6, kind: 'class' },
    ]);
  });

  it('handles a mix of def, async def, and class headers', () => {
    const src = [
      'def a():',
      '    pass',
      'async def b():',
      '    pass',
      'class C:',
      '    pass',
    ].join('\n');
    const defs = extractPythonDefs(src);
    expect(defs.map((d) => [d.name, d.kind])).toEqual([
      ['a', 'def'],
      ['b', 'def'],
      ['C', 'class'],
    ]);
  });

  it('returns an empty array for source with no top-level defs', () => {
    expect(extractPythonDefs('x = 1\ny = 2\n')).toEqual([]);
  });
});
