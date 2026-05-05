/* enchanter/src/transport/transport-descriptor.ts — v0.4 follow-up #2
   (FM 10 trust-pin closure, full digest).

   Background: TrustPinInputs in src/registry/trust-pin.ts already accepts six
   fields — cmd, args, binaryDigest, envAllowlist, url, schemaDigests — but
   v0.3.2's McpClient only populated `args`, `url`, and `schemaDigests` at
   trust-gate time. The other three (cmd, binaryDigest, envAllowlist) are
   stdio-launch-time inputs not naturally available where the trust-gate hook
   runs. This module is the typed carrier that threads those launch-time
   inputs from the transport-construction site through McpClient and into
   the trust-gate hook closure so all six fields contribute to the digest.

   Design notes:
   - `binaryDigest` is best-effort: SHA-256 over the executable's bytes,
     capped at 64 MiB, returns undefined (with a console warning) on any
     failure. The digest spec already handles undefined via canonical-JSON
     omission, so a missing binary digest does not throw — it just shrinks
     the digest's coverage by one field.
   - `cmd` resolution uses an inline `which` (PATH walk) so we have no new
     dep. Windows PATHEXT is honored.
   - Caching: results keyed by absolute path live for the life of the
     process. Repeated McpClient construction for the same binary doesn't
     re-read the file. */

import { createHash } from 'node:crypto';
import { existsSync, openSync, readSync, statSync, closeSync, accessSync, constants as fsConstants } from 'node:fs';
import { isAbsolute, resolve as pathResolve, join as pathJoin, sep as pathSep } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Carrier for the transport-launch-time inputs that feed the v0.4 full
 * trust-pin digest. Two shapes:
 *   - stdio: cmd + args + envAllowlist + (best-effort) binaryDigest
 *   - http:  url only
 *
 * `envAllowlist` carries env var NAMES, never values. Values rotate
 * legitimately; names changing IS security-relevant (see docs/v0.3/trust-pinning.md).
 */
export type TransportDescriptor =
  | {
      readonly kind: 'stdio';
      readonly cmd: string;
      readonly args: readonly string[];
      readonly binaryDigest?: string;
      readonly envAllowlist: readonly string[];
    }
  | {
      readonly kind: 'http';
      readonly url: string;
      readonly binaryDigest?: undefined;
      readonly envAllowlist: readonly [];
    };

export interface DescribeStdioOptions {
  readonly cmd: string;
  readonly args: readonly string[];
  /** When supplied without `envAllowlist`, every key in `env` becomes the allowlist. */
  readonly env?: NodeJS.ProcessEnv;
  /** Explicit allowlist; takes precedence over `env`. */
  readonly envAllowlist?: readonly string[];
  /** When true, skip computing the binary digest entirely (descriptor.binaryDigest = undefined). */
  readonly skipBinaryDigest?: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** 64 MiB cap on the binary file we'll digest. */
export const BINARY_DIGEST_MAX_BYTES = 64 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Module-level cache for computeBinaryDigest
// ---------------------------------------------------------------------------

const binaryDigestCache = new Map<string, string | undefined>();

/** Test-only: clear the cache between unit-test cases. */
export function _clearBinaryDigestCacheForTests(): void {
  binaryDigestCache.clear();
}

// ---------------------------------------------------------------------------
// `which` — minimal PATH walk, no new dep
// ---------------------------------------------------------------------------

function isExecutable(p: string): boolean {
  try {
    accessSync(p, fsConstants.F_OK);
  } catch {
    return false;
  }
  // On POSIX we'd want X_OK; on Windows, presence + .exe-ish suffix is the signal.
  if (process.platform === 'win32') return true;
  try {
    accessSync(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve `cmd` to an absolute path:
 *   - already absolute → return as-is if it exists
 *   - relative or bare → walk PATH (honoring PATHEXT on Windows)
 *   - returns undefined if no executable found
 */
function resolveCmd(cmd: string): string | undefined {
  if (isAbsolute(cmd)) {
    return existsSync(cmd) ? cmd : undefined;
  }

  // Allow explicit relative form like "./foo" without walking PATH.
  if (cmd.includes('/') || cmd.includes(pathSep)) {
    const abs = pathResolve(cmd);
    return existsSync(abs) ? abs : undefined;
  }

  const pathEnv = process.env['PATH'] ?? '';
  const sep = process.platform === 'win32' ? ';' : ':';
  const dirs = pathEnv.split(sep).filter((d) => d.length > 0);

  const exts =
    process.platform === 'win32'
      ? ['', ...(process.env['PATHEXT'] ?? '.EXE;.CMD;.BAT;.COM').split(';')]
      : [''];

  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = pathJoin(dir, cmd + ext);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// computeBinaryDigest — best-effort SHA-256 over the executable
// ---------------------------------------------------------------------------

/**
 * Read the file at `absCmdPath` and return the lowercase-hex SHA-256 of its
 * bytes. Best-effort:
 *   - returns undefined (and emits a one-line console.warn) if:
 *       - path is not absolute
 *       - file is missing or unreadable
 *       - file size exceeds BINARY_DIGEST_MAX_BYTES
 *   - cached by absPath for the life of the process
 *
 * The digest input pipeline already handles undefined via canonical-JSON
 * omission (see src/registry/trust-pin.ts canonicalize()), so callers do
 * NOT need to fail-closed when this returns undefined — they just get a
 * narrower digest.
 */
export async function computeBinaryDigest(absCmdPath: string): Promise<string | undefined> {
  if (!isAbsolute(absCmdPath)) {
    // eslint-disable-next-line no-console
    console.warn(`[transport-descriptor] computeBinaryDigest: path not absolute (${absCmdPath}); skipping`);
    return undefined;
  }
  if (binaryDigestCache.has(absCmdPath)) {
    return binaryDigestCache.get(absCmdPath);
  }

  let fd: number | undefined;
  try {
    const st = statSync(absCmdPath);
    if (!st.isFile()) {
      // eslint-disable-next-line no-console
      console.warn(`[transport-descriptor] computeBinaryDigest: not a regular file (${absCmdPath}); skipping`);
      binaryDigestCache.set(absCmdPath, undefined);
      return undefined;
    }
    if (st.size > BINARY_DIGEST_MAX_BYTES) {
      // eslint-disable-next-line no-console
      console.warn(
        `[transport-descriptor] computeBinaryDigest: file ${absCmdPath} is ${st.size} bytes (> ${BINARY_DIGEST_MAX_BYTES}); skipping`,
      );
      binaryDigestCache.set(absCmdPath, undefined);
      return undefined;
    }

    fd = openSync(absCmdPath, 'r');
    const hasher = createHash('sha256');
    const buf = Buffer.allocUnsafe(64 * 1024);
    let pos = 0;
    let read: number;
    while ((read = readSync(fd, buf, 0, buf.length, pos)) > 0) {
      hasher.update(buf.subarray(0, read));
      pos += read;
    }
    const hex = hasher.digest('hex');
    binaryDigestCache.set(absCmdPath, hex);
    return hex;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[transport-descriptor] computeBinaryDigest: failed for ${absCmdPath} — ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    binaryDigestCache.set(absCmdPath, undefined);
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// describeStdio / describeHttp
// ---------------------------------------------------------------------------

/**
 * Build a `TransportDescriptor` for a stdio MCP server.
 *
 * `envAllowlist` defaults to `Object.keys(env)` when `env` is supplied and
 * `envAllowlist` is not. If neither is supplied, the allowlist is empty.
 * Names are de-duplicated; sort happens later in canonicalize().
 *
 * `binaryDigest` is computed by resolving `cmd` via PATH (for bare names)
 * and reading the resulting file. On failure or `skipBinaryDigest: true`,
 * the field is omitted.
 */
export async function describeStdio(opts: DescribeStdioOptions): Promise<TransportDescriptor> {
  const allowlist =
    opts.envAllowlist !== undefined
      ? [...new Set(opts.envAllowlist)]
      : opts.env !== undefined
        ? [...new Set(Object.keys(opts.env))]
        : [];

  let binaryDigest: string | undefined;
  if (!opts.skipBinaryDigest) {
    const abs = resolveCmd(opts.cmd);
    if (abs !== undefined) {
      binaryDigest = await computeBinaryDigest(abs);
    } else {
      // eslint-disable-next-line no-console
      console.warn(
        `[transport-descriptor] describeStdio: could not resolve cmd ${opts.cmd} on PATH; binaryDigest omitted`,
      );
    }
  }

  return binaryDigest !== undefined
    ? {
        kind: 'stdio',
        cmd: opts.cmd,
        args: [...opts.args],
        binaryDigest,
        envAllowlist: allowlist,
      }
    : {
        kind: 'stdio',
        cmd: opts.cmd,
        args: [...opts.args],
        envAllowlist: allowlist,
      };
}

/** Build a `TransportDescriptor` for a Streamable-HTTP MCP server. */
export function describeHttp(url: string): TransportDescriptor {
  return { kind: 'http', url, envAllowlist: [] as const };
}
