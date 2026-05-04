/* enchanter/src/oauth/nonce.ts — implements v0.3 follow-up #1 OAuth replay
   defense (per IMPLEMENTATION_SUMMARY.md §v0.3 + README §v0.3 roadmap).

   Generates fresh, cryptographically-random nonces and RFC 3339 timestamps
   for every OAuth authorize/token request. Pairs with `replay-store.ts`
   (mint + consume contract). The nonce rides the request as a bound
   parameter alongside PKCE state; on response the AS echo is validated
   for (a) issued-by-us, (b) freshness, (c) not-yet-consumed.

   Counter: a static "nonce" reused across requests is trivially replayable;
   a per-request nonce closes the window to (freshnessSeconds) and one use. */

import { randomBytes } from 'node:crypto';

/** RFC 7636-style unreserved alphabet, base64url-safe. */
const NONCE_BYTE_LENGTH = 24; // → 32 base64url chars; ≥ 16 bytes per spec
const FRESHNESS_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Generate a cryptographically-random nonce, ≥ 16 bytes, base64url-encoded
 * with no padding. Suitable as a bound OAuth request parameter.
 */
export function generateNonce(): string {
  return base64urlEncode(randomBytes(NONCE_BYTE_LENGTH));
}

/**
 * Encode a millisecond epoch timestamp as RFC 3339 UTC ("Z" suffix).
 * Defaults to Date.now() when called with no argument.
 */
export function encodeTimestamp(epochMs: number = Date.now()): string {
  return new Date(epochMs).toISOString();
}

/**
 * Parse an RFC 3339 timestamp back to ms-since-epoch.
 * Returns null on malformed input — callers MUST treat null as "expired".
 */
export function parseTimestamp(rfc3339: string): number | null {
  if (!FRESHNESS_REGEX.test(rfc3339)) return null;
  const ms = Date.parse(rfc3339);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Validate that a parsed timestamp falls within `freshnessSeconds` of `nowMs`.
 * The clock skew tolerance is symmetric — issued-in-the-future beyond the
 * window is also rejected (typical AS clock-skew is < 60s).
 */
export function isFresh(issuedAtMs: number, freshnessSeconds: number, nowMs: number = Date.now()): boolean {
  const windowMs = freshnessSeconds * 1000;
  const delta = nowMs - issuedAtMs;
  return delta >= -windowMs && delta <= windowMs;
}

function base64urlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
