/* enchanter/src/oauth/resource-indicators.ts — implements architecture-spec
   phase_3.oauth flow steps 5 + 9 (RFC 8707 Resource Indicators — clients MUST
   implement for token-audience binding). Spec citation: S6, S7, S8, S9.
   Counter: simpler scope-based audience would work for OAuth 2.0 but the MCP
   spec mandates RFC 8707 — we honor it.

   v0.3 addition: bindReplayDefense() composes a freshness nonce + RFC 3339
   timestamp into the request parameter set. Pairs with replay-store.ts. */

import { encodeTimestamp } from './nonce.js';
import type { ReplayStore } from './replay-store.js';

export interface TokenAudience {
  /** The `aud` claim value(s) from the token. */
  readonly aud: string | string[];
}

/**
 * Per-request replay-defense parameters bound alongside `state` + PKCE.
 * Callers MUST send `nonce` and `request_ts` to the AS as part of the
 * authorize request and validate that the AS echoes them on response.
 */
export interface ReplayDefenseParams {
  /** Cryptographically-random per-request nonce (base64url, ≥ 16 bytes). */
  nonce: string;
  /** RFC 3339 UTC timestamp at request creation. */
  request_ts: string;
}

/**
 * Mint a fresh nonce + timestamp via the supplied ReplayStore. Call once
 * per OAuth authorize request; pair with consumeReplayDefense() on response.
 */
export function bindReplayDefense(store: ReplayStore): ReplayDefenseParams {
  const { nonce, issuedAt } = store.mint();
  return { nonce, request_ts: encodeTimestamp(issuedAt) };
}

export class ReplayDefenseError extends Error {
  constructor(
    public readonly reason: 'unknown' | 'replay' | 'expired',
    public readonly nonce: string,
  ) {
    super(`OAuth replay defense rejected nonce: ${reason}`);
    this.name = 'ReplayDefenseError';
  }
}

/**
 * Validate the AS-echoed nonce on response. Throws ReplayDefenseError on
 * any of: unknown nonce (not minted by us), replay (already consumed),
 * or expired (outside freshness window). Default freshness: 300 seconds.
 */
export function consumeReplayDefense(
  store: ReplayStore,
  echoedNonce: string,
  freshnessSeconds: number = 300,
): void {
  const result = store.consume(echoedNonce, freshnessSeconds);
  if (!result.ok) {
    throw new ReplayDefenseError(result.reason, echoedNonce);
  }
}

export class AudienceMismatchError extends Error {
  constructor(
    public readonly tokenAud: string | string[],
    public readonly expectedResource: string,
  ) {
    super(`OAuth token audience mismatch: token aud=${JSON.stringify(tokenAud)} does not include resource=${expectedResource}`);
    this.name = 'AudienceMismatchError';
  }
}

/**
 * Validate that a token's `aud` claim binds to the requested resource
 * per RFC 8707 §2. The `aud` MAY be a string or array of strings.
 * The expected resource MUST appear (exact string match).
 */
export function validateAudience(token: TokenAudience, expectedResource: string): void {
  const aud = token.aud;
  const matches = Array.isArray(aud) ? aud.includes(expectedResource) : aud === expectedResource;
  if (!matches) {
    throw new AudienceMismatchError(aud, expectedResource);
  }
}

/**
 * Build the `resource` parameter for an authorization request per RFC 8707 §2.
 * The MCP spec requires this on every `authorize` and `token` request.
 */
export function buildResourceParameter(serverUri: string): string {
  // RFC 8707 §2: resource parameter MUST be an absolute URI.
  // We do basic shape validation; full URI normalization is delegated to the AS.
  if (!/^https?:\/\/[^\s]+$/i.test(serverUri) && !/^[a-z]+:\/\/[^\s]+$/i.test(serverUri)) {
    throw new Error(`resource indicator must be an absolute URI: ${serverUri}`);
  }
  return serverUri;
}
