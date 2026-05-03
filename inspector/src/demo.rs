//! Built-in demo event emitter.
//!
//! When `enchanter` is launched with no piped stdin (i.e. directly from a
//! terminal with no event source), this module synthesizes a continuous
//! plausible event stream so the dashboard always shows life. This is not
//! a fixture replay — events are generated on the fly with a tiny LCG PRNG
//! so the only dependency is `serde_json` (already in deps).
//!
//! Events are constructed by JSON literal and fed through the existing
//! `Event` deserializer, so when the wire format changes there is exactly
//! one place that has to keep up.

use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::sync::mpsc::Sender;
use tokio::time::sleep;

use crate::event::Event;

/// Spawn the demo emitter onto the current tokio runtime. It runs forever,
/// pushing events into `tx` at randomized intervals between 300 and 1500 ms.
pub fn spawn_demo_emitter(tx: Sender<Event>) {
    tokio::spawn(async move {
        run(tx).await;
    });
}

async fn run(tx: Sender<Event>) {
    // PRNG: simple LCG seeded from process start nanos.
    let seed = Instant::now().elapsed().subsec_nanos() as u64
        ^ 0x9E37_79B9_7F4A_7C15u64;
    let mut prng = Lcg::new(seed.wrapping_add(1));

    // Wall-clock for synthetic `time` field on events.
    let started = Instant::now();
    let now_secs = |started: Instant| started.elapsed().as_secs_f64();

    // Bootstrap: emit session.started + plugin.loaded for all 10 plugins +
    // a runtime.metrics so the boxes have content immediately.
    let session_id = "demo-001";
    let workspace = "enchanter-inspector";
    let env_label = "local";

    let bootstrap = vec![
        json!({
            "type": "session.started",
            "time": now_secs(started),
            "session_id": session_id,
            "workspace": workspace,
            "env": env_label,
        }),
        json!({"type":"plugin.loaded","time":now_secs(started),"plugin":"pech"}),
        json!({"type":"plugin.loaded","time":now_secs(started),"plugin":"emu"}),
        json!({"type":"plugin.loaded","time":now_secs(started),"plugin":"hydra"}),
        json!({"type":"plugin.loaded","time":now_secs(started),"plugin":"sylph"}),
        json!({"type":"plugin.loaded","time":now_secs(started),"plugin":"lich"}),
        json!({"type":"plugin.loaded","time":now_secs(started),"plugin":"naga"}),
        json!({"type":"plugin.loaded","time":now_secs(started),"plugin":"crow"}),
        json!({"type":"plugin.loaded","time":now_secs(started),"plugin":"djinn"}),
        json!({"type":"plugin.loaded","time":now_secs(started),"plugin":"gorgon"}),
        json!({"type":"plugin.loaded","time":now_secs(started),"plugin":"wixie"}),
        // Initial runtime.metrics so the RUNTIME box is non-zero on first
        // paint instead of waiting ~5–10 cycles before populating.
        json!({
            "type":"runtime.metrics","time":now_secs(started),
            "open_sessions": 3,
            "ongoing_tasks": 5,
            "queued_tasks": 2,
            "blocked_tasks": 0,
            "code_written_lifetime_loc": 42_800u64,
            "code_modified_lifetime_loc": 128_400u64,
            "files_created_lifetime": 86u64,
            "files_modified_lifetime": 312u64,
            "tool_calls_lifetime": 9_400u64,
            "prs_created_lifetime": 18u64,
            "tests_run_lifetime": 2_100u64,
            "tests_passed_rate": 0.94,
            "total_spend_lifetime": 184.2,
        }),
    ];

    for v in bootstrap {
        if let Err(_) = send_value(&tx, v).await {
            return;
        }
    }

    // Stream loop state.
    let mut counter: u64 = 0;
    let mut task_serial: u32 = 104;
    let mut active_tasks: Vec<u32> = Vec::new();
    let mut session_cost: f64 = 0.0;
    let mut daily_cost: f64 = 5.12;
    let mut tool_calls: u64 = 9_400;
    let mut code_written: u64 = 42_800;
    let mut prs: u64 = 18;
    let mut tests_run: u64 = 2_100;
    let mut input_tokens_total: u64 = 0;
    let mut output_tokens_total: u64 = 0;
    let phases = [
        "anchor",
        "trust-gate",
        "pre-dispatch",
        "dispatch",
        "post-response",
        "post-session",
    ];
    let files = ["router.ts", "auth.ts", "billing.ts", "db.ts"];
    let plugin_names = [
        "pech", "emu", "hydra", "sylph", "lich", "naga", "crow", "djinn", "gorgon", "wixie",
    ];

    loop {
        // 1) Sleep a randomized 300–1500 ms before next emit.
        let delay_ms = 300 + (prng.next() % 1201);
        sleep(Duration::from_millis(delay_ms)).await;

        counter = counter.saturating_add(1);
        let t = now_secs(started);

        // 2) Decide what to emit this round.
        let roll = prng.next() % 100;

        // 60% — paired tool.call + tool.result
        if roll < 60 {
            let tool_idx = (prng.next() % 5) as usize;
            let tool = ["read_file", "list_directory", "grep", "edit", "bash"][tool_idx];
            let plugin = plugin_names[(prng.next() as usize) % plugin_names.len()];
            let task_id = if active_tasks.is_empty() {
                format!("T-{}", task_serial)
            } else {
                format!("T-{}", active_tasks[(prng.next() as usize) % active_tasks.len()])
            };
            let phase = phases[(prng.next() as usize) % phases.len()];
            let _ = send_value(
                &tx,
                json!({
                    "type": "tool.call",
                    "time": t,
                    "session_id": session_id,
                    "task_id": task_id,
                    "phase": phase,
                    "plugin": plugin,
                    "tool": tool,
                    "payload": {"path":"src/main.rs"},
                }),
            )
            .await;
            tool_calls = tool_calls.saturating_add(1);

            // tool.result paired right after, slight time bump.
            sleep(Duration::from_millis(40 + (prng.next() % 60))).await;
            let _ = send_value(
                &tx,
                json!({
                    "type": "tool.result",
                    "time": now_secs(started),
                    "session_id": session_id,
                    "task_id": task_id,
                    "plugin": plugin,
                    "tool": tool,
                    "severity": "info",
                }),
            )
            .await;
        }
        // 5% — hydra.veto
        else if roll < 65 {
            let _ = send_value(
                &tx,
                json!({
                    "type": "hydra.veto",
                    "time": t,
                    "session_id": session_id,
                    "plugin": "hydra",
                    "severity": "critical",
                    "policy": "h-rm-rf-root",
                    "reason": "blocked destructive root command",
                    "action": "blocked",
                    "payload": {"command":"rm -rf /","risk":"critical"},
                }),
            )
            .await;
        }
        // 5% — sylph.veto
        else if roll < 70 {
            let _ = send_value(
                &tx,
                json!({
                    "type": "sylph.veto",
                    "time": t,
                    "session_id": session_id,
                    "plugin": "sylph",
                    "severity": "high",
                    "policy": "force-push",
                    "reason": "force push to protected branch",
                    "action": "blocked",
                }),
            )
            .await;
        }
        // 12% — code.modified (rotate files)
        else if roll < 82 {
            let f = files[(prng.next() as usize) % files.len()];
            let _ = send_value(
                &tx,
                json!({
                    "type": "code.modified",
                    "time": t,
                    "session_id": session_id,
                    "file": f,
                    "language": "typescript",
                    "lines_added": (prng.next() % 40) as u32 + 1,
                    "lines_removed": (prng.next() % 20) as u32,
                    "lines_modified": (prng.next() % 15) as u32,
                }),
            )
            .await;
            code_written = code_written.saturating_add(5 + prng.next() % 46);
        }
        // 8% — phase.entered (cycle)
        else if roll < 90 {
            let phase = phases[(counter as usize) % phases.len()];
            let _ = send_value(
                &tx,
                json!({
                    "type": "phase.entered",
                    "time": t,
                    "session_id": session_id,
                    "phase": phase,
                }),
            )
            .await;
        }
        // 10% — sprinkle plugin signal events
        else {
            let pick = prng.next() % 6;
            let value: Value = match pick {
                0 => json!({
                    "type":"crow.trust","time":t,"plugin":"crow","session_id":session_id,
                    "trust_score": 0.7 + (prng.next() % 30) as f64 / 100.0,
                }),
                1 => json!({
                    "type":"djinn.drift","time":t,"plugin":"djinn","session_id":session_id,
                    "drift_score": (prng.next() % 25) as f64 / 100.0,
                }),
                2 => json!({
                    "type":"gorgon.hotspot","time":t,"plugin":"gorgon","session_id":session_id,
                    "file": files[(prng.next() as usize) % files.len()],
                }),
                3 => json!({
                    "type":"naga.spec_check","time":t,"plugin":"naga","session_id":session_id,
                    "status": if prng.next() % 4 == 0 { "drift" } else { "clean" },
                }),
                4 => json!({
                    "type":"lich.review","time":t,"plugin":"lich","session_id":session_id,
                    "severity":"info","message":"review clean",
                }),
                _ => json!({
                    "type":"emu.context_update","time":t,"plugin":"emu","session_id":session_id,
                    "context_size": 10_000 + (prng.next() % 50_000),
                    "turn_estimate": 10 + (prng.next() % 40),
                }),
            };
            let _ = send_value(&tx, value).await;
        }

        // 3) Periodic emissions on counter cadence.

        // Task lifecycle: spin up a new task every 5–10 events.
        if counter % (5 + (prng.next() % 6)) == 0 {
            let id = task_serial;
            task_serial = task_serial.saturating_add(1);
            active_tasks.push(id);
            let intent = ["optimize routing", "fix auth bug", "add tests", "refactor billing"]
                [(prng.next() as usize) % 4];
            let file = files[(prng.next() as usize) % files.len()];
            let _ = send_value(
                &tx,
                json!({
                    "type":"task.created","time":t,"task_id":format!("T-{}", id),
                    "session_id": session_id,"intent": intent,"file_or_area": file,"risk":"low",
                }),
            )
            .await;
        }
        // Update an active task.
        if !active_tasks.is_empty() && counter % 4 == 0 {
            let pick = (prng.next() as usize) % active_tasks.len();
            let id = active_tasks[pick];
            let phase = phases[(prng.next() as usize) % phases.len()];
            let _ = send_value(
                &tx,
                json!({
                    "type":"task.updated","time":t,"task_id": format!("T-{}", id),
                    "session_id": session_id,"status":"running","phase": phase,
                    "intent":"work in progress","file_or_area": files[(prng.next() as usize) % files.len()],
                    "age_seconds": (counter * 3) % 600,
                }),
            )
            .await;
        }
        // Complete the oldest task occasionally.
        if active_tasks.len() > 3 && counter % 7 == 0 {
            let id = active_tasks.remove(0);
            let _ = send_value(
                &tx,
                json!({
                    "type":"task.completed","time":t,"task_id":format!("T-{}", id),
                    "session_id": session_id, "message":"done",
                }),
            )
            .await;
        }

        // pech.ledger every 5–10 events — cumulative cost grows.
        if counter % (5 + (prng.next() % 6)) == 0 {
            let cost = 0.002 + (prng.next() % 50) as f64 / 1000.0;
            session_cost += cost;
            daily_cost += cost;
            let in_t = 800 + prng.next() % 1500;
            let out_t = 200 + prng.next() % 600;
            input_tokens_total = input_tokens_total.saturating_add(in_t);
            output_tokens_total = output_tokens_total.saturating_add(out_t);
            let _ = send_value(
                &tx,
                json!({
                    "type":"pech.ledger","time":t,"session_id": session_id,"plugin":"pech",
                    "payload":{
                        "input_tokens": in_t,
                        "output_tokens": out_t,
                        "cost_usd": cost,
                        "session_cost_usd": session_cost,
                        "daily_cost_usd": daily_cost,
                    }
                }),
            )
            .await;
        }

        // runtime.metrics every 5 events — slowly growing counters.
        // Cadence dropped from 10 to 5 so the RUNTIME box populates quickly
        // on a fresh launch (10 was enough cycles that early-quit users saw
        // zeros on every counter and reported it as a bug).
        if counter % 5 == 0 {
            let ongoing = 5 + (prng.next() % 5);
            tests_run = tests_run.saturating_add(prng.next() % 5);
            if counter % 30 == 0 {
                prs = prs.saturating_add(1);
            }
            let open_sessions = 3u32;
            let queued_tasks = 2u32;
            let blocked_tasks = (counter % 4 == 0) as u32;
            tracing::debug!(
                counter,
                open_sessions,
                ongoing,
                queued_tasks,
                blocked_tasks,
                "demo: emitting runtime.metrics"
            );
            let _ = send_value(
                &tx,
                json!({
                    "type":"runtime.metrics","time":t,
                    "open_sessions": open_sessions,
                    "ongoing_tasks": ongoing,
                    "queued_tasks": queued_tasks,
                    "blocked_tasks": blocked_tasks,
                    "code_written_lifetime_loc": code_written,
                    "code_modified_lifetime_loc": code_written.saturating_mul(3),
                    "files_created_lifetime": 86 + counter / 20,
                    "files_modified_lifetime": 312 + counter / 4,
                    "tool_calls_lifetime": tool_calls,
                    "prs_created_lifetime": prs,
                    "tests_run_lifetime": tests_run,
                    "tests_passed_rate": 0.92 + (prng.next() % 7) as f64 / 100.0,
                    "total_spend_lifetime": 184.2 + session_cost,
                }),
            )
            .await;
        }

        // plugin.health every ~20 events on a rotating plugin.
        if counter % 20 == 0 {
            let p = plugin_names[(counter as usize / 20) % plugin_names.len()];
            let h = 0.7 + (prng.next() % 30) as f64 / 100.0;
            let _ = send_value(
                &tx,
                json!({
                    "type":"plugin.health","time":t,"plugin": p,
                    "status":"healthy","health": h,
                    "latency_p95_ms": (40 + prng.next() % 200) as f64,
                    "latency_p99_ms": (120 + prng.next() % 400) as f64,
                }),
            )
            .await;
        }
    }
}

async fn send_value(tx: &Sender<Event>, value: Value) -> Result<(), ()> {
    match serde_json::from_value::<Event>(value) {
        Ok(ev) => tx.send(ev).await.map_err(|_| ()),
        Err(err) => {
            tracing::warn!(%err, "demo: synthetic event failed to parse");
            Ok(())
        }
    }
}

// ---------------------------------------------------------------------------
// Tiny LCG (Numerical Recipes constants) — no external rand crate.
// ---------------------------------------------------------------------------

struct Lcg {
    state: u64,
}

impl Lcg {
    fn new(seed: u64) -> Self {
        Self {
            state: if seed == 0 { 0xDEAD_BEEFu64 } else { seed },
        }
    }

    fn next(&mut self) -> u64 {
        // Numerical Recipes LCG.
        self.state = self
            .state
            .wrapping_mul(1_664_525)
            .wrapping_add(1_013_904_223);
        self.state >> 16
    }
}
