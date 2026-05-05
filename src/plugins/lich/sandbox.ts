/* enchanter/src/plugins/lich/sandbox.ts — v0.3.1 #4 (M5 sandbox stub).
   Refs: docs/v0.3/lich-m5-sandbox.md (design), lich.adapter.ts (entry).
   Resource-bounded code-review sandbox. Forks a worker (sandbox-worker.mjs)
   over IPC, sends a code string in, reads structured findings out. The
   worker is killed on time-budget exceeded or memory cap. All failure
   paths return a SandboxResult with failed:true and a reason — never
   throws to the caller. Stdlib only (node:child_process, node:url).

   v0.4 #1 adds runSandboxedToolCallLive — real-MCP-server replay variant.
   The mock-projection runSandboxedToolCall stays for back-compat tests. */

import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { JsonRpcMessage } from '../../protocol/jsonrpc.js';

export interface SandboxOptions {
  /** Wall-clock budget in ms before the worker is SIGKILLed. Default: 5000. */
  readonly time_budget_ms?: number;
  /** V8 old-space cap forwarded to the worker via --max-old-space-size. Default: 128 MB. */
  readonly memory_budget_mb?: number;
  /** Test-only hook: instruct the worker to crash on receipt of the code. */
  readonly _force_crash?: boolean;
  /** Test-only hook: instruct the worker to spin so the time budget fires. */
  readonly _force_spin?: boolean;
}

export interface SandboxFinding {
  readonly id: string;
  readonly severity: number;
}

export type SandboxFailReason = 'timeout' | 'worker-error' | 'spawn-error' | 'bad-response';

export interface SandboxSuccess {
  readonly failed: false;
  readonly findings: ReadonlyArray<SandboxFinding>;
  readonly score: number;
  readonly elapsed_ms: number;
}

export interface SandboxFailure {
  readonly failed: true;
  readonly reason: SandboxFailReason;
  readonly detail?: string;
  readonly elapsed_ms: number;
}

export type SandboxResult = SandboxSuccess | SandboxFailure;

// ---------------------------------------------------------------------------
// Tool-call confirmation (v0.3.2)
// ---------------------------------------------------------------------------

/** A single structural difference between original and replayed responses. */
export interface ToolConfirmDifference {
  /** JSON-pointer-shaped path (string + numeric index keys) to the diverging value. */
  readonly path: ReadonlyArray<string | number>;
  readonly original: unknown;
  readonly replayed: unknown;
}

export interface ToolConfirmSuccess {
  readonly failed: false;
  readonly ok: boolean;
  readonly differences: ReadonlyArray<ToolConfirmDifference>;
  readonly elapsed_ms: number;
}

export interface ToolConfirmFailure {
  readonly failed: true;
  readonly reason: SandboxFailReason;
  readonly detail?: string;
  readonly elapsed_ms: number;
}

export type ToolConfirmResult = ToolConfirmSuccess | ToolConfirmFailure;

const DEFAULT_TIME_BUDGET_MS = 5_000;
const DEFAULT_MEMORY_BUDGET_MB = 128;

// [author judgment] Resolve the worker relative to this module so the same
// path works in src/ (test) and dist/ (built). The worker is a .mjs and is
// copied verbatim — no transpilation step required.
function workerPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, 'sandbox-worker.mjs');
}

interface WorkerReadyMessage { kind: 'ready' }
interface WorkerReviewSuccess { ok: true; result: { findings: SandboxFinding[]; score: number } }
interface WorkerReviewError { ok: false; error: string }
type WorkerReply = WorkerReviewSuccess | WorkerReviewError;

interface WorkerToolConfirmSuccess {
  ok: true;
  result: { matches: boolean; differences: ToolConfirmDifference[]; replayed: unknown };
}
interface WorkerToolConfirmError { ok: false; error: string }
type WorkerToolConfirmReply = WorkerToolConfirmSuccess | WorkerToolConfirmError;

function isReadyMessage(v: unknown): v is WorkerReadyMessage {
  return typeof v === 'object' && v !== null && (v as { kind?: unknown }).kind === 'ready';
}

function isReplyMessage(v: unknown): v is WorkerReply {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as { ok?: unknown };
  return o.ok === true || o.ok === false;
}

function isToolConfirmReply(v: unknown): v is WorkerToolConfirmReply {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as { ok?: unknown; result?: unknown };
  if (o.ok === false) return true;
  if (o.ok !== true) return false;
  const r = o.result as { matches?: unknown; differences?: unknown } | undefined;
  return (
    typeof r === 'object' && r !== null &&
    typeof r.matches === 'boolean' &&
    Array.isArray(r.differences)
  );
}

export async function runSandboxedReview(
  code: string,
  options: SandboxOptions = {},
): Promise<SandboxResult> {
  const start = Date.now();
  const time_budget_ms = options.time_budget_ms ?? DEFAULT_TIME_BUDGET_MS;
  const memory_budget_mb = options.memory_budget_mb ?? DEFAULT_MEMORY_BUDGET_MB;

  let child: ChildProcess;
  try {
    child = fork(workerPath(), [], {
      // [author judgment] silent:true so stdout/stderr don't leak into the
      // parent's streams; IPC is the only channel.
      silent: true,
      // Strip the parent's environment — the worker only needs PATH for Node.
      env: { PATH: process.env['PATH'] ?? '' },
      execArgv: [
        `--max-old-space-size=${memory_budget_mb}`,
        '--no-warnings',
      ],
    });
  } catch (err) {
    return {
      failed: true,
      reason: 'spawn-error',
      detail: err instanceof Error ? err.message : String(err),
      elapsed_ms: Date.now() - start,
    };
  }

  return new Promise<SandboxResult>((resolvePromise) => {
    let settled = false;
    const finish = (r: SandboxResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Best-effort cleanup. SIGKILL guarantees death even on a busy-loop.
      if (!child.killed) {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      }
      resolvePromise(r);
    };

    const timer = setTimeout(() => {
      finish({
        failed: true,
        reason: 'timeout',
        detail: `wall-clock budget ${time_budget_ms}ms exceeded`,
        elapsed_ms: Date.now() - start,
      });
    }, time_budget_ms);

    child.on('error', (err) => {
      finish({
        failed: true,
        reason: 'spawn-error',
        detail: err.message,
        elapsed_ms: Date.now() - start,
      });
    });

    child.on('exit', (code, signal) => {
      // If we already finished (success or timeout), this exit is expected.
      if (settled) return;
      finish({
        failed: true,
        reason: 'worker-error',
        detail: `worker exited code=${code} signal=${signal} before responding`,
        elapsed_ms: Date.now() - start,
      });
    });

    let ready = false;
    child.on('message', (raw: unknown) => {
      if (isReadyMessage(raw)) {
        ready = true;
        try {
          child.send({
            kind: 'review',
            code,
            crash: options._force_crash === true,
            spin: options._force_spin === true,
          });
        } catch (err) {
          finish({
            failed: true,
            reason: 'worker-error',
            detail: err instanceof Error ? err.message : String(err),
            elapsed_ms: Date.now() - start,
          });
        }
        return;
      }

      if (!isReplyMessage(raw)) {
        finish({
          failed: true,
          reason: 'bad-response',
          detail: 'worker sent unrecognized IPC message',
          elapsed_ms: Date.now() - start,
        });
        return;
      }

      if (!ready) {
        finish({
          failed: true,
          reason: 'bad-response',
          detail: 'worker reply before ready signal',
          elapsed_ms: Date.now() - start,
        });
        return;
      }

      if (raw.ok === true) {
        finish({
          failed: false,
          findings: raw.result.findings,
          score: raw.result.score,
          elapsed_ms: Date.now() - start,
        });
      } else {
        finish({
          failed: true,
          reason: 'worker-error',
          detail: raw.error,
          elapsed_ms: Date.now() - start,
        });
      }
    });
  });
}

/**
 * v0.3.2 — MCP TOOL-CALL CONFIRMATION variant. Re-execute (or replay against a
 * mock transport) the tool call inside a forked worker, then structurally diff
 * the replay output against the live `originalResponse`. The v0.3.2 stub uses
 * mock-transport replay (see sandbox-worker.mjs `mockReplay`) since the
 * client-side runtime can't re-spawn an arbitrary MCP server. Real-server
 * replay is v0.3.3 scope. Same time/memory budgets and failure-shape contract
 * as runSandboxedReview — never throws to the caller.
 */
export async function runSandboxedToolCall(
  toolName: string,
  params: unknown,
  originalResponse: unknown,
  options: SandboxOptions = {},
): Promise<ToolConfirmResult> {
  const start = Date.now();
  const time_budget_ms = options.time_budget_ms ?? DEFAULT_TIME_BUDGET_MS;
  const memory_budget_mb = options.memory_budget_mb ?? DEFAULT_MEMORY_BUDGET_MB;

  let child: ChildProcess;
  try {
    child = fork(workerPath(), [], {
      silent: true,
      env: { PATH: process.env['PATH'] ?? '' },
      execArgv: [
        `--max-old-space-size=${memory_budget_mb}`,
        '--no-warnings',
      ],
    });
  } catch (err) {
    return {
      failed: true,
      reason: 'spawn-error',
      detail: err instanceof Error ? err.message : String(err),
      elapsed_ms: Date.now() - start,
    };
  }

  return new Promise<ToolConfirmResult>((resolvePromise) => {
    let settled = false;
    const finish = (r: ToolConfirmResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!child.killed) {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      }
      resolvePromise(r);
    };

    const timer = setTimeout(() => {
      finish({
        failed: true,
        reason: 'timeout',
        detail: `wall-clock budget ${time_budget_ms}ms exceeded`,
        elapsed_ms: Date.now() - start,
      });
    }, time_budget_ms);

    child.on('error', (err) => {
      finish({
        failed: true,
        reason: 'spawn-error',
        detail: err.message,
        elapsed_ms: Date.now() - start,
      });
    });

    child.on('exit', (code, signal) => {
      if (settled) return;
      finish({
        failed: true,
        reason: 'worker-error',
        detail: `worker exited code=${code} signal=${signal} before responding`,
        elapsed_ms: Date.now() - start,
      });
    });

    let ready = false;
    child.on('message', (raw: unknown) => {
      if (isReadyMessage(raw)) {
        ready = true;
        try {
          child.send({
            kind: 'tool-confirm',
            toolName,
            params,
            originalResponse,
            crash: options._force_crash === true,
            spin: options._force_spin === true,
          });
        } catch (err) {
          finish({
            failed: true,
            reason: 'worker-error',
            detail: err instanceof Error ? err.message : String(err),
            elapsed_ms: Date.now() - start,
          });
        }
        return;
      }

      if (!isToolConfirmReply(raw)) {
        finish({
          failed: true,
          reason: 'bad-response',
          detail: 'worker sent unrecognized IPC message',
          elapsed_ms: Date.now() - start,
        });
        return;
      }

      if (!ready) {
        finish({
          failed: true,
          reason: 'bad-response',
          detail: 'worker reply before ready signal',
          elapsed_ms: Date.now() - start,
        });
        return;
      }

      if (raw.ok === true) {
        finish({
          failed: false,
          ok: raw.result.matches,
          differences: raw.result.differences,
          elapsed_ms: Date.now() - start,
        });
      } else {
        finish({
          failed: true,
          reason: 'worker-error',
          detail: raw.error,
          elapsed_ms: Date.now() - start,
        });
      }
    });
  });
}

// ---------------------------------------------------------------------------
// v0.4 #1 — REAL-MCP-SERVER REPLAY (runSandboxedToolCallLive)
// ---------------------------------------------------------------------------

/** Minimal transport surface the live-replay path needs.
 *  Matches src/client/mcp-client.ts's `Transport` shape so production callers
 *  can pass a real StdioTransport / StreamableHttpTransport. Tests pass a
 *  small in-process stub. */
export interface LiveReplayTransport {
  send(msg: JsonRpcMessage): Promise<void>;
  recv(): AsyncIterableIterator<JsonRpcMessage>;
  shutdown?: () => Promise<void> | void;
}

/** Server descriptor — opaque metadata the transportFactory needs to spawn a
 *  fresh server. Stays a Record so callers can pin different fields per
 *  transport (stdio: cmd/args/env; http: endpoint/auth) without bloating the
 *  contract. */
export type ServerDescriptor = Record<string, unknown>;

/** Caller-supplied factory that constructs a transport for a fresh replay.
 *  Throwing here surfaces as `failed: true, reason: 'spawn-error'`. */
export type LiveTransportFactory = (
  descriptor: ServerDescriptor,
) => Promise<LiveReplayTransport> | LiveReplayTransport;

/** v0.5 #1 — execution mode for runSandboxedToolCallLive.
 *  - 'worker':     fork the sandbox worker; worker spawns the transport itself
 *                  from a SERIALIZABLE serverDescriptor. True process isolation.
 *                  Default for production.
 *  - 'in-process': run the replay in the parent process via an injected
 *                  transportFactory. Used by hermetic tests that stub a
 *                  transport without spawning a real server. */
export type LiveRunMode = 'worker' | 'in-process';

export interface LiveSandboxOptions extends SandboxOptions {
  /** In-process replay: required when runMode === 'in-process'. */
  readonly transportFactory?: LiveTransportFactory;
  /** Worker replay: required when runMode === 'worker'. Must be JSON-serializable. */
  readonly serverDescriptor?: ServerDescriptor;
  /** Default: 'worker' if serverDescriptor present, else 'in-process'. */
  readonly runMode?: LiveRunMode;
}

/** Same diff routine as the worker's, mirrored in TS. Kept narrow on purpose:
 *  primitives + plain objects + arrays. Arrays of primitives → multiset; arrays
 *  of structured items → ordered. Mixed-type or value mismatches yield one diff
 *  entry at the divergence path. */
function liveDiff(
  a: unknown,
  b: unknown,
  path: ReadonlyArray<string | number> = [],
): ToolConfirmDifference[] {
  const diffs: ToolConfirmDifference[] = [];
  if (Object.is(a, b)) return diffs;

  const isObj = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

  if (isObj(a) && isObj(b)) {
    const keys = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      diffs.push(...liveDiff(a[k], b[k], [...path, k]));
    }
    return diffs;
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      diffs.push({ path, original: a, replayed: b });
      return diffs;
    }
    const isPrimArr = (arr: unknown[]): boolean =>
      arr.every((x) => x === null || (typeof x !== 'object' && typeof x !== 'function'));
    if (isPrimArr(a) && isPrimArr(b)) {
      const sa = [...a].map(String).sort();
      const sb = [...b].map(String).sort();
      for (let i = 0; i < sa.length; i++) {
        if (sa[i] !== sb[i]) {
          diffs.push({ path, original: a, replayed: b });
          return diffs;
        }
      }
      return diffs;
    }
    for (let i = 0; i < a.length; i++) {
      diffs.push(...liveDiff(a[i], b[i], [...path, i]));
    }
    return diffs;
  }

  diffs.push({ path, original: a, replayed: b });
  return diffs;
}

/** Drive a `tools/call` over the supplied transport, awaiting the response
 *  by JSON-RPC id. Returns the `result` field (or throws on JSON-RPC error). */
async function callViaTransport(
  transport: LiveReplayTransport,
  toolName: string,
  params: unknown,
): Promise<unknown> {
  const id = 1; // [author judgment] Fresh transport per replay → id=1 is unique per call.
  const argsObject =
    params && typeof params === 'object' && !Array.isArray(params)
      ? (params as Record<string, unknown>)
      : {};
  await transport.send({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: toolName, arguments: argsObject },
  });
  for await (const msg of transport.recv()) {
    const m = msg as { id?: unknown; result?: unknown; error?: { message?: unknown } };
    if (m.id === id) {
      if (m.error !== undefined) {
        const detail =
          m.error && typeof m.error === 'object' && typeof m.error.message === 'string'
            ? m.error.message
            : 'jsonrpc-error';
        throw new Error(detail);
      }
      return m.result;
    }
  }
  throw new Error('transport closed before response');
}

/**
 * v0.5 #1 — MCP TOOL-CALL CONFIRMATION (live-replay variant). Re-issues the
 * captured `tools/call` against a fresh transport and structurally diffs the
 * live result against `originalResponse`. Time/memory-budget contract,
 * failure shapes, and structural-diff semantics match runSandboxedToolCall.
 *
 * Two execution modes (see LiveRunMode):
 *   - 'worker' (default for production): forks sandbox-worker.mjs; the worker
 *     builds its own transport from a SERIALIZABLE serverDescriptor and runs
 *     the replay in true process isolation. The parent process never sees the
 *     replayed payload mid-flight — only the final ToolConfirmResult.
 *   - 'in-process' (hermetic tests): runs the replay in the parent via an
 *     injected transportFactory. Required because Function values aren't
 *     IPC-serializable. Stubs/mocks of LiveReplayTransport go through here.
 *
 * Mode resolution: explicit options.runMode wins; else 'worker' if a
 * serverDescriptor is supplied, else 'in-process'. Mismatch between the
 * resolved mode and the supplied inputs throws synchronously — there's no
 * silent fallback that would mask a misconfigured caller.
 *
 * Failure modes:
 *   - transportFactory throws / worker spawn fails → spawn-error
 *   - transport hangs > budget                     → timeout
 *   - transport.send/recv error                    → worker-error
 *   - any other thrown error                       → worker-error (with detail)
 */
export async function runSandboxedToolCallLive(
  toolName: string,
  params: unknown,
  originalResponse: unknown,
  serverDescriptor: ServerDescriptor,
  options: LiveSandboxOptions,
): Promise<ToolConfirmResult> {
  const start = Date.now();
  const time_budget_ms = options.time_budget_ms ?? DEFAULT_TIME_BUDGET_MS;

  // Resolve runMode. The serverDescriptor argument is always present (legacy
  // signature); presence of options.serverDescriptor is the disambiguator.
  // [author judgment] Keep the positional arg for back-compat with v0.4
  // callers; treat options.serverDescriptor as override-or-defer when set.
  const effectiveDescriptor: ServerDescriptor =
    options.serverDescriptor !== undefined ? options.serverDescriptor : serverDescriptor;
  const hasFactory = options.transportFactory !== undefined;
  const hasDescriptor =
    effectiveDescriptor !== undefined && effectiveDescriptor !== null && Object.keys(effectiveDescriptor).length > 0;

  const runMode: LiveRunMode =
    options.runMode ?? (hasFactory && !hasDescriptor ? 'in-process' : 'worker');

  if (runMode === 'worker' && !hasDescriptor) {
    throw new Error(
      "runSandboxedToolCallLive: runMode='worker' requires a non-empty serverDescriptor",
    );
  }
  if (runMode === 'in-process' && !hasFactory) {
    throw new Error(
      "runSandboxedToolCallLive: runMode='in-process' requires a transportFactory",
    );
  }

  if (runMode === 'in-process') {
    return runInProcess(toolName, params, originalResponse, options.transportFactory!, time_budget_ms, start);
  }
  return runInWorker(toolName, params, originalResponse, effectiveDescriptor, options, start);
}

async function runInProcess(
  toolName: string,
  params: unknown,
  originalResponse: unknown,
  transportFactory: LiveTransportFactory,
  time_budget_ms: number,
  start: number,
): Promise<ToolConfirmResult> {
  let transport: LiveReplayTransport;
  try {
    transport = await transportFactory({});
  } catch (err) {
    return {
      failed: true,
      reason: 'spawn-error',
      detail: err instanceof Error ? err.message : String(err),
      elapsed_ms: Date.now() - start,
    };
  }

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<ToolConfirmResult>((resolveTimeout) => {
    timeoutHandle = setTimeout(() => {
      resolveTimeout({
        failed: true,
        reason: 'timeout',
        detail: `wall-clock budget ${time_budget_ms}ms exceeded`,
        elapsed_ms: Date.now() - start,
      });
    }, time_budget_ms);
  });

  const replayPromise: Promise<ToolConfirmResult> = (async () => {
    try {
      const replayed = await callViaTransport(transport, toolName, params);
      const differences = liveDiff(originalResponse, replayed);
      return {
        failed: false,
        ok: differences.length === 0,
        differences,
        elapsed_ms: Date.now() - start,
      };
    } catch (err) {
      return {
        failed: true,
        reason: 'worker-error',
        detail: err instanceof Error ? err.message : String(err),
        elapsed_ms: Date.now() - start,
      };
    }
  })();

  const result = await Promise.race([replayPromise, timeoutPromise]);
  if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  try {
    if (transport.shutdown) {
      await transport.shutdown();
    }
  } catch { /* ignore */ }
  return result;
}

interface WorkerToolConfirmLiveReply {
  ok: true;
  kind: 'tool-confirm-live';
  result: ToolConfirmResult;
}
interface WorkerToolConfirmLiveError { ok: false; error: string }

function isToolConfirmLiveReply(
  v: unknown,
): v is WorkerToolConfirmLiveReply | WorkerToolConfirmLiveError {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as { ok?: unknown; kind?: unknown };
  if (o.ok === false) return true;
  return o.ok === true && o.kind === 'tool-confirm-live';
}

async function runInWorker(
  toolName: string,
  params: unknown,
  originalResponse: unknown,
  serverDescriptor: ServerDescriptor,
  options: LiveSandboxOptions,
  start: number,
): Promise<ToolConfirmResult> {
  const time_budget_ms = options.time_budget_ms ?? DEFAULT_TIME_BUDGET_MS;
  const memory_budget_mb = options.memory_budget_mb ?? DEFAULT_MEMORY_BUDGET_MB;

  let child: ChildProcess;
  try {
    child = fork(workerPath(), [], {
      silent: true,
      env: { PATH: process.env['PATH'] ?? '' },
      execArgv: [`--max-old-space-size=${memory_budget_mb}`, '--no-warnings'],
    });
  } catch (err) {
    return {
      failed: true,
      reason: 'spawn-error',
      detail: err instanceof Error ? err.message : String(err),
      elapsed_ms: Date.now() - start,
    };
  }

  return new Promise<ToolConfirmResult>((resolvePromise) => {
    let settled = false;
    const finish = (r: ToolConfirmResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!child.killed) {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      }
      resolvePromise(r);
    };

    const timer = setTimeout(() => {
      finish({
        failed: true,
        reason: 'timeout',
        detail: `wall-clock budget ${time_budget_ms}ms exceeded`,
        elapsed_ms: Date.now() - start,
      });
    }, time_budget_ms);

    child.on('error', (err) => {
      finish({
        failed: true,
        reason: 'spawn-error',
        detail: err.message,
        elapsed_ms: Date.now() - start,
      });
    });

    child.on('exit', (code, signal) => {
      if (settled) return;
      finish({
        failed: true,
        reason: 'worker-error',
        detail: `worker exited code=${code} signal=${signal} before responding`,
        elapsed_ms: Date.now() - start,
      });
    });

    let ready = false;
    child.on('message', (raw: unknown) => {
      if (isReadyMessage(raw)) {
        ready = true;
        try {
          child.send({
            kind: 'tool-confirm-live',
            toolName,
            params,
            originalResponse,
            serverDescriptor,
          });
        } catch (err) {
          finish({
            failed: true,
            reason: 'worker-error',
            detail: err instanceof Error ? err.message : String(err),
            elapsed_ms: Date.now() - start,
          });
        }
        return;
      }

      if (!isToolConfirmLiveReply(raw)) {
        finish({
          failed: true,
          reason: 'bad-response',
          detail: 'worker sent unrecognized IPC message',
          elapsed_ms: Date.now() - start,
        });
        return;
      }

      if (!ready) {
        finish({
          failed: true,
          reason: 'bad-response',
          detail: 'worker reply before ready signal',
          elapsed_ms: Date.now() - start,
        });
        return;
      }

      if (raw.ok === true) {
        finish(raw.result);
      } else {
        finish({
          failed: true,
          reason: 'worker-error',
          detail: raw.error,
          elapsed_ms: Date.now() - start,
        });
      }
    });
  });
}
