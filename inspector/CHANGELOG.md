# Changelog

All notable changes to `enchanter-inspector` are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] — 2026-05-05

First public release. Lives inside the Enchanter monorepo at [`client/enchanter/inspector/`](.) and ships alongside the Enchanter `0.3.0` line.

### Added
- Phase 1 MVP scaffolding: 10 modules covering event protocol, transport (stdin/file/TCP), state model, app loop, UI theme + widgets, layout, and 10 views (overview, plugins, events, security, cost, drift, codebase, replay, runtime totals, active tasks).
- `enchanter` CLI binary built from this crate — `enchanter inspect` is the default subcommand; `--from <path>` replays a JSONL file, `--socket <addr>` connects to a TCP source. Bare `enchanter.exe` with a TTY stdin auto-enters demo mode (continuous synthetic event emitter).
- Bundled JSONL fixture (`tests/fixtures/demo-events.jsonl`) and `demo_emit` example for paced replay without a live runtime.
- Cross-platform CI workflow (Ubuntu, macOS, Windows) running `cargo fmt --check`, `cargo clippy -D warnings`, `cargo check`, `cargo test`, and `cargo audit`.
- `justfile` with the common dev recipes (`check`, `ci`, `demo`, `fmt`, `test`, `build`).
- Integration test `tests/fixture_replay.rs` that replays the bundled fixture end-to-end and pins runtime-metric expectations. Plus `bridge-roundtrip.jsonl` fixture proving cross-language compatibility with the Enchanter `0.3.0` JSONL bridge.
- Hard 1 MiB per-line cap in the transport (`MAX_LINE_BYTES`) — oversized lines are dropped with a warning so a misbehaving runtime cannot exhaust inspector memory.
- Built-in demo emitter (`src/demo.rs`) — synthesizes realistic plugin events on randomized intervals so the dashboard animates without requiring a live runtime.
- Identity probes (`src/state.rs`) — surfaces GitHub user (via `gh api user --jq .login` or `git config user.name`), Claude account (from `~/.claude.json` `oauthAccount.emailAddress`), Plan tier (from `oauthAccount.organizationType`), tokens-today (sums `usage` records from `~/.claude/projects/*/*.jsonl` with a 100ms wall-clock cap).
- Hero asset (`docs/assets/hero.png`) — full cockpit render embedded in the README.

### Wire schema
- Compatible with the JSONL contract documented at [`../docs/event-schema.md`](../docs/event-schema.md). The Enchanter `0.3.0` bridge emits events that this inspector parses without modification.
