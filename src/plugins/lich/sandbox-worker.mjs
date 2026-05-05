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
    // v0.5 #1: live MCP-server replay now executes INSIDE the worker for true
    // process isolation. The serverDescriptor is fully serializable (no
    // function state). The worker spawns its own transport, drives a
    // tools/call, and returns the ToolConfirmResult over IPC. The
    // parent-process path (transportFactory injection) is preserved on the
    // parent side as the 'in-process' runMode, used by hermetic tests that
    // need to stub a transport without forking.
    handleToolConfirmLive(msg).then(
      (toolConfirmResult) => process.send?.({ ok: true, kind: 'tool-confirm-live', result: toolConfirmResult }),
      (err) => process.send?.({ ok: false, error: err && err.message ? err.message : String(err) }),
    );
    return;
  }
});

// ---------------------------------------------------------------------------
// v0.5 #1 — tool-confirm-live INSIDE the worker
// ---------------------------------------------------------------------------

/* keep in sync with src/plugins/lich/sandbox.ts::structuralDiff (liveDiff)
   — the diff function is duplicated here because the worker is a .mjs and
   doesn't import the TS source. If you change one, change the other. */

/* Build a transport from a SERIALIZABLE serverDescriptor. Only `stdio` is
   supported in v0.5 #1; `http` returns a clear unsupported error so the parent
   surfaces it as spawn-error. Stdlib only (node:child_process for stdio).

   Returns: { send(msg), recv() async iterator, shutdown() } — same shape as
   LiveReplayTransport in sandbox.ts. */
async function buildTransport(descriptor) {
  if (!descriptor || typeof descriptor !== 'object') {
    const e = new Error('serverDescriptor missing or not an object');
    e.liveResult = { failed: true, reason: 'spawn-error', detail: e.message };
    throw e;
  }
  const kind = descriptor.kind;
  if (kind === 'stdio') {
    const { spawn } = await import('node:child_process');
    const cmd = descriptor.cmd;
    const args = Array.isArray(descriptor.args) ? descriptor.args : [];
    if (typeof cmd !== 'string' || cmd.length === 0) {
      const e = new Error('stdio descriptor: cmd missing');
      e.liveResult = { failed: true, reason: 'spawn-error', detail: e.message };
      throw e;
    }
    let child;
    try {
      child = spawn(cmd, args, {
        // Strip the parent worker's env entirely — only PATH passes through.
        env: { PATH: process.env.PATH ?? '' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      const e = new Error(`stdio spawn failed: ${err && err.message ? err.message : String(err)}`);
      e.liveResult = { failed: true, reason: 'spawn-error', detail: e.message };
      throw e;
    }

    // Capture early spawn errors (ENOENT etc.) — they fire after spawn() returns.
    let spawnErr;
    child.on('error', (err) => { spawnErr = err; });

    const queue = [];
    let resolveNext;
    let closed = false;
    let buffer = Buffer.alloc(0);

    child.stdout.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      let nl;
      while ((nl = buffer.indexOf(0x0a)) !== -1) {
        const lineBuf = buffer.subarray(0, nl);
        buffer = buffer.subarray(nl + 1);
        if (lineBuf.length === 0) continue;
        const line = lineBuf.toString('utf8');
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue; // skip malformed lines
        }
        if (resolveNext) {
          const r = resolveNext;
          resolveNext = undefined;
          r({ value: parsed, done: false });
        } else {
          queue.push(parsed);
        }
      }
    });

    const onClose = () => {
      closed = true;
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = undefined;
        r({ value: undefined, done: true });
      }
    };
    child.stdout.on('end', onClose);
    child.on('exit', onClose);

    return {
      async send(msg) {
        if (spawnErr) {
          const e = new Error(`stdio spawn error: ${spawnErr.message}`);
          e.liveResult = { failed: true, reason: 'spawn-error', detail: e.message };
          throw e;
        }
        if (closed) throw new Error('stdio transport closed');
        const line = JSON.stringify(msg) + '\n';
        await new Promise((res, rej) => {
          child.stdin.write(line, 'utf8', (err) => (err ? rej(err) : res()));
        });
      },
      recv() {
        return {
          [Symbol.asyncIterator]() { return this; },
          next() {
            if (queue.length > 0) {
              return Promise.resolve({ value: queue.shift(), done: false });
            }
            if (closed) {
              return Promise.resolve({ value: undefined, done: true });
            }
            return new Promise((r) => { resolveNext = r; });
          },
        };
      },
      shutdown() {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      },
    };
  }
  if (kind === 'http') {
    const e = new Error('http transport not yet supported inside the sandbox worker');
    e.liveResult = { failed: true, reason: 'spawn-error', detail: e.message };
    throw e;
  }
  const e = new Error(`unsupported transport kind: ${String(kind)}`);
  e.liveResult = { failed: true, reason: 'spawn-error', detail: e.message };
  throw e;
}

async function callViaTransport(transport, toolName, params) {
  const id = 1;
  const argsObject =
    params && typeof params === 'object' && !Array.isArray(params) ? params : {};
  await transport.send({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: toolName, arguments: argsObject },
  });
  for await (const m of transport.recv()) {
    if (m && m.id === id) {
      if (m.error !== undefined) {
        const detail =
          m.error && typeof m.error === 'object' && typeof m.error.message === 'string'
            ? m.error.message
            : 'jsonrpc-error';
        throw new Error(detail);
      }
      return m.result;
    }
  }
  throw new Error('transport closed before response');
}

async function handleToolConfirmLive(msg) {
  const start = Date.now();
  let transport;
  try {
    transport = await buildTransport(msg.serverDescriptor);
  } catch (err) {
    // buildTransport stamps `liveResult` for known shapes; fall back to
    // worker-error if it's a thrown Error without one.
    if (err && typeof err.liveResult === 'object') {
      return { ...err.liveResult, elapsed_ms: Date.now() - start };
    }
    return {
      failed: true,
      reason: 'spawn-error',
      detail: err && err.message ? err.message : String(err),
      elapsed_ms: Date.now() - start,
    };
  }
  try {
    const replayed = await callViaTransport(transport, msg.toolName, msg.params);
    const differences = diff(msg.originalResponse, replayed);
    return {
      failed: false,
      ok: differences.length === 0,
      differences,
      elapsed_ms: Date.now() - start,
    };
  } catch (err) {
    return {
      failed: true,
      reason: 'worker-error',
      detail: err && err.message ? err.message : String(err),
      elapsed_ms: Date.now() - start,
    };
  } finally {
    try { await transport.shutdown?.(); } catch { /* ignore */ }
  }
}

// Signal readiness so the parent knows IPC is live.
process.send?.({ kind: 'ready' });
