//! enchanter-inspector — terminal cockpit for the Enchanter AI runtime.
//!
//! Module ownership:
//! - `event`     — wire types for the JSONL event stream (owned elsewhere)
//! - `transport` — stdin / file / socket source adapters (owned elsewhere)
//! - `state`     — application state, plugin state, derived views (owned elsewhere)
//! - `app`       — main loop, input, terminal lifecycle (owned elsewhere)
//! - `ui`        — shared theme, widgets, layout primitives
//! - `views`     — per-view rendering (overview, plugins, events, ...)

pub mod event;
pub mod schema;
pub mod transport;
pub mod state;
pub mod app;
pub mod control;
pub mod demo;
pub mod ui;
pub mod views;

use std::path::PathBuf;

use clap::{Args, Parser, Subcommand};

/// Where the inspector pulls events from.
#[derive(Debug, Clone)]
pub enum Source {
    /// Read newline-delimited JSON from stdin (default; pairs with
    /// `enchanter-runtime | enchanter-inspector`).
    Stdin,
    /// Replay a previously captured JSONL file.
    File(PathBuf),
    /// Connect to a runtime socket (TCP `host:port` or unix path) READ-ONLY.
    /// Inbound events only; the inspector cannot send commands back.
    Socket(String),
    /// v0.5 #4 — connect bidirectionally to a runtime socket. Reads inbound
    /// events AND writes outbound `approval.response` commands on the same
    /// socket. Opt-in via `--control-socket`; the read-only `--socket`
    /// remains the default for back-compatibility.
    SocketControl(String),
    /// v0.5+ — spawn an arbitrary command and consume its stdout as JSONL.
    /// Usage: `enchanter inspect --exec "npx tsx scripts/demo-live.ts"`.
    /// Closes the producer↔consumer loop in one command without an external
    /// shell pipe.
    Exec(String),
    /// Follow a JSONL file like `tail -f`. Yields events as new lines are
    /// appended, surviving file rotation. The path may not yet exist when
    /// the inspector starts — it'll wait and retry.
    Tail(PathBuf),
}

/// Resolved runtime configuration handed to `app::run`.
#[derive(Debug, Clone)]
pub struct Config {
    pub source: Source,
}

#[derive(Parser, Debug)]
#[command(
    name = "enchanter",
    version,
    about = "Terminal cockpit for the Enchanter AI runtime",
    long_about = "Terminal is the cockpit. Web/Electron is the studio."
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Open the inspector against a live or recorded event stream (default).
    Inspect(InspectArgs),
    /// One-command live session: spawns the Node-side runtime
    /// (`scripts/live.ts`) and pipes its bus events straight into the cockpit.
    /// Equivalent to `enchanter inspect --exec "npx tsx scripts/live.ts"`.
    /// Run from the `client/enchanter/` directory so the script path resolves.
    Live(LiveArgs),
}

#[derive(Args, Debug, Default)]
struct LiveArgs {
    /// Override the script path (default: `scripts/live.ts`).
    #[arg(long, value_name = "SCRIPT", default_value = "scripts/live.ts")]
    script: String,
}

impl LiveArgs {
    fn into_config(self) -> Config {
        // Set ENCHANTER_BRIDGE inline so the spawned child uses stdout sink
        // for its bus events. Syntax differs per shell — `cmd /c` and `sh -c`
        // both accept their respective inline-env idioms.
        let cmd = if cfg!(windows) {
            format!("set ENCHANTER_BRIDGE=stdout&& npx tsx {}", self.script)
        } else {
            format!("ENCHANTER_BRIDGE=stdout npx tsx {}", self.script)
        };
        Config {
            source: Source::Exec(cmd),
        }
    }
}

#[derive(Args, Debug, Default)]
struct InspectArgs {
    /// Replay events from a JSONL file instead of stdin.
    #[arg(long, value_name = "JSONL_FILE", conflicts_with_all = ["socket", "control_socket"])]
    from: Option<PathBuf>,

    /// Connect READ-ONLY to a runtime socket (e.g. `127.0.0.1:7878`). The
    /// inspector receives events but cannot send commands back.
    #[arg(long, value_name = "ADDR", conflicts_with = "control_socket")]
    socket: Option<String>,

    /// v0.5 #4 — connect bidirectionally to a runtime socket. Reads events
    /// AND sends approve/veto decisions on the same socket. Opt-in.
    #[arg(long, value_name = "ADDR")]
    control_socket: Option<String>,

    /// Spawn the given shell command and consume its stdout as JSONL events.
    /// Closes the producer↔consumer loop in one command — no external pipe.
    /// Example: `enchanter inspect --exec "npx tsx scripts/demo-live.ts"`.
    #[arg(long, value_name = "CMD", conflicts_with_all = ["from", "socket", "control_socket"])]
    exec: Option<String>,

    /// Follow a JSONL file as it's appended (like `tail -f`). Pairs with the
    /// Claude Code hook emitter — the hook script writes one line per
    /// operation, the inspector picks them up live. The file may not exist
    /// yet at startup; the tailer waits and retries.
    #[arg(long, value_name = "JSONL_FILE",
          conflicts_with_all = ["from", "socket", "control_socket", "exec"])]
    tail: Option<PathBuf>,
}

impl InspectArgs {
    fn into_config(self) -> Config {
        let source = match (
            self.from,
            self.socket,
            self.control_socket,
            self.exec,
            self.tail,
        ) {
            (_, _, _, Some(cmd), _) => Source::Exec(cmd),
            (_, _, _, _, Some(path)) => Source::Tail(path),
            (Some(path), _, _, None, None) => Source::File(path),
            (None, _, Some(addr), None, None) => Source::SocketControl(addr),
            (None, Some(addr), None, None, None) => Source::Socket(addr),
            (None, None, None, None, None) => Source::Stdin,
        };
        Config { source }
    }
}

/// Decide what bare `enchanter` (no subcommand) should do.
///
/// Hierarchy:
/// 1. stdin is piped → consume JSONL from stdin (`Source::Stdin`, which the
///    app loop turns into demo mode iff the stdin is also a TTY but that
///    shouldn't happen if it's piped).
/// 2. stdin is a TTY AND `scripts/live.ts` is reachable from cwd → boot the
///    real runtime via `Source::Exec`. This is the "boom, just works"
///    path when the binary is run from `client/enchanter/`.
/// 3. stdin is a TTY AND `scripts/live.ts` is NOT reachable → fall back to
///    `Source::Stdin`, which the app loop turns into the synthetic
///    `src/demo.rs` emitter so the cockpit still has something to render.
fn default_command() -> Command {
    use std::io::IsTerminal;
    if std::io::stdin().is_terminal() && std::path::Path::new("scripts/live.ts").is_file() {
        Command::Live(LiveArgs::default())
    } else {
        Command::Inspect(InspectArgs::default())
    }
}

/// Library entry point invoked from `main`.
///
/// Builds a multi-thread tokio runtime and dispatches into `app::run`.
pub fn run() -> anyhow::Result<()> {
    let cli = Cli::parse();
    let config = match cli.command.unwrap_or_else(default_command) {
        Command::Inspect(args) => args.into_config(),
        Command::Live(args) => args.into_config(),
    };

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;

    runtime.block_on(async move { app::run(config).await })
}
