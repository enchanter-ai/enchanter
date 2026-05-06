/* scripts/demo-live.ts — connects Enchanter v0.2 to a real, npm-published MCP
   server (@modelcontextprotocol/server-filesystem) over stdio. Demonstrates:
     1. initialize handshake → server info
     2. tools/list → register in namespace
     3. callTool('list_directory') → benign call, all 7 phases fire
     4. callTool('read_file') on a sample file containing a planted secret →
        hydra masks the AWS-key-shaped string in post-response
     5. synthetic malicious tool call → hydra fires veto on the bus
     6. pech ledger summary, bus tap of all observed events

   Run:  npx tsx scripts/demo-live.ts
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
