//! Integration tests mirroring `tests/observability/schema.test.ts`.
//!
//! Coverage: each well-typed variant + a generic variant happy path,
//! missing-required rejection, wrong-type rejection, bad-enum rejection,
//! unknown-discriminator rejection, and a regression that the bundled
//! bridge-roundtrip.jsonl validates line-by-line.

use std::path::PathBuf;

use enchanter_inspector::schema::validate;
use serde_json::{json, Value};

fn fixture_path() -> PathBuf {
    [
        env!("CARGO_MANIFEST_DIR"),
        "tests",
        "fixtures",
        "bridge-roundtrip.jsonl",
    ]
    .iter()
    .collect()
}

#[test]
fn happy_runtime_metrics() {
    let v = json!({
        "type": "runtime.metrics",
        "time": 1714435200.5,
        "open_sessions": 3,
        "ongoing_tasks": 5,
        "queued_tasks": 2,
        "blocked_tasks": 1,
        "code_written_lifetime_loc": 12000,
        "code_modified_lifetime_loc": 4500,
        "files_created_lifetime": 80,
        "files_modified_lifetime": 210,
        "tool_calls_lifetime": 9000,
        "prs_created_lifetime": 14,
        "tests_run_lifetime": 320,
        "tests_passed_rate": 0.94,
        "total_spend_lifetime": 12.75
    });
    validate(&v).expect("runtime.metrics should validate");
}

#[test]
fn happy_tool_call() {
    let v = json!({
        "type": "tool.call", "time": 1.0, "tool": "read_file",
        "payload": { "path": "src/x.ts" },
        "session_id": "s1", "task_id": "t1", "phase": "dispatch"
    });
    validate(&v).expect("tool.call should validate");
}

#[test]
fn happy_hydra_veto() {
    let v = json!({
        "type": "hydra.veto", "time": 1.0,
        "policy": "p", "reason": "r", "action": "a", "severity": "critical",
        "payload": { "file": "x.rs", "line": 42 }
    });
    validate(&v).expect("hydra.veto should validate");
}

#[test]
fn happy_pech_ledger() {
    let v = json!({
        "type": "pech.ledger", "time": 1.0,
        "payload": {
            "input_tokens": 1, "output_tokens": 2,
            "cost_usd": 0.0, "session_cost_usd": 0.0, "daily_cost_usd": 0.0
        }
    });
    validate(&v).expect("pech.ledger should validate");
}

#[test]
fn happy_task_updated() {
    let v = json!({
        "type": "task.updated", "time": 1.0,
        "task_id": "t1", "session_id": "s1", "age_seconds": 42
    });
    validate(&v).expect("task.updated should validate");
}

#[test]
fn happy_code_modified() {
    let v = json!({
        "type": "code.modified", "time": 1.0,
        "file": "x.ts", "lines_added": 5, "lines_removed": 2, "lines_modified": 7
    });
    validate(&v).expect("code.modified should validate");
}

#[test]
fn happy_request_approval() {
    let v = json!({
        "type": "request.approval", "time": 1.0,
        "correlation_id": "cid", "plugin": "trust-pin",
        "reason": "risky", "phase": "trust-gate"
    });
    validate(&v).expect("request.approval should validate");
}

#[test]
fn happy_generic_variant() {
    let v = json!({
        "type": "session.started", "time": 1.0, "session_id": "s1"
    });
    validate(&v).expect("generic variant should validate");
}

#[test]
fn rejects_missing_required() {
    let v = json!({"type": "tool.call", "time": 1.0, "payload": {}});
    assert!(validate(&v).is_err(), "missing tool field");
}

#[test]
fn rejects_wrong_type() {
    let v = json!({
        "type": "code.modified", "time": 1.0,
        "file": "x.ts", "lines_added": "five", "lines_removed": 0, "lines_modified": 5
    });
    assert!(validate(&v).is_err(), "string in numeric field");
}

#[test]
fn rejects_bad_enum_severity() {
    let v = json!({
        "type": "hydra.veto", "time": 1.0,
        "policy": "p", "reason": "r", "action": "a", "severity": "fatal",
        "payload": null
    });
    assert!(validate(&v).is_err(), "severity=fatal not in enum");
}

#[test]
fn rejects_unknown_discriminator() {
    let v = json!({"type": "totally.unknown", "time": 1.0});
    assert!(validate(&v).is_err());
}

#[test]
fn rejects_non_object() {
    let v = Value::String("hello".into());
    assert!(validate(&v).is_err());
}

#[test]
fn fixture_validates_line_by_line() {
    let text = std::fs::read_to_string(fixture_path()).expect("read fixture");
    let mut count = 0;
    for line in text.lines() {
        if line.is_empty() {
            continue;
        }
        let value: Value = serde_json::from_str(line).expect("fixture line is JSON");
        if let Err(err) = validate(&value) {
            panic!(
                "fixture line failed validation: type={:?} reason={} path={}\nline: {}",
                value.get("type"),
                err.reason,
                err.pointer(),
                line,
            );
        }
        count += 1;
    }
    assert!(count > 0, "fixture must have at least one line");
}
