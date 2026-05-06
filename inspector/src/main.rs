//! enchanter-inspector binary entry point.
//!
//! Stdout is the event channel for downstream tools — never write logs there.
//! All tracing output is routed to a rotating file inside the user's cache dir.

use std::fs::OpenOptions;
use std::path::PathBuf;

use anyhow::Context;
use tracing_subscriber::{fmt, prelude::*, EnvFilter};

fn log_path() -> PathBuf {
    // Prefer XDG_CACHE_HOME / %LOCALAPPDATA%; fall back to a temp dir.
    let base = std::env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("LOCALAPPDATA").map(PathBuf::from))
        .or_else(|| dirs_cache_fallback())
        .unwrap_or_else(std::env::temp_dir);
    base.join("enchanter").join("inspector.log")
}

fn dirs_cache_fallback() -> Option<PathBuf> {
    // Minimal HOME-based fallback; avoids pulling in `dirs` for one path.
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .map(|h| h.join(".cache"))
}

/// Cap the inspector.log size at this many bytes. On startup, if the log is
/// larger we rotate (truncate the existing file + drop a `.1` sibling). This
/// keeps the log useful for debugging without growing unbounded — the user's
/// real-world install hit 40 GB before this rotation landed.
const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024; // 5 MB

fn rotate_log_if_needed(path: &std::path::Path) {
    let Ok(meta) = std::fs::metadata(path) else { return };
    if meta.len() <= MAX_LOG_BYTES {
        return;
    }
    // Rotate: rename current to .1 (overwriting any existing .1), then the
    // OpenOptions::create below will recreate the primary path empty.
    let backup = path.with_extension("log.1");
    let _ = std::fs::remove_file(&backup);
    let _ = std::fs::rename(path, &backup);
}

fn init_tracing() -> anyhow::Result<()> {
    let path = log_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating log directory {}", parent.display()))?;
    }
    rotate_log_if_needed(&path);
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .with_context(|| format!("opening log file {}", path.display()))?;

    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("enchanter_inspector=info,warn"));

    tracing_subscriber::registry()
        .with(filter)
        .with(
            fmt::layer()
                .with_writer(file)
                .with_ansi(false)
                .with_target(true),
        )
        .try_init()
        .map_err(|e| anyhow::anyhow!("init tracing: {e}"))?;

    Ok(())
}

fn main() -> anyhow::Result<()> {
    init_tracing()?;
    enchanter_inspector::run()
}
