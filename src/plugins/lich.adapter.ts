/* enchanter/src/plugins/lich.adapter.ts — v0.2 implementation.
   Refs: architecture-spec phase_4.failure_mode_2 + plugins/lich source (M1/M6).
   Primary owner of failure-mode 2 (tool poisoning). M5 sandbox deferred.
   M1 static suspicion: scans tool_schema descriptions, parameter names, and
   error templates for instruction-shaped patterns at post-response phase.
   M6 simplified: EMA-weighted false-positive rate per pattern_id; patterns with
   FP rate > 0.5 are downweighted 50% in suspicion scoring. Fail-closed.

   TODO(v0.3.1): M5 sandbox — see docs/v0.3/lich-m5-sandbox.md. The sandbox
   confirmation step lands as a sibling module (src/plugins/lich/sandbox.ts)
   wired in at the suspicionScore < VETO_THRESHOLD branch: instead of an
   advisory ack with degraded=true, we'd run the tool call inside a
   resource-bounded child_process and compare its observed output shape
   against the static schema before publishing the result. Do not modify
   scanToolSchema or the M1/M6 surfaces when landing M5. */

import type { PluginAdapter } from './plugin-contract.js';
import type { EnchantedEvent, PluginAck } from '../bus/event-types.js';
import type { RequestContext } from '../orchestration/request-context.js';
import {
  runSandboxedReview,
  runSandboxedToolCall,
  runSandboxedToolCallLive,
  type SandboxResult,
  type SandboxOptions,
  type ToolConfirmResult,
  type ToolConfirmDifference,
  type LiveTransportFactory,
  type LiveRunMode,
  type ServerDescriptor,
} from './lich/sandbox.js';
import { ReplayCache } from './lich/replay-cache.js';
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Pattern catalogue — [author judgment] on the 5 pattern categories
// ---------------------------------------------------------------------------

export interface SuspicionPattern {
  readonly id: string;
  readonly severity: number; // [author judgment] weight contributing to threshold
  readonly test: (text: string) => boolean;
}

// [author judgment] P1–P5 chosen as highest-signal tool-poisoning attack surfaces.
const PATTERNS: ReadonlyArray<SuspicionPattern> = [
  {
    // P1: Imperative override verbs at the start of a description field.
    id: 'P1:imperative-override',
    severity: 2,
    test: (t) => /(?:^|\n)\s*(?:MUST|IGNORE|OVERRIDE|DISREGARD|BYPASS)\b/i.test(t),
  },
  {
    // P2: Credential-request phrases in parameter descriptions.
    id: 'P2:credential-request',
    severity: 2,
    test: (t) => /\b(?:api[\s_-]?key|password|secret|token)\b/i.test(t),
  },
  {
    // P3: Suspicious TLD in URL-shaped strings inside error message templates.
    id: 'P3:suspicious-url',
    severity: 1,
    test: (t) => /https?:\/\/[^\s"']+\.(?:tk|ml|cf|gq|ga)\b|https?:\/\/\d{1,3}(?:\.\d{1,3}){3}/i.test(t),
  },
  {
    // P4: Base64-encoded payloads > 100 chars in description fields.
    id: 'P4:base64-payload',
    severity: 2,
    test: (t) => /[A-Za-z0-9+/]{100,}={0,2}/.test(t),
  },
  {
    // P5: Hidden Unicode — zero-width chars or RTL override codepoints.
    id: 'P5:hidden-unicode',
    severity: 2,
    test: (t) => /[​-‏‪-‮⁠-⁤﻿]/.test(t),
  },
];

// ---------------------------------------------------------------------------
// M6 simplified: EMA false-positive tracking
// ---------------------------------------------------------------------------

// [author judgment] decay=0.9 keeps recent corrections influential without
// discarding older signal. FP rate > 0.5 triggers a 50% score downweight.
const FP_DECAY = 0.9;
const FP_DOWNWEIGHT_THRESHOLD = 0.5;

interface PatternState {
  fpRate: number; // EMA false-positive rate in [0, 1]
}

const patternState = new Map<string, PatternState>(
  PATTERNS.map((p) => [p.id, { fpRate: 0 }]),
);

/** Feed a false-positive signal for pattern_id — reduces future suspicion score. */
export function markFalsePositive(pattern_id: string): void {
  const s = patternState.get(pattern_id);
  if (!s) return;
  // EMA update: new_fp_rate = decay * current + (1 - decay) * 1
  s.fpRate = FP_DECAY * s.fpRate + (1 - FP_DECAY);
}

function effectiveSeverity(pattern: SuspicionPattern): number {
  const s = patternState.get(pattern.id);
  if (s && s.fpRate > FP_DOWNWEIGHT_THRESHOLD) {
    return pattern.severity * 0.5;
  }
  return pattern.severity;
}

// ---------------------------------------------------------------------------
// Tool schema scanning (M1 static suspicion)
// ---------------------------------------------------------------------------

export interface SuspicionMatch {
  schema_path: string;
  pattern_id: string;
  severity: number;
}

interface ToolSchema {
  description?: unknown;
  parameters?: Record<string, unknown>;
  inputSchema?: { properties?: Record<string, unknown> };
  errorTemplates?: unknown;
  [key: string]: unknown;
}

function scanText(text: string, path: string): SuspicionMatch[] {
  const hits: SuspicionMatch[] = [];
  for (const p of PATTERNS) {
    if (p.test(text)) {
      hits.push({ schema_path: path, pattern_id: p.id, severity: effectiveSeverity(p) });
    }
  }
  return hits;
}

function scanSchema(schema: ToolSchema): SuspicionMatch[] {
  const matches: SuspicionMatch[] = [];

  if (typeof schema.description === 'string') {
    matches.push(...scanText(schema.description, 'description'));
  }

  // Scan parameter descriptions from both conventions Enchanter uses.
  const props: Record<string, unknown> =
    (schema.parameters as Record<string, unknown> | undefined) ??
    schema.inputSchema?.properties ??
    {};
  for (const [key, val] of Object.entries(props)) {
    const paramDesc =
      typeof val === 'object' && val !== null && 'description' in val
        ? String((val as { description: unknown }).description)
        : typeof val === 'string'
          ? val
          : null;
    if (paramDesc !== null) {
      matches.push(...scanText(paramDesc, `parameters.${key}.description`));
    }
  }

  // Scan error message templates.
  if (schema.errorTemplates !== undefined) {
    const errText =
      typeof schema.errorTemplates === 'string'
        ? schema.errorTemplates
        : JSON.stringify(schema.errorTemplates);
    matches.push(...scanText(errText, 'errorTemplates'));
  }

  // Scan tool name / display name for hidden unicode.
  for (const nameField of ['name', 'displayName'] as const) {
    if (typeof schema[nameField] === 'string') {
      matches.push(...scanText(schema[nameField] as string, nameField));
    }
  }

  return matches;
}

// ---------------------------------------------------------------------------
// [author judgment] threshold=3 balances veto sensitivity vs. false-positive
// rate across the 5 pattern categories (2+2+1+2+2 = max 9 possible).
// A single P1/P2/P4/P5 hit (severity 2) alone does not veto; two hits do.
// ---------------------------------------------------------------------------
const VETO_THRESHOLD = 3;

// ---------------------------------------------------------------------------
// M5 sandbox config (v0.3.1 #4)
// ---------------------------------------------------------------------------
// Default OFF for back-compat — existing M1+M6 behavior is unchanged. When
// enabled, post-response events whose payload carries `code` (string) will be
// reviewed inside a forked child_process with a wall-clock budget. Sandbox
// failures are advisory: the adapter continues to return the M1 verdict and
// flags `degraded:true` on the ack.
type SandboxRunner = (code: string, options: SandboxOptions) => Promise<SandboxResult>;
type ToolConfirmRunner = (
  toolName: string,
  params: unknown,
  originalResponse: unknown,
  options: SandboxOptions,
) => Promise<ToolConfirmResult>;
type ToolConfirmLiveRunner = (
  toolName: string,
  params: unknown,
  originalResponse: unknown,
  serverDescriptor: ServerDescriptor,
  options: SandboxOptions & {
    transportFactory?: LiveTransportFactory;
    serverDescriptor?: ServerDescriptor;
    runMode?: LiveRunMode;
  },
) => Promise<ToolConfirmResult>;

interface LichConfig {
  m5_sandbox: boolean;
  m5_time_budget_ms: number;
  /** Test-only injection point. Defaults to runSandboxedReview. */
  m5_sandbox_runner: SandboxRunner;
  /** v0.3.2 — MCP tool-call confirmation variant; default OFF. */
  m5_tool_confirm: boolean;
  /** Test-only injection point. Defaults to runSandboxedToolCall. */
  m5_tool_confirm_runner: ToolConfirmRunner;
  /** v0.4 #1 — real-MCP-server replay variant; default OFF. */
  m5_tool_confirm_live: boolean;
  /** Test-only injection point. Defaults to runSandboxedToolCallLive. */
  m5_tool_confirm_live_runner: ToolConfirmLiveRunner;
  /** Required when m5_tool_confirm_live is on AND m5_replay_run_mode is
   *  'in-process' — produces a fresh transport in the parent process. Unused
   *  when the run mode is 'worker' (the worker spawns its own transport from
   *  m5_replay_run_mode='worker' + payload.server_descriptor). */
  m5_transport_factory: LiveTransportFactory | undefined;
  /** v0.5 #1 — execution mode for the live replay. Default 'worker' for true
   *  process isolation; 'in-process' is for hermetic tests with stubbed
   *  transports. See LiveRunMode in sandbox.ts. */
  m5_replay_run_mode: LiveRunMode;
  /** LRU cache for live replay results, keyed by (schemaDigest, argsDigest). */
  m5_replay_cache: ReplayCache;
}

const config: LichConfig = {
  m5_sandbox: false,
  m5_time_budget_ms: 5_000,
  m5_sandbox_runner: runSandboxedReview,
  m5_tool_confirm: false,
  m5_tool_confirm_runner: runSandboxedToolCall,
  m5_tool_confirm_live: false,
  m5_tool_confirm_live_runner: runSandboxedToolCallLive,
  m5_transport_factory: undefined,
  m5_replay_run_mode: 'worker',
  m5_replay_cache: new ReplayCache(256),
};

/** Test/runtime hook to flip the M5 sandbox flag, tune its budget, or inject a stub runner. */
export function configureLich(patch: Partial<LichConfig>): void {
  if (patch.m5_sandbox !== undefined) config.m5_sandbox = patch.m5_sandbox;
  if (patch.m5_time_budget_ms !== undefined) config.m5_time_budget_ms = patch.m5_time_budget_ms;
  if (patch.m5_sandbox_runner !== undefined) config.m5_sandbox_runner = patch.m5_sandbox_runner;
  if (patch.m5_tool_confirm !== undefined) config.m5_tool_confirm = patch.m5_tool_confirm;
  if (patch.m5_tool_confirm_runner !== undefined) config.m5_tool_confirm_runner = patch.m5_tool_confirm_runner;
  if (patch.m5_tool_confirm_live !== undefined) config.m5_tool_confirm_live = patch.m5_tool_confirm_live;
  if (patch.m5_tool_confirm_live_runner !== undefined) {
    config.m5_tool_confirm_live_runner = patch.m5_tool_confirm_live_runner;
  }
  // Use `in` so callers can explicitly reset the factory back to undefined
  // (an `!== undefined` guard would silently drop the reset).
  if ('m5_transport_factory' in patch) config.m5_transport_factory = patch.m5_transport_factory;
  if (patch.m5_replay_run_mode !== undefined) config.m5_replay_run_mode = patch.m5_replay_run_mode;
  if (patch.m5_replay_cache !== undefined) config.m5_replay_cache = patch.m5_replay_cache;
}

/** Test-only: surface the live cache for assertions. */
export function getLichReplayCache(): ReplayCache {
  return config.m5_replay_cache;
}

// SHA-256 over a stable JSON serialization. For args we sort keys at every
// object level so {a:1,b:2} and {b:2,a:1} hash identically.
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function digestSchema(schema: unknown): string {
  return sha256Hex(stableStringify(schema ?? null));
}

function digestArgs(args: unknown): string {
  return sha256Hex(stableStringify(args ?? null));
}

// ---------------------------------------------------------------------------
// PluginAdapter
// ---------------------------------------------------------------------------

export const lichAdapter: PluginAdapter = {
  name: 'lich',
  phases: ['post-response'],
  required: true, // fail-closed: failure-mode 2 mitigation is mandatory
  topics: {
    subscribes: ['crow.*', 'hydra.*', 'filesystem.write.completed'],
    emits: ['lich.suspicion.flagged', 'lich.sandbox.executed', 'lich.rubric.verdict'],
  },
  budget_tier: 'always', // security plugin — never silenced

  async onPhase(event: EnchantedEvent, _ctx: RequestContext): Promise<PluginAck> {
    if (event.phase !== 'post-response') {
      return { status: 'ack' };
    }
    let ack = scanToolSchema(event);

    if (config.m5_sandbox) {
      const code = (event.payload as { code?: unknown }).code;
      if (typeof code === 'string') {
        ack = await augmentWithSandbox(ack, event, code);
      }
    }

    if (config.m5_tool_confirm && ack.status !== 'veto') {
      const p = event.payload as { tool?: unknown; args?: unknown; response?: unknown };
      const toolName = typeof p.tool === 'string' ? p.tool : null;
      const hasResponse = 'response' in (event.payload as object);
      if (toolName !== null && hasResponse) {
        ack = await augmentWithToolConfirm(ack, event, toolName, p.args, p.response);
      }
    }

    if (config.m5_tool_confirm_live && ack.status !== 'veto') {
      const p = event.payload as {
        tool?: unknown;
        tool_schema?: unknown;
        args?: unknown;
        response?: unknown;
        server_descriptor?: unknown;
      };
      const toolName = typeof p.tool === 'string' ? p.tool : null;
      const hasResponse = 'response' in (event.payload as object);
      const factory = config.m5_transport_factory;
      const runMode = config.m5_replay_run_mode;
      const descriptor: ServerDescriptor =
        p.server_descriptor && typeof p.server_descriptor === 'object'
          ? (p.server_descriptor as ServerDescriptor)
          : {};
      const hasDescriptor = Object.keys(descriptor).length > 0;
      // Worker mode needs a server_descriptor in the payload; in-process mode
      // needs a transportFactory in config. If the required input is missing
      // for the configured mode, skip the replay (fail-open: M1 ack stands).
      const canRun =
        toolName !== null &&
        hasResponse &&
        ((runMode === 'worker' && hasDescriptor) ||
          (runMode === 'in-process' && factory !== undefined));
      if (canRun && toolName !== null) {
        ack = await augmentWithToolConfirmLive(
          ack,
          event,
          toolName,
          p.args,
          p.response,
          p.tool_schema,
          descriptor,
          factory,
          runMode,
        );
      }
    }

    return ack;
  },
};

async function augmentWithSandbox(
  baseAck: PluginAck,
  event: EnchantedEvent,
  code: string,
): Promise<PluginAck> {
  // Veto from M1 already short-circuits — don't burn a fork on a doomed call.
  if (baseAck.status === 'veto') {
    return baseAck;
  }

  const sandbox: SandboxResult = await config.m5_sandbox_runner(code, {
    time_budget_ms: config.m5_time_budget_ms,
  });

  const sandboxEvent: EnchantedEvent = {
    id: `${event.correlation_id}::lich-sandbox`,
    correlation_id: event.correlation_id,
    session_id: event.session_id,
    phase: event.phase,
    topic: 'lich.sandbox.executed',
    source: 'lich',
    budget_tier: event.budget_tier,
    ts: Date.now(),
    payload: sandbox.failed
      ? { failed: true, reason: sandbox.reason, elapsed_ms: sandbox.elapsed_ms }
      : { failed: false, findings: sandbox.findings, score: sandbox.score, elapsed_ms: sandbox.elapsed_ms },
  };

  const derived = [...(baseAck.derived_events ?? []), sandboxEvent];

  if (sandbox.failed) {
    // Fail-open: surface degraded state, keep the underlying ack/veto status.
    return {
      ...baseAck,
      status: baseAck.status,
      degraded: true,
      reason: baseAck.reason
        ? `${baseAck.reason}; lich-sandbox-${sandbox.reason}`
        : `lich-sandbox-${sandbox.reason}`,
      derived_events: derived,
    };
  }

  return {
    ...baseAck,
    derived_events: derived,
  };
}

async function augmentWithToolConfirm(
  baseAck: PluginAck,
  event: EnchantedEvent,
  toolName: string,
  params: unknown,
  originalResponse: unknown,
): Promise<PluginAck> {
  const result: ToolConfirmResult = await config.m5_tool_confirm_runner(
    toolName,
    params,
    originalResponse,
    { time_budget_ms: config.m5_time_budget_ms },
  );

  const confirmEvent: EnchantedEvent = {
    id: `${event.correlation_id}::lich-tool-confirm`,
    correlation_id: event.correlation_id,
    session_id: event.session_id,
    phase: event.phase,
    topic: 'lich.sandbox.executed',
    source: 'lich',
    budget_tier: event.budget_tier,
    ts: Date.now(),
    payload: result.failed
      ? { variant: 'tool-confirm', failed: true, reason: result.reason, elapsed_ms: result.elapsed_ms }
      : {
          variant: 'tool-confirm',
          failed: false,
          ok: result.ok,
          differences: result.differences,
          elapsed_ms: result.elapsed_ms,
        },
  };

  const derived = [...(baseAck.derived_events ?? []), confirmEvent];

  if (result.failed) {
    // Fail-open: mark degraded, let the request through.
    return {
      ...baseAck,
      status: baseAck.status,
      degraded: true,
      reason: baseAck.reason
        ? `${baseAck.reason}; lich-tool-confirm-${result.reason}`
        : `lich-tool-confirm-${result.reason}`,
      derived_events: derived,
    };
  }

  if (!result.ok) {
    // Replay diverged from live response — high-severity ack with diff payload.
    const diffSummary = summarizeDiff(result.differences);
    return {
      ...baseAck,
      status: baseAck.status,
      degraded: true,
      reason: baseAck.reason
        ? `${baseAck.reason}; lich-tool-confirm-divergence:${diffSummary}`
        : `lich-tool-confirm-divergence:${diffSummary}`,
      derived_events: derived,
    };
  }

  return {
    ...baseAck,
    derived_events: derived,
  };
}

async function augmentWithToolConfirmLive(
  baseAck: PluginAck,
  event: EnchantedEvent,
  toolName: string,
  params: unknown,
  originalResponse: unknown,
  toolSchema: unknown,
  serverDescriptor: ServerDescriptor,
  transportFactory: LiveTransportFactory | undefined,
  runMode: LiveRunMode,
): Promise<PluginAck> {
  const cache = config.m5_replay_cache;
  const schemaDigest = digestSchema(toolSchema);
  const argsDigest = digestArgs(params);
  const cacheKey = cache.key(schemaDigest, argsDigest);

  let result: ToolConfirmResult | undefined = cache.get(cacheKey);
  const cacheHit = result !== undefined;

  if (!cacheHit) {
    result = await config.m5_tool_confirm_live_runner(
      toolName,
      params,
      originalResponse,
      serverDescriptor,
      {
        time_budget_ms: config.m5_time_budget_ms,
        runMode,
        ...(transportFactory !== undefined ? { transportFactory } : {}),
      },
    );
    cache.set(cacheKey, result);
  }

  // result is defined: either retrieved from cache or just produced by the
  // runner above. Narrow for noUncheckedIndexedAccess.
  const finalResult = result as ToolConfirmResult;

  const confirmEvent: EnchantedEvent = {
    id: `${event.correlation_id}::lich-tool-confirm-live`,
    correlation_id: event.correlation_id,
    session_id: event.session_id,
    phase: event.phase,
    topic: 'lich.sandbox.executed',
    source: 'lich',
    budget_tier: event.budget_tier,
    ts: Date.now(),
    payload: finalResult.failed
      ? {
          variant: 'tool-confirm-live',
          failed: true,
          reason: finalResult.reason,
          elapsed_ms: finalResult.elapsed_ms,
          cache_hit: cacheHit,
        }
      : {
          variant: 'tool-confirm-live',
          failed: false,
          ok: finalResult.ok,
          differences: finalResult.differences,
          elapsed_ms: finalResult.elapsed_ms,
          cache_hit: cacheHit,
        },
  };

  const derived = [...(baseAck.derived_events ?? []), confirmEvent];

  if (finalResult.failed) {
    return {
      ...baseAck,
      status: baseAck.status,
      degraded: true,
      reason: baseAck.reason
        ? `${baseAck.reason}; lich-tool-confirm-live-${finalResult.reason}`
        : `lich-tool-confirm-live-${finalResult.reason}`,
      derived_events: derived,
    };
  }

  if (!finalResult.ok) {
    const diffSummary = summarizeDiff(finalResult.differences);
    return {
      ...baseAck,
      status: baseAck.status,
      degraded: true,
      reason: baseAck.reason
        ? `${baseAck.reason}; lich-tool-confirm-live-divergence:${diffSummary}`
        : `lich-tool-confirm-live-divergence:${diffSummary}`,
      derived_events: derived,
    };
  }

  return {
    ...baseAck,
    derived_events: derived,
  };
}

function summarizeDiff(diffs: ReadonlyArray<ToolConfirmDifference>): string {
  if (diffs.length === 0) return 'none';
  const paths = diffs.slice(0, 3).map((d) => d.path.join('.') || '<root>');
  const tail = diffs.length > 3 ? `+${diffs.length - 3}` : '';
  return `${diffs.length} path(s): ${paths.join(',')}${tail}`;
}

function scanToolSchema(event: EnchantedEvent): PluginAck {
  const rawSchema = (event.payload as { tool_schema?: unknown }).tool_schema;
  if (rawSchema === undefined) {
    return { status: 'ack' };
  }

  const schema =
    typeof rawSchema === 'object' && rawSchema !== null
      ? (rawSchema as ToolSchema)
      : null;
  if (schema === null) {
    return { status: 'ack' };
  }

  const matches = scanSchema(schema);
  if (matches.length === 0) {
    return { status: 'ack' };
  }

  const suspicionScore = matches.reduce((sum, m) => sum + m.severity, 0);

  const derived: EnchantedEvent[] = matches.map((m, i) => ({
    id: `${event.correlation_id}::lich-flag-${i}`,
    correlation_id: event.correlation_id,
    session_id: event.session_id,
    phase: event.phase,
    topic: 'lich.suspicion.flagged',
    source: 'lich',
    budget_tier: event.budget_tier,
    ts: Date.now(),
    payload: { schema_path: m.schema_path, pattern_id: m.pattern_id, severity: m.severity },
  }));

  if (suspicionScore >= VETO_THRESHOLD) {
    const patternList = [...new Set(matches.map((m) => m.pattern_id))].join(',');
    return {
      status: 'veto',
      reason: `lich-tool-poisoning:${patternList}`,
      derived_events: derived,
    };
  }

  return {
    status: 'ack',
    degraded: true,
    reason: `lich-suspicion-below-threshold:score=${suspicionScore}`,
    derived_events: derived,
  };
}
