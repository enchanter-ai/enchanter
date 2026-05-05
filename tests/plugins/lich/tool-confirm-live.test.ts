/* tests/plugins/lich/tool-confirm-live.test.ts — v0.4 #1 (M5 tool-confirm-live).
   Covers runSandboxedToolCallLive() against an in-process MCP-server stub +
   the LRU replay cache + adapter wire-up around m5_tool_confirm_live. The
   v0.3.2 mock-projection runSandboxedToolCall path is left untouched and
   covered by tool-confirm.test.ts. */

import { describe, it, expect, afterEach } from 'vitest';
import {
  runSandboxedToolCallLive,
  runSandboxedToolCall,
  runSandboxedReview,
  type LiveReplayTransport,
  type ToolConfirmResult,
  type ServerDescriptor,
} from '../../../src/plugins/lich/sandbox.js';
import { ReplayCache } from '../../../src/plugins/lich/replay-cache.js';
import {
  lichAdapter,
  configureLich,
  getLichReplayCache,
} from '../../../src/plugins/lich.adapter.js';
import { createRequestContext } from '../../../src/orchestration/request-context.js';
import type { EnchantedEvent } from '../../../src/bus/event-types.js';
import type { JsonRpcMessage } from '../../../src/protocol/jsonrpc.js';

const ctx = createRequestContext();

afterEach(() => {
  configureLich({
    m5_sandbox: false,
    m5_time_budget_ms: 5000,
    m5_sandbox_runner: runSandboxedReview,
    m5_tool_confirm: false,
    m5_tool_confirm_runner: runSandboxedToolCall,
    m5_tool_confirm_live: false,
    m5_tool_confirm_live_runner: runSandboxedToolCallLive,
    m5_transport_factory: undefined,
    m5_replay_run_mode: 'worker',
    m5_replay_cache: new ReplayCache(256),
  });
});

function makeEvent(payload: Record<string, unknown>): EnchantedEvent {
  return {
    id: 'tcl-id', correlation_id: 'tcl-corr', session_id: 'tcl-sess',
    phase: 'post-response', topic: 'mcp.tool.result.received',
    source: 'orchestrator', budget_tier: 'HIGH', ts: Date.now(),
    payload,
  };
}

/** Tiny in-process MCP-server stub. Yields the configured response when it
 *  receives a `tools/call` request that matches the expected toolName. */
function makeStubTransport(replayResult: unknown, opts: { hang?: boolean } = {}): LiveReplayTransport {
  const queue: JsonRpcMessage[] = [];
  let resolveNext: ((m: JsonRpcMessage) => void) | undefined;
  const enqueue = (m: JsonRpcMessage): void => {
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = undefined;
      r(m);
    } else {
      queue.push(m);
    }
  };
  return {
    async send(msg: JsonRpcMessage): Promise<void> {
      const m = msg as { id?: number | string; method?: string };
      if (opts.hang) return; // never respond
      if (m.method === 'tools/call' && m.id !== undefined) {
        enqueue({ jsonrpc: '2.0', id: m.id, result: replayResult });
      }
    },
    async *recv(): AsyncIterableIterator<JsonRpcMessage> {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift()!;
        } else {
          yield await new Promise<JsonRpcMessage>((r) => { resolveNext = r; });
        }
      }
    },
  };
}

describe('runSandboxedToolCallLive — real-MCP-server replay', () => {
  it('happy path: stub replay matches → ok:true', async () => {
    const params = { city: 'Berlin' };
    const live = { content: [{ type: 'text', text: 'Berlin: 12C' }] };
    const stub = makeStubTransport(live);
    const result = await runSandboxedToolCallLive('weather', params, live, {}, {
      time_budget_ms: 4000,
      transportFactory: () => stub,
    });
    expect(result.failed).toBe(false);
    if (!result.failed) {
      expect(result.ok).toBe(true);
      expect(result.differences).toEqual([]);
    }
  });

  it('mismatch: stub returns different payload → ok:false, differences populated', async () => {
    const params = { city: 'Berlin' };
    const live = { content: [{ type: 'text', text: 'Berlin: 12C' }] };
    const replayed = { content: [{ type: 'text', text: 'Berlin: 12C' }], exfil: 'secret' };
    const stub = makeStubTransport(replayed);
    const result = await runSandboxedToolCallLive('weather', params, live, {}, {
      time_budget_ms: 4000,
      transportFactory: () => stub,
    });
    expect(result.failed).toBe(false);
    if (!result.failed) {
      expect(result.ok).toBe(false);
      expect(result.differences.length).toBeGreaterThan(0);
      const paths = result.differences.map((d) => d.path.join('.'));
      expect(paths).toContain('exfil');
    }
  });

  it('spawn failure: transportFactory throws → failed:true, reason:spawn-error', async () => {
    const result = await runSandboxedToolCallLive('weather', {}, {}, {}, {
      time_budget_ms: 4000,
      transportFactory: () => { throw new Error('boom'); },
    });
    expect(result.failed).toBe(true);
    if (result.failed) {
      expect(result.reason).toBe('spawn-error');
      expect(result.detail).toContain('boom');
    }
  });

  it('timeout: stub hangs → failed:true, reason:timeout', async () => {
    const stub = makeStubTransport({}, { hang: true });
    const result = await runSandboxedToolCallLive('weather', {}, {}, {}, {
      time_budget_ms: 200,
      transportFactory: () => stub,
    });
    expect(result.failed).toBe(true);
    if (result.failed) {
      expect(result.reason).toBe('timeout');
      expect(result.elapsed_ms).toBeGreaterThanOrEqual(200);
    }
  }, 4000);
});

describe('ReplayCache — LRU semantics', () => {
  it('stores and retrieves by composite key', () => {
    const c = new ReplayCache(4);
    const k = c.key('schema-1', 'args-1');
    const r: ToolConfirmResult = { failed: false, ok: true, differences: [], elapsed_ms: 5 };
    expect(c.get(k)).toBeUndefined();
    c.set(k, r);
    expect(c.get(k)).toEqual(r);
    expect(c.size()).toBe(1);
  });

  it('evicts the LRU entry when over capacity', () => {
    const c = new ReplayCache(3);
    const r = (id: number): ToolConfirmResult =>
      ({ failed: false, ok: true, differences: [], elapsed_ms: id });
    c.set('a', r(1));
    c.set('b', r(2));
    c.set('c', r(3));
    c.set('d', r(4)); // evicts 'a'
    expect(c.size()).toBe(3);
    expect(c.get('a')).toBeUndefined();
    expect(c.get('b')).toBeDefined();
    expect(c.get('c')).toBeDefined();
    expect(c.get('d')).toBeDefined();
  });

  it('promotes on get — recently-read entry survives eviction', () => {
    const c = new ReplayCache(3);
    const r = (id: number): ToolConfirmResult =>
      ({ failed: false, ok: true, differences: [], elapsed_ms: id });
    c.set('a', r(1));
    c.set('b', r(2));
    c.set('c', r(3));
    c.get('a'); // 'a' becomes MRU
    c.set('d', r(4)); // 'b' is now LRU and is evicted
    expect(c.get('a')).toBeDefined();
    expect(c.get('b')).toBeUndefined();
  });

  it('cache eviction: 257 distinct entries with default capacity → size stays 256', () => {
    const c = new ReplayCache(); // default 256
    for (let i = 0; i < 257; i++) {
      c.set(`k-${i}`, { failed: false, ok: true, differences: [], elapsed_ms: i });
    }
    expect(c.size()).toBe(256);
    // Oldest (k-0) is evicted; newest (k-256) is present.
    expect(c.get('k-0')).toBeUndefined();
    expect(c.get('k-256')).toBeDefined();
  });
});

describe('lich adapter — m5_tool_confirm_live config flag wire-up', () => {
  it('flag OFF (default): no live-replay event produced', async () => {
    const ack = await lichAdapter.onPhase(makeEvent({
      tool_schema: { name: 't', description: 'clean', inputSchema: { properties: {} } },
      tool: 'weather',
      args: { city: 'Berlin' },
      response: { content: [{ type: 'text', text: 'ok' }] },
    }), ctx);
    expect(ack.status).toBe('ack');
    const evs = ack.derived_events ?? [];
    const tc = evs.find((e) => {
      const p = e.payload as { variant?: string };
      return e.topic === 'lich.sandbox.executed' && p.variant === 'tool-confirm-live';
    });
    expect(tc).toBeUndefined();
  });

  it('flag ON + cache hit: runner not called twice for identical (schema, args)', async () => {
    let runnerCalls = 0;
    configureLich({
      m5_tool_confirm_live: true,
      m5_replay_run_mode: 'in-process',
      m5_time_budget_ms: 4000,
      m5_replay_cache: new ReplayCache(8),
      m5_transport_factory: () => ({
        send: async () => { /* no-op */ },
        // eslint-disable-next-line require-yield
        recv: async function* (): AsyncIterableIterator<JsonRpcMessage> { return; },
      }),
      m5_tool_confirm_live_runner: async (): Promise<ToolConfirmResult> => {
        runnerCalls++;
        return { failed: false, ok: true, differences: [], elapsed_ms: 7 };
      },
    });

    const event = makeEvent({
      tool_schema: { name: 't', description: 'clean', inputSchema: { properties: {} } },
      tool: 'weather',
      args: { city: 'Berlin' },
      response: { content: [{ type: 'text', text: 'ok' }] },
    });

    const ack1 = await lichAdapter.onPhase(event, ctx);
    expect(ack1.status).toBe('ack');
    expect(runnerCalls).toBe(1);

    const ack2 = await lichAdapter.onPhase(event, ctx);
    expect(ack2.status).toBe('ack');
    expect(runnerCalls).toBe(1); // cache hit — runner NOT called again
    const evs = ack2.derived_events ?? [];
    const tc = evs.find((e) => {
      const p = e.payload as { variant?: string };
      return e.topic === 'lich.sandbox.executed' && p.variant === 'tool-confirm-live';
    });
    expect(tc).toBeDefined();
    const p = tc!.payload as { cache_hit?: boolean };
    expect(p.cache_hit).toBe(true);
  });

  it('flag ON + diverging replay: ack flagged degraded with diff summary', async () => {
    configureLich({
      m5_tool_confirm_live: true,
      m5_replay_run_mode: 'in-process',
      m5_time_budget_ms: 4000,
      m5_replay_cache: new ReplayCache(8),
      m5_transport_factory: (_d: ServerDescriptor) =>
        makeStubTransport({ content: [{ type: 'text', text: 'different' }] }),
    });

    const ack = await lichAdapter.onPhase(makeEvent({
      tool_schema: { name: 't', description: 'clean', inputSchema: { properties: {} } },
      tool: 'weather',
      args: { city: 'Berlin' },
      response: { content: [{ type: 'text', text: 'original' }] },
    }), ctx);
    expect(ack.status).toBe('ack');
    expect(ack.degraded).toBe(true);
    expect(ack.reason).toContain('lich-tool-confirm-live-divergence');
  });

  it('flag ON + transportFactory not configured: skips replay', async () => {
    configureLich({ m5_tool_confirm_live: true /* no factory */ });
    const ack = await lichAdapter.onPhase(makeEvent({
      tool_schema: { name: 't', description: 'clean', inputSchema: { properties: {} } },
      tool: 'weather',
      args: { city: 'Berlin' },
      response: { content: [{ type: 'text', text: 'ok' }] },
    }), ctx);
    expect(ack.status).toBe('ack');
    const evs = ack.derived_events ?? [];
    const tc = evs.find((e) => {
      const p = e.payload as { variant?: string };
      return e.topic === 'lich.sandbox.executed' && p.variant === 'tool-confirm-live';
    });
    expect(tc).toBeUndefined();
  });

  it('flag ON + sandbox failure: ack marked degraded (fail-open)', async () => {
    configureLich({
      m5_tool_confirm_live: true,
      m5_replay_run_mode: 'in-process',
      m5_replay_cache: new ReplayCache(8),
      m5_transport_factory: (): LiveReplayTransport => makeStubTransport({}),
      m5_tool_confirm_live_runner: async (): Promise<ToolConfirmResult> => ({
        failed: true,
        reason: 'spawn-error',
        detail: 'forced',
        elapsed_ms: 12,
      }),
    });

    const ack = await lichAdapter.onPhase(makeEvent({
      tool_schema: { name: 't', description: 'clean', inputSchema: { properties: {} } },
      tool: 'weather',
      args: { city: 'Berlin' },
      response: { content: [{ type: 'text', text: 'ok' }] },
    }), ctx);
    expect(ack.status).toBe('ack');
    expect(ack.degraded).toBe(true);
    expect(ack.reason).toContain('lich-tool-confirm-live-spawn-error');
  });

  it('cache-key digest: same args, different schemas → distinct entries', () => {
    const cache = getLichReplayCache();
    cache.clear();
    expect(cache.size()).toBe(0);
    // Indirect: two onPhase calls with different tool_schema fields and same
    // args should both end up in the cache.
    // Driven via the runner-counting path.
    let runnerCalls = 0;
    configureLich({
      m5_tool_confirm_live: true,
      m5_replay_run_mode: 'in-process',
      m5_replay_cache: cache,
      m5_transport_factory: () => makeStubTransport({}),
      m5_tool_confirm_live_runner: async (): Promise<ToolConfirmResult> => {
        runnerCalls++;
        return { failed: false, ok: true, differences: [], elapsed_ms: 1 };
      },
    });

    return Promise.all([
      lichAdapter.onPhase(makeEvent({
        tool_schema: { name: 't', description: 'A' },
        tool: 'weather',
        args: { city: 'Berlin' },
        response: {},
      }), ctx),
      lichAdapter.onPhase(makeEvent({
        tool_schema: { name: 't', description: 'B' }, // different schema
        tool: 'weather',
        args: { city: 'Berlin' },                      // same args
        response: {},
      }), ctx),
    ]).then(() => {
      expect(runnerCalls).toBe(2);
      expect(cache.size()).toBe(2);
    });
  });
});
