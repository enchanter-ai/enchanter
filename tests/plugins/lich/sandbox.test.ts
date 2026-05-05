/* tests/plugins/lich/sandbox.test.ts — v0.3.1 #4 (M5 sandbox stub).
   Covers runSandboxedReview() happy path / timeout / worker-error and the
   adapter wire-up around the m5_sandbox config flag. */

import { describe, it, expect, afterEach } from 'vitest';
import { runSandboxedReview } from '../../../src/plugins/lich/sandbox.js';
import { lichAdapter, configureLich } from '../../../src/plugins/lich.adapter.js';
import { createRequestContext } from '../../../src/orchestration/request-context.js';
import type { EnchantedEvent } from '../../../src/bus/event-types.js';

const ctx = createRequestContext();

afterEach(() => {
  // Reset config so individual tests opt in without bleeding state.
  configureLich({ m5_sandbox: false, m5_time_budget_ms: 5000, m5_sandbox_runner: runSandboxedReview });
});

function makeEvent(payload: Record<string, unknown>): EnchantedEvent {
  return {
    id: 'sb-id', correlation_id: 'sb-corr', session_id: 'sb-sess',
    phase: 'post-response', topic: 'mcp.tool.result.received',
    source: 'orchestrator', budget_tier: 'HIGH', ts: Date.now(),
    payload,
  };
}

describe('runSandboxedReview — worker isolation', () => {
  it('happy path: simple code returns findings without failing', async () => {
    const result = await runSandboxedReview(
      'const x = process.env.HOME; console.log(x);',
      { time_budget_ms: 4000 },
    );
    expect(result.failed).toBe(false);
    if (!result.failed) {
      expect(result.findings.some((f) => f.id === 'env-read')).toBe(true);
      expect(result.score).toBeGreaterThan(0);
      expect(result.elapsed_ms).toBeGreaterThanOrEqual(0);
    }
  });

  it('happy path: clean code returns empty findings', async () => {
    const result = await runSandboxedReview(
      'const sum = (a, b) => a + b;\nconst out = sum(1, 2);',
      { time_budget_ms: 4000 },
    );
    expect(result.failed).toBe(false);
    if (!result.failed) {
      expect(result.findings).toEqual([]);
      expect(result.score).toBe(0);
    }
  });

  it('time budget: spinning worker is killed and returns timeout', async () => {
    const result = await runSandboxedReview('// payload ignored — worker is forced to spin', {
      time_budget_ms: 250,
      _force_spin: true,
    });
    expect(result.failed).toBe(true);
    if (result.failed) {
      expect(result.reason).toBe('timeout');
      expect(result.elapsed_ms).toBeGreaterThanOrEqual(250);
    }
    // Generous outer cap so vitest's 5s timeout never trips.
  }, 4000);

  it('crash: worker error returns worker-error reason (not throw)', async () => {
    const result = await runSandboxedReview('whatever', {
      time_budget_ms: 4000,
      _force_crash: true,
    });
    expect(result.failed).toBe(true);
    if (result.failed) {
      expect(result.reason).toBe('worker-error');
    }
  });
});

describe('lich adapter — m5_sandbox config flag wire-up', () => {
  it('sandbox flag OFF (default): no sandbox event produced', async () => {
    const ack = await lichAdapter.onPhase(makeEvent({
      tool_schema: { name: 't', description: 'clean', inputSchema: { properties: {} } },
      code: 'process.env.SECRET',
    }), ctx);
    expect(ack.status).toBe('ack');
    const evs = ack.derived_events ?? [];
    expect(evs.find((e) => e.topic === 'lich.sandbox.executed')).toBeUndefined();
  });

  it('sandbox flag ON: produces lich.sandbox.executed event', async () => {
    configureLich({ m5_sandbox: true, m5_time_budget_ms: 4000 });
    const ack = await lichAdapter.onPhase(makeEvent({
      tool_schema: { name: 't', description: 'clean', inputSchema: { properties: {} } },
      code: 'eval("malicious")',
    }), ctx);
    expect(ack.status).toBe('ack');
    const evs = ack.derived_events ?? [];
    const sandboxEv = evs.find((e) => e.topic === 'lich.sandbox.executed');
    expect(sandboxEv).toBeDefined();
    const p = sandboxEv!.payload as { failed: boolean; score?: number };
    expect(p.failed).toBe(false);
    expect(p.score).toBeGreaterThan(0);
  });

  it('sandbox failure marks ack as degraded (fail-open)', async () => {
    configureLich({
      m5_sandbox: true,
      m5_sandbox_runner: async () => ({
        failed: true,
        reason: 'timeout',
        detail: 'forced',
        elapsed_ms: 12,
      }),
    });
    const ack = await lichAdapter.onPhase(makeEvent({
      tool_schema: { name: 't', description: 'clean', inputSchema: { properties: {} } },
      code: 'const x = 1;',
    }), ctx);
    expect(ack.status).toBe('ack');
    expect(ack.degraded).toBe(true);
    expect(ack.reason).toContain('lich-sandbox-timeout');
    const sb = (ack.derived_events ?? []).find((e) => e.topic === 'lich.sandbox.executed');
    expect(sb).toBeDefined();
    expect((sb!.payload as { failed: boolean }).failed).toBe(true);
  });

  it('sandbox flag ON + no code in payload: no sandbox event produced', async () => {
    configureLich({ m5_sandbox: true });
    const ack = await lichAdapter.onPhase(makeEvent({
      tool_schema: { name: 't', description: 'clean', inputSchema: { properties: {} } },
    }), ctx);
    expect(ack.status).toBe('ack');
    const evs = ack.derived_events ?? [];
    expect(evs.find((e) => e.topic === 'lich.sandbox.executed')).toBeUndefined();
  });
});
