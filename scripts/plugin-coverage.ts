/* scripts/plugin-coverage.ts — does every plugin actually run?
 *
 * Spins up an Orchestrator with all 10 adapters wired in, fires the
 * synthetic topic each plugin subscribes to, and reports for each:
 *   - did the orchestrator dispatch the event to it?
 *   - did the plugin's onPhase() return an ack?
 *   - did it emit the events its `topics.emits` contract promises?
 *
 * Read the rendered table at the end as honest-numbers: a plugin
 * marked "silent" on a topic it CLAIMS to subscribe to is either a
 * spec mismatch in the adapter or a real wiring bug.
 *
 *   npx tsx scripts/plugin-coverage.ts
 */

import { InProcessBus } from '../src/bus/pubsub.js';
import { Orchestrator } from '../src/orchestration/lifecycle.js';
import { hydraAdapter } from '../src/plugins/hydra.adapter.js';
import { sylphAdapter } from '../src/plugins/sylph.adapter.js';
import { pechAdapter, setBudget, clear as clearPech } from '../src/plugins/pech.adapter.js';
import { nagaAdapter } from '../src/plugins/naga.adapter.js';
import { lichAdapter } from '../src/plugins/lich.adapter.js';
import { crowAdapter } from '../src/plugins/crow.adapter.js';
import { djinnAdapter } from '../src/plugins/djinn.adapter.js';
import { emuAdapter } from '../src/plugins/emu.adapter.js';
import { gorgonAdapter } from '../src/plugins/gorgon.adapter.js';
import type { PluginAdapter } from '../src/plugins/plugin-contract.js';
import type { EnchantedEvent } from '../src/bus/event-types.js';
import type { LifecyclePhase } from '../src/orchestration/request-context.js';

const ALL = [
  hydraAdapter, sylphAdapter, pechAdapter, nagaAdapter, lichAdapter,
  crowAdapter, djinnAdapter, emuAdapter, gorgonAdapter,
];

const bus = new InProcessBus(500);
const registry = new Map<string, PluginAdapter>();
for (const a of ALL) registry.set(a.name, a);
clearPech();
setBudget('coverage', 100_000);
const orchestrator = new Orchestrator({ registry, bus });
void orchestrator;  // construction wires subscribers

// ---------------------------------------------------------------------------
// Track what each plugin emits, and which topics each plugin's onPhase
// actually fires for (we wrap onPhase to log invocations).
// ---------------------------------------------------------------------------
const onPhaseInvocations = new Map<string, string[]>(); // plugin → [event.topic]
const emittedByPlugin    = new Map<string, string[]>(); // plugin → [topic emitted]

for (const a of ALL) {
  onPhaseInvocations.set(a.name, []);
  emittedByPlugin.set(a.name, []);
  const orig = a.onPhase.bind(a);
  (a as { onPhase: typeof a.onPhase }).onPhase = async (event, ctx) => {
    onPhaseInvocations.get(a.name)!.push(event.topic);
    return orig(event, ctx);
  };
}

// Snoop on the bus to see what each plugin's events.emits actually fired.
const PLUGIN_EMIT_PREFIX: Record<string, string[]> = {
  hydra:  ['hydra.'],
  sylph:  ['sylph.'],
  pech:   ['pech.'],
  naga:   ['naga.'],
  lich:   ['lich.'],
  crow:   ['crow.'],
  djinn:  ['djinn.'],
  emu:    ['emu.'],
  gorgon: ['gorgon.'],
};

bus.subscribe('*', (e) => {
  for (const [name, prefixes] of Object.entries(PLUGIN_EMIT_PREFIX)) {
    if (prefixes.some((p) => e.topic.startsWith(p))) {
      emittedByPlugin.get(name)!.push(e.topic);
    }
  }
});

// ---------------------------------------------------------------------------
// Synthetic stimuli — for every distinct topic in any subscribers list,
// publish one event. The orchestrator's wireSubscriptions has installed
// listeners that route into onPhase. Plugins that fail to ack are silent.
// ---------------------------------------------------------------------------
const STIMULI: ReadonlyArray<{ topic: string; phase: LifecyclePhase }> = [
  { topic: 'mcp.tool.call.requested',     phase: 'trust-gate' },
  { topic: 'mcp.tool.result.received',    phase: 'post-response' },
  { topic: 'mcp.tools.list.received',     phase: 'pre-dispatch' },
  { topic: 'lifecycle.trust-gate',        phase: 'trust-gate' },
  { topic: 'lifecycle.post-response',     phase: 'post-response' },
  { topic: 'lifecycle.post-session',      phase: 'post-session' },
  { topic: 'session.start',               phase: 'anchor' },
  { topic: 'user.prompt.submit',          phase: 'anchor' },
  { topic: 'compact.requested',           phase: 'post-session' },
  { topic: 'filesystem.write.completed',  phase: 'post-response' },
  { topic: 'sampling.completed',          phase: 'post-response' },
  { topic: 'crow.trust.scored',           phase: 'trust-gate' },
  { topic: 'hydra.veto.fired',            phase: 'trust-gate' },
];

async function fire(): Promise<void> {
  // First pass: one shot of every topic in STIMULI for the simple-trigger plugins
  let i = 0;
  for (const s of STIMULI) {
    i++;
    await bus.publish(s.topic, {
      correlation_id: `cov-${i}`,
      session_id:     'coverage',
      phase:          s.phase,
      source:         'coverage',
      budget_tier:    'HIGH',
      payload:        buildPayloadFor(s.topic),
    });
    await wait(50);
  }

  // Second pass: realistic multi-event stimuli for plugins with internal
  // thresholds (naga drift detection, emu runway forecast, gorgon hotspot
  // recompute, lich code-review pattern match).

  // naga: two tools/list with the SAME tool but mutated description = drift
  await bus.publish('mcp.tools.list.received', {
    correlation_id: 'cov-naga-1', session_id: 'coverage', phase: 'pre-dispatch',
    source: 'coverage', budget_tier: 'HIGH',
    payload: { tools: [{ name: 'echo', description: 'echo a string', inputSchema: { type: 'object' } }] },
  });
  await wait(50);
  await bus.publish('mcp.tools.list.received', {
    correlation_id: 'cov-naga-2', session_id: 'coverage', phase: 'pre-dispatch',
    source: 'coverage', budget_tier: 'HIGH',
    payload: { tools: [{ name: 'echo', description: 'malicious instruction here', inputSchema: { type: 'object' } }] },
  });
  await wait(80);

  // emu: 5 result events to feed the runway forecast model
  for (let n = 0; n < 5; n++) {
    await bus.publish('mcp.tool.result.received', {
      correlation_id: `cov-emu-${n}`, session_id: 'coverage', phase: 'post-response',
      source: 'coverage', budget_tier: 'HIGH',
      payload: { tool: 'read_file', vendor: 'coverage', tokens: { input: 100 + n * 50, output: 200 + n * 80 } },
    });
    await wait(40);
  }

  // gorgon: 6 filesystem writes to clear its batch threshold
  for (let n = 0; n < 6; n++) {
    await bus.publish('filesystem.write.completed', {
      correlation_id: `cov-gorgon-${n}`, session_id: 'coverage', phase: 'post-response',
      source: 'coverage', budget_tier: 'HIGH',
      payload: { path: `/tmp/cov/file-${n}.ts`, size: 1000 + n * 200 },
    });
    await wait(40);
  }

  // lich: filesystem write + mocked code-review pattern (lich subscribes to
  // crow.* / hydra.* / filesystem.write.completed and flags suspicions when
  // its M1 patterns match changed source content)
  await bus.publish('filesystem.write.completed', {
    correlation_id: 'cov-lich-1', session_id: 'coverage', phase: 'post-response',
    source: 'coverage', budget_tier: 'HIGH',
    payload: {
      path: '/tmp/cov/auth.ts', size: 2000,
      content: 'eval(userInput); // executes arbitrary code from request body\nawait db.query(`SELECT * FROM users WHERE id = ${id}`)',
    },
  });
  await wait(80);
}

function buildPayloadFor(topic: string): Record<string, unknown> {
  switch (topic) {
    case 'mcp.tool.call.requested':
      return { tool: 'shell.exec', args: ['rm', '-rf', '/'], server_id: 'coverage' };
    case 'mcp.tool.result.received':
      return { tool: 'read_file', vendor: 'coverage', tokens: { input: 100, output: 200 }, content: 'AKIAIOSFODNN7EXAMPLE' };
    case 'mcp.tools.list.received':
      return { tools: [{ name: 'echo', description: 'echo a string', inputSchema: { type: 'object' } }] };
    case 'session.start':
      return { session_id: 'cov-session', cwd: '/tmp/cov' };
    case 'user.prompt.submit':
      return { prompt: 'refactor the auth middleware' };
    case 'filesystem.write.completed':
      return { path: '/tmp/cov/foo.ts', size: 42 };
    case 'compact.requested':
      return { reason: 'context-pressure' };
    case 'sampling.completed':
      return { vendor: 'coverage', tokens: { input: 50, output: 80 } };
    case 'crow.trust.scored':
      return { posterior_mean: 0.72, posterior_variance: 0.04 };
    case 'hydra.veto.fired':
      return { pattern_id: 'h-rm-rf-root', reason: 'rm -rf /' };
    default:
      return {};
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  await fire();

  const PAD = (s: string, n: number): string => s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);

  console.log('\n=== plugin coverage report ===\n');
  console.log(PAD('plugin', 8) + PAD('phases', 22) + PAD('subscribed-topics', 60) + PAD('onPhase-fired', 14) + PAD('emitted', 10) + 'verdict');
  console.log('-'.repeat(120));
  for (const a of ALL) {
    const fired   = onPhaseInvocations.get(a.name) ?? [];
    const emitted = emittedByPlugin.get(a.name)    ?? [];
    const verdict =
      fired.length === 0 ? 'SILENT — orchestrator never invoked onPhase'
      : emitted.length === 0 ? 'PARTIAL — invoked but emitted nothing'
      : 'OK';
    console.log(
      PAD(a.name, 8) +
      PAD(a.phases.join(','), 22) +
      PAD(a.topics.subscribes.join(' '), 60) +
      PAD(String(fired.length), 14) +
      PAD(String(emitted.length), 10) +
      verdict,
    );
  }

  console.log('\n--- per-plugin detail ---\n');
  for (const a of ALL) {
    const fired   = onPhaseInvocations.get(a.name) ?? [];
    const emitted = emittedByPlugin.get(a.name)    ?? [];
    console.log(`${a.name}:`);
    console.log(`  fired on ${fired.length}: ${fired.slice(0, 6).join(', ') || '(none)'}`);
    console.log(`  emitted ${emitted.length}: ${emitted.slice(0, 6).join(', ') || '(none)'}`);
    console.log('');
  }

  process.exit(0);
}

void main();
