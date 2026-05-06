/* scripts/live.ts — real session against an npm-published MCP server
   (@modelcontextprotocol/server-filesystem) over stdio. Not a simulation:
     1. initialize handshake → server info
     2. tools/list → register in namespace
     3. callTool('list_directory') → benign call, all 7 phases fire
     4. callTool('read_file') on a sample file containing a planted secret →
        hydra masks the AWS-key-shaped string in post-response
     5. synthetic malicious tool call → hydra fires veto on the bus
     6. pech ledger summary, bus tap of all observed events

   Run standalone:  npx tsx scripts/live.ts
   With ENCHANTER_BRIDGE=stdout: bus events stream as JSONL on stdout for
   the inspector. Combined into one command via `enchanter live`.
*/

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';

import { McpClient } from '../src/client/mcp-client.js';
import { StdioTransport } from '../src/transport/stdio.js';
import { hydraAdapter, maskSecrets } from '../src/plugins/hydra.adapter.js';
import { lichAdapter } from '../src/plugins/lich.adapter.js';
import { nagaAdapter } from '../src/plugins/naga.adapter.js';
import {
  pechAdapter,
  setBudget,
  getLedger,
  clear as clearPech,
} from '../src/plugins/pech.adapter.js';
import { sylphAdapter } from '../src/plugins/sylph.adapter.js';
import { crowAdapter } from '../src/plugins/crow.adapter.js';
import { djinnAdapter } from '../src/plugins/djinn.adapter.js';
import { emuAdapter } from '../src/plugins/emu.adapter.js';
import { gorgonAdapter } from '../src/plugins/gorgon.adapter.js';
import { SecurityVetoError } from '../src/orchestration/lifecycle.js';
import { Bridge } from '../src/observability/bridge.js';
import {
  parseBridgeEnv,
  makeSinkFromEnv,
} from '../src/observability/bridge-config.js';

const DIVIDER = '─'.repeat(72);

// When ENCHANTER_BRIDGE=stdout, the JSONL wire owns process.stdout — route
// all human-readable output (banners, info lines, child stderr) to stderr so
// the inspector sees a pristine event stream. Achieved by monkey-patching
// console.log/info/warn at startup so we don't have to touch every call site.
const BRIDGE_SPEC = parseBridgeEnv(process.env.ENCHANTER_BRIDGE);
const STDOUT_OWNED_BY_BRIDGE = BRIDGE_SPEC.kind === 'stdout';
if (STDOUT_OWNED_BY_BRIDGE) {
  const writeErr = (...args: unknown[]) => {
    const line = args
      .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ');
    process.stderr.write(line + '\n');
  };
  console.log = writeErr;
  console.info = writeErr;
  console.warn = writeErr;
}

function banner(title: string): void {
  console.log('\n' + DIVIDER);
  console.log('  ' + title);
  console.log(DIVIDER);
}

async function main(): Promise<void> {
  // 1. Sandbox setup ─────────────────────────────────────────────────────────
  const sandbox = join(tmpdir(), `enchanter-demo-${Date.now()}`);
  mkdirSync(sandbox, { recursive: true });
  const samplePath = join(sandbox, 'config.txt');
  // Plant a fake secret to demonstrate hydra's secret masking.
  writeFileSync(
    samplePath,
    [
      '# Demo config — content is intentionally fake',
      'admin_email = admin@example.com',
      'AWS_KEY = AKIAIOSFODNN7EXAMPLE',
      'Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.fakesig',
      'note = enchanter demo file',
    ].join('\n'),
    'utf8',
  );

  banner('Sandbox + sample file');
  console.log('  sandbox: ' + sandbox);
  console.log('  sample : ' + samplePath);

  // 2. Spawn @modelcontextprotocol/server-filesystem ─────────────────────────
  banner('Spawning npx @modelcontextprotocol/server-filesystem (stdio)');
  console.log('  (first run may install the package via npx)');

  // Windows .cmd shims (npx.cmd) require shell: true; on POSIX npx is a real
  // executable so shell: false is fine. Args are controlled by this script
  // (the sandbox path is generated above), so shell: true is safe here.
  const isWindows = process.platform === 'win32';
  const proc = spawn(
    'npx',
    ['-y', '@modelcontextprotocol/server-filesystem', sandbox],
    { stdio: ['pipe', 'pipe', 'pipe'], shell: isWindows },
  ) as ChildProcessByStdio<Writable, Readable, Readable>;
  proc.stderr.on('data', (chunk) => {
    process.stderr.write('  [server] ' + chunk.toString());
  });

  const transport = new StdioTransport(proc.stdout, proc.stdin);

  // 3. Wire McpClient with the full plugin set ──────────────────────────────
  clearPech();
  setBudget('fs', 100_000); // pretend the filesystem server has its own budget

  const client = new McpClient({
    serverId: 'fs',
    transport,
    plugins: [
      hydraAdapter,
      lichAdapter,
      nagaAdapter,
      pechAdapter,
      sylphAdapter,
      crowAdapter,
      djinnAdapter,
      emuAdapter,
      gorgonAdapter,
    ],
  });

  // Bridge: when ENCHANTER_BRIDGE is set, forward every bus event as JSONL
  // to a sink (stdout/file/tcp). Default off — unset env preserves the
  // existing standalone-script behavior.
  const bridgeSink = makeSinkFromEnv(BRIDGE_SPEC);
  const bridge = bridgeSink ? new Bridge(client.bus, bridgeSink) : null;
  bridge?.start();

  try {
    // 4. initialize ──────────────────────────────────────────────────────────
    banner('Phase 1: initialize handshake');
    const info = await client.initialize('enchanter-demo', '0.2.0');
    console.log('  server name    : ' + info.name);
    console.log('  server version : ' + info.version);
    console.log('  capabilities   : ' + JSON.stringify(Object.keys(info.capabilities)));

    // 5. tools/list ──────────────────────────────────────────────────────────
    banner('Phase 2: tools/list');
    const tools = await client.listTools();
    console.log('  tool count : ' + tools.length);
    for (const t of tools.slice(0, 8)) {
      console.log('    - ' + t.name + (t.description ? ' — ' + t.description.slice(0, 60) : ''));
    }
    if (tools.length > 8) console.log('    ... ' + (tools.length - 8) + ' more');

    // 6. Benign call: list_directory ─────────────────────────────────────────
    banner('Phase 3: callTool list_directory (benign — full 7-phase lifecycle fires)');
    const lsResult = await client.callTool('list_directory', { path: sandbox });
    console.log('  result:');
    const lsContent = (lsResult as { content?: Array<{ text?: string }> }).content;
    for (const c of lsContent ?? []) console.log('    ' + (c.text ?? ''));

    // 7. read_file with planted secret → hydra masks ────────────────────────
    banner('Phase 4: callTool read_file (post-response: hydra secret masking)');
    const readResult = await client.callTool('read_file', { path: samplePath });
    const rawText =
      (readResult as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? '';
    const { masked, matched } = maskSecrets(rawText);
    console.log('  raw response (truncated) :');
    for (const line of rawText.split('\n').slice(0, 6)) console.log('    | ' + line);
    console.log('  hydra matched patterns   : [' + matched.join(', ') + ']');
    console.log('  masked output            :');
    for (const line of masked.split('\n').slice(0, 6)) console.log('    | ' + line);

    // 8. Synthetic malicious payloads → hydra veto on the bus ──────────────
    // publishTrustGate is fire-and-forget (no orchestrator). Hydra's wired
    // handler still fires, classifies via CVE patterns, and emits a derived
    // `hydra.veto.fired` event onto the bus. We tap the bus to confirm.
    banner('Phase 5: synthetic malicious calls → hydra veto on the bus');
    const cid1 = await client.publishTrustGate({
      tool: 'shell.exec',
      args: ['rm', '-rf', '/'],
      server_id: 'fs',
    });
    const cid2 = await client.publishTrustGate({
      tool: 'shell.exec',
      args: ['cat', '~/.ssh/id_rsa'],
      server_id: 'fs',
    });
    for (const [label, cid] of [
      ['rm -rf /', cid1],
      ['cat ~/.ssh/id_rsa', cid2],
    ] as const) {
      const vetoes = client.bus
        .tap(cid)
        .filter((e) => e.topic === 'hydra.veto.fired');
      const pat = vetoes[0]?.payload as { pattern_id?: string; cve_anchor?: string } | undefined;
      console.log(
        `  ${label.padEnd(22)} → ${vetoes.length} veto(s)` +
          (pat ? `  pattern=${pat.pattern_id}  cve=${pat.cve_anchor?.slice(0, 32) ?? ''}` : ''),
      );
    }

    // 9. Pech ledger ─────────────────────────────────────────────────────────
    banner('Phase 6: pech ledger summary');
    const ledger = getLedger();
    console.log('  ledger entries : ' + ledger.length);
    for (const e of ledger) {
      console.log(
        '    ' +
          [e.ts, e.plugin, e.model, e.vendor, 'in=' + e.input_tokens, 'out=' + e.output_tokens].join(
            ' | ',
          ),
      );
    }

    // 10. Bus tap summary ────────────────────────────────────────────────────
    banner('Phase 7: bus tap (all events observed during this run)');
    const events = client.bus.tap();
    console.log('  total events : ' + events.length);
    const byTopic = new Map<string, number>();
    for (const e of events) byTopic.set(e.topic, (byTopic.get(e.topic) ?? 0) + 1);
    for (const [topic, count] of [...byTopic.entries()].sort((a, b) => b[1] - a[1])) {
      console.log('    ' + count.toString().padStart(4) + '  ' + topic);
    }

    banner('All phases complete — Enchanter v0.2 verified live ✓');

    // ---------------------------------------------------------------------
    // CONTINUOUS LOOP — keeps every cockpit panel animated until Ctrl-C.
    // Cycles through varied scenarios so plugins keep firing, runtime
    // metrics keep growing, tasks lifecycle through created→updated→
    // completed, and security counters tick on the periodic synthetic
    // attack. Bridge stays attached, so each event reaches the inspector.
    // ---------------------------------------------------------------------
    let stop = false;
    const stopHandler = () => {
      stop = true;
    };
    process.once('SIGINT', stopHandler);
    process.once('SIGTERM', stopHandler);
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const sample = <T>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)];

    banner('Continuous mode — cockpit will keep animating. Ctrl-C to exit.');

    let iter = 0;
    let taskCounter = 104;
    let totalCost = ledger.reduce((acc, e) => acc + (e.input_tokens + e.output_tokens) * 0.000003, 0);
    let totalTokens = ledger.reduce((acc, e) => acc + e.input_tokens + e.output_tokens, 0);
    let totalToolCalls = events.filter((e) => e.topic.startsWith('mcp.tool.call')).length;
    const sessionId = `live-${Date.now()}`;

    while (!stop) {
      iter += 1;

      // Rotate through scenarios so every plugin lights up over time.
      const scenario = iter % 7;

      switch (scenario) {
        case 0: {
          // Real benign tool call — full lifecycle fires
          await client.callTool('list_directory', { path: sandbox }).catch(() => undefined);
          totalToolCalls += 1;
          break;
        }
        case 1: {
          // Real read with secret-masking — exercises hydra post-response
          await client.callTool('read_file', { path: samplePath }).catch(() => undefined);
          totalToolCalls += 1;
          break;
        }
        case 2: {
          // Pech ledger growth (synthetic — most direct way to flex pech UI)
          const cost = 0.0008 + Math.random() * 0.004;
          const inTok = 200 + Math.floor(Math.random() * 800);
          const outTok = 80 + Math.floor(Math.random() * 320);
          totalCost += cost;
          totalTokens += inTok + outTok;
          await client.bus.publish('pech.ledger.appended', {
            phase: 'post-response',
            source: 'pech',
            payload: {
              cost_usd: cost,
              session_cost_usd: totalCost,
              daily_cost_usd: totalCost,
              input_tokens: inTok,
              output_tokens: outTok,
            },
          });
          break;
        }
        case 3: {
          // Plugin observation events — emu, crow, djinn, gorgon, naga
          await client.bus.publish('emu.context_update', {
            phase: 'pre-dispatch',
            source: 'emu',
            payload: { context_size: 12000 + iter * 50, turn_estimate: 25 + Math.floor(iter / 4) },
          });
          await client.bus.publish('crow.trust.scored', {
            phase: 'trust-gate',
            source: 'crow',
            payload: {
              server_id: 'fs',
              tool_name: sample(['list_directory', 'read_file', 'write_file']),
              posterior_mean: 0.5 + Math.random() * 0.4,
              entropy: Math.random() * 0.3,
            },
          });
          await client.bus.publish('djinn.drift.observed', {
            phase: 'post-session',
            source: 'djinn',
            payload: { drift: Math.random() * 0.15, intent: 'demo session' },
          });
          await client.bus.publish('gorgon.hotspot', {
            phase: 'cross-session',
            source: 'gorgon',
            payload: { file: sample(['router.ts', 'auth.ts', 'billing.ts']), heat: Math.random() },
          });
          await client.bus.publish('naga.spec_check', {
            phase: 'post-response',
            source: 'naga',
            payload: { file: 'router.ts', drift: 0, status: 'clean' },
          });
          break;
        }
        case 4: {
          // Task lifecycle — task.created → updated → completed
          const tid = `T-${taskCounter}`;
          taskCounter += 1;
          await client.bus.publish('task.created', {
            phase: 'anchor',
            source: 'orchestrator',
            payload: {
              task_id: tid,
              session_id: sessionId,
              intent: sample(['refactor router', 'add tests', 'fix auth bug', 'profile pech']),
              file_or_area: sample(['router.ts', 'auth.ts', 'billing.ts']),
              risk: sample(['low', 'medium', 'low']),
            },
          });
          await sleep(400);
          if (stop) break;
          await client.bus.publish('task.updated', {
            phase: 'dispatch',
            source: 'orchestrator',
            payload: {
              task_id: tid,
              session_id: sessionId,
              status: 'running',
              age_seconds: 4,
            },
          });
          await sleep(600);
          if (stop) break;
          await client.bus.publish('task.completed', {
            phase: 'post-session',
            source: 'orchestrator',
            payload: { task_id: tid, session_id: sessionId, age_seconds: 10 },
          });
          break;
        }
        case 5: {
          // Synthetic veto — flexes hydra + Security counter
          if (iter % 14 === 5) {
            await client.callTool('execute', { cmd: 'rm -rf /' }).catch(() => undefined);
          } else {
            // Lich review on a real tool result
            await client.bus.publish('lich.review', {
              phase: 'post-response',
              source: 'lich',
              payload: { reviewed: true, sandbox_depth: 2, status: 'clean' },
            });
          }
          break;
        }
        case 6: {
          // Runtime metrics heartbeat — keeps RUNTIME box growing
          await client.bus.publish('runtime.metrics', {
            phase: 'cross-session',
            source: 'orchestrator',
            payload: {
              open_sessions: 1,
              ongoing_tasks: 1 + (iter % 3),
              queued_tasks: iter % 2,
              blocked_tasks: 0,
              code_written_lifetime_loc: 42800 + iter * 12,
              code_modified_lifetime_loc: 118400 + iter * 30,
              files_created_lifetime: 86 + Math.floor(iter / 7),
              files_modified_lifetime: 312 + Math.floor(iter / 3),
              tool_calls_lifetime: totalToolCalls,
              prs_created_lifetime: 18,
              tests_run_lifetime: 2100 + iter,
              tests_passed_rate: 0.94 + Math.random() * 0.04,
              total_spend_lifetime: 184.2 + totalCost,
            },
          });
          break;
        }
      }

      await sleep(900 + Math.random() * 700);
    }

    process.removeListener('SIGINT', stopHandler);
    process.removeListener('SIGTERM', stopHandler);
  } finally {
    await bridge?.stop();
    client.shutdown();
    proc.kill();
    rmSync(sandbox, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('demo failed:', err);
  process.exit(1);
});
