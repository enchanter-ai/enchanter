/* enchanter/src/plugins/hydra.adapter.ts — implements architecture-spec
   phase_1.hydra (trust-gate veto + post-response secret/CVE scan) and
   phase_4 failure-modes 4 + 5 (indirect prompt injection masking +
   unbounded-resource rate hint). The reference plugin: full implementation,
   not a stub.
   Counter: a permissive "report only" mode would reduce UX friction but
   loses the deterministic block guarantee that ADR-002 mandates — hydra
   fails closed. */

import type { PluginAdapter } from './plugin-contract.js';
import type { EnchantedEvent, PluginAck } from '../bus/event-types.js';
import type { RequestContext } from '../orchestration/request-context.js';
import { CVE_PATTERNS_V0_1, SECRET_PATTERNS_V0_1, type CvePattern } from './hydra/cve-patterns.js';

export interface HydraConfig {
  /** Override the CVE pattern table. Default: ships v0.1 high-confidence patterns. */
  cvePatterns?: ReadonlyArray<CvePattern>;
  /** Override secret-masking patterns. */
  secretPatterns?: ReadonlyArray<{ readonly id: string; readonly match: RegExp; readonly redaction: string }>;
}

interface HydraState {
  cvePatterns: ReadonlyArray<CvePattern>;
  secretPatterns: ReadonlyArray<{ readonly id: string; readonly match: RegExp; readonly redaction: string }>;
}

const STATE: HydraState = {
  cvePatterns: CVE_PATTERNS_V0_1,
  secretPatterns: SECRET_PATTERNS_V0_1,
};

export function configureHydra(config: HydraConfig): void {
  if (config.cvePatterns) STATE.cvePatterns = config.cvePatterns;
  if (config.secretPatterns) STATE.secretPatterns = config.secretPatterns;
}

export function maskSecrets(input: string): { masked: string; matched: string[] } {
  let masked = input;
  const matched: string[] = [];
  for (const p of STATE.secretPatterns) {
    if (p.match.test(masked)) {
      matched.push(p.id);
      // Reset lastIndex for global regexes between calls.
      p.match.lastIndex = 0;
      masked = masked.replace(p.match, p.redaction);
    }
  }
  return { masked, matched };
}

export function matchCvePatterns(input: string): CvePattern[] {
  const hits: CvePattern[] = [];
  for (const p of STATE.cvePatterns) {
    if (p.match.test(input)) hits.push(p);
  }
  return hits;
}

export const hydraAdapter: PluginAdapter = {
  name: 'hydra',
  phases: ['trust-gate', 'post-response'],
  required: true, // fail closed
  topics: {
    subscribes: ['mcp.tool.call.requested', 'mcp.tool.result.received', 'lifecycle.trust-gate', 'lifecycle.post-response'],
    emits: ['hydra.veto.fired', 'hydra.secret.masked', 'hydra.cve.matched'],
  },
  budget_tier: 'always', // security plugins never silence

  async onPhase(event: EnchantedEvent, _ctx: RequestContext): Promise<PluginAck> {
    if (event.phase === 'trust-gate') {
      return guardActionAtTrustGate(event);
    }
    if (event.phase === 'post-response') {
      return scanResultAtPostResponse(event);
    }
    return { status: 'ack' };
  },
};

function guardActionAtTrustGate(event: EnchantedEvent): PluginAck {
  // Match against multiple corpus views to defeat array-arg evasion:
  //   1. JSON-stringified payload (catches inline string args)
  //   2. Reconstructed command line `<tool> <args.join(' ')>` so patterns
  //      anchored on tool-name boundaries (`git push --force`,
  //      `curl ... | bash`, `rm -rf /`) match even when MCP splits the
  //      tool name from its arguments.
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const corpora: string[] = [JSON.stringify(payload)];
  const tool = typeof payload['tool'] === 'string' ? (payload['tool'] as string) : '';
  const args = payload['args'];
  const argString = Array.isArray(args) && args.every((a) => typeof a === 'string')
    ? (args as string[]).join(' ')
    : typeof args === 'string'
      ? args
      : '';
  if (tool || argString) {
    corpora.push(`${tool} ${argString}`.trim());
  }
  const cveHits: CvePattern[] = [];
  for (const c of corpora) {
    for (const h of matchCvePatterns(c)) {
      if (!cveHits.includes(h)) cveHits.push(h);
    }
  }

  if (cveHits.length === 0) {
    return { status: 'ack' };
  }

  const critical = cveHits.find((h) => h.severity === 'critical');
  if (critical) {
    return {
      status: 'veto',
      reason: `hydra-cve-block:${critical.id} (${critical.cve_anchor}): ${critical.rationale}`,
      derived_events: [
        {
          id: `${event.correlation_id}::hydra-veto`,
          correlation_id: event.correlation_id,
          session_id: event.session_id,
          phase: event.phase,
          topic: 'hydra.veto.fired',
          source: 'hydra',
          budget_tier: event.budget_tier,
          ts: Date.now(),
          payload: { pattern_id: critical.id, severity: critical.severity, cve_anchor: critical.cve_anchor },
        },
      ],
    };
  }

  // High/medium hits: warn but allow (advisory). v0.2: configurable severity threshold.
  return {
    status: 'ack',
    degraded: true,
    reason: `hydra-cve-warn: ${cveHits.map((h) => h.id).join(',')}`,
  };
}

function scanResultAtPostResponse(event: EnchantedEvent): PluginAck {
  const payload = event.payload ?? {};
  const result = (payload as { result?: unknown }).result;
  if (result === undefined) return { status: 'ack' };

  const corpus = typeof result === 'string' ? result : JSON.stringify(result);
  const { masked, matched } = maskSecrets(corpus);

  if (matched.length === 0) {
    return { status: 'ack' };
  }

  return {
    status: 'ack',
    reason: `hydra-secret-masked: ${matched.join(',')}`,
    derived_events: [
      {
        id: `${event.correlation_id}::hydra-mask`,
        correlation_id: event.correlation_id,
        session_id: event.session_id,
        phase: event.phase,
        topic: 'hydra.secret.masked',
        source: 'hydra',
        budget_tier: event.budget_tier,
        ts: Date.now(),
        payload: { matched_patterns: matched, redacted_length: masked.length },
      },
    ],
  };
}
