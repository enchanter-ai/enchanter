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
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
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
import { homedir } from 'node:os';
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
  renderContextStrip,
  renderSubPanel,
  topicColor,
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
  // Plugin enable/disable + keyboard selection (for the on/off toggle)
  disabledPlugins: Set<keyof TuiCounters>;
  selectedPlugin:  keyof TuiCounters | null;
  // What the inspector is watching (MCP server target, not the inspector's
  // own cwd) + the Claude Code account we're connected to.
  watchedScope:    string | null;
  claudeAccount:   string;
  workflows:       Workflow[];
  activeWorkflow:  number;  // index into workflows[]
  // High-priority events that the developer should NOT miss.
  alertBuffer:     EnchantedEvent[];
}

interface Workflow {
  id:       string;
  label:    string;
  cwd:      string;
  startedMs:number;
  status:   'running' | 'idle' | 'done' | 'failed';
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
    disabledPlugins: new Set(),
    selectedPlugin:  null,
    // Default to the launch cwd so `enchanter` run from a project root shows
    // that path immediately. spawnSession() overrides with the MCP server's
    // sandbox once a demo session starts.
    watchedScope:    process.cwd(),
    claudeAccount:   detectClaudeAccount(),
    workflows:       [{
      id:        'demo',
      label:     'demo',
      cwd:       process.cwd(),
      startedMs: Date.now(),
      status:    'idle',
    }],
    activeWorkflow:  0,
    alertBuffer:     [],
  };
}

/** Read Claude Code's local config to surface the connected account.
 *
 *  Source order:
 *    1. ~/.claude.json → oauthAccount.{emailAddress, displayName}
 *       (canonical Claude Code config; carries the email + display name)
 *    2. ~/.claude/.credentials.json → claudeAiOauth.subscriptionType
 *       (fallback when ~/.claude.json is missing — no email there)
 *
 *  Returns the email when available (the user IS the account owner — this
 *  is their own info displayed back to them, no secret being leaked).
 *  Falls back to display name → subscription tier → "anonymous". */
function detectClaudeAccount(): string {
  try {
    const path = join(homedir(), '.claude.json');
    const raw  = readFileSync(path, 'utf8');
    const json = JSON.parse(raw) as Record<string, unknown>;
    const acct = (json['oauthAccount'] ?? {}) as Record<string, unknown>;
    const email = typeof acct['emailAddress'] === 'string'
      ? (acct['emailAddress'] as string).trim()
      : '';
    if (email) return email;
    const name = typeof acct['displayName'] === 'string'
      ? (acct['displayName'] as string).trim()
      : '';
    if (name) return name;
  } catch {
    // fall through
  }
  // Fallback: subscription tier from the credentials file.
  try {
    const path = join(homedir(), '.claude', '.credentials.json');
    const raw  = readFileSync(path, 'utf8');
    const json = JSON.parse(raw) as Record<string, unknown>;
    const oauth = (json['claudeAiOauth'] ?? {}) as Record<string, unknown>;
    const tier  = typeof oauth['subscriptionType'] === 'string'
      ? (oauth['subscriptionType'] as string)
      : null;
    if (tier) return tier;
  } catch {
    // fall through
  }
  return 'anonymous';
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

  // Responsive tiers — easier to reason about than scattered W >= N checks.
  // ultra: <80 cols   (cards drop to 3, no events panel, no context strip)
  // narrow: 80–99 cols (cards 4, no events panel, compact context)
  // wide:  100+ cols   (cards 5, events panel, full context strip)
  const tier = W >= 100 ? 'wide' : W >= 80 ? 'narrow' : 'ultra';
  const wide = tier === 'wide';

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
  // Hints get truncated on narrow widths so they don't bury the mode.
  const hintsText = tier === 'wide' ? headerHints()
                  : tier === 'narrow' ? 'q quit · / filter · ?'
                  : '';
  lines.push(topBorder(W, titleText, hintsText));

  // ── Watching + Claude account context strip + workflow tabs ─────────────
  // Skipped on ultra-narrow terminals where every row is precious.
  if (tier !== 'ultra') {
    const ctx = renderContextStrip({
      watching:  state.watchedScope,
      account:   state.claudeAccount,
      workflows: state.workflows.map((wf) => ({
        id:     wf.id,
        label:  wf.label,
        status: wf.status,
      })),
      active:    state.activeWorkflow,
      maxWidth:  W - 4,
    });
    lines.push(frameRow(W, ` ${ctx}`));
  }
  lines.push(frameEmpty(W));

  // ── Golden-signal cards row (3 lines: top / mid / bot) ───────────────────
  // Card count steps down with width: 5 / 4 / 3.
  const cardCount = tier === 'wide' ? 5 : tier === 'narrow' ? 4 : 3;
  const cards = renderGoldenSignals(buildGoldenSignals(), cardCount);
  for (const c of cards) {
    lines.push(frameRow(W, `  ${c}`));
  }
  lines.push(frameEmpty(W));

  // ── Three sub-panels: plugins · recent events · alerts ──────────────────
  // Each panel has its own bordered box. On wide terminals the plugins and
  // events panels sit side-by-side; alerts spans full width below them.
  // On narrow/ultra terminals everything stacks vertically, events drops
  // first (alerts are higher priority).
  if (state.inputMode === 'help') {
    const help = renderHelpLines();
    const bodyRows = Math.min(help.length, 14);
    for (let i = 0; i < bodyRows; i++) {
      lines.push(frameRow(W, `  ${help[i] ?? ''}`));
    }
  } else {
    const innerW = W - 4;
    const PANEL_BODY_ROWS = 9;
    const split = wide ? Math.floor(innerW * 0.55) : innerW;
    const pluginsW = wide ? split : innerW;
    const eventsW  = wide ? innerW - split - 2 /* gutter */ : innerW;

    const pluginRows = renderPlugins(
      state.counters,
      sparks,
      state.sort,
      state.meta,
      pluginsW - 2,
      state.disabledPlugins,
      state.selectedPlugin,
    );
    const eventRows = buildEventLines(eventsW - 2);
    const alertRows = buildAlertLines(innerW - 2);

    const pluginsPanel = renderSubPanel(pluginsW, 'plugins · on/off', pluginRows, PANEL_BODY_ROWS);
    const eventsPanel  = wide
      ? renderSubPanel(eventsW, 'recent events', eventRows, PANEL_BODY_ROWS)
      : null;

    if (wide && eventsPanel) {
      // Side-by-side: zip lines from both panels with a 2-space gutter.
      const rows = Math.max(pluginsPanel.length, eventsPanel.length);
      for (let i = 0; i < rows; i++) {
        const l = pluginsPanel[i] ?? padVis('', pluginsW);
        const r = eventsPanel[i] ?? padVis('', eventsW);
        lines.push(frameRow(W, ` ${padVis(l, pluginsW)}  ${padVis(r, eventsW)}`));
      }
    } else {
      for (const row of pluginsPanel) lines.push(frameRow(W, ` ${row}`));
    }

    // Alerts panel — full inside width, rendered below the side-by-side
    // panels (or below the plugins panel on narrow terminals).
    const alertsPanel = renderSubPanel(innerW, 'alerts · don\'t miss', alertRows, 4);
    for (const row of alertsPanel) lines.push(frameRow(W, ` ${row}`));
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

function buildAlertLines(maxWidth: number): string[] {
  if (state.alertBuffer.length === 0) {
    return [`${A.label}(none yet — vetoes, drift, suspicions, budget breaks land here)${A.reset}`];
  }
  const lines: string[] = [];
  // Newest first — alerts are read top-down.
  const ordered = [...state.alertBuffer].reverse();
  for (const e of ordered) {
    const d = new Date(e.ts);
    const ts = `${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
    const c = topicColor(e.topic);
    const summary = summarizeAlertPayload(e.payload);
    const tag = `${A.red}${A.bold}!${A.reset}`;
    const line = `${A.label}${ts}${A.reset} ${tag} ${c}${e.topic}${A.reset}  ${A.body}${summary}${A.reset}`;
    lines.push(line);
  }
  return lines;
}

function summarizeAlertPayload(payload: Readonly<Record<string, unknown>>): string {
  if (!payload || typeof payload !== 'object') return '';
  const p = payload;
  if (typeof p['pattern_id'] === 'string') return `pattern ${p['pattern_id'] as string}`;
  if (typeof p['reason']     === 'string') return p['reason']     as string;
  if (typeof p['tool']       === 'string') {
    const args = Array.isArray(p['args']) ? (p['args'] as unknown[]).join(' ') : '';
    return `${p['tool'] as string} ${args}`.trim();
  }
  if (typeof p['secret_type'] === 'string') return `secret type ${p['secret_type'] as string}`;
  return '';
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
  // Skip counter updates for plugins the user has toggled off — the disabled
  // row should freeze in place rather than silently keep accumulating.
  const owner = topicToPlugin(e.topic);
  if (!owner || !state.disabledPlugins.has(owner)) {
    trackAll(state.counters, e);
  }
  // Pin high-priority events to the alert buffer so they don't scroll past.
  if (isAlertTopic(e.topic)) {
    state.alertBuffer.push(e);
    if (state.alertBuffer.length > ALERT_BUFFER_SIZE) state.alertBuffer.shift();
  }
  scheduleRender();
}

// Topics the developer can't afford to miss. Vetoes (security/git) +
// suspicions + drift detections + budget/runway exhaustion.
const ALERT_TOPIC_PREFIXES: ReadonlyArray<string> = [
  'hydra.veto',
  'sylph.destructive',
  'lich.suspicion',
  'naga.schema.drift',
  'djinn.drift',
  'emu.runway.exhausted',
  'pech.budget.exceeded',
];
const ALERT_BUFFER_SIZE = 20;

function isAlertTopic(topic: string): boolean {
  for (const p of ALERT_TOPIC_PREFIXES) if (topic.startsWith(p)) return true;
  return false;
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
  // The "watching" header keeps showing the user's launch cwd — the demo
  // sandbox is an internal implementation detail and shouldn't replace
  // the user's project context. The sandbox path is logged only.
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
  pushWorkflow(scriptName);
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
  child.on('close', (code) => {
    if (buf.trim()) pushLine(buf);
    state.mode         = 'idle';
    state.currentLabel = `${scriptName} done`;
    finishWorkflow(scriptName, code === 0 ? 'done' : 'failed');
    scheduleRender();
  });
}

/** Append (or refresh) a workflow tab and make it active. Older tabs stay
 *  visible (capped at 5) so the user can see history. */
function pushWorkflow(label: string): void {
  const existing = state.workflows.findIndex((w) => w.label === label);
  if (existing >= 0) {
    const w = state.workflows[existing];
    if (w) {
      w.status    = 'running';
      w.startedMs = Date.now();
    }
    state.activeWorkflow = existing;
    return;
  }
  state.workflows.push({
    id:        `${label}-${Date.now()}`,
    label,
    cwd:       process.cwd(),
    startedMs: Date.now(),
    status:    'running',
  });
  if (state.workflows.length > 5) state.workflows.shift();
  state.activeWorkflow = state.workflows.length - 1;
}

function finishWorkflow(label: string, status: 'done' | 'failed'): void {
  const w = state.workflows.find((wf) => wf.label === label);
  if (w) w.status = status;
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

/** Flip the disabled flag for one plugin. Display-level only — events still
 *  arrive on the bus, but counters/sparklines for the disabled plugin pause
 *  and the row dims so the on/off state is visible at a glance. */
function togglePlugin(name: keyof TuiCounters): void {
  if (state.disabledPlugins.has(name)) state.disabledPlugins.delete(name);
  else                                  state.disabledPlugins.add(name);
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

    // Plugin selection + on/off toggle.
    //   1..9  → select that plugin (positions match ALL_PLUGINS order)
    //   t      → toggle the currently-selected plugin on/off
    //   T      → toggle ALL plugins
    if (key >= '1' && key <= '9') {
      const idx = parseInt(key, 10) - 1;
      if (idx < PLUGIN_KEYS.length) {
        state.selectedPlugin = PLUGIN_KEYS[idx] ?? null;
        scheduleRender();
      }
      return;
    }
    if (key === 't') {
      const sel = state.selectedPlugin;
      if (sel) togglePlugin(sel);
      return;
    }
    if (key === 'T') {
      const allOff = PLUGIN_KEYS.every((k) => state.disabledPlugins.has(k));
      if (allOff) state.disabledPlugins.clear();
      else        for (const k of PLUGIN_KEYS) state.disabledPlugins.add(k);
      scheduleRender();
      return;
    }

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
      pushWorkflow('demo');
      scheduleRender();
      runDemo()
        .then(() => finishWorkflow('demo', 'done'))
        .catch(() => {
          state.mode = 'idle';
          state.errCount += 1;
          finishWorkflow('demo', 'failed');
          scheduleRender();
        });
      return;
    }
    if (key === '\t') {
      // Tab cycles the active workflow tab.
      if (state.workflows.length > 1) {
        state.activeWorkflow = (state.activeWorkflow + 1) % state.workflows.length;
        scheduleRender();
      }
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
