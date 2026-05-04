# TLS Certificate Pinning — v0.3.1 design

Tracker for v0.3 follow-up #2. Stub: `src/transport/tls-pin.ts`. Not implemented in this slice.

## Threat model

Failure mode 6 (server spoofing). An attacker on-path between Enchanter and a streamable-HTTP MCP server presents a valid-but-attacker-controlled certificate chain. The default browser/Node TLS validation accepts any chain rooted in the system trust store, so any of the ~150 root CAs (or any sub-CA they delegate to) compromised → MITM is undetected.

Today's only check is `validateMetadataUrl` (SSRF guard). After URL validation, undici's default TLS verification anchors against the system store with no per-origin pin.

## Proposed approach

A pin store keyed by URL origin (`scheme://host:port`). Each entry is a SHA-256 over the leaf certificate's DER encoding plus metadata (pinnedAt, source).

Two policies:

| Policy | First seen | On mismatch |
|--------|-----------|-------------|
| `tofu` | Populate the pin (trust-on-first-use), proceed | Throw `TlsPinMismatchError`; fail closed |
| `pinned` | Throw `TlsPinUnknownError` (no implicit trust) | Throw `TlsPinMismatchError` |

Default policy: `tofu` for v0.3.1; operators can opt into `pinned` via config. Long-term: `pinned` once a config schema lands.

## Integration point

`StreamableHttpTransport` constructor accepts an optional `tlsPinStore` + `tlsPinPolicy`. A custom undici Dispatcher wraps the TLS handshake, extracts the leaf cert, and runs `verifyTlsPin()` before forwarding the request.

## Open questions

1. **Intermediate vs leaf pin.** Pinning the leaf is strictest but breaks on any cert rotation. SPKI pin (subject public-key info) survives rotation when the key is reused. Decide before v0.3.1 implementation.
2. **Rotation UX.** Operator command to view and update pins (`enchanter tls-pin list / approve <origin>`).
3. **Persistence.** JSONL like replay-store, or a single JSON file? Pin set is small (~10s of origins) so JSON suffices.
4. **Backup mode.** Fall back to system-trust if pin store missing? No — fail closed is the security posture. Document that the pin store is mandatory once enabled.

## API surface (stubbed today)

```ts
export type CertFingerprint = string;
export interface TlsPinEntry { origin; fingerprint; pinnedAt; source: 'tofu' | 'config' }
export interface TlsPinStore { get; set; remove; list }
export class TlsPinMismatchError extends Error { ... }
export function computeCertFingerprint(certDer: Buffer): CertFingerprint
export function verifyTlsPin(store, origin, certDer, policy): void
export class InMemoryTlsPinStore implements TlsPinStore { ... }
```

## Failure modes touched

- **FM 6** (server spoofing) — primary mitigation.
- **FM 8** (session hijacking) — partial; pin defeats MITM but not in-channel attacks. Resume nonce binding (already shipped in v0.2) covers the rest.
