#!/usr/bin/env node
/* scripts/copy-assets.mjs — copy non-TS asset files (e.g. forked-worker .mjs)
   from src/ to dist/ after `tsc`. tsc only emits .ts → .js; assets needed at
   runtime (notably src/plugins/lich/sandbox-worker.mjs) must be copied here. */

import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url)) + '/..';
const SRC = join(ROOT, 'src');
const DIST = join(ROOT, 'dist');
const ASSET_EXTS = ['.mjs', '.cjs', '.json'];

async function walk(dir, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      await walk(p, out);
    } else if (ASSET_EXTS.some((ext) => e.name.endsWith(ext))) {
      out.push(p);
    }
  }
  return out;
}

const assets = await walk(SRC);
let copied = 0;
for (const src of assets) {
  const rel = relative(SRC, src);
  const dst = join(DIST, rel);
  await mkdir(dirname(dst), { recursive: true });
  await copyFile(src, dst);
  copied += 1;
}
console.log(`copy-assets: ${copied} file(s) copied to dist/`);
