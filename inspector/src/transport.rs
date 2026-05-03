//! Transport — JSONL event source adapters.
//!
//! Streams newline-delimited JSON events from one of three sources (stdin,
//! file, or TCP socket), parses each line via [`crate::event::parse_line`],
//! and forwards successful parses through a bounded `tokio::sync::mpsc`
//! channel. Malformed lines are logged and skipped — fail-open per
//! `shared/conduct/hooks.md`: one bad line never crashes the consumer.

use std::path::PathBuf;

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::mpsc;

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
    Socket(String),
}

/// Owns the receive side of the event channel produced by a spawned
/// transport task. The send side lives inside the task and is dropped on
/// EOF / disconnect / consumer-drop, signalling end-of-stream to consumers.
pub struct Transport {
    rx: mpsc::Receiver<Event>,
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
        }

        Transport { rx }
    }

    /// Like [`Transport::spawn`], but opens file / socket sources eagerly
    /// so that open errors surface to the caller instead of being swallowed
    /// inside the task.
    pub async fn try_spawn(source: Source, buffer: usize) -> anyhow::Result<Self> {
        let buffer = if buffer == 0 { DEFAULT_BUFFER } else { buffer };
        let (tx, rx) = mpsc::channel(buffer);

        match source {
            Source::Stdin => {
                tokio::spawn(run_stdin(tx));
            }
            Source::File(path) => {
                let file = tokio::fs::File::open(&path).await?;
                let reader = BufReader::new(file);
                tokio::spawn(forward_lines(reader, tx, "file"));
            }
            Source::Socket(addr) => {
                let stream = tokio::net::TcpStream::connect(&addr).await?;
                let (read_half, _write_half) = stream.into_split();
                let reader = BufReader::new(read_half);
                tokio::spawn(forward_lines(reader, tx, "socket"));
            }
        }

        Ok(Transport { rx })
    }

    /// Receive the next event, or `None` once the source ends.
    pub async fn recv(&mut self) -> Option<Event> {
        self.rx.recv().await
    }

    /// Surrender the underlying receiver — useful when handing the stream
    /// off to a select-loop that wants the raw `mpsc::Receiver`.
    pub fn into_receiver(self) -> mpsc::Receiver<Event> {
        self.rx
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
