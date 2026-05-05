/* enchanter/src/plugins/lich/sandbox.ts — v0.3.1 #4 (M5 sandbox stub).
   Refs: docs/v0.3/lich-m5-sandbox.md (design), lich.adapter.ts (entry).
   Resource-bounded code-review sandbox. Forks a worker (sandbox-worker.mjs)
   over IPC, sends a code string in, reads structured findings out. The
   worker is killed on time-budget exceeded or memory cap. All failure
   paths return a SandboxResult with failed:true and a reason — never
   throws to the caller. Stdlib only (node:child_process, node:url). */

import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

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
interface WorkerReviewSuccess { kind: 'reply'; ok: true; result: { findings: SandboxFinding[]; score: number } }
interface WorkerReviewError { kind: 'reply'; ok: false; error: string }
type WorkerReply = WorkerReviewSuccess | WorkerReviewError;
type WorkerMessage = WorkerReadyMessage | WorkerReply;

function isReadyMessage(v: unknown): v is WorkerReadyMessage {
  return typeof v === 'object' && v !== null && (v as { kind?: unknown }).kind === 'ready';
}

function isReplyMessage(v: unknown): v is WorkerReply {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as { ok?: unknown };
  return o.ok === true || o.ok === false;
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
