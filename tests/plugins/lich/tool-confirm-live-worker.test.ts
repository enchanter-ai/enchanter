/* tests/plugins/lich/tool-confirm-live-worker.test.ts — v0.5 #1.
   Covers the worker-mode path of runSandboxedToolCallLive: forks the sandbox
   worker, the worker spawns a tiny stdio MCP-server stub from a serializable
   serverDescriptor, drives a tools/call, structurally diffs, returns. Also
   covers a regression of the v0.4 in-process path so both run modes stay
   green. Hermetic: only the sandbox-worker fork + the stub fixture spawn —
   no real MCP servers. */

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  runSandboxedToolCallLive,
  type LiveReplayTransport,
  type ServerDescriptor,
} from '../../../src/plugins/lich/sandbox.js';
import type { JsonRpcMessage } from '../../../src/protocol/jsonrpc.js';

const here = dirname(fileURLToPath(import.meta.url));
const STUB = resolve(here, 'fixtures/stub-mcp-server.mjs');

function stdioDescriptor(extraArgs: string[] = []): ServerDescriptor {
  return { kind: 'stdio', cmd: process.execPath, args: [STUB, ...extraArgs] };
}

describe('runSandboxedToolCallLive — runMode:worker (fork + stdio fixture)', () => {
  it('happy path: stub replays identical payload → ok:true, differences empty', async () => {
    const live = { content: [{ type: 'text', text: 'Berlin: 12C' }] };
    const result = await runSandboxedToolCallLive(
      'weather',
      { city: 'Berlin' },
      live,
      stdioDescriptor(['--reply', JSON.stringify(live)]),
      { runMode: 'worker', time_budget_ms: 4000 },
    );
    expect(result.failed).toBe(false);
    if (!result.failed) {
      expect(result.ok).toBe(true);
      expect(result.differences).toEqual([]);
    }
  }, 10_000);

  it('mismatch: stub injects extra field → ok:false, differences populated', async () => {
    const live = { content: [{ type: 'text', text: 'Berlin: 12C' }] };
    const result = await runSandboxedToolCallLive(
      'weather',
      { city: 'Berlin' },
      live,
      stdioDescriptor([
        '--reply',
        JSON.stringify(live),
        '--extra',
        JSON.stringify({ exfil: 'secret' }),
      ]),
      { runMode: 'worker', time_budget_ms: 4000 },
    );
    expect(result.failed).toBe(false);
    if (!result.failed) {
      expect(result.ok).toBe(false);
      expect(result.differences.length).toBeGreaterThan(0);
      const paths = result.differences.map((d) => d.path.join('.'));
      expect(paths).toContain('exfil');
    }
  }, 10_000);

  it('timeout: stub hangs → failed:true, reason:timeout', async () => {
    const result = await runSandboxedToolCallLive(
      'weather',
      {},
      {},
      stdioDescriptor(['--reply', '{}', '--hang']),
      { runMode: 'worker', time_budget_ms: 300 },
    );
    expect(result.failed).toBe(true);
    if (result.failed) {
      expect(result.reason).toBe('timeout');
      expect(result.elapsed_ms).toBeGreaterThanOrEqual(300);
    }
  }, 4000);

  it('spawn-error: invalid cmd → failed:true, reason:spawn-error', async () => {
    const result = await runSandboxedToolCallLive(
      'weather',
      {},
      {},
      { kind: 'stdio', cmd: '/no/such/binary-xyz-enchanter-test', args: [] },
      { runMode: 'worker', time_budget_ms: 2000 },
    );
    expect(result.failed).toBe(true);
    if (result.failed) {
      // spawn-error or worker-error both acceptable: ENOENT may surface via
      // child.on('error') (worker-error) or via stdin write failure
      // (worker-error) depending on platform timing. The contract is "did
      // not produce a successful diff".
      expect(['spawn-error', 'worker-error']).toContain(result.reason);
    }
  }, 6000);

  it("explicit runMode='worker' without serverDescriptor throws synchronously", async () => {
    await expect(
      runSandboxedToolCallLive('weather', {}, {}, {}, { runMode: 'worker' }),
    ).rejects.toThrow(/serverDescriptor/);
  });

  it("explicit runMode='in-process' without transportFactory throws synchronously", async () => {
    await expect(
      runSandboxedToolCallLive('weather', {}, {}, { kind: 'stdio', cmd: 'x', args: [] }, {
        runMode: 'in-process',
      }),
    ).rejects.toThrow(/transportFactory/);
  });
});

describe('runSandboxedToolCallLive — runMode:in-process (v0.4 regression)', () => {
  function makeStubTransport(replayResult: unknown): LiveReplayTransport {
    const queue: JsonRpcMessage[] = [];
    let resolveNext: ((m: JsonRpcMessage) => void) | undefined;
    return {
      async send(msg: JsonRpcMessage): Promise<void> {
        const m = msg as { id?: number | string; method?: string };
        if (m.method === 'tools/call' && m.id !== undefined) {
          const reply = { jsonrpc: '2.0', id: m.id, result: replayResult } as JsonRpcMessage;
          if (resolveNext) {
            const r = resolveNext;
            resolveNext = undefined;
            r(reply);
          } else {
            queue.push(reply);
          }
        }
      },
      async *recv(): AsyncIterableIterator<JsonRpcMessage> {
        while (true) {
          if (queue.length > 0) yield queue.shift()!;
          else yield await new Promise<JsonRpcMessage>((r) => { resolveNext = r; });
        }
      },
    };
  }

  it('in-process path still works: stub matches → ok:true', async () => {
    const live = { content: [{ type: 'text', text: 'ok' }] };
    const result = await runSandboxedToolCallLive(
      'weather',
      { city: 'Berlin' },
      live,
      {},
      { runMode: 'in-process', transportFactory: () => makeStubTransport(live), time_budget_ms: 4000 },
    );
    expect(result.failed).toBe(false);
    if (!result.failed) expect(result.ok).toBe(true);
  });
});
