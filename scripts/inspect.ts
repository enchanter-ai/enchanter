/* scripts/inspect.ts — Enchanter SDK CLI Inspector v0.4 (boxed redesign).

   Design ref: wixie/prompts/enchanter-monitor-redesign/prompt.md
   - §2 layout: rounded outer frame with embedded title + mode + hints; 4-6
     golden-signal cards (sharp inner corners); plugins | events split using
     outer frame's │ as the divider; single phase bar; mode-pill footer.
   - §7 mascot: tiny 4×9 block-art rendered inline left of the title on every
     frame; larger 10×14 welcome mascot rendered at boot.
   - Datadog/Google-SRE: ≤12 informational regions, top = "what", bottom =
     "why", actionable signals only.

   Architecture-spec refs:
   - phase_2 ADR-001 (7-phase orchestrator lifecycle) → phase bar
   - phase_5.cost_attribution_unit (pech ledger) → spent card
   - phase_6.observability (event-stream tap) → events panel + plugins panel
   - phase_1_plugin_role_mapping (10 plugins) → plugins panel rows

   Run:  npx tsx scripts/inspect.ts
*/

import { spawn, type ChildProcessByStdio, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';

import { McpClient } from '../src/client/mcp-client.js';
import { StdioTransport } from '../src/transport/stdio.js';
import { hydraAdapter }                        from '../src/plugins/hydra.adapter.js';
import { lichAdapter }                         from '../src/plugins/lich.adapter.js';
import { nagaAdapter }                         from '../src/plugins/naga.adapter.js';
import { pechAdapter, setBudget, clear as clearPech } from '../src/plugins/pech.adapter.js';
import { sylphAdapter }                        from '../src/plugins/sylph.adapter.js';
import { crowAdapter }                         from '../src/plugins/crow.adapter.js';
import { djinnAdapter }                        from '../src/plugins/djinn.adapter.js';
import { emuAdapter }                          from '../src/plugins/emu.adapter.js';
import { gorgonAdapter }                       from '../src/plugins/gorgon.adapter.js';
import { subscribeNotifier }                   from '../src/observability/notifier.js';

import type { EnchantedEvent } from '../src/bus/event-types.js';
import type { LifecyclePhase } from '../src/orchestration/request-context.js';
import {
  A,
  renderPhaseBar,
  formatEventLine,
  makeTuiCounters,
  trackAll,
  renderPlugins,
  renderGoldenSignals,
  topBorder,
  bottomBorder,
  frameRow,
  frameEmpty,
  headerMode,
  headerHints,
  brandedTitle,
  footerPill,
  renderHelpLines,
  renderScrollIndicator,
  stripAnsi,
  visWidth,
  padVis,
  truncVis,
  diffFrames,
  SparkRing,
  makePluginActivityMeta,
  SPARKLINE_SAMPLES,
  type TuiCounters,
  type SidebarSort,
  type InputMode,
  type PluginActivityMeta,
  type GoldenSignals,
} from '../src/observability/cli-renderer.js';

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------
const RING_BUFFER_SIZE     = 1000;
const RENDER_THROTTLE_MS   = 16;     // ~60fps cap
const SAMPLE_INTERVAL_MS   = 1000;   // sparkline sample cadence
const MAX_VISIBLE_EVENTS   = 8;      // §2: events panel max 8 lines
const PHASE_LATENCY_WINDOW = 50;     // p99 over last 50 phases

// ---------------------------------------------------------------------------
// MCP session
// ---------------------------------------------------------------------------
interface McpSession {
  client:  McpClient;
  proc:    ChildProcess;
  sandbox: string;
  samplePath: string;
}
let session: McpSession | null = null;

// ---------------------------------------------------------------------------
// Lifecycle phase order
// ---------------------------------------------------------------------------
const LIFECYCLE_PHASE_ORDER: LifecyclePhase[] = [
  'anchor', 'trust-gate', 'pre-dispatch', 'dispatch',
  'post-response', 'post-session', 'cross-session',
];

// ---------------------------------------------------------------------------
// Sparkline rings — one per plugin
// ---------------------------------------------------------------------------
type PluginKey = keyof TuiCounters;

const PLUGIN_KEYS: PluginKey[] = [
  'pech', 'emu', 'hydra', 'sylph', 'lich', 'naga', 'crow', 'djinn', 'gorgon',
];

const sparks = new Map<PluginKey, SparkRing>(
  PLUGIN_KEYS.map((k) => [k, new SparkRing(SPARKLINE_SAMPLES)]),
);
const sparkAccum = new Map<PluginKey, number>(
  PLUGIN_KEYS.map((k) => [k, 0]),
);
const sparkValues = new Map<PluginKey, number | null>(
  PLUGIN_KEYS.map((k) => [k, null]),
);

// ---------------------------------------------------------------------------
// Inspector state
// ---------------------------------------------------------------------------
interface InspectorState {
  startMs:         number;
  currentPhase:    LifecyclePhase | null;
  completedPhases: Set<LifecyclePhase>;
  currentCorrelId: string;
  currentLabel:    string;
  callStartMs:     number;
  ringBuffer:      EnchantedEvent[];
  totalEvents:     number;
  counters:        TuiCounters;
  mode:            'idle' | 'running' | 'subprocess';
  subprocLabel:    string;
  prevFrame:       string[];
  frameCount:      number;
  paused:          boolean;
  pendingEvents:   EnchantedEvent[];
  filter:          string;
  sort:            SidebarSort;
  inputMode:       InputMode;
  filterDraft:     string;
  scrollBack:      number;
  meta:            PluginActivityMeta;
  // Golden-signal accumulators
  phaseLatencies:  number[];   // last N phase wall-times in ms
  phaseStartMs:    number;     // latest phase enter timestamp
  errCount:        number;
  // LIVE-indicator blink phase (0..7, advanced ~250ms)
  blinkPhase:      number;
}

function makeState(): InspectorState {
  return {
    startMs:         Date.now(),
    currentPhase:    null,
    completedPhases: new Set(),
    currentCorrelId: '—',
    currentLabel:    'idle',
    callStartMs:     Date.now(),
    ringBuffer:      [],
    totalEvents:     0,
    counters:        makeTuiCounters(),
    mode:            'idle',
    subprocLabel:    '',
    prevFrame:       [],
    frameCount:      0,
    paused:          false,
    pendingEvents:   [],
    filter:          '',
    sort:            'recent',
    inputMode:       'normal',
    filterDraft:     '',
    scrollBack:      0,
    meta:            makePluginActivityMeta(),
    phaseLatencies:  [],
    phaseStartMs:    0,
    errCount:        0,
    blinkPhase:      0,
  };
}

let state = makeState();

// ---------------------------------------------------------------------------
// Render scheduling — 60fps cap
// ---------------------------------------------------------------------------
let renderTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleRender(): void {
  if (renderTimer !== null) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    render();
  }, RENDER_THROTTLE_MS);
}

// ---------------------------------------------------------------------------
// Build golden-signal snapshot from current counters + accumulators.
// ---------------------------------------------------------------------------
function buildGoldenSignals(): GoldenSignals {
  const c = state.counters;
  const security =
    c.hydra.vetoes +
    c.sylph.destructiveVetoes +
    c.lich.suspicions +
    c.naga.driftAlerts;
  const drift = c.djinn.driftCount + c.emu.driftPatternCount;

  // p99 over phaseLatencies — author judgment: simple sort+pick at idx 99%.
  let p99: number | null = null;
  if (state.phaseLatencies.length >= 5) {
    const sorted = [...state.phaseLatencies].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99));
    p99 = sorted[idx] ?? null;
  }

  return {
    turnsMean:     c.emu.runwayMean,
    turnsCI:       c.emu.runwayCI,
    spentUsd:      c.pech.costUsd,
    securityCount: security,
    driftCount:    drift,
    p99Ms:         p99,
    errCount:      state.errCount,
  };
}

// ---------------------------------------------------------------------------
// Frame renderer — composes the boxed layout and emits diff to terminal.
// ---------------------------------------------------------------------------
function render(): void {
  const cols = process.stdout.columns ?? 120;
  const rows = process.stdout.rows    ?? 40;
  state.frameCount += 1;

  const W = Math.max(60, Math.min(cols, 200));  // outer frame width
  const lines: string[] = [];

  // ── Header (top border with embedded title + mode + hints) ──────────────
  const modeWord = headerMode({
    paused: state.paused,
    pendingCount: state.pendingEvents.length,
    filter: state.filter,
    sort: state.sort,
    scrollBack: state.scrollBack,
    blinkPhase: state.blinkPhase,
  });
  const titleText = `${brandedTitle()} ${A.label}─${A.reset} ${modeWord}`;
  const hintsText = headerHints();
  lines.push(topBorder(W, titleText, hintsText));
  lines.push(frameEmpty(W));

  // ── Golden-signal cards row (3 lines: top / mid / bot) ───────────────────
  const cardCount = W >= 100 ? 5 : 4; // §2 responsive: drop card 5-6 < 100 cols
  const cards = renderGoldenSignals(buildGoldenSignals(), cardCount);
  for (const c of cards) {
    lines.push(frameRow(W, `  ${c}`));
  }
  lines.push(frameEmpty(W));

  // ── Plugins | Events split ───────────────────────────────────────────────
  const wide = W >= 100;
  // Inner panels: account for outer frame chrome + a 1-char gutter each side.
  // Total inside width = W - 2.  Reserve 2 for left+right gutter spaces.
  const innerW = W - 4;
  const splitGap = 1;
  const pluginsW = wide ? Math.floor(innerW * 0.55) : innerW;
  const eventsW = wide ? innerW - pluginsW - splitGap : innerW;

  if (state.inputMode === 'help') {
    const help = renderHelpLines();
    const bodyRows = Math.min(help.length, 14);
    for (let i = 0; i < bodyRows; i++) {
      lines.push(frameRow(W, `  ${help[i] ?? ''}`));
    }
  } else {
    // Plugins panel header (rounded inner top)
    // We render the panels as sub-frames inside the outer.  For minimal noise,
    // we use a simple top label line then bare rows (§2: bare rows).
    const pluginRows = renderPlugins(
      state.counters,
      sparks,
      state.sort,
      state.meta,
      pluginsW - 2,
    );
    const eventRows = buildEventLines(eventsW - 2);

    // Inner panel headers (one row each, label-grey)
    const pluginsHeader = `${A.label}plugins${A.reset}`;
    const eventsHeader  = `${A.label}recent events${A.reset}`;
    if (wide) {
      lines.push(frameRow(W, ` ${padVis(pluginsHeader, pluginsW)} ${padVis(eventsHeader, eventsW)}`));
    } else {
      lines.push(frameRow(W, ` ${pluginsHeader}`));
    }

    const bodyRows = Math.max(pluginRows.length, eventRows.length, MAX_VISIBLE_EVENTS);
    const rowsToShow = Math.min(bodyRows, 11);
    for (let i = 0; i < rowsToShow; i++) {
      const left  = pluginRows[i] ?? '';
      const right = eventRows[i] ?? '';
      const leftPadded = padVis(truncVis(left, pluginsW), pluginsW);
      if (wide) {
        const rightPadded = padVis(truncVis(right, eventsW), eventsW);
        lines.push(frameRow(W, ` ${leftPadded} ${rightPadded}`));
      } else {
        lines.push(frameRow(W, ` ${leftPadded}`));
      }
    }
  }

  lines.push(frameEmpty(W));

  // ── Phase bar (single row) ───────────────────────────────────────────────
  const phaseBar = renderPhaseBar(state.currentPhase, state.completedPhases, state.frameCount);
  lines.push(frameRow(W, ` ${truncVis(phaseBar, W - 4)}`));

  lines.push(frameEmpty(W));

  // ── Bottom border with mode pill ─────────────────────────────────────────
  lines.push(bottomBorder(W, footerPill({
    paused: state.paused,
    pendingCount: state.pendingEvents.length,
    filter: state.filter,
    sort: state.sort,
    scrollBack: state.scrollBack,
    uptimeSec: (Date.now() - state.startMs) / 1000,
    totalEvents: state.totalEvents,
  })));

  // ── Pack into rows-tall frame buffer ─────────────────────────────────────
  const nextFrame: string[] = new Array(rows).fill('') as string[];
  for (let r = 0; r < Math.min(lines.length, rows); r++) {
    nextFrame[r] = lines[r] ?? '';
  }
  const delta = diffFrames(state.prevFrame, nextFrame);
  if (delta) process.stdout.write(delta);
  state.prevFrame = nextFrame;
}

// ---------------------------------------------------------------------------
// Visible events — applies filter + scroll-back window
// ---------------------------------------------------------------------------
function buildVisibleEvents(): EnchantedEvent[] {
  const source: EnchantedEvent[] = state.filter
    ? state.ringBuffer.filter((e) => e.topic.includes(state.filter))
    : state.ringBuffer;
  const total  = source.length;
  let end      = total - state.scrollBack;
  if (end < 0) end = 0;
  const start  = Math.max(0, end - MAX_VISIBLE_EVENTS);
  return source.slice(start, end);
}

function buildEventLines(maxWidth: number): string[] {
  const events = buildVisibleEvents();
  const lines: string[] = [];

  if (state.scrollBack > 0) {
    lines.push(renderScrollIndicator(state.scrollBack));
  }
  if (events.length === 0) {
    lines.push(state.filter
      ? `${A.label}(no events match "${state.filter}")${A.reset}`
      : `${A.label}(no events yet)${A.reset}`);
  } else {
    for (const e of events) {
      lines.push(formatEventLine(e, maxWidth));
    }
  }
  if (state.paused) {
    const pend = state.pendingEvents.length;
    const msg = pend > 0
      ? `${A.amber}⏸ PAUSED — ${pend} pending${A.reset}`
      : `${A.amber}⏸ PAUSED${A.reset}`;
    lines.push(msg);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Bus event handler
// ---------------------------------------------------------------------------
function handleEvent(e: EnchantedEvent): void {
  state.totalEvents += 1;

  state.ringBuffer.push(e);
  if (state.ringBuffer.length > RING_BUFFER_SIZE) state.ringBuffer.shift();

  if (state.paused) state.pendingEvents.push(e);

  if (e.correlation_id && e.correlation_id !== state.currentCorrelId) {
    state.currentCorrelId = e.correlation_id;
    state.callStartMs     = e.ts;
  }
  if (e.phase) {
    const idx = LIFECYCLE_PHASE_ORDER.indexOf(e.phase);
    if (idx > 0) {
      for (let i = 0; i < idx; i++) {
        state.completedPhases.add(LIFECYCLE_PHASE_ORDER[i] as LifecyclePhase);
      }
    }
    if (state.currentPhase !== e.phase) {
      // Record the wall-time of the previous phase (if any) for p99
      if (state.phaseStartMs > 0 && state.currentPhase !== null) {
        const dur = e.ts - state.phaseStartMs;
        if (dur >= 0 && dur < 60_000) {
          state.phaseLatencies.push(dur);
          if (state.phaseLatencies.length > PHASE_LATENCY_WINDOW) {
            state.phaseLatencies.shift();
          }
        }
      }
      state.phaseStartMs = e.ts;
    }
    state.currentPhase = e.phase;
  }

  updatePluginMeta(e);
  trackAll(state.counters, e);
  scheduleRender();
}

// ---------------------------------------------------------------------------
// Plugin activity metadata tracking
// ---------------------------------------------------------------------------
const TOPIC_TO_PLUGIN: Array<[string, PluginKey]> = [
  ['pech.', 'pech'], ['emu.', 'emu'], ['hydra.', 'hydra'],
  ['sylph.', 'sylph'], ['lich.', 'lich'], ['naga.', 'naga'],
  ['crow.', 'crow'], ['djinn.', 'djinn'], ['gorgon.', 'gorgon'],
];

function topicToPlugin(topic: string): PluginKey | null {
  for (const [prefix, key] of TOPIC_TO_PLUGIN) {
    if (topic.startsWith(prefix)) return key;
  }
  return null;
}

function updatePluginMeta(e: EnchantedEvent): void {
  const key = topicToPlugin(e.topic);
  if (!key) return;
  state.meta.lastTs.set(key, e.ts);

  if (
    e.topic === 'hydra.veto.fired'      ||
    e.topic === 'sylph.destructive.veto' ||
    e.topic === 'lich.suspicion.flagged' ||
    e.topic === 'naga.schema.drift.detected'
  ) {
    state.meta.vetoCounts.set(key, (state.meta.vetoCounts.get(key) ?? 0) + 1);
  }
  sparkAccum.set(key, (sparkAccum.get(key) ?? 0) + 1);

  if (key === 'crow' && e.topic === 'crow.trust.scored') {
    const p = e.payload as Record<string, unknown>;
    const m = typeof p['posterior_mean'] === 'number' ? p['posterior_mean'] : null;
    if (m !== null) sparkValues.set('crow', m);
  }
  if (key === 'emu' && e.topic === 'emu.runway.forecast') {
    const p = e.payload as Record<string, unknown>;
    if (typeof p['mean'] === 'number') sparkValues.set('emu', p['mean'] as number);
  }
}

// 8 phases × 250ms ≈ 2.0s full fade-out → fade-in cycle.
const BLINK_INTERVAL_MS = 250;

function installBlinkTick(): void {
  setInterval(() => {
    state.blinkPhase = (state.blinkPhase + 1) % 8;
    scheduleRender();
  }, BLINK_INTERVAL_MS);
}

function installSparklineTick(): void {
  setInterval(() => {
    for (const key of PLUGIN_KEYS) {
      const ring = sparks.get(key);
      if (!ring) continue;
      let sample: number;
      if (key === 'crow') {
        const v = sparkValues.get('crow');
        sample = v !== null && v !== undefined ? v : 0;
      } else if (key === 'emu') {
        const v = sparkValues.get('emu');
        sample = v !== null && v !== undefined ? Math.min(v, 100) / 100 : 0;
      } else {
        sample = sparkAccum.get(key) ?? 0;
      }
      ring.push(sample);
      sparkAccum.set(key, 0);
    }
    scheduleRender();
  }, SAMPLE_INTERVAL_MS);
}

// ---------------------------------------------------------------------------
// MCP session lifecycle
// ---------------------------------------------------------------------------
function spawnSession(): McpSession {
  const sandbox    = join(tmpdir(), `enchanter-inspect-${Date.now()}`);
  mkdirSync(sandbox, { recursive: true });
  const samplePath = join(sandbox, 'config.txt');
  writeFileSync(
    samplePath,
    [
      '# Demo config — intentionally fake secrets',
      'admin_email = admin@example.com',
      'AWS_KEY = AKIAIOSFODNN7EXAMPLE',
      'Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.fakesig',
      'note = enchanter inspector demo file',
    ].join('\n'),
    'utf8',
  );

  const isWindows = process.platform === 'win32';
  const proc = spawn(
    'npx',
    ['-y', '@modelcontextprotocol/server-filesystem', sandbox],
    { stdio: ['pipe', 'pipe', 'pipe'], shell: isWindows },
  ) as ChildProcessByStdio<Writable, Readable, Readable>;
  proc.stderr.on('data', () => {});

  const transport = new StdioTransport(proc.stdout, proc.stdin);
  clearPech();
  setBudget('fs', 100_000);

  const client = new McpClient({
    serverId: 'fs',
    transport,
    plugins: [
      hydraAdapter, lichAdapter, nagaAdapter, pechAdapter,
      sylphAdapter, crowAdapter, djinnAdapter, emuAdapter, gorgonAdapter,
    ],
  });

  subscribeNotifier(client.bus, { sound: false, throttleMs: 500 });
  client.bus.subscribe('*', handleEvent);

  return { client, proc, sandbox, samplePath };
}

function teardownSession(s: McpSession): void {
  try { s.client.shutdown(); } catch { /* ignore */ }
  try { s.proc.kill(); }       catch { /* ignore */ }
  try { rmSync(s.sandbox, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Demo sequence
// ---------------------------------------------------------------------------
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function runDemo(): Promise<void> {
  if (!session) return;
  const { client, sandbox, samplePath } = session;

  const steps: Array<{ label: string; fn: () => Promise<void> }> = [
    {
      label: 'initialize',
      fn: async () => {
        await client.initialize('enchanter-inspector', '0.4.0');
        await client.listTools();
      },
    },
    {
      label: 'list_directory',
      fn: async () => {
        resetPhase();
        await client.callTool('list_directory', { path: sandbox });
        await sleep(300);
      },
    },
    {
      label: 'read_file[secret]',
      fn: async () => {
        resetPhase();
        await client.callTool('read_file', { path: samplePath });
        await sleep(300);
      },
    },
    {
      label: 'trust-gate: rm -rf /',
      fn: async () => {
        resetPhase();
        await client.publishTrustGate({ tool: 'shell.exec', args: ['rm', '-rf', '/'], server_id: 'fs' });
        await sleep(300);
      },
    },
    {
      label: 'trust-gate: cat ~/.ssh/id_rsa',
      fn: async () => {
        resetPhase();
        await client.publishTrustGate({ tool: 'shell.exec', args: ['cat', '~/.ssh/id_rsa'], server_id: 'fs' });
        await sleep(300);
      },
    },
  ];

  for (const step of steps) {
    if (state.mode !== 'running') break;
    state.currentLabel = step.label;
    scheduleRender();
    await step.fn();
  }

  if (state.mode === 'running') {
    state.currentLabel = 'demo done — waiting';
    state.mode = 'idle';
    scheduleRender();
  }
}

function resetPhase(): void {
  state.currentPhase    = null;
  state.completedPhases = new Set();
}

// ---------------------------------------------------------------------------
// Subprocess runner
// ---------------------------------------------------------------------------
function runSubprocess(scriptName: string): void {
  if (state.mode === 'running' || state.mode === 'subprocess') return;
  state.mode         = 'subprocess';
  state.subprocLabel = scriptName;
  scheduleRender();

  const child = spawn(
    'npx',
    ['tsx', `scripts/${scriptName}.ts`],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      cwd: process.cwd(),
    },
  );

  const pushLine = (line: string): void => {
    const e: EnchantedEvent = {
      id:             `subprocess-${Date.now()}`,
      correlation_id: 'subprocess',
      session_id:     'subprocess',
      phase:          'cross-session',
      topic:          `subprocess.${scriptName}.line`,
      source:         scriptName,
      budget_tier:    'HIGH',
      ts:             Date.now(),
      payload:        { line: line.replace(/\x1b\[[0-9;]*m/g, '').slice(0, 120) },
    };
    state.totalEvents += 1;
    state.ringBuffer.push(e);
    if (state.ringBuffer.length > RING_BUFFER_SIZE) state.ringBuffer.shift();
    if (state.paused) state.pendingEvents.push(e);
    scheduleRender();
  };

  let buf = '';
  const onData = (chunk: Buffer): void => {
    buf += chunk.toString('utf8');
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const l of lines) if (l.trim()) pushLine(l);
  };

  (child.stdout as Readable).on('data', onData);
  (child.stderr as Readable).on('data', onData);
  child.on('close', () => {
    if (buf.trim()) pushLine(buf);
    state.mode         = 'idle';
    state.currentLabel = `${scriptName} done`;
    scheduleRender();
  });
}

// ---------------------------------------------------------------------------
// Keyboard input
// ---------------------------------------------------------------------------
let escBuf = '';
let escTimer: ReturnType<typeof setTimeout> | null = null;

function flushEscBuf(): void {
  escTimer = null;
  const seq = escBuf;
  escBuf = '';
  dispatchEscSequence(seq);
}

function dispatchEscSequence(seq: string): void {
  switch (seq) {
    case '\x1b[A':   handleArrowUp();   break;
    case '\x1b[B':   handleArrowDown(); break;
    case '\x1b[H':   handleHome();      break;
    case '\x1b[F':   handleEnd();       break;
    case '\x1b':     handleEscape();    break;
    default: break;
  }
}

function handleArrowUp(): void {
  if (state.inputMode !== 'normal') return;
  if (!state.paused) togglePause();
  state.scrollBack = Math.min(state.scrollBack + 5, Math.max(0, state.ringBuffer.length - 1));
  scheduleRender();
}
function handleArrowDown(): void {
  if (state.inputMode !== 'normal') return;
  state.scrollBack = Math.max(0, state.scrollBack - 5);
  scheduleRender();
}
function handleHome(): void {
  if (state.inputMode !== 'normal') return;
  if (!state.paused) togglePause();
  state.scrollBack = Math.max(0, state.ringBuffer.length - MAX_VISIBLE_EVENTS);
  scheduleRender();
}
function handleEnd(): void {
  state.scrollBack = 0;
  scheduleRender();
}
function handleEscape(): void {
  if (state.inputMode === 'filter') {
    state.inputMode  = 'normal';
    state.filterDraft = '';
    scheduleRender();
  } else if (state.inputMode === 'help') {
    state.inputMode = 'normal';
    scheduleRender();
  } else if (state.filter) {
    state.filter     = '';
    state.filterDraft = '';
    scheduleRender();
  }
}

function togglePause(): void {
  state.paused = !state.paused;
  if (!state.paused) {
    state.pendingEvents = [];
    state.scrollBack    = 0;
  }
  scheduleRender();
}

function installKeyboard(): void {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stdin.setEncoding('utf8');

  process.stdin.on('data', (key: string) => {
    if (state.inputMode === 'filter') {
      if (key === '\r' || key === '\n') {
        state.filter      = state.filterDraft;
        state.filterDraft = '';
        state.inputMode   = 'normal';
        state.scrollBack  = 0;
        scheduleRender();
      } else if (key === '\x1b') {
        state.inputMode   = 'normal';
        state.filterDraft = '';
        scheduleRender();
      } else if (key === '\x7f' || key === '\x08') {
        state.filterDraft = state.filterDraft.slice(0, -1);
        scheduleRender();
      } else if (key.length === 1 && key >= ' ') {
        state.filterDraft += key;
        scheduleRender();
      }
      return;
    }

    if (state.inputMode === 'help') {
      state.inputMode = 'normal';
      scheduleRender();
      return;
    }

    if (key === '\x1b' || escBuf.length > 0) {
      escBuf += key;
      if (escTimer !== null) clearTimeout(escTimer);
      if (escBuf.length >= 3 && escBuf[1] === '[') {
        flushEscBuf();
      } else {
        escTimer = setTimeout(flushEscBuf, 50);
      }
      return;
    }

    if (key === 'q' || key === '\x03') { gracefulExit(); return; }
    if (key === 'p') { togglePause(); return; }
    if (key === '/') {
      state.inputMode   = 'filter';
      state.filterDraft = state.filter;
      scheduleRender();
      return;
    }
    if (key === 'S') {
      const cycle: SidebarSort[] = ['recent', 'name', 'veto'];
      const idx = cycle.indexOf(state.sort);
      state.sort = cycle[(idx + 1) % cycle.length] ?? 'recent';
      scheduleRender();
      return;
    }
    if (key === '?') {
      state.inputMode = state.inputMode === 'help' ? 'normal' : 'help';
      scheduleRender();
      return;
    }
    if (key === 'c') {
      state.filter      = '';
      state.filterDraft = '';
      state.sort        = 'recent';
      state.scrollBack  = 0;
      state.inputMode   = 'normal';
      state.prevFrame   = [];
      scheduleRender();
      return;
    }
    if (key === 'r') {
      if (state.mode !== 'idle') return;
      if (session) teardownSession(session);
      session = spawnSession();
      state.mode            = 'running';
      state.currentLabel    = 'starting demo…';
      state.currentPhase    = null;
      state.completedPhases = new Set();
      scheduleRender();
      runDemo().catch(() => {
        state.mode = 'idle';
        state.errCount += 1;
        scheduleRender();
      });
      return;
    }
    if (key === 's') {
      if (state.mode !== 'idle') return;
      runSubprocess('stress-plugins');
      return;
    }
    if (key === 'x') {
      if (state.mode !== 'idle') return;
      runSubprocess('red-team');
      return;
    }
  });
}

// ---------------------------------------------------------------------------
// Resize handler
// ---------------------------------------------------------------------------
function installResizeHandler(): void {
  process.stdout.on('resize', () => {
    state.prevFrame = [];
    scheduleRender();
  });
}

// ---------------------------------------------------------------------------
// Clean teardown
// ---------------------------------------------------------------------------
function gracefulExit(): void {
  const rows = process.stdout.rows ?? 40;
  process.stdout.write(`${A.showCursor}\x1b[${rows};1H\n`);
  if (session) teardownSession(session);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  process.stdout.write(A.hideCursor);
  process.stdout.write(A.clearScreen);

  process.on('SIGINT', gracefulExit);

  installKeyboard();
  installResizeHandler();
  installSparklineTick();
  installBlinkTick();

  // Initial render
  render();

  session            = spawnSession();
  state.mode         = 'running';
  state.currentLabel = 'starting…';
  scheduleRender();

  await runDemo();
}

// Surface unhandled errors as a golden-signal err count rather than crashing
process.on('uncaughtException', (err) => {
  state.errCount += 1;
  // Best-effort log to stderr without breaking the TUI
  try { process.stderr.write(`\n[uncaught] ${(err as Error).message}\n`); } catch { /* ignore */ }
});

main().catch((err) => {
  process.stdout.write(A.showCursor + '\n');
  console.error('inspector failed:', err);
  process.exit(1);
});

// Unused noise-silencer for tooling — these vars are imported for callers
void stripAnsi; void visWidth;
