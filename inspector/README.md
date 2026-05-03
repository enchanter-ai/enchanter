# enchanter-inspector

Terminal-first TUI cockpit for the [Enchanter](../) AI runtime — think `htop` / `btop` / `k9s` / `lazygit`, but for an AI agent runtime.

> **Terminal is the cockpit. Web/Electron is the studio.**

The inspector consumes the runtime's JSONL event stream and renders a live, navigable view of plugins, events, security, cost, drift, codebase impact, replay, runtime internals, and task graph. Lives inside the [Enchanter](../) monorepo as the Rust-side dashboard.

## Install / build

This is a Rust crate inside the Enchanter monorepo at `client/enchanter/inspector/`. From this directory:

```bash
cargo build --release
```

The binary lands at `target/release/enchanter` (so `enchanter inspect` becomes one short command on PATH).

## Usage

The default mode reads newline-delimited JSON events from **stdin** — pipe the runtime in:

```bash
enchanter-runtime | enchanter
```

Replay a previously captured run:

```bash
enchanter --from ./run-2026-04-30.jsonl
# or via the explicit subcommand:
enchanter inspect --from ./run-2026-04-30.jsonl
```

Connect to a live runtime socket:

```bash
enchanter --socket 127.0.0.1:7878
# or unix socket
enchanter --socket /tmp/enchanter.sock
```

### Try it without a runtime

A bundled fixture replays a realistic session covering every event variant. The `demo_emit` example paces lines by the `time` field on each event so the dashboard animates the way it would under live load:

```bash
cargo run --example demo_emit | cargo run
# faster replay
cargo run --example demo_emit -- --speed 4 | cargo run
# instant blast
cargo run --example demo_emit -- --speed 0 | cargo run
```

`stdout` is reserved for forwarding events to downstream tools; all log output is written to a file under `$XDG_CACHE_HOME/enchanter/inspector.log` (or the platform equivalent).

## Key bindings

| Key       | Action                                                        |
|-----------|---------------------------------------------------------------|
| `q`       | Quit                                                          |
| `p`       | Pause / resume the live event stream                          |
| `/`       | Open filter / search                                          |
| `?`       | Toggle help overlay                                           |
| `Tab`     | Cycle to the next view                                        |
| `Enter`   | Drill into the highlighted row                                |
| `Esc`     | Cancel filter / close overlay / pop drill-down                |
| `1`       | Overview                                                      |
| `2`       | Plugins                                                       |
| `3`       | Events                                                        |
| `4`       | Security                                                      |
| `5`       | Cost                                                          |
| `6`       | Drift                                                         |
| `7`       | Codebase                                                      |
| `8`       | Replay                                                        |
| `9`       | Runtime                                                       |
| `0`       | Tasks                                                         |
| `v`       | Toggle verbose / detail panel                                 |
| `c`       | Copy highlighted row (id, path, or quote) to clipboard        |
| `d`       | Diff the highlighted artifact against its baseline            |
| `r`       | Refresh / reload current view                                 |
| `e`       | Export current view to a file                                 |
| `a`       | Acknowledge / dismiss the highlighted alert                   |

## Plugins

The inspector tracks the ten Enchanter plugins, each with a stable accent color used in the UI:

| Plugin   | Accent  |
|----------|---------|
| pech     | orange  |
| emu      | yellow  |
| hydra    | green   |
| sylph    | cyan    |
| lich     | blue    |
| naga     | green   |
| crow     | yellow  |
| djinn    | purple  |
| gorgon   | pink    |
| wixie    | magenta |

## Architecture

- `src/event/` — wire types for the JSONL event stream
- `src/transport/` — stdin / file / socket source adapters
- `src/state/` — application + per-plugin state, derived views
- `src/app/` — main loop, terminal lifecycle, input handling
- `src/ui/` — shared theme, widgets, layout primitives
- `src/views/` — one module per top-level screen

See the parent monorepo README for how the inspector relates to `enchanter-runtime`, the `enchanter` Node CLI, and the broader plugin set.
