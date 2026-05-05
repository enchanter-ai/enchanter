/* enchanter/src/plugins/lich/sandbox-worker.mjs — v0.3.1 #4 (M5 sandbox stub).
   Forked child for runSandboxedReview. Receives a code string via IPC,
   performs a deterministic review (pattern scan over the input only),
   posts the findings back. Plain ESM .mjs so child_process.fork works
   in both test (tsx-less) and built (dist) modes without a transpile
   step on the worker boundary. Runs with stdlib only.

   Threat model: this is a stub. The fork inherits process.env unless the
   caller strips it (the caller does); it does not enforce a memory cap
   from inside the worker (Node's --max-old-space-size on execArgv handles
   that). Time budget is enforced by the parent via SIGTERM. */

const REVIEW_PATTERNS = [
  { id: 'eval-call',      severity: 3, re: /\beval\s*\(/                                              },
  { id: 'function-ctor',  severity: 3, re: /\bnew\s+Function\s*\(/                                    },
  { id: 'shell-exec',     severity: 3, re: /\b(?:exec|execSync|spawn|spawnSync)\s*\(/                  },
  { id: 'fs-write',       severity: 2, re: /\b(?:writeFile|writeFileSync|unlink|unlinkSync|rm|rmSync)\s*\(/ },
  { id: 'network',        severity: 2, re: /\b(?:fetch|http\.request|https\.request)\s*\(/             },
  { id: 'env-read',       severity: 1, re: /\bprocess\.env\b/                                          },
];

function review(code) {
  const findings = [];
  if (typeof code !== 'string') {
    return { findings, score: 0 };
  }
  for (const p of REVIEW_PATTERNS) {
    if (p.re.test(code)) {
      findings.push({ id: p.id, severity: p.severity });
    }
  }
  const score = findings.reduce((s, f) => s + f.severity, 0);
  return { findings, score };
}

// ---------------------------------------------------------------------------
// Tool-call confirmation (v0.3.2): replay a tool call against a deterministic
// mock transport, then structurally diff the replay output against the live
// response. The v0.3.1 stub doesn't have a way to re-spawn an MCP server, so
// "replay" here means: run a deterministic projection of (toolName, params)
// that mirrors what the server would have returned, given that the params
// fully determined the response. Mismatches surface as a non-empty `differences`
// list. Worker stays stdlib-only.
// ---------------------------------------------------------------------------

/* Deep structural diff. Returns { matches, differences } where each diff entry
   is { path, original, replayed }. Arrays are compared as ordered sequences
   when their elements are objects/arrays (structural), and as multisets when
   their elements are primitives — keeps the rule simple per the spec
   ("ignore ordering of unordered arrays"). */
function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isPrimitiveArray(arr) {
  return arr.every((x) => x === null || (typeof x !== 'object' && typeof x !== 'function'));
}

function diff(a, b, path = []) {
  const diffs = [];
  if (Object.is(a, b)) return diffs;

  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      diffs.push(...diff(a[k], b[k], [...path, k]));
    }
    return diffs;
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      diffs.push({ path, original: a, replayed: b });
      return diffs;
    }
    if (isPrimitiveArray(a) && isPrimitiveArray(b)) {
      // Multiset equality for primitive arrays.
      const sa = [...a].map(String).sort();
      const sb = [...b].map(String).sort();
      for (let i = 0; i < sa.length; i++) {
        if (sa[i] !== sb[i]) {
          diffs.push({ path, original: a, replayed: b });
          return diffs;
        }
      }
      return diffs;
    }
    for (let i = 0; i < a.length; i++) {
      diffs.push(...diff(a[i], b[i], [...path, i]));
    }
    return diffs;
  }

  // Mixed type or primitive mismatch.
  diffs.push({ path, original: a, replayed: b });
  return diffs;
}

/* Deterministic mock-transport replay. Given (toolName, params), produce the
   response we *expect* to see if the server were honest and stateless. The
   contract: replay = JSON-roundtripped clone of params under the canonical
   key `echo`, plus the toolName under `tool`. This is the v0.3.2 stub — real
   MCP-server replay is v0.3.3 scope. A schema-clean tool whose live response
   matches this projection passes; one whose live response carries injected
   payload, extra fields, or mutated values mismatches.

   For tests, an explicit `_replay_override` argument under params can supply a
   replay payload directly so test harnesses can drive specific diff outcomes
   without depending on the projection's default shape. */
function mockReplay(toolName, params) {
  if (params && typeof params === 'object' && '_replay_override' in params) {
    return JSON.parse(JSON.stringify(params._replay_override));
  }
  return {
    tool: toolName,
    echo: params === undefined ? null : JSON.parse(JSON.stringify(params)),
  };
}

function confirmToolCall(toolName, params, originalResponse) {
  const replayed = mockReplay(toolName, params);
  const differences = diff(originalResponse, replayed);
  return {
    matches: differences.length === 0,
    differences,
    replayed,
  };
}

process.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') {
    process.send?.({ ok: false, error: 'bad-message' });
    return;
  }
  if (msg.kind === 'review') {
    try {
      // Optional eval-mode for tests that want a worker-error or hang.
      if (msg.crash === true) {
        throw new Error('intentional-crash');
      }
      if (msg.spin === true) {
        // Busy-loop the worker so the parent's wall-clock timer fires.
        // eslint-disable-next-line no-constant-condition
        while (true) { /* spin until killed */ }
      }
      const result = review(msg.code);
      process.send?.({ ok: true, result });
    } catch (err) {
      process.send?.({ ok: false, error: err && err.message ? err.message : String(err) });
    }
    return;
  }
  if (msg.kind === 'tool-confirm') {
    try {
      if (msg.crash === true) {
        throw new Error('intentional-crash');
      }
      if (msg.spin === true) {
        // eslint-disable-next-line no-constant-condition
        while (true) { /* spin until killed */ }
      }
      const result = confirmToolCall(msg.toolName, msg.params, msg.originalResponse);
      process.send?.({ ok: true, result });
    } catch (err) {
      process.send?.({ ok: false, error: err && err.message ? err.message : String(err) });
    }
    return;
  }
  if (msg.kind === 'tool-confirm-live') {
    // v0.4 #1: live MCP-server replay runs in the parent process so the
    // injected transportFactory (which carries non-serializable function
    // state) can be applied. Forking into the worker for the live variant is
    // reserved for the no-factory production path; until that lands the
    // worker rejects this kind explicitly so silent drops don't mask bugs.
    process.send?.({
      ok: false,
      error: 'tool-confirm-live should run in parent (no transportFactory injection over IPC)',
    });
    return;
  }
});

// Signal readiness so the parent knows IPC is live.
process.send?.({ kind: 'ready' });
