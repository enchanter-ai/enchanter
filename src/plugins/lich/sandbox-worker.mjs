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
  }
});

// Signal readiness so the parent knows IPC is live.
process.send?.({ kind: 'ready' });
