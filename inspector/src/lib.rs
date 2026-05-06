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

/// Resolve the path the Claude Code hook emitter writes to. Mirrors the
/// algorithm in `scripts/hooks/claude-code-emit.mjs::cachePath` —
/// XDG_CACHE_HOME → LOCALAPPDATA → HOME/.cache, all under `enchanter/`.
fn claude_code_hook_jsonl() -> PathBuf {
    let base = std::env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("LOCALAPPDATA").map(PathBuf::from))
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".cache")))
        .unwrap_or_else(std::env::temp_dir);
    base.join("enchanter").join("claude-code.jsonl")
}

/// Decide what bare `enchanter` (no subcommand) should do.
///
/// Hierarchy, highest priority first:
/// 1. stdin is piped → consume JSONL from stdin.
/// 2. stdin is a TTY AND the Claude Code hook JSONL exists OR its parent
///    cache dir exists (hooks installed but no events yet) → tail it.
///    This is the "real Claude Code work" path — every tool call, prompt,
///    session boundary lights up the cockpit from authentic hook output.
/// 3. stdin is a TTY AND `scripts/live.ts` is reachable from cwd → boot
///    the showcase runtime. Fallback when hooks aren't wired up.
/// 4. stdin is a TTY AND nothing else → demo mode (synthetic emitter).
fn default_command() -> Command {
    use std::io::IsTerminal;
    if !std::io::stdin().is_terminal() {
        return Command::Inspect(InspectArgs::default());
    }

    // Real Claude Code path: prefer it whenever hooks are installed —
    // the JSONL file may not exist yet (no Claude session has fired a hook
    // since install), but the parent dir does, and `--tail` waits up to 30s
    // for the file to appear. That's the "boom, real data" UX.
    let hook_jsonl = claude_code_hook_jsonl();
    let hooks_wired_up = hook_jsonl.exists()
        || hook_jsonl.parent().map(|p| p.is_dir()).unwrap_or(false);
    if hooks_wired_up {
        // Log so users can grep ~/.cache/enchanter/inspector.log to confirm
        // which mode bare `enchanter` picked — useful when troubleshooting
        // "is this real or showcase data" without restarting the binary.
        tracing::info!(
            path = %hook_jsonl.display(),
            "default_command: hooks wired up — tailing real Claude Code stream"
        );
        return Command::Inspect(InspectArgs {
            tail: Some(hook_jsonl),
            ..InspectArgs::default()
        });
    }

    // Showcase fallback when running from the monorepo with the demo script.
    if std::path::Path::new("scripts/live.ts").is_file() {
        return Command::Live(LiveArgs::default());
    }

    // Last-resort synthetic demo (handled by app::run when stdin is TTY).
    Command::Inspect(InspectArgs::default())
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
