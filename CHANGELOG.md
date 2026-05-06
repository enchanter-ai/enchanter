# Changelog

All notable changes to Enchanter are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] — 2026-05-06

Three v0.5 carry-overs from v0.4 landed; npm-publish ceremony for v0.4.0 still gated on operator authorization (NPM_TOKEN). Test count: 347 → 374 / 7 todo / 0 fail across 40 files (TS); Rust cargo check + tests clean.

### Added
- **Worker-side real-replay execution for lich M5** (`src/plugins/lich/sandbox.ts`, `src/plugins/lich/sandbox-worker.mjs`) — `runSandboxedToolCallLive` now defaults to `runMode: 'worker'`, dispatching the live replay inside the forked sandbox worker for true process isolation. Worker constructs the transport from a serializable `serverDescriptor`, issues `initialize` + `tools/call`, captures the response, runs the structural diff, returns over IPC. Worker supports stdio MCP transports today; http variant flagged for v0.6 (returns explicit `spawn-error` with detail). The v0.4 in-process `transportFactory` path stays available via `runMode: 'in-process'` for hermetic tests.
- **HMM state-shape versioning** (`src/plugins/djinn/hmm.ts`, `src/plugins/djinn/hmm-store.ts`) — `HMM_STATE_VERSION = 1` constant; `HmmStateSnapshot` carries a `version` field. `IntentHmm.fromSnapshot` returns `null` on version mismatch or `posterior.length` mismatch, forcing fresh build. Both `InMemoryHmmStore` and `PersistentHmmStore` warn-and-reset on stale records. Versionless snapshots (pre-v0.5) treated as `version: 0` → reset path. Forward-compat protocol documented inline at the constant: bump `HMM_STATE_VERSION` when state space changes (more states, renamed states, different observation buckets).
- **Bidirectional control channel** (`src/observability/control-protocol.ts`, `inspector/src/control.rs`) — TS-side `TcpControlSink` accepts inbound commands on the same TCP connection as outbound events. New event variant `request.approval` (carrying `correlation_id / plugin / reason / phase / payload`). New outbound command `{ kind: "control.command", command: "approval.response", correlation_id, decision, reason? }`. Trust-gate phase, when configured with a `controlChannel`, emits `request.approval` and awaits the matching response with a 30-second default timeout. **Fail-closed** on timeout — operator wanted human-in-the-loop, missing decision = no human present = veto.
  - Inspector side: `Source::SocketControl(addr)` opens a bidirectional TCP transport. New `app.state.pending_approvals` queue. Overview view renders a `PENDING APPROVAL: <plugin> — <reason>  [a]pprove  [v]eto` banner when the queue is non-empty. `a` and `v` keys serialize an `approval.response` and pop from the queue.
  - Wire schema documented at `docs/event-schema.md` under "Bidirectional control channel (v0.5 #4)".

### Changed
- `IntentHmm.serialize` now stamps `version: HMM_STATE_VERSION` on every snapshot. Existing test snapshots get the new field automatically.
- `Bridge` config gains an optional `kind: 'tcp-control'` for the bidirectional path. Existing `kind: 'tcp'` (one-way) stays the default for back-compat.
- Rust `Transport` gains `send_control(line: &str)` for outbound writes; only available when constructed via `Source::SocketControl`.

### Open scope (deferred to v0.6)
- HTTP transport inside the sandbox worker (currently stdio-only; explicit error for http).
- The `PENDING APPROVAL` banner renders only in the overview view; lifting to a shared widget consumed by `draw_app` is the obvious next slice.
- Auto-reconnect for `Source::SocketControl` if the runtime restarts mid-session.
- `transportDescriptor.envAllowlist` / `binaryDigest` aren't honored by the worker's stdio spawn yet; uses bare `cmd / args` and forces `env: { PATH }`.
- npm-publish ceremony for v0.4.0 still gated on `NPM_TOKEN` setup.

## [0.4.0] — 2026-05-05

Carry-overs from the v0.3.0 ship list, all landed in one cycle. Test count: 270 → 347 / 7 todo / 0 fail across 37 files. Typecheck clean. All new behavior is default-off behind config flags.

### Added
- **Lich M5 real-MCP-server replay + LRU cache** (`src/plugins/lich/sandbox.ts::runSandboxedToolCallLive`, `src/plugins/lich/replay-cache.ts`) — second tool-call-confirmation variant that re-issues the captured `tools/call` against an injectable `transportFactory` and structurally diffs the live response. Per-`(schemaDigest, argsDigest)` LRU cache (default 256 entries) avoids doubling latency on repeated calls. Gated on `m5_tool_confirm_live: false`.
- **Trust-pin digest expansion** (`src/transport/transport-descriptor.ts`) — `TransportDescriptor` carries `cmd / args / binaryDigest / envAllowlist` (stdio) or `url` (http). `describeStdio` resolves the binary via PATH walk and SHA-256s the file (cap 64 MiB, cached). `McpClient.transportDescriptor` threads the descriptor into the trust-gate hook so all 6 `TrustPinInputs` fields contribute to the digest. `binaryDigest` is best-effort: missing / unreadable files don't fail closed, just omit the field via canonical-JSON omission.
- **Djinn D2 HMM persistence** (`src/plugins/djinn/hmm-store.ts`) — `InMemoryHmmStore` (default) and `PersistentHmmStore` (JSONL append-only, replay-on-construct, corrupt-tail tolerant). `IntentHmm.serialize` / `fromSnapshot` round-trip the forward state. Adapter wires load-on-configure, save-on-update, clear-on-anchor-clear. `hmm_store_path` config opts into persistence. Transition matrix is intentionally NOT persisted — hydrated sessions continue under whatever matrix is current at load time, with documented forward-looking note about adding a `version` field if state shape ever changes.
- **Gorgon dotted-module resolution** (`src/plugins/gorgon/pyproject-resolver.ts`) — hand-rolled minimal TOML parser (no new deps) extracts package roots from `[tool.poetry]`, `[project]`, `[tool.setuptools]` and their `packages` / `package-dir` / `[tool.setuptools.packages.find]` variants. `resolveModule` walks `<root>/foo/bar.py` then `<root>/foo/bar/__init__.py` candidates with an injectable `FileSystemView` for testability. Roots from multiple build-system layouts are merged additively. Fail-open: invalid TOML / missing file → resolver becomes a no-op, extractor returns verbatim module names.
- **Plugin-package release pipeline** (`scripts/publish-packages.ts`, `scripts/release-prep.ts`, `.github/workflows/publish.yml`, `docs/RELEASE.md`) — `release:prep` bumps root + all 10 plugin versions in lockstep + retightens `peerDependencies.enchanter` to `^<version>`. `publish-packages.ts --dry-run` validates package shape (name regex, version lockstep, `dist` in files, peer-range compat). `--publish` mode runs `npm publish --workspace ... --access public` per package; gated on `NPM_TOKEN`. CI workflow triggers on `v*.*.*` tags. `docs/RELEASE.md` walks the operator through bump → tag → push → CI publishes.

### Changed
- `IntentHmm` gains `serialize()` / `static fromSnapshot()` for state hydration. `IntentHmm` constructor / behavior unchanged for callers that don't persist.
- `TrustGateHookContext` extended with optional `transportDescriptor`. Existing callers without a descriptor see unchanged behavior — `cmd / binaryDigest / envAllowlist` simply omitted from the digest as before.
- `extractPythonImports` gains an optional `resolver` parameter. Unset → existing verbatim-module-name behavior.

## [0.3.0] — 2026-05-05

Major release — full v0.3 roadmap landed across three sub-iterations (0.3.0 / 0.3.1 / 0.3.2). Test count: 144 → 270 / 7 todo / 0 fail across 31 files. Every new feature is default-off behind a config flag for back-compat.

### Added — v0.3.0 (foundation)
- **OAuth replay defense** (`src/oauth/replay-store.ts`, `src/oauth/nonce.ts`) — nonce + RFC 3339 timestamp ride request alongside PKCE state. `consumeReplayDefense` validates issuance, replay, and freshness. `InMemoryReplayStore` (FIFO at 10k entries) and `PersistentReplayStore` (JSONL append-only, restart-survival, corrupt-tail tolerant).
- **JSONL event bridge** (`src/observability/bridge.ts`) — explicit producer-side bridge from the in-process bus to a configurable sink. `StdoutSink`, `FileSink` (append-only), `TcpSink` (capped exp-backoff + 200-line buffer). Closes the implicit-protocol gap between the runtime and the Rust inspector.
- **Wire schema** (`docs/event-schema.md`) — canonical JSONL contract: UTF-8, ≤ 1 MiB / line, type-discriminated, well-typed variants for `runtime.metrics` / `tool.call` / `hydra.veto` / `pech.ledger` / `task.updated` / `code.modified`, tolerant `GenericPayload` for all others. Severity ladder + phase enum match the inspector's Rust ground truth.
- **File-backed pech ledger** (`src/plugins/pech/ledger-store.ts`) — opt-in JSONL append + replay-on-configure, parent-dir mkdir, `degraded:true` ack on write failure (never blocks the hot path).
- **Rust ratatui terminal cockpit** (`inspector/`) — single `enchanter` binary, 10 live views, reads JSONL from stdin / file / TCP socket. See `inspector/CHANGELOG.md` for the inspector's own version log.

### Added — v0.3.1 (security + algorithm upgrades)
- **TLS cert pinning** (`src/transport/tls-pin.ts`) — `computeCertFingerprint` (SHA-256 over leaf cert DER, hex), `InMemoryTlsPinStore` and `PersistentTlsPinStore`, `verifyTlsPin` with TOFU and PINNED policies. Wired into `StreamableHttpTransport` via a custom undici `Agent` connector — verification fires before any request bytes go out.
- **Full trust-pin** (`src/registry/trust-pin.ts`) — `computeTrustDigest` over canonical-JSON of `TrustPinInputs` (cmd / args / url / schemaDigests / binaryDigest / envAllowlist), `enforceTrustPin` publishes `hydra.trust-pin.mismatch` on `TrustPinMismatchError`, `approveTrustPinUpdate` for explicit human-in-the-loop rotation. Persistent JSONL store mirrors the OAuth replay pattern.
- **Lich M5 sandboxed review** (`src/plugins/lich/sandbox.ts` + `sandbox-worker.mjs`) — `runSandboxedReview(code, options)` forks a worker via IPC with stripped env, wall-clock budget, `--max-old-space-size`. Returns `SandboxResult` (never throws); reasons: `timeout / worker-error / spawn-error / bad-response`. Adapter wires it into post-response behind `m5_sandbox: false` default; preserves M1 verdict; sets `degraded:true` on failure.
- **Djinn D2 HMM drift detection** (`src/plugins/djinn/hmm.ts`) — 3-state HMM (ON_TASK / SIDEQUEST / LOST). Transition matrix tuned so SIDEQUEST is the gateway state and LOST requires sustained drift; emissions tuned so the design's "argmax SIDEQUEST under sustained low" holds. Forward-algorithm posteriors. Gated on `d2_hmm: false` default; `clearAnchor()` also clears HMM state.
- **Gorgon Tarjan SCC + Python AST** (`src/plugins/gorgon/tarjan.ts` + `python-extractor.ts`) — iterative Tarjan returns SCCs in topological order, surfaced via `cycles: string[][]` in the existing snapshot payload (filtered to size > 1). Python regex extractor handles `from X import`, `import X`, `import X.Y`, `def`, `async def`, `class`. Routed via `setSourceMap` for `.py` files; non-Python extraction unchanged.

### Added — v0.3.2 (workspace + wire-ups)
- **`@enchanter-ai/plugin-*` workspace packages** (`packages/`) — npm workspaces over the existing `src/plugins/` source. 10 publish-ready packages each with their own `package.json` / `tsconfig.json` / `README.md` / `LICENSE`. `plugin-pech` is the reference implementation (full re-export); the other nine are scaffolded thin re-export shells. `npm pack --dry-run` succeeds for all 10. Not yet on the npm registry — release ceremony deferred to v0.4.
- **Orchestrator → trust-pin enforcement** (`src/orchestration/lifecycle.ts`, `src/client/mcp-client.ts`) — trust-gate phase invokes `enforceTrustPin` against the live request inputs; `TrustPinMismatchError` is converted to `SecurityVetoError(plugin: 'trust-pin')` so it rides the existing veto plumbing. Default-off: pass `trustPinStore` to `McpClient` to enable. v0.3.2 populates `args / url / schemaDigests`; `cmd / binaryDigest / envAllowlist` deferred to v0.4.
- **`ENCHANTER_BRIDGE` env switch** (`scripts/run.ts`, `src/observability/bridge-config.ts`) — supervisor reads `ENCHANTER_BRIDGE` and constructs the matching sink. Accepted forms: `stdout`, `tcp://host:port`, `file:./path`, `off` (default). On stdout sink: child stdout re-routed to stderr to keep the JSONL wire uncorrupted.
- **Lich M5 tool-call confirmation** (`src/plugins/lich/sandbox.ts::runSandboxedToolCall`) — second sandbox variant that re-runs a tool call (currently against a deterministic mock-transport projection) and structurally diffs the result against the original response. Diff format: `{ matches, differences: [{ path, original, replayed }] }` with order-insensitive multiset comparison for arrays of primitives. Gated on `m5_tool_confirm: false`; sets `degraded:true` on sandbox failure. Real-MCP-server replay deferred to v0.4.

### Changed
- README — top-level "What's in the box" table now reflects v0.3.x. Stale "v0.3 roadmap" section replaced by "What shipped in v0.3" + "v0.4 roadmap". Hero image points at the Rust cockpit, not the retired SVG.
- IMPLEMENTATION_SUMMARY.md is no longer the sole source of v0.3 status — see this changelog and the README's roadmap section.

### Removed
- `scripts/inspect.ts` — TS CLI inspector. Replaced by the Rust binary.
- `src/observability/dashboard-server.ts` — TS dashboard server. Replaced by the JSONL bridge feeding the Rust inspector.
- `src/observability/cli-renderer.ts` — TS CLI renderer.
- `vscode-extension/` — VS Code extension that wrapped the TS inspector. Terminal-first per the inspector mantra: "Terminal is the cockpit. Web/Electron is the studio."

### Security
- TLS cert pinning closes FM 6 (server spoofing) for HTTPS MCP servers.
- Trust-pin enforcement closes FM 10 (full server identity) at the trust-gate phase.
- OAuth replay defense closes the residual replay window in the existing PKCE flow.

## [0.2.2] — 2026-04-29

### Added
- **CLI inspector** — long-running boxed minimalist real-time observability monitor (`npm run inspect`). Smart frame-diff redraw (no flicker), 4 golden-signal cards on top (turns left, spent, security alerts, drift), per-plugin sparklines (6-char Unicode block trends), event log with topic-family colors, phase progress bar with amber pulse on the active phase, sticky hint footer, mode banner pills (LIVE / PAUSED / FILTER / SORT). Long-running until `q` or Ctrl-C. Keyboard-driven: `r` re-run demo, `s` stress, `x` red-team, `p` pause, `/` filter, `S` sort, `↑↓` scroll history, `?` help.
- **Mascot** — 2D Unicode block-art chibi grimoire (gold pages + violet body + black eyes + red ribbon) rendered in the inspector header. `MascotPaint` interface with per-cell color masks; `renderMascot()` helper applies multi-color ANSI escapes.
- **VS Code extension** (`vscode-extension/`) — native TreeViews (Plugins / Events / Phases) + StatusBarItem + WelcomeView. No webview. `ws` dep dropped — uses Node's native `WebSocket` global. VSIX 120 KB, 29 files. Connects to the WebSocket broadcaster.
- **Stress test** (`scripts/stress-plugins.ts`, `npm run stress`) — 14 attack scenarios, one per plugin hotspot. 14/14 pass.
- **Red team** (`scripts/red-team.ts`, `npm run red-team`) — 26 advanced exploits in 5 tiers (hydra evasion, secret-pattern coverage, SSRF, resource exhaustion, schema mutation). Honest BLOCKED / BYPASSED / DEGRADED / N/A reporting. 11 BLOCKED + 13 BYPASSED (v0.3 follow-ups documented per scenario).
- **Desktop notifier** (`src/observability/notifier.ts`) — `node-notifier`-backed OS toasts on hydra/sylph/lich/naga/pech alerts. Throttled per-topic. Auto-wired into the inspector.
- **Documentation surfaces** — interactive HTML demo at `docs/index.html` (clickable counters, demo + stress buttons, mascot, full inspector layout) for GitHub Pages, plus animated SVG hero at `docs/hero.svg` (SMIL-driven counters, sparklines, phase pulse, LIVE badge — auto-loops in the README).

### Changed
- **Hydra command-injection scanner** — now reconstructs the command line from `tool` + `args` array fields, defeating the `{tool:"git", args:["push","--force"]}` evasion. `h-curl-pipe-shell` bumped to `critical` severity (was `high` warn-only) — RCE-class.
- **Sylph W5 destructive-op gate** — same reconstruction logic. Vetoes `git push --force`, `git reset --hard`, `git branch -D` even when split across `tool` + `args`.
- **Bus topic matcher** (`src/bus/pubsub.ts`) — `*` wildcard now matches any topic. Previously plain `*` was treated as a literal topic name. AckTracker gained `has(correlation_id, phase, plugin)` for orchestrator dedup.
- **Test count**: 136 → **144 passing** (added notifier + integration test scenarios). 7 todo, 0 fail.

### Removed
- VS Code extension's `ws` npm dependency (uses native `WebSocket`).
- VS Code extension webview UI (replaced by native TreeViews per Microsoft UX guidance — webviews cost performance + accessibility versus core API).

## [0.2.1] — 2026-04-28

### Removed
- **Browser dashboard (Vite + Preact UI)** — dropped because terminal + VS Code surfaces are in-context where developers work; the dashboard required active browser-tab visiting and got ignored. The WebSocket broadcaster (`src/observability/dashboard-server.ts`) stays — VS Code's webview consumes it. Notifier stays. Bus, orchestrator, plugins, transports unchanged.
- `scripts/run-dashboard.ts` — launcher that spawned Vite + the browser UI.
- `npm run dashboard` and `npm run dashboard:dev` scripts removed from `package.json`.

## [Unreleased]

### Planned for v0.3
- OAuth replay defense (nonce + freshness store)
- TLS cert pinning + Authorization-header response-origin check
- Full trust-pin: SHA-256 over (cmd + args + binary digest + env + URL + schema)
- Lich M5 sandbox surface
- Djinn D2 HMM drift detection
- Pech file-backed ledger + L1 EMA / L3 Z-score / L4 cache-waste
- Gorgon Tarjan SCC + Python-AST extraction
- npm-publishable `@enchanter/plugin-*` packages

## [0.2.0] — 2026-04-27

### Added
- High-level `McpClient` class with JSON-RPC request/response correlation.
- 8 plugin adapter implementations (replacing v0.1 stubs):
  - **crow** — Beta-Binomial trust posterior + Lanczos log-Γ + asymptotic ψ for closed-form Beta entropy.
  - **djinn** — D1 LCS drift detection at anchor + post-session.
  - **emu** — A2 linear runway forecast + A1 read-loop / edit-revert pattern detection.
  - **gorgon** — language-agnostic PageRank with dangling-mass redistribution.
  - **lich** — M1 5-pattern static scan + M6 EMA false-positive learning. Required, fail-closed.
  - **naga** — N1 SHA-1 shape + N2 TF-IDF top-20 + N3 naming-convention fingerprint. Required.
  - **pech** — In-memory ledger + per-vendor budget tracking + tier-boundary thresholds. Required.
  - **sylph** — W5 6-pattern destructive-op gate + W2 Jaccard boundary clusters. Required.
- Streamable HTTP transport (single endpoint POST + GET, SSE, exp-backoff reconnect, resume disabled by default).
- End-to-end integration test suite (6 tests against a real Node subprocess MCP server).
- Live demo script (`scripts/demo-live.ts`) verified against `@modelcontextprotocol/server-filesystem`.

### Fixed
- **HIGH:** IPv6 SSRF guard — now blocks `::1`, `::ffff:` mapped, `fe80::/10`, `fc00::/7` (was only `::1`). 6 regression tests.
- **HIGH:** JSON-RPC parse — now validates method/id/error field shapes (was unchecked cast). 12 regression tests.
- **HIGH:** Hydra `rm -rf /` bypass — now reconstructs command line from string-array `args` (was missing array shape). 5 regression tests.
- **CRITICAL (false positive):** AckTracker deadline check — variable rename from `remaining` to `elapsedPastDeadline` for clarity.

### Architectural changes
- Orchestrator auto-subscribes each plugin to `lifecycle.<phase>` for every declared phase (per ADR-001). Without this, required plugins subscribed to domain topics never acked.
- AckTracker exposes `has()`; wired handler dedups invocations per (correlation_id, phase, plugin) to prevent double side-effects (e.g., pech ledger doubling).
- NamespaceRegistry resolves `byQualified` first, falls back to `byBare` (tools with dots in bare names like `shell.exec` are now correctly resolved).
- PluginAck.derived_events are now published to the bus by the wired handler (was stored on the ack but never reaching subscribers).

### Stats
- 41 TypeScript files / ~6700 LOC
- 18 test files / 136 tests / 7 todo / 0 fail
- 3 audit findings closed (HIGH); 5 medium / 5 low tracked for v0.3

## [0.1.0] — 2026-04-27 (initial reference)

### Added
- 7-phase orchestrator (anchor → trust-gate → pre-dispatch → dispatch → post-response → post-session → cross-session) with timeout-bounded fail-closed/fail-open.
- In-process pub/sub bus with bounded ring buffer + correlation_id stamping.
- stdio transport (newline-delimited UTF-8 JSON-RPC 2.0).
- OAuth 2.1 + S256 PKCE + RFC 8707 Resource Indicators.
- SSRF metadata guard (RFC 1918, link-local, cloud metadata, loopback).
- Namespace registry with SHA-256 schema-digest pin.
- Hydra reference plugin (5 CVE patterns + 5 secret-masking patterns).
- 33 tests across 5 test files.
