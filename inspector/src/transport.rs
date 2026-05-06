//! Transport — JSONL event source adapters.
//!
//! Streams newline-delimited JSON events from one of three sources (stdin,
//! file, or TCP socket), parses each line via [`crate::event::parse_line`],
//! and forwards successful parses through a bounded `tokio::sync::mpsc`
//! channel. Malformed lines are logged and skipped — fail-open per
//! `shared/conduct/hooks.md`: one bad line never crashes the consumer.

use std::path::PathBuf;
use std::sync::Arc;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::tcp::OwnedWriteHalf;
use tokio::sync::{mpsc, Mutex};

use crate::event::Event;

/// Default channel buffer when the caller does not specify one.
pub const DEFAULT_BUFFER: usize = 1024;

/// Where the transport pulls JSONL bytes from.
pub enum Source {
    /// Read from process stdin (pairs with `runtime | inspector`).
    Stdin,
    /// One-shot replay of a JSONL file. No tail-follow on MVP.
    File(PathBuf),
    /// Connect to a TCP `host:port` and stream until the peer closes.
    /// READ-ONLY — peer's writes are ignored.
    Socket(String),
    /// v0.5 #4: connect to a TCP `host:port` bidirectionally — read events
    /// AND write outbound control commands on the same socket. Opt-in via
    /// `--control-socket` so plain `--socket` callers stay read-only and
    /// back-compatible.
    SocketControl(String),
    /// Spawn an arbitrary command and consume its stdout as JSONL events.
    /// On Windows, runs via `cmd /c <cmd>`; elsewhere via `sh -c <cmd>`.
    /// The child's stderr is forwarded to the inspector's stderr so the
    /// user can see banners/errors from the producer alongside the cockpit.
    Exec(String),
}

/// Outbound control half of a bidirectional transport. Cheap to clone — wraps
/// a tokio `OwnedWriteHalf` behind a mutex so multiple call-sites
/// (UI input handlers, future plugins) can share it without re-locking.
#[derive(Clone)]
pub struct ControlWriter {
    inner: Arc<Mutex<Option<OwnedWriteHalf>>>,
}

impl ControlWriter {
    /// Build a no-op writer (used when the source is read-only). All sends
    /// are silently dropped — log at warn so misconfiguration is visible.
    pub fn disconnected() -> Self {
        Self {
            inner: Arc::new(Mutex::new(None)),
        }
    }

    fn from_half(half: OwnedWriteHalf) -> Self {
        Self {
            inner: Arc::new(Mutex::new(Some(half))),
        }
    }

    /// Write a single line, appending `\n` if the caller didn't.
    /// Returns Err on disconnected, write failure, or shutdown peer.
    pub async fn send_control(&self, line: &str) -> std::io::Result<()> {
        let mut guard = self.inner.lock().await;
        let Some(half) = guard.as_mut() else {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotConnected,
                "control writer not connected",
            ));
        };
        half.write_all(line.as_bytes()).await?;
        if !line.ends_with('\n') {
            half.write_all(b"\n").await?;
        }
        half.flush().await?;
        Ok(())
    }

    /// True when the writer was constructed with a real socket half.
    pub async fn is_connected(&self) -> bool {
        self.inner.lock().await.is_some()
    }
}

/// Owns the receive side of the event channel produced by a spawned
/// transport task. The send side lives inside the task and is dropped on
/// EOF / disconnect / consumer-drop, signalling end-of-stream to consumers.
pub struct Transport {
    rx: mpsc::Receiver<Event>,
    /// Outbound control half. Disconnected for stdin / file / read-only
    /// sockets; connected for `Source::SocketControl`.
    writer: ControlWriter,
}

impl Transport {
    /// Spawn the transport task. Panics on init failure for sources that
    /// always succeed at open (stdin); for file/socket sources prefer
    /// [`Transport::try_spawn`] which returns the open error.
    pub fn spawn(source: Source, buffer: usize) -> Self {
        let buffer = if buffer == 0 { DEFAULT_BUFFER } else { buffer };
        let (tx, rx) = mpsc::channel(buffer);

        match source {
            Source::Stdin => {
                tokio::spawn(run_stdin(tx));
            }
            Source::File(path) => {
                tokio::spawn(run_file(path, tx));
            }
            Source::Socket(addr) => {
                tokio::spawn(run_socket(addr, tx));
            }
            Source::SocketControl(_) => {
                // Bidirectional sockets need eager open to surface the writer.
                // Falling back to disconnected control here keeps `spawn`
                // total but the channel won't accept inbound commands. Use
                // `try_spawn` for control-aware setups.
                tracing::warn!(
                    "Source::SocketControl spawned via Transport::spawn — control writer disconnected; use try_spawn"
                );
            }
            Source::Exec(cmd) => {
                tokio::spawn(run_exec(cmd, tx));
            }
        }

        Transport {
            rx,
            writer: ControlWriter::disconnected(),
        }
    }

    /// Like [`Transport::spawn`], but opens file / socket sources eagerly
    /// so that open errors surface to the caller instead of being swallowed
    /// inside the task.
    pub async fn try_spawn(source: Source, buffer: usize) -> anyhow::Result<Self> {
        let buffer = if buffer == 0 { DEFAULT_BUFFER } else { buffer };
        let (tx, rx) = mpsc::channel(buffer);

        let writer = match source {
            Source::Stdin => {
                tokio::spawn(run_stdin(tx));
                ControlWriter::disconnected()
            }
            Source::File(path) => {
                let file = tokio::fs::File::open(&path).await?;
                let reader = BufReader::new(file);
                tokio::spawn(forward_lines(reader, tx, "file"));
                ControlWriter::disconnected()
            }
            Source::Socket(addr) => {
                let stream = tokio::net::TcpStream::connect(&addr).await?;
                let (read_half, _write_half) = stream.into_split();
                let reader = BufReader::new(read_half);
                tokio::spawn(forward_lines(reader, tx, "socket"));
                // Read-only mode: write half is dropped, control writer
                // exposes disconnected so any send_control calls report it.
                ControlWriter::disconnected()
            }
            Source::SocketControl(addr) => {
                let stream = tokio::net::TcpStream::connect(&addr).await?;
                let (read_half, write_half) = stream.into_split();
                let reader = BufReader::new(read_half);
                tokio::spawn(forward_lines(reader, tx, "socket-control"));
                ControlWriter::from_half(write_half)
            }
            Source::Exec(cmd) => {
                tokio::spawn(run_exec(cmd, tx));
                ControlWriter::disconnected()
            }
        };

        Ok(Transport { rx, writer })
    }

    /// Receive the next event, or `None` once the source ends.
    pub async fn recv(&mut self) -> Option<Event> {
        self.rx.recv().await
    }

    /// Surrender the underlying receiver — useful when handing the stream
    /// off to a select-loop that wants the raw `mpsc::Receiver`. The control
    /// writer is dropped along with the rest of `Transport`; clone
    /// [`Transport::writer`] first if the caller still needs it.
    pub fn into_receiver(self) -> mpsc::Receiver<Event> {
        self.rx
    }

    /// Cheap-to-clone outbound control writer. Disconnected for read-only
    /// sources; connected for [`Source::SocketControl`].
    pub fn writer(&self) -> ControlWriter {
        self.writer.clone()
    }

    /// Convenience: write one outbound control line. Equivalent to
    /// `transport.writer().send_control(line).await`.
    pub async fn send_control(&self, line: &str) -> std::io::Result<()> {
        self.writer.send_control(line).await
    }
}

// --- task bodies -----------------------------------------------------------

async fn run_stdin(tx: mpsc::Sender<Event>) {
    let stdin = tokio::io::stdin();
    let reader = BufReader::new(stdin);
    forward_lines(reader, tx, "stdin").await;
}

async fn run_file(path: PathBuf, tx: mpsc::Sender<Event>) {
    match tokio::fs::File::open(&path).await {
        Ok(file) => {
            let reader = BufReader::new(file);
            forward_lines(reader, tx, "file").await;
        }
        Err(err) => {
            tracing::error!(?path, %err, "transport file open failed");
        }
    }
}

async fn run_socket(addr: String, tx: mpsc::Sender<Event>) {
    match tokio::net::TcpStream::connect(&addr).await {
        Ok(stream) => {
            let (read_half, _write_half) = stream.into_split();
            let reader = BufReader::new(read_half);
            forward_lines(reader, tx, "socket").await;
        }
        Err(err) => {
            tracing::error!(%addr, %err, "transport socket connect failed");
        }
    }
}

/// Resolve the path to the runtime-stderr log. Best-effort.
fn runtime_log_path() -> Option<PathBuf> {
    let base = std::env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("LOCALAPPDATA").map(PathBuf::from))
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".cache")))
        .unwrap_or_else(std::env::temp_dir);
    Some(base.join("enchanter").join("runtime.log"))
}

/// Spawn an arbitrary shell command and stream its stdout as JSONL events.
/// Stderr is captured to a log file (NOT inherited) — inheriting writes to
/// the same TTY the TUI's alternate-screen owns, smearing the cockpit on
/// any npm-install / npx-cache output. Log path: `<cache>/enchanter/runtime.log`,
/// where `<cache>` is `XDG_CACHE_HOME` / `LOCALAPPDATA` / `HOME/.cache` /
/// the system temp dir, in that order.
async fn run_exec(cmd: String, tx: mpsc::Sender<Event>) {
    use std::process::Stdio;
    use tokio::io::AsyncReadExt as _;
    use tokio::process::Command;

    // Resolve the runtime-log path. Best-effort — fall back to discarding
    // stderr if we can't open the file.
    let log_path = runtime_log_path();
    if let Some(ref p) = log_path {
        if let Some(parent) = p.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
    }

    let mut child = if cfg!(windows) {
        Command::new("cmd")
            .arg("/c")
            .arg(&cmd)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
    } else {
        Command::new("sh")
            .arg("-c")
            .arg(&cmd)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
    }
    .map_err(|e| {
        tracing::error!(%cmd, err=%e, "transport exec spawn failed");
    })
    .ok();

    let Some(stdout) = child.as_mut().and_then(|c| c.stdout.take()) else {
        // spawn failed; tx drops, consumer sees None.
        return;
    };

    // Drain the child's stderr into the runtime log so npm-install / npx /
    // tsx noise doesn't smear the TUI. Spawned as its own task so it runs
    // concurrently with stdout reading.
    if let Some(stderr) = child.as_mut().and_then(|c| c.stderr.take()) {
        let log_path = log_path.clone();
        tokio::spawn(async move {
            use tokio::fs::OpenOptions;
            use tokio::io::AsyncWriteExt as _;
            let mut file = match log_path {
                Some(p) => OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(p)
                    .await
                    .ok(),
                None => None,
            };
            let mut reader = stderr;
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf).await {
                    Ok(0) => break,
                    Ok(n) => {
                        if let Some(f) = file.as_mut() {
                            let _ = f.write_all(&buf[..n]).await;
                        }
                    }
                    Err(_) => break,
                }
            }
            if let Some(mut f) = file {
                let _ = f.flush().await;
            }
        });
    }

    let reader = BufReader::new(stdout);
    forward_lines(reader, tx, "exec").await;

    // Reap the child so we don't leak zombies on shutdown.
    if let Some(mut c) = child {
        if let Ok(Some(_)) = c.try_wait() {
            // already exited
        } else {
            let _ = c.kill().await;
        }
    }
}

/// Hard ceiling on a single JSONL line. Lines longer than this are dropped
/// with a warning so a misbehaving runtime cannot exhaust inspector memory.
/// Realistic events fit comfortably under 64 KiB; 1 MiB leaves a 16x margin
/// for unusually large `tool.result` payloads.
pub const MAX_LINE_BYTES: usize = 1024 * 1024;

/// Generic line pump. Reads lines from any `AsyncBufRead`, parses each via
/// `crate::event::parse_line`, forwards `Ok` events into `tx`. Skips empty
/// lines silently, logs and skips malformed lines, drops oversized lines
/// (> [`MAX_LINE_BYTES`]) with a warning, and exits on read error, EOF, or
/// consumer-drop.
async fn forward_lines<R>(mut reader: R, tx: mpsc::Sender<Event>, kind: &'static str)
where
    R: AsyncBufReadExt + Unpin,
{
    let mut buf: Vec<u8> = Vec::with_capacity(4096);
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf).await {
            Ok(0) => {
                if kind == "socket" {
                    tracing::info!("transport socket closed");
                }
                return;
            }
            Ok(_n) => {
                if buf.len() > MAX_LINE_BYTES {
                    tracing::warn!(
                        bytes = buf.len(),
                        max = MAX_LINE_BYTES,
                        kind,
                        "dropping oversized line"
                    );
                    // If the line had no terminating newline within the cap,
                    // keep draining until we hit one or EOF so the next
                    // iteration starts on a fresh line boundary.
                    if buf.last() != Some(&b'\n') {
                        let mut sink = [0u8; 4096];
                        loop {
                            use tokio::io::AsyncReadExt as _;
                            match reader.read(&mut sink).await {
                                Ok(0) => return,
                                Ok(n) => {
                                    if let Some(_) = sink[..n].iter().position(|&b| b == b'\n') {
                                        break;
                                    }
                                }
                                Err(err) => {
                                    tracing::warn!(%err, kind, "transport read error during overflow drain");
                                    return;
                                }
                            }
                        }
                    }
                    continue;
                }

                // Trim trailing \n and (Windows) \r before parsing.
                if buf.last() == Some(&b'\n') {
                    buf.pop();
                }
                if buf.last() == Some(&b'\r') {
                    buf.pop();
                }
                if buf.is_empty() {
                    continue;
                }

                let line = match std::str::from_utf8(&buf) {
                    Ok(s) => s,
                    Err(err) => {
                        tracing::warn!(%err, kind, "non-utf8 line skipped");
                        continue;
                    }
                };

                match crate::event::parse_line(line) {
                    Ok(event) => {
                        // Schema-validate after parse succeeds. Wire-shape
                        // drift between Node (Bridge) and Rust (Transport)
                        // surfaces here as a typed mismatch, not a silent
                        // round-trip. Drop on mismatch with a warning —
                        // a bad line never crashes the consumer.
                        match serde_json::from_str::<serde_json::Value>(line) {
                            Ok(value) => {
                                if let Err(err) = crate::schema::validate(&value) {
                                    tracing::warn!(line = %line, %err, "schema validation failed, dropping event");
                                    continue;
                                }
                            }
                            Err(err) => {
                                // Should not happen — parse_line just
                                // succeeded — but stay defensive.
                                tracing::warn!(line = %line, %err, "schema-pass json reparse failed");
                                continue;
                            }
                        }
                        if let Err(err) = tx.send(event).await {
                            tracing::debug!(%err, kind, "transport consumer dropped, exiting");
                            return;
                        }
                    }
                    Err(err) => {
                        tracing::warn!(line = %line, %err, "skipping malformed event line");
                    }
                }
            }
            Err(err) => {
                tracing::warn!(%err, kind, "transport read error, ending stream");
                return;
            }
        }
    }
}

// --- tests -----------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;

    /// Spawn a File-source transport over a tempfile containing 3 valid
    /// JSON event lines + 1 malformed line, assert exactly 3 events arrive
    /// and the channel closes on EOF.
    #[tokio::test]
    async fn file_source_skips_malformed_and_closes_on_eof() {
        // Build a unique temp path; clean up at the end regardless of result.
        let pid = std::process::id();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let path = std::env::temp_dir()
            .join(format!("enchanter_inspector_test_{}_{}.jsonl", pid, nanos));

        // Write 3 valid lines + 1 malformed. Validity is determined by what
        // `crate::event::parse_line` accepts — events need a `type` discriminator
        // matching one of the known variants.
        {
            let mut f = std::fs::File::create(&path).expect("create tempfile");
            writeln!(f, r#"{{"type":"session.started","time":1.0}}"#).unwrap();
            writeln!(f, r#"{{"type":"session.opened","time":2.0}}"#).unwrap();
            writeln!(f, r#"this is not json at all"#).unwrap();
            writeln!(f, r#"{{"type":"session.closed","time":3.0}}"#).unwrap();
            f.flush().unwrap();
        }

        let result = async {
            let mut transport = Transport::try_spawn(Source::File(path.clone()), 16)
                .await
                .expect("open tempfile");

            let mut received = 0usize;
            while let Some(_event) = transport.recv().await {
                received += 1;
            }
            received
        }
        .await;

        // Always clean up before asserting.
        let _ = std::fs::remove_file(&path);

        assert_eq!(
            result, 3,
            "expected 3 well-formed events to pass through, malformed line skipped"
        );
    }
}
