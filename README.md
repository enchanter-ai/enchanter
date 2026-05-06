# Enchanter

[![CI](https://github.com/enchanter-ai/enchanter/actions/workflows/ci.yml/badge.svg)](https://github.com/enchanter-ai/enchanter/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

<p align="center">
  <a href="inspector/">
    <img src="inspector/docs/assets/hero.png" alt="Enchanter Inspector — terminal cockpit for the Enchanter AI runtime" width="1280">
  </a>
</p>

Enchanter is a TypeScript MCP client SDK with a hybrid orchestrator and 10 capability plugins, plus a Rust terminal cockpit ([`inspector/`](inspector/)) for live observability. Every outbound tool call rides a 7-phase request lifecycle, runs through an in-process event bus, and lets specialized plugins (trust scoring, drift detection, security veto, code review, structural fingerprinting, cost attribution, git workflow) observe, modify, or block before the request leaves your process.

## Install

```bash
npm install enchanter
```

Requires Node 22+.

## Try it

```bash
npm install -g enchanter           # or: cd client/enchanter && npm install
cd inspector && cargo build --release
enchanter                          # opens the cockpit; runs the live demo
```

## Quickstart

```typescript
import {
  McpClient,
  StdioTransport,
  hydraAdapter,    // security veto + secret masking
  pechAdapter,     // cost ledger + budget thresholds
} from 'enchanter';
import { spawn } from 'node:child_process';

// Spawn any MCP-spec server (filesystem, github, postgres, ...).
// Pin the version — DO NOT use `npx -y` in production. The `-y` flag
// auto-installs whatever the registry currently resolves at fetch time,
// a known supply-chain attack surface. Install once with an exact version,
// then resolve via require.resolve so the path is locked to your lockfile.
//
//   npm install @modelcontextprotocol/server-filesystem@<exact-version>
//
// (See hydra/plugins/package-gate for pre-install advisory checks.)
const serverPath = require.resolve('@modelcontextprotocol/server-filesystem/dist/index.js');
const server = spawn('node', [serverPath, '/path/to/sandbox']);
const transport = new StdioTransport(server.stdout!, server.stdin!);

const client = new McpClient({
  serverId: 'fs',
  transport,
  plugins: [hydraAdapter, pechAdapter /* + 8 more */],
});

await client.initialize('my-app', '1.0.0');
const tools = await client.listTools();
const result = await client.callTool('read_file', { path: 'config.txt' });
// hydra masks AWS keys / bearer tokens / PEM blocks in the response
// pech appends a ledger entry per call
```

## What's in the box

| Subsystem | Status |
|---|---|
| 7-phase request orchestrator (anchor → trust-gate → pre-dispatch → dispatch → post-response → post-session → cross-session) | ✓ |
| In-process pub/sub bus with bounded ring buffer + correlation_id propagation | ✓ |
| stdio transport (newline-delimited UTF-8 JSON-RPC 2.0, 8MB body cap) | ✓ |
| Streamable HTTP transport (POST + GET, exp-backoff reconnect, resume disabled by default) | ✓ |
| OAuth 2.1 + S256 PKCE + RFC 8707 audience binding + SSRF guard | ✓ |
| OAuth replay defense (nonce + freshness store, in-memory + JSONL-persistent) | ✓ |
| TLS cert pinning (TOFU + PINNED policies, hooked into the streaming HTTP transport) | ✓ |
| Full trust-pin (SHA-256 over cmd + args + url + schemaDigests + binaryDigest + envAllowlist) | ✓ |
| Namespace registry with SHA-256 schema-digest pin (MCPoison defense) | ✓ |
| Tool name collision rejection | ✓ |
| JSONL event bridge (runtime → inspector wire contract; stdout / file / TCP sinks) | ✓ |
| Bidirectional control channel (inspector approve/veto into the trust-gate, fail-closed) | ✓ |
| Rust terminal cockpit ([`inspector/`](inspector/)) — 10 live views over the JSONL stream | ✓ |
| 10 plugin adapters (in-tree) | ✓ |
| Independently installable `@enchanter-ai/plugin-*` packages (workspace) | ✓ |
| Live integration tested against `@modelcontextprotocol/server-filesystem` | ✓ |

## The 10 plugins

Each plugin is its own repo under [github.com/enchanter-ai](https://github.com/enchanter-ai/). The TypeScript adapters in this SDK (`src/plugins/*.adapter.ts`) port the algorithms; the source repos hold the original Python implementations + Claude Code skills.

| Plugin | Lifecycle phase | Role | Source |
|---|---|---|---|
| **crow** | trust-gate | Bayesian trust scoring + info-gain review ordering | [enchanter-ai/crow](https://github.com/enchanter-ai/crow) |
| **djinn** | anchor + post-session | Intent anchoring + drift detection across `/compact` | [enchanter-ai/djinn](https://github.com/enchanter-ai/djinn) |
| **emu** | pre-dispatch + post-response | Token economy monitor + ±CI runway forecast | [enchanter-ai/emu](https://github.com/enchanter-ai/emu) |
| **gorgon** | cross-session + post-response | Codebase structural intelligence (PageRank hotspots) | [enchanter-ai/gorgon](https://github.com/enchanter-ai/gorgon) |
| **hydra** | trust-gate + post-response | Real-time security interception (1844 CVE-mapped patterns) | [enchanter-ai/hydra](https://github.com/enchanter-ai/hydra) |
| **lich** | post-response | Code review with sandboxed confirmation + Bayesian preference | [enchanter-ai/lich](https://github.com/enchanter-ai/lich) |
| **naga** | trust-gate + post-response + post-session | Structural replication (AST + TF-IDF + naming convention) | [enchanter-ai/naga](https://github.com/enchanter-ai/naga) |
| **pech** | post-response | Cost attribution ledger + budget thresholds | [enchanter-ai/pech](https://github.com/enchanter-ai/pech) |
| **schematic** | governance (non-runtime) | Canonical scaffold template | [enchanter-ai/schematic](https://github.com/enchanter-ai/schematic) |
| **sylph** | trust-gate + post-session | Git workflow automation + destructive-op gate | [enchanter-ai/sylph](https://github.com/enchanter-ai/sylph) |

The companion prompt-engineering meta-engine [Wixie](https://github.com/enchanter-ai/wixie) runs the research → craft → converge → harden → translate lifecycle that produced the original architecture spec.

## Architecture

A thin per-request orchestrator owns the canonical request lifecycle. An in-process bus carries plugin findings as derived events. Required plugins (hydra, lich, naga, pech, sylph) fail-closed on missing ACK; advisory plugins (crow, djinn, emu, gorgon) fail-open with `degraded=true`. MCP spec primitives (Resources, Prompts, Tools, Sampling, Roots, Elicitation) are honored verbatim with OAuth 2.1 + PKCE + RFC 8707 audience binding for remote servers.

Observability is the Rust terminal cockpit at [`inspector/`](inspector/) — a single binary that reads the runtime's JSONL event stream from stdin / file / socket and renders 10 live views (overview, plugins, events, security, cost, drift, codebase, replay, runtime totals, active tasks). The wire contract is documented at [`docs/event-schema.md`](docs/event-schema.md).

Full architectural spec: produced by [Wixie](https://github.com/enchanter-ai/wixie).

## Streaming events to the inspector

The runtime supervisor (`scripts/run.ts`) ships every bus event as JSONL when `ENCHANTER_BRIDGE` is set. Default is off — unset env var preserves the existing WebSocket-broadcaster path. Three forms are accepted:

```bash
ENCHANTER_BRIDGE=stdout npx tsx scripts/run.ts -- npm test | enchanter           # pipe directly into the Rust TUI
ENCHANTER_BRIDGE=tcp://127.0.0.1:7878 npx tsx scripts/run.ts -- npm test         # for an inspector listening on a socket
ENCHANTER_BRIDGE=file:./run-2026-05-05.jsonl npx tsx scripts/run.ts -- npm test  # capture-to-replay
```

When `stdout` is selected, the supervisor re-routes the wrapped child's stdout to stderr so the JSONL wire stays uncorrupted.

## Status

Current production version: **v0.5.0**. Every roadmap item from `0.2` through `0.5` is shipped — see [CHANGELOG.md](CHANGELOG.md) for per-version detail. Next: HTTP transport inside the sandbox worker, npm-publish ceremony for the `@enchanter-ai/plugin-*` packages, and auto-reconnect for the bidirectional control socket.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, plugin-authoring conventions, and the behavioral modules every plugin honors.

## License

[Apache 2.0](LICENSE).
