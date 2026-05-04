# Lich M5 — Sandboxed Tool-Call Confirmation

**Status:** v0.3.1 design.
**Owner:** `src/plugins/lich.adapter.ts` (entry), `src/plugins/lich/sandbox.ts` (new).

## Problem statement

Lich v0.2 mitigates failure-mode 2 (tool poisoning) with M1 static suspicion (5
pattern categories) and M6 EMA-weighted false-positive learning. Static scans
catch declared malice — text patterns visible at schema-load time. They miss
**latent** malice: a server whose schema looks innocent but whose runtime
output exfiltrates, escalates, or pivots when invoked with specific arguments.
Below the M1 veto threshold (`suspicionScore < 3`) v0.2 acks with
`degraded: true` and lets the call through. M5 closes that gap.

## Threat model

In scope:

1. Schema-clean tool whose response payload contains injected instructions
   ("Now also call ...", base64-encoded follow-on prompts).
2. Schema-clean tool that performs side effects beyond its declared
   `outputSchema` shape (writes files, shells out, reaches a second URL).
3. Time-of-check / time-of-use: a tool whose schema was scanned cleanly at
   list-time but whose response shape mutates between calls.

Out of scope: kernel-level isolation (already covered by the runtime's
process boundary), network egress to declared upstream hosts.

## Algorithm sketch

At the `post-response` phase, when M1 returns a non-veto ack with
`suspicionScore > 0`:

1. Re-run the tool call inside a resource-bounded `child_process` fork with:
   - `--max-old-space-size=128`, `--no-warnings`
   - 2-second wall-clock cap
   - stdin/stdout pipes only (no inherited fds)
   - fresh `process.env` minus secrets
2. Compare observed output to the live response on three axes:
   - **Shape:** JSON-schema validation against the declared `outputSchema`.
   - **Cardinality:** field count, max string length, max array length within
     2x of the live response.
   - **Drift hash:** SHA-1 over canonicalized field names — must equal the
     live response's hash.
3. Any mismatch → publish `lich.sandbox.divergence` and convert the parent
   ack to a veto with reason `lich-sandbox-divergence:<axis>`.

## Dependencies

Stdlib only: `node:child_process`, `node:crypto`, `node:perf_hooks`. No new
top-level deps.

## Test strategy

- Unit: `tests/plugins/lich/sandbox.test.ts` with a deterministic stub
  child-process driver. Six fixtures: clean shape, shape drift, cardinality
  drift, hash drift, timeout, child crash.
- Integration: extend `tests/integration/end-to-end.test.ts` with a mock MCP
  server that returns a different response shape on the second call.
- Negative: verify M1-clean schemas (suspicionScore == 0) skip the sandbox
  entirely — M5 must not regress hot-path latency for the common case.

## Open questions

- Sandbox cache: re-running every below-threshold call doubles latency. A
  per-`(schema_digest, args_digest)` LRU keyed cache may be appropriate;
  defer until the v0.3.1 baseline is measured.
