# Enchanter

[![CI](https://github.com/enchanter-ai/enchanter/actions/workflows/ci.yml/badge.svg)](https://github.com/enchanter-ai/enchanter/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

<p align="center">
  <a href="inspector/">
    <img src="inspector/docs/assets/hero.png" alt="Enchanter Inspector — terminal cockpit for the Enchanter AI runtime" width="1280">
  </a>
</p>

> Production-grade agent SDK with native Model Context Protocol support, hybrid orchestrator, and 10 capability plugins.

Enchanter is a TypeScript SDK for building agentic AI applications that speak [MCP (Model Context Protocol)](https://modelcontextprotocol.io). It wraps every outbound tool call in a 7-phase orchestrator lifecycle, runs it through an in-process event bus, and lets specialized plugins (trust scoring, drift detection, security veto, code review, structural fingerprinting, cost attribution, git workflow, and more) observe, modify, or block before the request leaves your process.

**v0.2.2 — verified live against `@modelcontextprotocol/server-filesystem`.** 144 tests / 7 todo / 0 fail. 14/14 stress scenarios pass. Observability ships as a Rust terminal cockpit ([`inspector/`](inspector/)) — htop / btop / k9s for an AI agent runtime — that consumes the runtime's JSONL event stream over stdin, file, or socket.

## Install

```bash
npm install enchanter
```

Requires Node 22+.

## Quickstart

```typescript
import {
  McpClient,
  StdioTransport,
  hydraAdapter,    // security veto + secret masking
  pechAdapter,     // cost ledger + budget thresholds
  setBudget,
} from 'enchanter';
import { spawn } from 'node:child_process';

// Spawn any MCP-spec server (filesystem, github, postgres, ...)
const server = spawn('npx', ['-y', '@modelcontextprotocol/server-filesystem', '/path/to/sandbox']);
const transport = new StdioTransport(server.stdout!, server.stdin!);

setBudget('fs', 100_000);

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

## What's in the box (v0.2)

| Subsystem | Status |
|---|---|
| 7-phase request orchestrator (anchor → trust-gate → pre-dispatch → dispatch → post-response → post-session → cross-session) | ✓ |
| In-process pub/sub bus with bounded ring buffer + correlation_id propagation | ✓ |
| stdio transport (newline-delimited UTF-8 JSON-RPC 2.0, 8MB body cap) | ✓ |
| Streamable HTTP transport (POST + GET, exp-backoff reconnect, resume disabled by default) | ✓ |
| OAuth 2.1 + S256 PKCE + RFC 8707 audience binding + SSRF guard | ✓ |
| Namespace registry with SHA-256 schema-digest pin (MCPoison defense) | ✓ |
| Tool name collision rejection | ✓ |
| 10 plugin adapters (8 with v0.2 algorithms, 2 v0.3-pending) | ✓ |
| Live integration tested against `@modelcontextprotocol/server-filesystem` | ✓ |
| 6 of 10 documented MCP failure modes mitigated | ✓ |

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

## Live demo

```bash
git clone https://github.com/enchanter-ai/enchanter.git
cd enchanter
npm install
npx tsx scripts/demo-live.ts
```

Spawns the official `@modelcontextprotocol/server-filesystem`, runs through all 7 phases, and shows hydra masking real AWS-key-shaped strings + bearer tokens in file content, and vetoing synthetic `rm -rf /` and `cat ~/.ssh/id_rsa` calls on the bus.

Observability is the Rust terminal cockpit at [`inspector/`](inspector/) — single binary, reads the runtime's JSONL event stream from stdin / file / socket, renders 10 live views (overview, plugins, events, security, cost, drift, codebase, replay, runtime totals, active tasks). The earlier TS CLI inspector and VS Code extension were retired at v0.3 in favor of the terminal-first approach. The browser dashboard was intentionally dropped at v0.2.1 — see `IMPLEMENTATION_SUMMARY.md`.

## Architecture

A thin per-request orchestrator owns the canonical request lifecycle. An in-process bus carries plugin findings as derived events. Required plugins (hydra, lich, naga, pech, sylph) fail-closed on missing ACK; advisory plugins (crow, djinn, emu, gorgon) fail-open with `degraded=true`. MCP spec primitives (Resources, Prompts, Tools, Sampling, Roots, Elicitation) are honored verbatim with OAuth 2.1 + PKCE + RFC 8707 audience binding for remote servers.

Full architectural spec: produced by [Wixie](https://github.com/enchanter-ai/wixie) — see `output-opus-4-7.json` in that repo's prompts directory. ADRs for the three load-bearing decisions (hybrid coordination, security model, budget tiers) are at `adr/`.

See [IMPLEMENTATION_SUMMARY.md](IMPLEMENTATION_SUMMARY.md) for the per-file inventory + v0.3 follow-up plan.

## v0.3 roadmap

The 5 highest-risk security follow-ups (in order):

1. **OAuth replay defense** — nonce + freshness store. Currently audience-binding only.
2. **Server spoofing (FM 6)** — TLS cert pinning + Authorization-header response-origin check.
3. **Full trust-pin (FM 10)** — SHA-256 over (cmd + args + binary digest + env + URL + schema).
4. **Lich M5 sandbox** — currently M1 static + M6 EMA only.
5. **Djinn D2 HMM drift** — currently D1 LCS only.

Plus: file-backed pech ledger, gorgon Tarjan SCC + Python AST extraction, npm-publishable `@enchanter-ai/plugin-*` packages.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, plugin-authoring conventions, and the behavioral modules every plugin honors.

## License

[Apache 2.0](LICENSE).
