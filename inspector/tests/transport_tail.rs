//! Integration test for `Source::Tail` — the `tail -f` JSONL follower.
//!
//! Covers the four contracts:
//!   1. Replay of pre-existing content at spawn time.
//!   2. Pickup of bytes appended after spawn.
//!   3. Recovery from rotation (rename original, create fresh file at the
//!      original path).
//!   4. Late-creation: file does not exist at spawn, appears later.
//!
//! Tempfiles live in `std::env::temp_dir()` and are cleaned up on the way
//! out — including on panic, via small drop-guards.

use std::io::Write as _;
use std::path::PathBuf;
use std::time::Duration;

use enchanter_inspector::transport::{Source, Transport};
use tokio::time::timeout;

/// Best-effort cleanup of a tempfile (and a numbered rotated sibling) on
/// drop, so a failed assertion doesn't leak files into the temp dir.
struct TmpPathGuard {
    path: PathBuf,
}

impl Drop for TmpPathGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
        let rotated = self.path.with_extension(
            // append .1 to whatever the existing extension is
            format!(
                "{}.1",
                self.path
                    .extension()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
            ),
        );
        let _ = std::fs::remove_file(&rotated);
    }
}

fn unique_tmp_path(label: &str) -> PathBuf {
    let pid = std::process::id();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!(
        "enchanter_inspector_tail_{}_{}_{}.jsonl",
        label, pid, nanos
    ))
}

fn write_lines(path: &PathBuf, lines: &[&str]) {
    let mut f = std::fs::File::create(path).expect("create tempfile");
    for line in lines {
        writeln!(f, "{}", line).unwrap();
    }
    f.flush().unwrap();
}

fn append_lines(path: &PathBuf, lines: &[&str]) {
    let mut f = std::fs::OpenOptions::new()
        .append(true)
        .open(path)
        .expect("append tempfile");
    for line in lines {
        writeln!(f, "{}", line).unwrap();
    }
    f.flush().unwrap();
}

async fn drain_n(transport: &mut Transport, n: usize, deadline: Duration) -> usize {
    let mut got = 0usize;
    let recv_loop = async {
        while got < n {
            match transport.recv().await {
                Some(_) => got += 1,
                None => break,
            }
        }
        got
    };
    timeout(deadline, recv_loop).await.unwrap_or(got)
}

const L1: &str = r#"{"type":"session.started","time":1.0}"#;
const L2: &str = r#"{"type":"session.opened","time":2.0}"#;
const L3: &str = r#"{"type":"session.closed","time":3.0}"#;
const L4: &str = r#"{"type":"session.started","time":4.0}"#;
const L5: &str = r#"{"type":"session.opened","time":5.0}"#;
const L6: &str = r#"{"type":"session.closed","time":6.0}"#;

#[tokio::test]
async fn tail_replays_existing_then_picks_up_appends() {
    let path = unique_tmp_path("basic");
    let _guard = TmpPathGuard { path: path.clone() };

    write_lines(&path, &[L1, L2, L3]);

    let mut transport = Transport::try_spawn(Source::Tail(path.clone()), 64)
        .await
        .expect("spawn tail");

    // 1) Replay existing 3 lines within 5s.
    let got = drain_n(&mut transport, 3, Duration::from_secs(5)).await;
    assert_eq!(got, 3, "expected the 3 pre-existing lines");

    // 2) Append 3 more, expect them within ~1.5s (poll = 200 ms × ~7 ticks).
    append_lines(&path, &[L4, L5, L6]);
    let got_more = drain_n(&mut transport, 3, Duration::from_millis(2_500)).await;
    assert_eq!(got_more, 3, "expected 3 appended lines to arrive");
}

#[tokio::test]
async fn tail_survives_rotation() {
    let path = unique_tmp_path("rotation");
    let _guard = TmpPathGuard { path: path.clone() };

    write_lines(&path, &[L1, L2]);

    let mut transport = Transport::try_spawn(Source::Tail(path.clone()), 64)
        .await
        .expect("spawn tail");

    // Drain initial 2.
    let got = drain_n(&mut transport, 2, Duration::from_secs(5)).await;
    assert_eq!(got, 2);

    // Rotate: rename original to .1 and recreate at original path.
    // On Windows, the inspector's open file handle may keep the file alive
    // — we still rename it, then create a fresh file at the original path.
    let rotated = path.with_extension("jsonl.1");
    let _ = std::fs::remove_file(&rotated);
    // If rename fails on Windows due to the open file lock, fall back to
    // truncating the original — which the tailer also treats as rotation.
    if std::fs::rename(&path, &rotated).is_err() {
        // Truncate in place — len() will fall below read_offset, tailer
        // resets to 0 and rereads from the new content.
        std::fs::File::create(&path).expect("truncate");
    }
    write_lines(&path, &[L3]);

    // Expect the new line within 2s (200 ms poll + open + read).
    let got = drain_n(&mut transport, 1, Duration::from_secs(2)).await;
    assert_eq!(got, 1, "expected the post-rotation line");

    let _ = std::fs::remove_file(&rotated);
}

#[tokio::test]
async fn tail_waits_for_late_creation() {
    let path = unique_tmp_path("late");
    let _guard = TmpPathGuard { path: path.clone() };
    // Make sure the file does NOT exist at spawn.
    let _ = std::fs::remove_file(&path);

    let mut transport = Transport::try_spawn(Source::Tail(path.clone()), 64)
        .await
        .expect("spawn tail");

    // Sleep ~1.5s, then create with 1 line.
    tokio::time::sleep(Duration::from_millis(1_500)).await;
    write_lines(&path, &[L1]);

    let got = drain_n(&mut transport, 1, Duration::from_secs(3)).await;
    assert_eq!(got, 1, "tailer should pick up the line after late creation");
}
