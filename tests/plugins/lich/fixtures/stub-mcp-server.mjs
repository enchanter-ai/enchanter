#!/usr/bin/env node
/* tests/plugins/lich/fixtures/stub-mcp-server.mjs — v0.5 #1 fixture.
   Tiny deterministic stdio MCP-server stub used by tool-confirm-live-worker.test.ts.
   Reads newline-delimited JSON-RPC from stdin, replies on stdout. Behaviour
   is driven by argv:
     --reply <json>   — JSON object/value to return as the `result` of any
                        tools/call request. Required.
     --hang           — never reply (drives the timeout test).
     --extra <json>   — merge these fields into the reply object (drives the
                        mismatch test). */

const argv = process.argv.slice(2);
let replyArg;
let extraArg;
let hang = false;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--reply') { replyArg = argv[++i]; continue; }
  if (argv[i] === '--extra') { extraArg = argv[++i]; continue; }
  if (argv[i] === '--hang') { hang = true; continue; }
}

const baseReply = replyArg !== undefined ? JSON.parse(replyArg) : {};
const extra = extraArg !== undefined ? JSON.parse(extraArg) : undefined;

let buffer = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  let nl;
  while ((nl = buffer.indexOf(0x0a)) !== -1) {
    const line = buffer.subarray(0, nl).toString('utf8');
    buffer = buffer.subarray(nl + 1);
    if (line.length === 0) continue;
    let req;
    try { req = JSON.parse(line); } catch { continue; }
    if (hang) continue;
    if (req && req.method === 'tools/call' && req.id !== undefined) {
      const result = extra && typeof baseReply === 'object' && baseReply !== null
        ? { ...baseReply, ...extra }
        : baseReply;
      const out = JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\n';
      process.stdout.write(out);
    }
  }
});

process.stdin.on('end', () => process.exit(0));
