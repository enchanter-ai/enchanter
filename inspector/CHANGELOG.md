# Changelog

All notable changes to `enchanter-inspector` are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- Initial Phase 1 MVP scaffolding: 10 modules covering event protocol, transport (stdin/file/TCP), state model, app loop, UI theme + widgets, layout, and 10 views (overview, plugins, events, security, cost, drift, codebase, replay, runtime totals, active tasks).
- `enchanter-inspector inspect` CLI subcommand with `--from <path>` and `--socket <addr>` modes; default is stdin.
- Bundled JSONL fixture (`tests/fixtures/demo-events.jsonl`) and `demo_emit` example for paced replay without a live runtime.
- Cross-platform CI workflow (Ubuntu, macOS, Windows) running `cargo fmt --check`, `cargo clippy -D warnings`, `cargo check`, `cargo test`, and `cargo audit`.
- `justfile` with the common dev recipes (`check`, `ci`, `demo`, `fmt`, `test`, `build`).
- Integration test `tests/fixture_replay.rs` that replays the bundled fixture end-to-end and pins runtime-metric expectations.
- Hard 1 MiB per-line cap in the transport (`MAX_LINE_BYTES`) — oversized lines are dropped with a warning so a misbehaving runtime cannot exhaust inspector memory.
