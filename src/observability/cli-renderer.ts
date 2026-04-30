/* enchanter/src/observability/cli-renderer.ts — boxed minimalist redesign.
   Pure ANSI escape codes, no dependencies.

   Design ref: wixie/prompts/enchanter-monitor-redesign/prompt.md
   - §1 grounding: rounded box-drawing (btop/lazygit/gitui idiom), Google-SRE
     golden signals, Datadog <12-panels rule, Claude Code muted aesthetic.
   - §2 spec: rounded outer frame, 4-6 golden-signal cards (sharp inner
     corners), plugins | events split, single phase bar, hint footer.
   - §7 spec: mascot block-art constants (MASCOT_TINY, MASCOT_WELCOME) +
     renderMascot() helper applying gold/violet/black-on-violet/red rules.

   Architecture-spec refs:
   - phase_2 ADR-001 (7-phase lifecycle) → phase bar
   - phase_5.cost_attribution_unit (pech ledger) → spent / signal cards
   - phase_6.observability (event-stream tap) → events panel
   - phase_1_plugin_role_mapping (10 plugins) → plugins panel rows
*/

import type { EnchantedEvent } from '../bus/event-types.js';
import type { LifecyclePhase } from '../orchestration/request-context.js';
import { LIFECYCLE_PHASES } from '../orchestration/request-context.js';

// ---------------------------------------------------------------------------
// ANSI primitives — muted body palette + single warm-amber accent (locked
// per §2 color rules). Plugin mascot truecolors ONLY as 1-char accents.
// ---------------------------------------------------------------------------
const tc = (r: number, g: number, b: number): string => `\x1b[38;2;${r};${g};${b}m`;
const bg = (r: number, g: number, b: number): string => `\x1b[48;2;${r};${g};${b}m`;

export const A = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  // Body palette (§2)
  body:    tc(180, 185, 195),  // #b4b9c3 muted off-white
  border:  tc(68,  72,  80),   // #44484f muted grey
  label:   tc(120, 128, 135),  // #788087 medium grey for titles
  amber:   tc(210, 153, 34),   // #d29922 warm amber accent
  red:     tc(248, 81,  73),   // #f85149 vetoes / errors only
  green:   tc(107, 176, 74),   // #6bb04a phase-complete green (truecolor)
  // Legacy 16-color (kept for compatibility — still used in places)
  yellow:  '\x1b[33m',
  cyan:    '\x1b[36m',
  magenta: '\x1b[35m',
  blue:    '\x1b[34m',
  grey:    '\x1b[90m',
  white:   '\x1b[97m',
  bgBlue:  '\x1b[44m',
  bgGrey:  bg(28, 28, 28),
  // Cursor / screen
  clearScreen: '\x1b[2J\x1b[H',
  hideCursor:  '\x1b[?25l',
  showCursor:  '\x1b[?25h',
  clearLine:   '\x1b[2K',
  home:        '\x1b[H',
  // Mascot palette (§7)
  gold:    tc(232, 210, 122),  // #e8d27a
  violet:  tc(124, 92,  219),  // #7c5cdb
  bgViolet: bg(124, 92,  219),
  black:   tc(0,   0,   0),
  // Per-plugin truecolor accents — used as 1-char bullets in event log only
  wixie:  tc(0x7c, 0x5c, 0xdb),
  sylph:  tc(0x4e, 0xc8, 0xe5),
  djinn:  tc(0x3d, 0x5a, 0xc4),
  hydra:  tc(0x6b, 0xb0, 0x4a),
  lich:   tc(0xb8, 0xbf, 0xc5),
  naga:   tc(0x1f, 0x6b, 0x4a),
  emu:    tc(0xc9, 0x92, 0x5e),
  crow:   tc(0xe8, 0xd2, 0x7a),
  gorgon: tc(0xc7, 0x6b, 0x7a),
  pech:   tc(0xb3, 0x6a, 0x2e),
} as const;

// ---------------------------------------------------------------------------
// Topic-family color mapping — used ONLY as a 1-char bullet prefix in the
// compact event-log row. Saturated coloring elsewhere is reserved for the
// amber accent + red veto state. (§2 color rule 6 + 7.)
// ---------------------------------------------------------------------------
const TOPIC_COLORS: Array<[string, string]> = [
  ['hydra.',     A.hydra],
  ['pech.',      A.pech],
  ['djinn.',     A.djinn],
  ['lich.',      A.lich],
  ['sylph.',     A.sylph],
  ['crow.',      A.crow],
  ['naga.',      A.naga],
  ['emu.',       A.emu],
  ['gorgon.',    A.gorgon],
  ['wixie.',     A.wixie],
  ['lifecycle.', A.label],
  ['mcp.',       A.wixie],
];

export function topicColor(topic: string): string {
  for (const [prefix, color] of TOPIC_COLORS) {
    if (topic.startsWith(prefix)) return color;
  }
  return A.body;
}

// ---------------------------------------------------------------------------
// Strip ANSI escapes — for visible-length measurement
// ---------------------------------------------------------------------------
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[mhHJKlABCDsuGf]/g, '');
}

/** Visible width (post-ANSI strip), used for box padding math. */
export function visWidth(s: string): number {
  return stripAnsi(s).length;
}

/** Right-pad a string to N visible chars (ignoring ANSI escapes). */
export function padVis(s: string, n: number): string {
  const w = visWidth(s);
  return w >= n ? s : s + ' '.repeat(n - w);
}

/** Truncate to N visible chars (cuts ANSI mid-sequence safely if needed). */
export function truncVis(s: string, n: number): string {
  if (visWidth(s) <= n) return s;
  // Walk, accumulate until we'd exceed n visible. Drop ANSI in pass since
  // truncation here is for display-only (caller wraps in fresh color resets).
  const stripped = stripAnsi(s);
  return stripped.slice(0, n);
}

// ---------------------------------------------------------------------------
// Frame-buffer diff emit (kept verbatim from prior version — smart redraw)
// ---------------------------------------------------------------------------
export function cursorAt(row: number): string {
  return `\x1b[${row};1H`;
}

export function diffFrames(prev: readonly string[], next: readonly string[]): string {
  let out = '';
  const len = Math.max(prev.length, next.length);
  for (let i = 0; i < len; i++) {
    const p = prev[i] ?? '';
    const n = next[i] ?? '';
    if (p !== n) {
      out += cursorAt(i + 1) + A.clearLine + n;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Box-drawing helpers (§2: rounded outer; sharp inner only on signal cards).
// All boxes are rendered as arrays of pre-formatted lines including ANSI.
// ---------------------------------------------------------------------------

const BOX = {
  // Rounded
  tl: '╭', tr: '╮', bl: '╰', br: '╯',
  // Sharp (inner signal cards)
  stl: '┌', str: '┐', sbl: '└', sbr: '┘',
  h: '─', v: '│',
  // T-junctions for inner panel split
  tt: '┬', tb: '┴', tll: '├', trr: '┤', tx: '┼',
} as const;

/**
 * Render a top border with embedded title.
 *   ╭─ title ─────────────── trailing ─╮
 * Width is the OUTSIDE width (border-to-border, inclusive).
 * `trailing` (optional) is right-aligned just inside the right corner.
 */
export function topBorder(width: number, title: string, trailing = '', rounded = true): string {
  const tl = rounded ? BOX.tl : BOX.stl;
  const tr = rounded ? BOX.tr : BOX.str;
  // Title is passed through verbatim — caller controls its colors. Only the
  // trailing slot is auto-wrapped in label grey (matches the hint convention).
  const trailLabel = trailing ? `${A.label}${trailing}${A.reset}` : '';
  const titlePart = title ? ` ${title} ` : '';
  const trailPart = trailing ? ` ${trailLabel} ` : '';
  const inside = width - 2;
  const titleVis = visWidth(titlePart);
  const trailVis = visWidth(trailPart);
  const minDashes = 1;
  const used = titleVis + trailVis + minDashes * 2;
  const fill = Math.max(1, inside - used);
  const left  = `${A.border}${BOX.h}${A.reset}`;
  const right = `${A.border}${BOX.h}${A.reset}`;
  const fillStr = `${A.border}${BOX.h.repeat(fill)}${A.reset}`;
  return `${A.border}${tl}${A.reset}${left}${titlePart}${fillStr}${trailPart}${right}${A.border}${tr}${A.reset}`;
}

/** Render a bottom border with optional embedded mode-pill text on the right.
 *   ╰─────────────────── pill ─╯
 */
export function bottomBorder(width: number, pill = '', rounded = true): string {
  const bl = rounded ? BOX.bl : BOX.sbl;
  const br = rounded ? BOX.br : BOX.sbr;
  // Visible char budget inside the corners.
  // Layout:  bl + fill + pillPart + 2 trailing dashes + br = width
  //          1  + fill + pillVis  + 2                  + 1  = width
  //   ⇒ fill = width - pillVis - 4
  const inside = width - 2;
  const pillPart = pill ? ` ${pill} ` : '';
  const pillVis = visWidth(pillPart);
  const fill = Math.max(1, inside - pillVis - 2);
  return `${A.border}${bl}${A.reset}${A.border}${BOX.h.repeat(fill)}${A.reset}${pillPart}${A.border}${BOX.h}${BOX.h}${br}${A.reset}`;
}

/** Wrap inner content with side borders and pad to `width`.
 *   │ <content padded> │
 */
export function frameRow(width: number, content: string): string {
  const inside = width - 2;
  const pad = padVis(content, inside);
  return `${A.border}${BOX.v}${A.reset}${pad}${A.border}${BOX.v}${A.reset}`;
}

/** Empty frame row of a given width (just the side borders + spaces). */
export function frameEmpty(width: number): string {
  return frameRow(width, '');
}

// ---------------------------------------------------------------------------
// Mascot block-art (§7) — multi-color per-cell painting.
// Source: vscode-extension/media/icon.png — chibi purple grimoire with:
//   gold page-top edges, gold corner trim, violet body, black square eyes,
//   red ribbon at bottom center, violet feet at bottom corners.
//
// MascotPaint: art[] rows + mask[] rows aligned char-for-char.
// Color tags: 'g'=gold #e8d27a, 'v'=violet #7c5cdb, 'k'=black #000 on
//   violet bg, 'r'=red #f85149, '.'=no color (space/transparent)
// ---------------------------------------------------------------------------

export interface MascotPaint {
  readonly art:  ReadonlyArray<string>;
  readonly mask: ReadonlyArray<string>;
}

//
// MASCOT_TINY — 5 rows × 11 visible cols
// Grimoire face: gold pages on top, gold corner brackets, violet body,
// black eyes, red ribbon bottom-center, violet feet bottom-corners.
//
//  row 0:  ·▁▁▁▁▁▁▁·   ← gold pages strip (narrow top)
//  row 1:  g╔═════╗·   ← gold border top
//  row 2:  g║v██kv██v║g  ← violet body, black eyes
//  row 3:  g╚═════╝·   ← gold border bottom
//  row 4:  v█·r▎·v█·   ← violet feet, red ribbon center
//
export const MASCOT_TINY: MascotPaint = {
  art: [
    ' ▁▁▁▁▁▁▁ ',
    '╔███████╗',
    '║█ ██ █ ║',
    '╚███████╝',
    '█  ▎  █  ',
  ],
  mask: [
    '.ggggggg.',
    'gvvvvvvvg',
    'gv.kk.v.g',
    'gvvvvvvvg',
    'v..r..v..',
  ],
} as const;

//
// MASCOT_WELCOME — 11 rows × 17 visible cols
// Larger version: top pages strip, gold dashed-corner frame, violet body,
// two black eye slots, red ribbon bottom center, violet feet/arms.
//
export const MASCOT_WELCOME: MascotPaint = {
  art: [
    '  ▁▁▁▁▁▁▁▁▁▁▁  ',
    ' ╔═══════════╗  ',
    ' ║┌─────────┐║  ',
    ' ║│         │║  ',
    ' ║│  ██  ██ │║  ',
    ' ║│         │║  ',
    ' ║└─────────┘║  ',
    ' ╚═══════════╝  ',
    '█  ╔══▎══╗  █   ',
    '█  ╚═════╝  █   ',
    '   ██   ██      ',
  ],
  mask: [
    '..ggggggggggg..',
    '.gvvvvvvvvvvvg.',
    '.ggggggggggggg.',
    '.gv.........vg.',
    '.gv..kk..kk.vg.',
    '.gv.........vg.',
    '.ggggggggggggg.',
    '.gvvvvvvvvvvvg.',
    'v..ggrrrrrgg..v.',
    'v..gvvvvvvvg..v.',
    '...vv...vv......',
  ],
} as const;

/**
 * Render a MascotPaint into ANSI-colored lines.
 * Walks art and mask in parallel; emits per-cell color escapes.
 * Resets color at end of each row.
 */
export function renderMascot(paint: MascotPaint): string[] {
  const { art, mask } = paint;
  const out: string[] = [];
  for (let r = 0; r < art.length; r++) {
    const artRow  = art[r]  ?? '';
    const maskRow = mask[r] ?? '';
    let line = '';
    for (let i = 0; i < artRow.length; i++) {
      const ch  = artRow[i]  ?? ' ';
      const tag = maskRow[i] ?? '.';
      switch (tag) {
        case 'g': line += `${A.gold}${ch}${A.reset}`;              break;
        case 'v': line += `${A.violet}${ch}${A.reset}`;            break;
        case 'k': line += `${A.bgViolet}${A.black}${ch}${A.reset}`; break;
        case 'r': line += `${A.red}${ch}${A.reset}`;               break;
        default:  line += ch;                                        break;
      }
    }
    out.push(line);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sparklines — block chars, 6-wide per spec §2 (was 12).
// [author judgment] Stuck with block chars not Braille for terminal-portability.
// ---------------------------------------------------------------------------
const SPARK_CHARS = '▁▂▃▄▅▆▇█';

export const SPARKLINE_WIDTH = 6;
export const SPARKLINE_SAMPLES = 6;

export class SparkRing {
  private buf: number[];
  private head: number;
  readonly size: number;

  constructor(size = SPARKLINE_SAMPLES) {
    this.size = size;
    this.buf  = new Array(size).fill(0) as number[];
    this.head = 0;
  }

  push(value: number): void {
    this.buf[this.head] = value;
    this.head = (this.head + 1) % this.size;
  }

  toArray(): number[] {
    const result: number[] = [];
    for (let i = 0; i < this.size; i++) {
      result.push(this.buf[(this.head + i) % this.size] ?? 0);
    }
    return result;
  }
}

/**
 * Render a sparkline. Default color is `A.label` (medium grey); pass
 * `amberThreshold` to switch to amber when the latest sample is over it.
 */
export function renderSparkline(
  samples: number[],
  width: number,
  color: string = A.label,
): string {
  const used = samples.slice(-width);
  const maxV = Math.max(...used, 0.0001);
  let out = color;
  for (let i = 0; i < width; i++) {
    const v = (used[i] ?? 0) / maxV;
    const idx = Math.min(7, Math.floor(v * 8));
    out += SPARK_CHARS[idx] ?? '▁';
  }
  out += A.reset;
  return out;
}

// ---------------------------------------------------------------------------
// Phase progress bar — single horizontal line per §2.
//   phase  ✓anchor  ●trust-gate  pre-disp  dispatch  post-resp  post-sess  cross-sess
// ---------------------------------------------------------------------------
const PHASE_SHORT_NAMES: Record<LifecyclePhase, string> = {
  'anchor':         'anchor',
  'trust-gate':     'trust-gate',
  'pre-dispatch':   'pre-disp',
  'dispatch':       'dispatch',
  'post-response':  'post-resp',
  'post-session':   'post-sess',
  'cross-session':  'cross-sess',
};

export function renderPhaseBar(
  currentPhase: LifecyclePhase | null,
  completedPhases: ReadonlySet<LifecyclePhase>,
  _frameCount = 0,
): string {
  const parts: string[] = [`${A.label}phase${A.reset}`];
  for (const phase of LIFECYCLE_PHASES) {
    const label = PHASE_SHORT_NAMES[phase as LifecyclePhase] ?? phase;
    let cell: string;
    if (phase === currentPhase) {
      cell = `${A.amber}●${A.bold}${label}${A.reset}`;
    } else if (completedPhases.has(phase as LifecyclePhase)) {
      cell = `${A.green}✓${label}${A.reset}`;    // Fix #2: completed phases in green
    } else {
      cell = `${A.label}${label}${A.reset}`;
    }
    parts.push(cell);
  }
  return parts.join('  ');
}

// ---------------------------------------------------------------------------
// Compact event-log line (§2: events panel is right side of split).
// ---------------------------------------------------------------------------
/** Severity glyph for an event — info / ok / warn / error.
 *  Placed in the dedicated SEV column so severity is readable without
 *  parsing the topic, and survives monochrome rendering. */
function eventSeverity(topic: string): { glyph: string; color: string } {
  if (topic.includes('.veto') || topic.includes('.suspicion')
      || topic.includes('.exhausted') || topic.includes('.exceeded')) {
    return { glyph: '✖!', color: A.red };
  }
  if (topic.includes('.drift') || topic.includes('.warn')) {
    return { glyph: '⚠ ', color: A.amber };
  }
  if (topic.includes('.complete') || topic.includes('.ready')
      || topic.includes('.scored')) {
    return { glyph: '● ', color: A.green };
  }
  return { glyph: '· ', color: A.label };
}

/** Column header for the events panel. Schema: TIME · SEV · TOPIC · MSG.
 *  Each column has a fixed width; truncation drops SEV first then narrows
 *  TOPIC, but never drops TIME. */
export function renderEventHeader(width: number): string {
  const head = ` ${A.label}TIME    SEV TOPIC                MSG${A.reset}`;
  return padVis(truncVis(head, width), width);
}

const TIME_W   = 7;   // "SS.mmm "
const SEV_W    = 3;   // "✖! " / "⚠  " / "·  "
const TOPIC_W  = 20;  // truncated when narrower

export function formatEventLine(e: EnchantedEvent, maxWidth?: number): string {
  const d = new Date(e.ts);
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  const ts = `${ss}.${ms}`;

  const topic   = compactTopic(e.topic);
  const summary = summarizePayload(e.payload);
  const sev     = eventSeverity(e.topic);
  const topicColorCode = topicColor(e.topic);

  const showSev   = !maxWidth || maxWidth >= 50;
  const topicW    = !maxWidth || maxWidth >= 80 ? TOPIC_W : 12;

  const tCol = `${A.label}${ts}${A.reset}`;
  const sCol = showSev
    ? ` ${sev.color}${sev.glyph}${A.reset}`
    : '';
  const pCol = ` ${topicColorCode}${padVis(truncVis(topic, topicW), topicW)}${A.reset}`;
  const mCol = summary ? `  ${A.body}${summary}${A.reset}` : '';
  const line = `${tCol}${sCol}${pCol}${mCol}`;

  if (maxWidth && maxWidth > 20) {
    const stripped = stripAnsi(line);
    if (stripped.length > maxWidth) {
      const budget = Math.floor(maxWidth * 1.4);
      return line.slice(0, budget) + A.reset;
    }
  }
  return line;
}

function compactTopic(topic: string): string {
  let t = topic
    .replace(/^lifecycle\./, 'lc.')
    .replace(/^mcp\.tool\./, 'tool.')
    .replace(/^mcp\.tools\./, 'tool.')
    .replace(/^mcp\./, 'mcp.');
  t = t.replace(/\.(?:requested|received|fired|set|appended|crossed|exhausted|detected|matched|masked|ready|changed|flagged|executed|scored|ordered|closed|opened|drafted|pinned|fingerprinted|applied|guarded|reorientation|required)$/, '');
  t = t.replace(/\.post-response/, '.post-resp')
       .replace(/\.post-session/, '.post-sess')
       .replace(/\.cross-session/, '.cross-sess')
       .replace(/\.pre-dispatch/, '.pre-disp');
  return t;
}

function summarizePayload(payload: Readonly<Record<string, unknown>>): string {
  if (!payload || typeof payload !== 'object') return '';
  const keys = Object.keys(payload);
  if (keys.length === 0) return '';

  const parts: string[] = [];
  if (typeof payload['tool'] === 'string')
    parts.push(`t=${payload['tool']}`);
  if (typeof payload['pattern_id'] === 'string')
    parts.push(`p=${A.red}${payload['pattern_id']}${A.reset}`);
  if (typeof payload['vendor'] === 'string')
    parts.push(`v=${payload['vendor']}`);
  if (typeof payload['input_tokens'] === 'number')
    parts.push(`in=${payload['input_tokens']}`);
  if (typeof payload['output_tokens'] === 'number')
    parts.push(`out=${payload['output_tokens']}`);
  if (parts.length === 0) {
    for (const k of keys.slice(0, 1)) {
      const v = payload[k];
      const vs = typeof v === 'string' ? v.slice(0, 18) : String(v).slice(0, 18);
      parts.push(`${k}=${vs}`);
    }
  }
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Counter state (per-plugin runtime metrics).
// Identical to prior shape — preserves API surface for tests/extension.
// ---------------------------------------------------------------------------

export interface PechCard {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  vendorCounts: Map<string, number>;
}
export interface EmuCard {
  runwayMean: number | null;
  runwayCI: number;
  driftPatternCount: number;
  lastPattern: string;
}
export interface HydraCard {
  vetoes: number;
  masked: number;
  lastVetoReason: string;
}
export interface SylphCard {
  branch: string;
  openClusters: number;
  destructiveVetoes: number;
}
export interface LichCard {
  suspicions: number;
  sandboxRuns: number;
}
export interface NagaCard {
  fingerprinted: number;
  driftAlerts: number;
}
export interface CrowCard {
  trustMean: number | null;
  reviewsOrdered: number;
}
export interface DjinnCard {
  anchorSet: boolean;
  driftCount: number;
}
export interface GorgonCard {
  nodeCount: number;
  hotspots: string[];
}

export interface TuiCounters {
  pech:   PechCard;
  emu:    EmuCard;
  hydra:  HydraCard;
  sylph:  SylphCard;
  lich:   LichCard;
  naga:   NagaCard;
  crow:   CrowCard;
  djinn:  DjinnCard;
  gorgon: GorgonCard;
}

export function makeTuiCounters(): TuiCounters {
  return {
    pech:   { inputTokens: 0, outputTokens: 0, costUsd: 0, vendorCounts: new Map() },
    emu:    { runwayMean: null, runwayCI: 0, driftPatternCount: 0, lastPattern: '' },
    hydra:  { vetoes: 0, masked: 0, lastVetoReason: '' },
    sylph:  { branch: 'main', openClusters: 0, destructiveVetoes: 0 },
    lich:   { suspicions: 0, sandboxRuns: 0 },
    naga:   { fingerprinted: 0, driftAlerts: 0 },
    crow:   { trustMean: null, reviewsOrdered: 0 },
    djinn:  { anchorSet: false, driftCount: 0 },
    gorgon: { nodeCount: 0, hotspots: [] },
  };
}

// [author judgment] Placeholder rate card: $0.005/1k input, $0.015/1k output.
const RATE_INPUT_PER_1K  = 0.005;
const RATE_OUTPUT_PER_1K = 0.015;

export function trackPech(counters: TuiCounters, e: EnchantedEvent): void {
  if (e.topic === 'pech.ledger.appended') {
    const p = e.payload as Record<string, unknown>;
    const inp = typeof p['input_tokens']  === 'number' ? p['input_tokens']  : 0;
    const out = typeof p['output_tokens'] === 'number' ? p['output_tokens'] : 0;
    const vendor = typeof p['vendor'] === 'string' ? p['vendor'] : 'unknown';
    counters.pech.inputTokens  += inp;
    counters.pech.outputTokens += out;
    counters.pech.costUsd += (inp / 1000) * RATE_INPUT_PER_1K + (out / 1000) * RATE_OUTPUT_PER_1K;
    counters.pech.vendorCounts.set(vendor, (counters.pech.vendorCounts.get(vendor) ?? 0) + 1);
  }
}

export function trackEmu(counters: TuiCounters, e: EnchantedEvent): void {
  if (e.topic === 'emu.runway.forecast') {
    const p = e.payload as Record<string, unknown>;
    if (typeof p['mean'] === 'number') counters.emu.runwayMean = p['mean'];
    if (typeof p['ci']   === 'number') counters.emu.runwayCI   = p['ci'];
  }
  if (e.topic === 'emu.drift.pattern') {
    const p = e.payload as Record<string, unknown>;
    counters.emu.driftPatternCount += 1;
    if (typeof p['pattern_name'] === 'string') counters.emu.lastPattern = p['pattern_name'];
  }
}

export function trackHydra(counters: TuiCounters, e: EnchantedEvent): void {
  if (e.topic === 'hydra.veto.fired') {
    counters.hydra.vetoes += 1;
    const p = e.payload as Record<string, unknown>;
    const id = typeof p['pattern_id'] === 'string' ? p['pattern_id'] : '';
    if (id) counters.hydra.lastVetoReason = id;
  }
  if (e.topic === 'hydra.secret.masked') {
    counters.hydra.masked += 1;
  }
}

export function trackSylph(counters: TuiCounters, e: EnchantedEvent): void {
  if (e.topic === 'sylph.boundary.closed') {
    counters.sylph.openClusters = Math.max(0, counters.sylph.openClusters - 1);
  }
  if (e.topic === 'sylph.boundary.opened') {
    counters.sylph.openClusters += 1;
  }
  if (e.topic === 'sylph.destructive.veto') {
    counters.sylph.destructiveVetoes += 1;
  }
}

export function trackLich(counters: TuiCounters, e: EnchantedEvent): void {
  if (e.topic === 'lich.suspicion.flagged') counters.lich.suspicions  += 1;
  if (e.topic === 'lich.sandbox.executed')  counters.lich.sandboxRuns += 1;
}

export function trackNaga(counters: TuiCounters, e: EnchantedEvent): void {
  if (e.topic === 'naga.pattern.fingerprinted')  counters.naga.fingerprinted += 1;
  if (e.topic === 'naga.schema.drift.detected')  counters.naga.driftAlerts  += 1;
}

export function trackCrow(counters: TuiCounters, e: EnchantedEvent): void {
  if (e.topic === 'crow.trust.scored') {
    const p = e.payload as Record<string, unknown>;
    const mean = typeof p['posterior_mean'] === 'number' ? p['posterior_mean'] : null;
    if (mean !== null) {
      counters.crow.trustMean = counters.crow.trustMean === null
        ? mean
        : counters.crow.trustMean * 0.8 + mean * 0.2;
    }
  }
  if (e.topic === 'crow.review.ordered') {
    counters.crow.reviewsOrdered += 1;
  }
}

export function trackDjinn(counters: TuiCounters, e: EnchantedEvent): void {
  if (e.topic === 'djinn.anchor.set')     counters.djinn.anchorSet = true;
  if (e.topic === 'djinn.drift.detected') counters.djinn.driftCount += 1;
}

export function trackGorgon(counters: TuiCounters, e: EnchantedEvent): void {
  if (e.topic === 'gorgon.snapshot.ready') {
    const p = e.payload as Record<string, unknown>;
    if (typeof p['node_count'] === 'number') counters.gorgon.nodeCount = p['node_count'];
    const hs = p['hotspots'];
    if (Array.isArray(hs)) {
      counters.gorgon.hotspots = (hs as unknown[])
        .slice(0, 3)
        .map((h) => (typeof h === 'string' ? h : typeof (h as Record<string, unknown>)['file'] === 'string'
          ? (h as Record<string, unknown>)['file'] as string
          : String(h)));
    }
  }
}

export function trackAll(counters: TuiCounters, e: EnchantedEvent): void {
  trackPech(counters, e);
  trackEmu(counters, e);
  trackHydra(counters, e);
  trackSylph(counters, e);
  trackLich(counters, e);
  trackNaga(counters, e);
  trackCrow(counters, e);
  trackDjinn(counters, e);
  trackGorgon(counters, e);
}

// ---------------------------------------------------------------------------
// Helpers — number formatting (§2: K/M abbreviation; cost; runway).
// ---------------------------------------------------------------------------
function fmtK(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function fmtCost(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Golden-signal cards (§2: 4-6 sub-cards on top, sharp `┌─┐│└┘` corners).
// Each card occupies 14 wide × 3 tall.  Spec rules:
//   - turns left: amber when CI lower bound < 5
//   - spent:      amber when > $1.00
//   - security:   red when > 0
//   - drift:      amber when > 0
//   - p99:        amber when > 1000 ms
//   - errs:       red when > 0
// ---------------------------------------------------------------------------

export interface GoldenSignals {
  turnsMean: number | null;
  turnsCI: number;
  spentUsd: number;
  securityCount: number;
  driftCount: number;
  p99Ms: number | null;
  errCount: number;
}

const CARD_WIDTH = 14;

function smallBoxTop(title: string): string {
  // ┌─ title ──┐  exact total width = CARD_WIDTH
  // Layout: ┌ ─ <space title space> <fill ─...─> ┐
  // Bytes:   1   1                  1            (variable)  1   1
  const inside = CARD_WIDTH - 2;             // chars between corners
  const maxTitleChars = inside - 3;          // 1 leading dash + 2 spaces around title
  const safe = title.length > maxTitleChars ? title.slice(0, maxTitleChars) : title;
  const titleVis = safe.length + 2;          // " title "
  const fill = Math.max(0, inside - titleVis - 1);
  const titlePart = ` ${A.label}${safe}${A.reset} `;
  return `${A.border}${BOX.stl}${BOX.h}${A.reset}${titlePart}${A.border}${BOX.h.repeat(fill)}${BOX.str}${A.reset}`;
}
function smallBoxBot(): string {
  return `${A.border}${BOX.sbl}${BOX.h.repeat(CARD_WIDTH - 2)}${BOX.sbr}${A.reset}`;
}
function smallBoxMid(content: string, accent = A.body): string {
  const inside = CARD_WIDTH - 2;
  // Center content inside the card.
  const w = visWidth(content);
  const padTotal = Math.max(0, inside - w);
  const padL = Math.floor(padTotal / 2);
  const padR = padTotal - padL;
  return `${A.border}${BOX.v}${A.reset}${' '.repeat(padL)}${accent}${content}${A.reset}${' '.repeat(padR)}${A.border}${BOX.v}${A.reset}`;
}

/**
 * Render the golden-signal card row. Returns 3 lines (top / mid / bot).
 * `count` controls how many cards (1-6 valid; default 5).
 */
export function renderGoldenSignals(s: GoldenSignals, count = 5): string[] {
  const cards: Array<{ title: string; value: string; accent: string }> = [];

  // 1. turns left
  {
    let value: string;
    let accent = A.body;
    if (s.turnsMean === null) {
      value = '—';
    } else {
      value = `${Math.round(s.turnsMean)} ± ${Math.round(s.turnsCI)}`;
      const lower = s.turnsMean - s.turnsCI;
      if (lower < 5) accent = A.amber;
    }
    cards.push({ title: 'turns', value, accent });
  }
  // 2. spent
  {
    const accent = s.spentUsd > 1.0 ? A.amber : A.body;
    cards.push({ title: 'spent', value: fmtCost(s.spentUsd), accent });
  }
  // 3. security
  {
    const accent = s.securityCount > 0 ? A.red : A.body;
    const value = s.securityCount === 0 ? '0' : `${s.securityCount} vetoes`;
    cards.push({ title: 'security', value, accent });
  }
  // 4. drift
  {
    const accent = s.driftCount > 0 ? A.amber : A.body;
    cards.push({ title: 'drift', value: String(s.driftCount), accent });
  }
  // 5. p99
  {
    let value: string;
    let accent = A.body;
    if (s.p99Ms === null) {
      value = '—';
    } else {
      value = `${Math.round(s.p99Ms)}ms`;
      if (s.p99Ms > 1000) accent = A.amber;
    }
    cards.push({ title: 'p99', value, accent });
  }
  // 6. errs
  {
    const accent = s.errCount > 0 ? A.red : A.body;
    cards.push({ title: 'errs', value: String(s.errCount), accent });
  }

  const slice = cards.slice(0, count);
  const tops = slice.map((c) => smallBoxTop(c.title)).join('  ');
  const mids = slice.map((c) => smallBoxMid(c.value, c.accent)).join('  ');
  const bots = slice.map(() => smallBoxBot()).join('  ');
  return [tops, mids, bots];
}

// ---------------------------------------------------------------------------
// Plugins panel — left side of split (§2: bare rows, no headers).
//   <name 8w>  <spark 6w>  <metric summary rest of width>
// Plugin name uses mascot color as a 1-char accent dot prefix only; actual
// name + summary stay in body grey.
// ---------------------------------------------------------------------------

export type SidebarSort = 'recent' | 'name' | 'veto';

export interface PluginActivityMeta {
  lastTs: Map<keyof TuiCounters, number>;
  vetoCounts: Map<keyof TuiCounters, number>;
}

export function makePluginActivityMeta(): PluginActivityMeta {
  return {
    lastTs:    new Map(),
    vetoCounts: new Map(),
  };
}

const ALL_PLUGINS: Array<keyof TuiCounters> = [
  'pech', 'emu', 'hydra', 'sylph', 'lich', 'naga', 'crow', 'djinn', 'gorgon',
];

/**
 * Per-plugin impact label — what the plugin actually does for the developer,
 * not what it's named. People care about cost / security / drift, not "pech"
 * or "naga". Plugin name moves to the right in dim text as a tag.
 */
const PLUGIN_IMPACT: Record<keyof TuiCounters, string> = {
  pech:   'cost',
  emu:    'turns left',
  hydra:  'security',
  sylph:  'git ops',
  djinn:  'intent',
  lich:   'review',
  naga:   'schema',
  crow:   'trust',
  gorgon: 'hotspots',
};

/** Returns { text, accent } for the ONE key metric per plugin.
 *  Accent is colored by SEMANTICS (red/amber/body), not plugin color. */
function pluginMetric(name: keyof TuiCounters, c: TuiCounters): { text: string; accent: string } {
  switch (name) {
    case 'pech': {
      const cost = c.pech.costUsd;
      return { text: fmtCost(cost), accent: cost > 1.0 ? A.amber : A.body };
    }
    case 'emu': {
      const e = c.emu;
      if (e.runwayMean === null) return { text: '—', accent: A.body };
      const lower = e.runwayMean - e.runwayCI;
      return {
        text:   `${Math.round(e.runwayMean)} ± ${Math.round(e.runwayCI)}`,
        accent: lower < 5 ? A.amber : A.body,
      };
    }
    case 'hydra': {
      const h = c.hydra;
      return {
        text:   h.vetoes > 0 ? `${h.vetoes} vetoes` : '0 vetoes',
        accent: h.vetoes > 0 ? A.red : A.body,
      };
    }
    case 'sylph': {
      const s = c.sylph;
      return {
        text:   s.destructiveVetoes > 0 ? `${s.destructiveVetoes} blocked` : 'clean ✓',
        accent: s.destructiveVetoes > 0 ? A.red : A.body,
      };
    }
    case 'djinn': {
      const d = c.djinn;
      const drifting = d.driftCount > 0;
      return {
        text:   drifting ? 'drifting ⚠' : 'on task ✓',
        accent: drifting ? A.amber : A.body,
      };
    }
    case 'lich': {
      const l = c.lich;
      return {
        text:   l.suspicions > 0 ? `${l.suspicions} flagged` : 'clean ✓',
        accent: l.suspicions > 0 ? A.red : A.body,
      };
    }
    case 'naga': {
      const n = c.naga;
      return {
        text:   n.driftAlerts > 0 ? `${n.driftAlerts} alert` : 'clean ✓',
        accent: n.driftAlerts > 0 ? A.red : A.body,
      };
    }
    case 'crow': {
      const m = c.crow.trustMean;
      return {
        text:   m === null ? '—' : m.toFixed(2),
        accent: m !== null && m < 0.5 ? A.amber : A.body,
      };
    }
    case 'gorgon': {
      const g = c.gorgon;
      const top = g.hotspots.length > 0
        ? (g.hotspots[0]?.split('/').pop() ?? g.hotspots[0] ?? '—')
        : '—';
      return { text: top, accent: A.body };
    }
  }
}

/** Column header row for the plugins panel. Returned as a single
 *  pre-formatted line (caller pads it inside the sub-panel border).
 *  Must match the column widths used in renderPlugins() below. */
export function renderPluginHeader(width: number): string {
  // Two-char marker block (sel + on/off) + 11ch KIND + 1 gap + 14ch VALUE +
  // 2 gap + 8ch SPARK + 2 gap + 6ch NAME + 2 gap + 8ch STATE
  const head = ` ${A.label}KIND        VALUE          SPARK   NAME    STATE${A.reset}`;
  return padVis(truncVis(head, width), width);
}

/**
 * Render plugin rows for the inner panel. Each row leads with the impact
 * label, the metric value, the spark, plugin name as a dim trailing tag,
 * and an explicit state tag (running / paused / off / error). State is
 * communicated through THREE channels — glyph + text-tag + dim/bright —
 * so the row reads on monochrome.
 *
 *   ●  cost          $0.42        ▁▂▃▄▅▆  pech
 *   ⏸  cost          $0.42        ▁▂▃▄▅▆  pech    [paused]
 *   ○  cost          —            ······  pech    [off]
 *   ✖  cost          ! ledger     ······  pech    [error]
 */
export function renderPlugins(
  counters: TuiCounters,
  sparks: Map<keyof TuiCounters, SparkRing>,
  sort: SidebarSort,
  meta: PluginActivityMeta,
  width: number,
  disabled?: ReadonlySet<keyof TuiCounters>,
  selected?: keyof TuiCounters | null,
): string[] {
  let order = [...ALL_PLUGINS];
  if (sort === 'name') {
    order.sort((a, b) => a.localeCompare(b));
  } else if (sort === 'veto') {
    order.sort((a, b) => (meta.vetoCounts.get(b) ?? 0) - (meta.vetoCounts.get(a) ?? 0));
  } else {
    order.sort((a, b) => (meta.lastTs.get(b) ?? 0) - (meta.lastTs.get(a) ?? 0));
  }

  // Decide column widths based on available space. Compact (<=46 ch) drops
  // the trailing name tag; ultra-compact (<=34) also drops the spark.
  const showName  = width >= 50;
  const showSpark = width >= 36;
  const impactW   = 11;   // longest impact label = "turns left"
  const metricW   = Math.max(8, width - 2 /* "● " */ - impactW - 2 /* gap */
    - (showSpark ? SPARKLINE_WIDTH + 2 : 0)
    - (showName ? 8 : 0));

  const showState = width >= 58;  // state-tag column drops first on narrow

  const lines: string[] = [];
  for (const name of order) {
    const ring = sparks.get(name) ?? new SparkRing();
    const pluginColor = (A as Record<string, string>)[name] ?? A.body;
    const isOff = disabled?.has(name) ?? false;
    const isSel = selected === name;

    const selMark = isSel ? `${A.amber}▸${A.reset}` : ' ';
    const dot     = isOff
      ? `${A.label}○${A.reset}`
      : `${pluginColor}●${A.reset}`;
    const impactRaw = PLUGIN_IMPACT[name];
    const impactStr = isOff
      ? `${A.label}${impactRaw}${A.reset}`
      : `${A.bold}${pluginColor}${impactRaw}${A.reset}`;
    const impactCol = padVis(impactStr, impactW);

    const { text: metricText, accent: metricAccent } = pluginMetric(name, counters);
    const metricStr = isOff
      ? `${A.label}—${A.reset}`
      : `${metricAccent}${metricText}${A.reset}`;
    const metricCol = padVis(truncVis(metricStr, metricW), metricW);

    const sparkStr = isOff
      ? `${A.label}${'·'.repeat(SPARKLINE_WIDTH)}${A.reset}`
      : renderSparkline(ring.toArray(), SPARKLINE_WIDTH, pluginColor);
    const sparkCol = showSpark ? `  ${sparkStr}` : '';

    const nameStr = isOff
      ? `${A.label}${name}${A.reset}`
      : `${A.dim}${pluginColor}${name}${A.reset}`;
    const nameCol = showName ? `  ${padVis(nameStr, 6)}` : '';

    // State tag — second channel for the on/off signal so it reads on mono.
    const stateTag = isOff
      ? `${A.label}[off]${A.reset}`
      : `${A.label}      ${A.reset}`;
    const stateCol = showState ? `  ${padVis(stateTag, 8)}` : '';

    const row = `${selMark}${dot} ${impactCol} ${metricCol}${sparkCol}${nameCol}${stateCol}`;
    lines.push(padVis(truncVis(row, width), width));
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Header / footer / mode-pill helpers — rendered at the OUTER frame edges.
// ---------------------------------------------------------------------------

export interface ModeBannerOpts {
  paused:       boolean;
  pendingCount: number;
  filter:       string;
  sort:         SidebarSort;
  scrollBack:   number;
  uptimeSec?:   number;
  /** Blink phase 0..7 (modular). Driven externally on a ~250ms tick.
   *  The cycle is 0→1→2→3→4→5→6→7→0, mapped to a green-brightness ramp:
   *  0..3 fade out, 4..7 fade in. ~2s full cycle. Phase 4 is fully hidden. */
  blinkPhase?:  number;
  /** Total event count — replaces footer LIVE so we don't show two blinking
   *  LIVEs at once. The footer becomes a stats strip. */
  totalEvents?: number;
}

/** 8-phase green brightness ramp for slow fade blink. Phase 4 = fully hidden,
 *  phases 0/8 = fully bright. The ramp uses truecolor so a real fade is
 *  possible (terminal-portable: degrades to grey on 256-color, off on 16). */
const BLINK_RAMP_GREEN: ReadonlyArray<string> = [
  tc(107, 176, 74),   // 0 — full bright
  tc( 92, 152, 64),   // 1
  tc( 70, 116, 49),   // 2
  tc( 45,  74, 31),   // 3 — almost gone
  '',                  // 4 — invisible (caller emits 4 spaces)
  tc( 45,  74, 31),   // 5
  tc( 70, 116, 49),   // 6
  tc( 92, 152, 64),   // 7
] as const;

function liveAtPhase(phase: number): string {
  const p = ((phase % 8) + 8) % 8;
  if (p === 4) return '    ';
  const color = BLINK_RAMP_GREEN[p] ?? A.green;
  return `${color}${A.bold}LIVE${A.reset}`;
}

/** Compact mode word used inside the header title, pre-colored:
 *  fading green LIVE / amber PAUSED / amber FILTER / amber SCROLLED-BACK. */
export function headerMode(opts: ModeBannerOpts): string {
  if (opts.scrollBack > 0) return `${A.amber}${A.bold}SCROLLED-BACK${A.reset}`;
  if (opts.filter)         return `${A.amber}${A.bold}FILTER:${opts.filter}${A.reset}`;
  if (opts.paused) {
    const tag = opts.pendingCount > 0 ? `PAUSED(+${opts.pendingCount})` : 'PAUSED';
    return `${A.amber}${A.bold}${tag}${A.reset}`;
  }
  return liveAtPhase(opts.blinkPhase ?? 0);
}

/** Pre-colored "Enchanter" wordmark — purple body color, bold. */
export function brandedTitle(): string {
  return `${A.violet}${A.bold}Enchanter${A.reset}`;
}

// ---------------------------------------------------------------------------
// Workspace context strip — cwd + user + workflow tabs. Rendered as one row
// just under the header border so the developer sees what folder + identity
// the inspector is operating against, and can switch between concurrent
// workflows.
// ---------------------------------------------------------------------------

export interface WorkflowTab {
  id:     string;
  label:  string;
  status: 'running' | 'idle' | 'done' | 'failed';
}

/** Replace the user's home directory prefix with `~` for compactness. */
export function tildify(path: string, home?: string): string {
  const h = home ?? '';
  if (!h) return path;
  // Match either / or \ separators; case-insensitive on Windows for safety.
  if (path.toLowerCase().startsWith(h.toLowerCase())) {
    const tail = path.slice(h.length);
    return '~' + tail.replace(/\\/g, '/');
  }
  return path.replace(/\\/g, '/');
}

/** Truncate a path from the LEFT with ellipsis so the trailing folder is
 *  always visible. Wider than `maxWidth` → "…/foo/bar". */
export function shortenPath(path: string, maxWidth: number): string {
  if (path.length <= maxWidth) return path;
  return '…' + path.slice(path.length - maxWidth + 1);
}

/** Render a sub-panel: small bordered box with a label and rows of content.
 *  Used to split the inspector's body into named regions (plugins / events /
 *  alerts) so each one is its own visual unit instead of a shared split.
 *
 *    ┌─ plugins ────────────────┐
 *    │ <row 1 padded to inside> │
 *    │ <row 2 padded to inside> │
 *    └──────────────────────────┘
 *
 *  Inside content is right-padded to the inner width so the right border
 *  always lands at the same column. Sharp corners (┌┐└┘) match the
 *  golden-signal cards' inner-corner convention. */
export function renderSubPanel(
  width: number,
  title: string,
  rows: ReadonlyArray<string>,
  minRowsInside: number,
  focused: boolean = false,
): string[] {
  const inside = Math.max(4, width - 2);
  // Focused pane shows ▸ marker in title and uses amber for the title text;
  // unfocused panes stay in label grey. Pattern from lazygit / k9s focus model.
  const focusMark = focused ? `${A.amber}▸${A.reset}` : ' ';
  const titleColor = focused ? A.amber : A.label;
  const titlePart = ` ${focusMark}${titleColor}${title}${A.reset} `;
  const titleVis = 1 + 1 + title.length + 1; // mark + space + title + trailing space
  const fillTop  = Math.max(0, inside - titleVis - 1);
  const top = `${A.border}${BOX.stl}${BOX.h}${A.reset}${titlePart}${A.border}${BOX.h.repeat(fillTop)}${BOX.str}${A.reset}`;
  const bot = `${A.border}${BOX.sbl}${BOX.h.repeat(inside)}${BOX.sbr}${A.reset}`;

  const body: string[] = [];
  const rowsToShow = Math.max(minRowsInside, rows.length);
  for (let i = 0; i < rowsToShow; i++) {
    const r = rows[i] ?? '';
    const padded = padVis(truncVis(r, inside), inside);
    body.push(`${A.border}${BOX.v}${A.reset}${padded}${A.border}${BOX.v}${A.reset}`);
  }
  return [top, ...body, bot];
}

/** Render the watch + account context strip:
 *    watching <scope> · <plan> / <model> · <email>  …  ▸demo │ stress │ …
 *  - "watching" is the MCP server target (what the inspector is observing),
 *    not the inspector's own cwd. Empty/null → "<no MCP target>".
 *  - plan is the Claude Code subscription tier (max / pro / free / team)
 *  - model is the currently-active model (best-effort from env vars)
 *  - email is the connected Claude account
 *  Returns the pre-padded inner content for `frameRow`. */
export function renderContextStrip(opts: {
  watching: string | null;
  plan:     string;
  model:    string;
  email:    string;
  workflows: ReadonlyArray<WorkflowTab>;
  active:    number;
  maxWidth:  number;
}): string {
  const { watching, plan, model, email, workflows, active, maxWidth } = opts;
  const watchLabel = `${A.label}watching${A.reset}`;
  const watchValue = watching
    ? `${A.cyan}${watching}${A.reset}`
    : `${A.label}<no MCP target>${A.reset}`;
  // <plan> / <model> as a single colored unit so the relationship reads
  // visually: plan is the entitlement, model is what's running on it.
  const planModel  = `${A.amber}${plan}${A.reset}${A.label}/${A.reset}${A.gold}${model}${A.reset}`;
  const emailValue = `${A.violet}${email}${A.reset}`;
  const sep        = ` ${A.label}·${A.reset} `;
  const left       = `${watchLabel} ${watchValue}${sep}${planModel}${sep}${emailValue}`;

  const tabs = workflows.map((wf, i) => {
    const isActive = i === active;
    const marker = isActive ? `${A.amber}▸${A.reset}` : ' ';
    const statusGlyph = wf.status === 'running' ? `${A.green}●${A.reset}`
                      : wf.status === 'failed'  ? `${A.red}✗${A.reset}`
                      : wf.status === 'done'    ? `${A.label}✓${A.reset}`
                      :                            ` `;
    const label = isActive
      ? `${A.bold}${A.body}${wf.label}${A.reset}`
      : `${A.label}${wf.label}${A.reset}`;
    return `${marker}${label}${statusGlyph ? ` ${statusGlyph}` : ''}`;
  }).join(`${A.label} │ ${A.reset}`);

  const leftVis  = visWidth(left);
  const rightVis = visWidth(tabs);
  const gap      = Math.max(2, maxWidth - leftVis - rightVis);
  const composed = left + ' '.repeat(gap) + tabs;
  if (visWidth(composed) <= maxWidth) return composed;
  // Too wide — shorten the watching path, retry once.
  if (watching) {
    const shortRoom = Math.max(8, maxWidth - rightVis - leftVis + watching.length - 4);
    const shortWatch = shortenPath(watching, shortRoom);
    const left2 = `${watchLabel} ${A.cyan}${shortWatch}${A.reset}${sep}${planModel}${sep}${emailValue}`;
    return truncVis(left2 + '  ' + tabs, maxWidth);
  }
  return truncVis(composed, maxWidth);
}

/** Right-aligned trailing text in the header — keyboard hints. */
export function headerHints(): string {
  return 'q quit · / filter · p pause · S sort · ↑↓ scroll';
}

function fmtUptime(sec: number): string {
  if (sec < 0 || !Number.isFinite(sec)) return '—';
  const total = Math.floor(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Mode pill rendered inside the bottom border (§2 footer).
 *  Each segment wears a distinct color so the strip reads as a real status
 *  bar instead of a wall of grey. The header already carries the blinking
 *  LIVE indicator; the footer instead surfaces the running event total. */
export function footerPill(opts: ModeBannerOpts): string {
  const sep = `${A.label}·${A.reset}`;
  const parts: string[] = [];

  // Lead segment: PAUSED if paused, otherwise running event count (cyan).
  if (opts.paused) {
    parts.push(`${A.amber}${A.bold}PAUSED${A.reset}`);
  } else if (typeof opts.totalEvents === 'number') {
    parts.push(`${A.cyan}events ${opts.totalEvents.toLocaleString()}${A.reset}`);
  }

  // Pending: amber when > 0 to draw the eye, dim violet otherwise.
  const pendColor = opts.pendingCount > 0 ? A.amber : A.violet;
  parts.push(`${pendColor}${opts.pendingCount} pending${A.reset}`);

  // Sort mode in violet — distinct from the others, ties to the brand.
  parts.push(`${A.magenta}sort: ${opts.sort}${A.reset}`);

  // Uptime in gold so it stands apart from greys around it.
  if (typeof opts.uptimeSec === 'number') {
    parts.push(`${A.gold}up ${fmtUptime(opts.uptimeSec)}${A.reset}`);
  }
  return parts.join(` ${sep} `);
}

// ---------------------------------------------------------------------------
// Welcome screen — larger mascot + title + hints (§7B).
// Returns array of lines, ready to write into the boot-time clear screen.
// ---------------------------------------------------------------------------
export function renderWelcome(version: string, status: string): string[] {
  const mascot = renderMascot(MASCOT_WELCOME);  // MascotPaint → string[]
  const out: string[] = [];
  out.push('');
  out.push('');
  // Center the mascot in 60 cols
  const titleLines = [
    `${A.amber}${A.bold}Enchanter v${version}${A.reset}`,
    `${A.body}Real-time observability monitor${A.reset}`,
    '',
    `${A.label}q quit · / filter · p pause · ? help${A.reset}`,
    '',
    `${A.label}${status}${A.reset}`,
  ];
  for (let i = 0; i < mascot.length; i++) {
    const m = mascot[i] ?? '';
    const t = titleLines[i - 2] ?? '';
    out.push(`     ${m}     ${t}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Help overlay — rendered as inner frame body when `?` is toggled.
// ---------------------------------------------------------------------------
export type InputMode = 'normal' | 'filter' | 'help';

export function renderHelpLines(): string[] {
  const row = (key: string, desc: string): string =>
    `  ${A.bold}${A.body}${key.padEnd(14)}${A.reset}${A.label}${desc}${A.reset}`;
  return [
    `${A.amber}${A.bold}Enchanter Inspector — Keyboard Reference${A.reset}`,
    '',
    row('q / Ctrl-C',   'quit'),
    row('r',            'run demo (re-spawns MCP session)'),
    row('s',            'run stress-plugins script'),
    row('x',            'run red-team script'),
    row('c',            'clear: reset filter, sort, scroll'),
    row('p',            'pause / resume event stream'),
    row('Tab',          'cycle pane focus (plugins → events → alerts)'),
    row('] / [',        'next / prev workflow tab'),
    '',
    `  ${A.label}── Plugins pane (when focused) ──${A.reset}`,
    row('1..9',         'select plugin row (1=pech, 2=emu, …)'),
    row('t',            'toggle selected plugin on/off'),
    row('T',            'toggle ALL plugins on/off'),
    row('S',            'cycle sort: recent → name → veto'),
    row('/',            'enter filter mode (substring on topic)'),
    row('Esc',          'cancel filter (or exit help)'),
    row('↑ / ↓',        'scroll history (auto-pauses)'),
    row('Home / End',   'jump to oldest / live tail'),
    row('?',            'toggle this help overlay'),
    '',
    `  ${A.label}Press any key to dismiss.${A.reset}`,
  ];
}

// ---------------------------------------------------------------------------
// Scroll-back indicator (kept for inspect.ts call site).
// ---------------------------------------------------------------------------
export function renderScrollIndicator(scrollBack: number): string {
  if (scrollBack <= 0) return '';
  return `${A.amber}▲ scrolled back ${scrollBack} events — End to return to tail${A.reset}`;
}
