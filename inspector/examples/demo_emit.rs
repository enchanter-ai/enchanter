//! Demo emitter — replays a JSONL fixture to stdout with realistic pacing
//! so the inspector dashboard animates.
//!
//! Usage:
//!     cargo run --example demo_emit | cargo run
//!     cargo run --example demo_emit -- tests/fixtures/demo-events.jsonl
//!     cargo run --example demo_emit -- --speed 4 tests/fixtures/demo-events.jsonl
//!
//! `--speed N` divides the inter-event delay by N (default 1; use higher to
//! replay faster, or `--speed 0` to emit as fast as the OS can flush).
//!
//! The pacing comes from the `time` field on each event: each line's delay
//! relative to the previous line's `time` is what gets slept. Lines with a
//! non-monotonic or missing `time` are emitted immediately.

use std::env;
use std::fs::File;
use std::io::{self, BufRead, BufReader, Write};
use std::path::PathBuf;
use std::thread::sleep;
use std::time::Duration;

fn main() -> io::Result<()> {
    let args: Vec<String> = env::args().skip(1).collect();
    let mut speed: f64 = 1.0;
    let mut path: Option<PathBuf> = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--speed" => {
                i += 1;
                speed = args
                    .get(i)
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(1.0);
            }
            "-h" | "--help" => {
                eprintln!(
                    "usage: demo_emit [--speed N] [PATH]\n\
                     default PATH: tests/fixtures/demo-events.jsonl"
                );
                return Ok(());
            }
            other => path = Some(PathBuf::from(other)),
        }
        i += 1;
    }

    let path = path.unwrap_or_else(|| PathBuf::from("tests/fixtures/demo-events.jsonl"));
    let file = File::open(&path).map_err(|e| {
        eprintln!("demo_emit: cannot open {}: {}", path.display(), e);
        e
    })?;
    let reader = BufReader::new(file);

    let stdout = io::stdout();
    let mut out = stdout.lock();
    let mut prev_t: Option<f64> = None;

    for line in reader.lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }

        let t = extract_time(&line);
        if let (Some(p), Some(c)) = (prev_t, t) {
            let delta = (c - p).max(0.0);
            let scaled = if speed > 0.0 { delta / speed } else { 0.0 };
            if scaled > 0.0 {
                sleep(Duration::from_secs_f64(scaled.min(2.0)));
            }
        }
        prev_t = t.or(prev_t);

        writeln!(out, "{}", line)?;
        out.flush()?;
    }

    Ok(())
}

/// Cheap `time` field extraction without pulling in serde_json. Looks for
/// `"time":` followed by a JSON number. Good enough for monotonic JSONL
/// fixtures we control.
fn extract_time(line: &str) -> Option<f64> {
    let key = "\"time\":";
    let idx = line.find(key)?;
    let rest = &line[idx + key.len()..];
    let rest = rest.trim_start();
    let end = rest
        .find(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-' || c == 'e' || c == 'E' || c == '+'))
        .unwrap_or(rest.len());
    rest[..end].parse().ok()
}
