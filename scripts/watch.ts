/* scripts/watch.ts — Stage B of the dogfood plan.
 *
 * Filesystem + git-ref watcher that emits Enchanter bus events. A running
 * `enchanter inspect` will surface every save, create, delete, and branch
 * switch as the user develops Enchanter itself.
 *
 *   <files change> ──▶ fs.watch ──▶ debounce ──▶ BusClient ──▶ inspector
 *
 * Usage:
 *   enchanter watch                  # watch process.cwd()
 *   enchanter watch ./some/dir       # watch a specific directory
 *
 * Events emitted:
 *   - enchanter.watch.started   once at startup
 *   - fs.file.changed           file created / changed / deleted
 *   - fs.dir.changed            directory mutated
 *   - git.head.changed          .git/HEAD content changed (branch switch)
 *   - git.ref.changed           a ref under .git/refs/heads/* changed
 *
 * Failure mode: if the broadcaster (ws://127.0.0.1:3001/ws) isn't running,
 * BusClient buffers; we never block the watcher on its availability.
 */

import { randomUUID } from 'node:crypto';
import { watch as fsWatch, statSync, readFileSync, existsSync } from 'node:fs';
import { join, relative, resolve, sep, basename } from 'node:path';

import { BusClient, DEFAULT_BROADCASTER_URL } from '../src/observability/bus-client.js';
import type { EnchantedEvent } from '../src/bus/event-types.js';

// ---------------------------------------------------------------------------
// Argv: optional directory; default to cwd
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const target = args[0] ? resolve(args[0]) : process.cwd();

if (!existsSync(target)) {
  process.stderr.write(`[enchanter watch] target does not exist: ${target}\n`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Correlation: one watch session = one correlation_id reused across events.
// ---------------------------------------------------------------------------
const correlationId = `watch-${randomUUID().slice(0, 8)}`;
const sessionId = 'watch';

// ---------------------------------------------------------------------------
// Ignored-path rules — match the most common noise sources.
// ---------------------------------------------------------------------------
const IGNORED_DIR_SEGMENTS: ReadonlyArray<string> = [
  'node_modules',
  'dist',
  '.next',
  'target',
  'coverage',
];

const IGNORED_GIT_PREFIXES: ReadonlyArray<string> = [
  '.git' + sep + 'objects',
  '.git' + sep + 'logs',
  '.git/objects',
  '.git/logs',
];

const IGNORED_FILE_SUFFIXES: ReadonlyArray<string> = ['.log', '.tmp', '.swp'];
const IGNORED_FILE_NAMES: ReadonlyArray<string> = ['.DS_Store', 'Thumbs.db'];

const IGNORED_DESCRIPTOR: ReadonlyArray<string> = [
  ...IGNORED_DIR_SEGMENTS.map((d) => `${d}/`),
  '.git/objects/',
  '.git/logs/',
  ...IGNORED_FILE_SUFFIXES.map((s) => `*${s}`),
  ...IGNORED_FILE_NAMES,
];

function isIgnored(relPath: string): boolean {
  if (!relPath) return false;
  // Normalize separators so we can match either form.
  const norm = relPath.split(sep).join('/');
  const segments = norm.split('/');
  for (const seg of segments) {
    if (IGNORED_DIR_SEGMENTS.includes(seg)) return true;
  }
  for (const prefix of IGNORED_GIT_PREFIXES) {
    const p = prefix.split(sep).join('/');
    if (norm === p || norm.startsWith(p + '/')) return true;
  }
  const base = basename(relPath);
  if (IGNORED_FILE_NAMES.includes(base)) return true;
  for (const suffix of IGNORED_FILE_SUFFIXES) {
    if (base.endsWith(suffix)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// BusClient wiring — same shape as scripts/mcp-wrap.ts.
// ---------------------------------------------------------------------------
const broadcaster = new BusClient(process.env['ENCHANTER_BUS_URL'] ?? DEFAULT_BROADCASTER_URL);
broadcaster.connect();

function emit(topic: string, payload: Record<string, unknown>): void {
  const e: EnchantedEvent = {
    id:             randomUUID(),
    correlation_id: correlationId,
    session_id:     sessionId,
    phase:          'cross-session',
    topic,
    source:         'watch',
    budget_tier:    'HIGH',
    ts:             Date.now(),
    payload,
  };
  broadcaster.send(e);
}

// ---------------------------------------------------------------------------
// Debounce: coalesce burst events with a 250ms window per (filepath, kind).
// A single save that fires rename+change five times → one emission.
// ---------------------------------------------------------------------------
const DEBOUNCE_MS = 250;
const pending = new Map<string, ReturnType<typeof setTimeout>>();

function classify(absPath: string): 'created' | 'changed' | 'deleted' {
  if (!existsSync(absPath)) return 'deleted';
  // Heuristic: if mtime is within ~1s of ctime, it was just created.
  try {
    const st = statSync(absPath);
    if (Math.abs(st.mtimeMs - st.ctimeMs) < 1_000 && Date.now() - st.ctimeMs < 2_000) {
      return 'created';
    }
  } catch { /* fall through */ }
  return 'changed';
}

function fileSize(absPath: string): number | undefined {
  try { return statSync(absPath).size; }
  catch { return undefined; }
}

function isDirectory(absPath: string): boolean {
  try { return statSync(absPath).isDirectory(); }
  catch { return false; }
}

interface FsEvent { eventType: string; filename: string }

function scheduleEmit(ev: FsEvent): void {
  const relPath = ev.filename;
  if (isIgnored(relPath)) return;

  const absPath = join(target, relPath);
  const key = `${relPath}::${ev.eventType}`;

  const existing = pending.get(key);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    pending.delete(key);
    dispatch(absPath, relPath);
  }, DEBOUNCE_MS);
  pending.set(key, timer);
}

function dispatch(absPath: string, relPath: string): void {
  const norm = relPath.split(sep).join('/');

  // Git-ref handling — sourced from .git/HEAD and .git/refs/heads/*.
  if (norm === '.git/HEAD') {
    let headContents = '';
    try { headContents = readFileSync(absPath, 'utf8').trim(); } catch { /* deleted */ }
    emit('git.head.changed', { path: relPath, head: headContents });
    return;
  }
  if (norm.startsWith('.git/refs/heads/')) {
    const branch = norm.substring('.git/refs/heads/'.length);
    let sha = '';
    try { sha = readFileSync(absPath, 'utf8').trim(); } catch { /* deleted */ }
    emit('git.ref.changed', { path: relPath, branch, sha });
    return;
  }

  // Filesystem: file vs. directory.
  const kind = classify(absPath);
  if (kind !== 'deleted' && isDirectory(absPath)) {
    emit('fs.dir.changed', { path: relPath, kind });
    return;
  }

  const payload: Record<string, unknown> = { path: relPath, kind };
  if (kind !== 'deleted') {
    const size = fileSize(absPath);
    if (size !== undefined) payload['size'] = size;
  }
  emit('fs.file.changed', payload);
}

// ---------------------------------------------------------------------------
// Start watching. fs.watch with recursive:true is supported on macOS and
// Windows; on Linux it's been supported since Node 20, which is below our
// >=22 engines floor — safe to rely on.
// ---------------------------------------------------------------------------
const watcher = fsWatch(target, { recursive: true, encoding: 'utf8' }, (eventType, filename) => {
  if (!filename) return;
  // With encoding:'utf8', filename is a string. Defensive cast for older typings.
  const relName: string = typeof filename === 'string' ? filename : String(filename);
  scheduleEmit({ eventType, filename: relName });
});

watcher.on('error', (err) => {
  process.stderr.write(`[enchanter watch] watcher error: ${err.message}\n`);
});

emit('enchanter.watch.started', {
  cwd: target,
  ignored: IGNORED_DESCRIPTOR,
});

process.stderr.write(
  `[enchanter watch] watching ${target} (correlation_id=${correlationId})\n` +
  `[enchanter watch] forwarding events to ${process.env['ENCHANTER_BUS_URL'] ?? DEFAULT_BROADCASTER_URL}\n`,
);

// Keep process alive even though fs.watch should hold the loop open.
// (Belt-and-braces: ensures Ctrl-C path is the only exit route.)
const keepalive = setInterval(() => { /* tick */ }, 60_000);

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
process.on('SIGINT',  () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

function shutdown(code: number): void {
  clearInterval(keepalive);
  for (const t of pending.values()) clearTimeout(t);
  pending.clear();
  try { watcher.close(); }      catch { /* ignore */ }
  try { broadcaster.close(); }  catch { /* ignore */ }
  process.exit(code);
}

// Relative-path utility export kept private; import path-relative used here
// to avoid an unused-import lint complaint when the helper is inlined.
void relative;
