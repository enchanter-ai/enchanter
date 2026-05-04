# Full Trust-Pin (FM 10 closure) — v0.3.1 design

Tracker for v0.3 follow-up #3. Stub: `src/registry/trust-pin.ts`. Not implemented in this slice.

## Threat model

Failure mode 10 (MCPoison). An MCP server that was approved at registration silently mutates one of its surfaces — schema, binary, args, env — and exfiltrates / misbehaves under the operator's prior consent. v0.2 closed the schema-mutation vector via `SchemaDigestMismatchError` in `namespace.ts`. v0.3 closes the rest.

## Proposed digest

```
trust_digest = SHA-256(
    canonical_json({
        cmd: <stdio-command-or-null>,
        args: <argv-array-as-given>,         // order preserved
        binaryDigest: <sha256-of-executable>, // stdio only
        envAllowlist: <sorted-env-name-list>, // names only, NOT values
        url: <normalized-absolute-url>,       // http transport only
        schemaDigests: <sorted-list-of-per-tool-schema-digests>,
    })
)
```

Canonicalization rules:
- args **NOT sorted** (argv order is meaningful for CLI invocation).
- envAllowlist **sorted lexicographically** (set semantics).
- schemaDigests **sorted lexicographically** (set semantics).
- JSON.stringify with explicit field ordering: `cmd, args, binaryDigest, envAllowlist, url, schemaDigests`.
- Missing fields omitted entirely (not present as `null`) so the digest is stable across transport types.

## Update protocol

| Event | Action |
|-------|--------|
| First registration | TOFU populate. Record digest + inputs snapshot. |
| Subsequent registration, digest match | No-op; proceed. |
| Subsequent registration, digest mismatch | Throw `TrustPinMismatchError`. Surface a diff (which fields changed). Block server use until operator runs `approveTrustPinUpdate()`. |

The diff display is a human-in-the-loop affordance — *what* changed (binary digest, env, schema set) determines whether the operator should re-consent or treat the mismatch as a compromise signal.

## Integration point

`Orchestrator` registers a server → calls `verifyTrustPin(store, server_id, inputs)`. On `TrustPinMismatchError`, the orchestrator emits a security veto event (existing `bus` channel) and refuses to dispatch tool calls to the server until re-consent.

`namespace.ts` already computes per-tool schema digests; the trust-pin layer aggregates them into the `schemaDigests` field above.

## Open questions

1. **Binary digest scope.** stdio binary may be a wrapper script that imports the real implementation. Pin the wrapper (path-stable) or the resolved binary (impl-stable)? Default: pin the wrapper (what's actually invoked) and document the limitation.
2. **Env value sensitivity.** We hash env *names* not *values* — values change legitimately (rotation, secrets reload). But a name appearing or disappearing IS security-relevant.
3. **Re-consent UX.** CLI command (`enchanter trust-pin approve <server>`) vs. interactive prompt at orchestrator-registration time.
4. **Persistence format.** JSONL append-only mirrors replay-store; alternative is a snapshot JSON. Pin count is small (one entry per server) → snapshot JSON simpler. Recommend snapshot JSON.

## API surface (stubbed today)

```ts
export type TrustDigest = string;
export interface TrustPinInputs { cmd?; args?; binaryDigest?; envAllowlist?; url?; schemaDigests }
export interface TrustPinEntry { server_id; digest; pinnedAt; inputs }
export class TrustPinMismatchError extends Error { ... }
export interface TrustPinStore { get; set; remove; list }
export function computeTrustDigest(inputs): TrustDigest
export function verifyTrustPin(store, server_id, inputs): void
export function approveTrustPinUpdate(store, server_id, inputs): TrustPinEntry
export class InMemoryTrustPinStore implements TrustPinStore { ... }
```

## Failure modes touched

- **FM 10** (MCPoison) — primary; full closure.
- **FM 1** (tool-name collision) — orthogonal; namespace.ts already covers.
- **FM 6** (server spoofing) — orthogonal; tls-pin.ts covers.
