/* scripts/run.ts — process supervisor that wraps any shell command and emits
 * Enchanter bus events tracking lifecycle, stdout/stderr lines, and exit code.
 *
 * Usage:
 *   enchanter run -- <cmd> [<args>...]
 *   enchanter run -- npm test
 *   enchanter run -- tsc --watch
 *   enchanter run -- node -e 'console.log(1)'
 *
 * Forwards the child's stdout/stderr to our own so the user sees their build
 * output normally; in parallel, ships per-line events to a running enchanter
 * inspector. Exit code mirrors the child's. SIGINT propagates to the child.
 *
 * Events emitted (phase = 'cross-session', source = 'run', tier = 'HIGH'):
 *   proc.started            — once on spawn
 *   proc.stdout / proc.stderr — per non-blank line, severity-tagged, rate-limited
 *   proc.exited             — once on close
 *   pech.ledger.appended    — wall-time ledger advisory
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';

import { BusClient, DEFAULT_BROADCASTER_URL } from '../src/observability/bus-client.js';
import type { EnchantedEvent } from '../src/bus/event-types.js';

// ---------------------------------------------------------------------------
// Argv: everything after `--` is the wrapped command
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const sepIdx = args.indexOf('--');
const childArgv = sepIdx >= 0 ? args.slice(sepIdx + 1) : [];

if (childArgv.length === 0) {
  process.stderr.write(
    'usage: enchanter run -- <cmd> [<args>...]\n' +
    'example: enchanter run -- npm test\n',
  );
  process.exit(2);
}

const [cmd, ...cmdArgs] = childArgv;
if (!cmd) process.exit(2);

// ---------------------------------------------------------------------------
// Bus wiring + event helper
// ---------------------------------------------------------------------------
const broadcaster = new BusClient(process.env['ENCHANTER_BUS_URL'] ?? DEFAULT_BROADCASTER_URL);
broadcaster.connect();

const correlationId = `run-${randomUUID().slice(0, 8)}`;

function emit(topic: string, payload: Record<string, unknown>): void {
  const e: EnchantedEvent = {
    id:             randomUUID(),
    correlation_id: correlationId,
    session_id:     'run',
    phase:          'cross-session',
    topic,
    source:         'run',
    budget_tier:    'HIGH',
    ts:             Date.now(),
    payload,
  };
  broadcaster.send(e);
}

// ---------------------------------------------------------------------------
// Spawn the wrapped command
// ---------------------------------------------------------------------------
const isWindows = process.platform === 'win32';
const startedAt = Date.now();

const child = spawn(cmd, cmdArgs, {
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: isWindows,
}) as ChildProcessByStdio<null, Readable, Readable>;

child.on('error', (err) => {
  process.stderr.write(`[enchanter run] failed to spawn '${cmd}': ${err.message}\n`);
  shutdown(1);
});

emit('proc.started', {
  cmd,
  args:       cmdArgs,
  cwd:        process.cwd(),
  pid:        child.pid,
  started_at: startedAt,
});

// ---------------------------------------------------------------------------
// Rate limiter — window-based, 50 events/sec/stream
// ---------------------------------------------------------------------------
const RATE_LIMIT     = 50;
const WINDOW_MS      = 1000;
const MAX_LINE_CHARS = 500;

interface StreamState {
  topic:   'proc.stdout' | 'proc.stderr';
  buf:     string;
  lineNo:  number;
  count:   number;       // emits in current window
  skipped: number;       // lines coalesced because over-budget
  timer:   ReturnType<typeof setTimeout> | null;
}

function makeState(topic: 'proc.stdout' | 'proc.stderr'): StreamState {
  return { topic, buf: '', lineNo: 0, count: 0, skipped: 0, timer: null };
}

function flushSkipped(state: StreamState): void {
  if (state.skipped > 0) {
    emit(state.topic, { batch: true, skipped: state.skipped });
    state.skipped = 0;
  }
  state.count = 0;
  state.timer = null;
}

function ensureTimer(state: StreamState): void {
  if (state.timer) return;
  state.timer = setTimeout(() => flushSkipped(state), WINDOW_MS);
}

function severityFor(line: string): 'error' | 'warn' | null {
  if (/error|ERROR|✖/.test(line)) return 'error';
  if (/warn|WARNING|⚠/.test(line)) return 'warn';
  return null;
}

function emitLine(state: StreamState, line: string): void {
  state.lineNo += 1;

  ensureTimer(state);

  if (state.count >= RATE_LIMIT) {
    state.skipped += 1;
    return;
  }
  state.count += 1;

  const truncated = line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) : line;
  const sev = severityFor(line);
  const payload: Record<string, unknown> = { line: truncated, line_no: state.lineNo };
  if (sev) payload['severity'] = sev;
  emit(state.topic, payload);
}

// ---------------------------------------------------------------------------
// Forward child output verbatim + line-buffer for events
// ---------------------------------------------------------------------------
const stdoutState = makeState('proc.stdout');
const stderrState = makeState('proc.stderr');

function pipeStream(src: Readable, sink: NodeJS.WritableStream, state: StreamState): void {
  src.on('data', (chunk: Buffer) => {
    sink.write(chunk);
    state.buf += chunk.toString('utf8');
    const lines = state.buf.split('\n');
    state.buf = lines.pop() ?? '';
    for (const raw of lines) {
      const line = raw.replace(/\r$/, '');
      if (line.trim()) emitLine(state, line);
    }
  });
  src.on('end', () => {
    if (state.buf.trim()) {
      emitLine(state, state.buf.replace(/\r$/, ''));
      state.buf = '';
    }
  });
}

pipeStream(child.stdout, process.stdout, stdoutState);
pipeStream(child.stderr, process.stderr, stderrState);

// ---------------------------------------------------------------------------
// Lifecycle close
// ---------------------------------------------------------------------------
let closed = false;

child.on('close', (code, signal) => {
  if (closed) return;
  closed = true;

  // Flush any pending rate-limited skips before final events.
  if (stdoutState.timer) { clearTimeout(stdoutState.timer); flushSkipped(stdoutState); }
  if (stderrState.timer) { clearTimeout(stderrState.timer); flushSkipped(stderrState); }

  const elapsedMs   = Date.now() - startedAt;
  const totalLines  = stdoutState.lineNo + stderrState.lineNo;

  emit('proc.exited', {
    code,
    signal,
    elapsed_ms:  elapsedMs,
    total_lines: totalLines,
  });

  emit('pech.ledger.appended', {
    vendor:        'run',
    plugin:        'run',
    input_tokens:  0,
    output_tokens: 0,
    tool:          cmd,
    elapsed_ms:    elapsedMs,
  });

  // Give the broadcaster a tick to flush, then exit with the child's code.
  setTimeout(() => {
    try { broadcaster.close(); } catch { /* ignore */ }
    if (signal) process.kill(process.pid, signal);
    else        process.exit(code ?? 0);
  }, 50);
});

// ---------------------------------------------------------------------------
// Signal forwarding — SIGINT on us → SIGINT child → wait → exit via 'close'
// ---------------------------------------------------------------------------
function forwardSignal(sig: NodeJS.Signals): void {
  try { child.kill(sig); } catch { /* ignore */ }
}

process.on('SIGINT',  () => forwardSignal('SIGINT'));
process.on('SIGTERM', () => forwardSignal('SIGTERM'));

function shutdown(code: number): void {
  if (closed) return;
  closed = true;
  try { broadcaster.close(); } catch { /* ignore */ }
  try { child.kill(); }       catch { /* ignore */ }
  process.exit(code);
}
