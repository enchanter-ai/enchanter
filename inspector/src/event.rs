//! Wire-format event types for the Enchanter inspector.
//!
//! Events arrive as JSONL over a socket or stdin. The discriminator lives on
//! the `type` field (e.g. `runtime.metrics`, `tool.call`). Variants we have
//! full schemas for are typed precisely; the rest fall back to a tolerant
//! `Generic` shape that flattens unknown payload into a JSON map so the
//! parser keeps making progress when the runtime adds new fields.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Severity ladder shared by veto / review / drift events.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Debug,
    Info,
    Warning,
    High,
    Critical,
}

/// Lifecycle phase of a session, matching the runtime's hook taxonomy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Phase {
    #[serde(rename = "anchor")]
    Anchor,
    #[serde(rename = "trust-gate")]
    TrustGate,
    #[serde(rename = "pre-dispatch")]
    PreDispatch,
    #[serde(rename = "dispatch")]
    Dispatch,
    #[serde(rename = "post-response")]
    PostResponse,
    #[serde(rename = "post-session")]
    PostSession,
    #[serde(rename = "cross-session")]
    CrossSession,
}

/// Token + spend payload for `pech.ledger`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PechLedgerPayload {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cost_usd: f64,
    pub session_cost_usd: f64,
    pub daily_cost_usd: f64,
}

/// Free-form payload for `tool.call`. The runtime attaches arbitrary
/// arguments; we keep it as a JSON value to stay tolerant.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallPayload {
    #[serde(flatten)]
    pub data: BTreeMap<String, serde_json::Value>,
}

/// Common loose-shape body for events whose schema we don't pin.
///
/// Captures the fields that nearly every event carries plus an `extra`
/// catch-all so unknown keys round-trip without loss.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GenericPayload {
    pub time: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugin: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub severity: Option<Severity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// All wire-format events the inspector understands.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Event {
    #[serde(rename = "runtime.metrics")]
    RuntimeMetrics {
        open_sessions: u32,
        ongoing_tasks: u32,
        queued_tasks: u32,
        blocked_tasks: u32,
        code_written_lifetime_loc: u64,
        code_modified_lifetime_loc: u64,
        files_created_lifetime: u64,
        files_modified_lifetime: u64,
        tool_calls_lifetime: u64,
        prs_created_lifetime: u64,
        tests_run_lifetime: u64,
        tests_passed_rate: f64,
        total_spend_lifetime: f64,
        time: f64,
    },

    #[serde(rename = "session.started")]
    SessionStarted(GenericPayload),
    #[serde(rename = "session.opened")]
    SessionOpened(GenericPayload),
    #[serde(rename = "session.closed")]
    SessionClosed(GenericPayload),
    #[serde(rename = "session.ended")]
    SessionEnded(GenericPayload),

    #[serde(rename = "phase.entered")]
    PhaseEntered(GenericPayload),
    #[serde(rename = "phase.completed")]
    PhaseCompleted(GenericPayload),

    #[serde(rename = "plugin.loaded")]
    PluginLoaded(GenericPayload),
    #[serde(rename = "plugin.health")]
    PluginHealth(GenericPayload),

    #[serde(rename = "tool.call")]
    ToolCall {
        tool: String,
        payload: ToolCallPayload,
        time: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        task_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        phase: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        plugin: Option<String>,
    },
    #[serde(rename = "tool.result")]
    ToolResult(GenericPayload),
    #[serde(rename = "tool.error")]
    ToolError(GenericPayload),

    #[serde(rename = "hydra.veto")]
    HydraVeto {
        policy: String,
        reason: String,
        action: String,
        severity: Severity,
        payload: serde_json::Value,
        time: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        plugin: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        phase: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        workspace: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        env: Option<String>,
    },
    #[serde(rename = "sylph.veto")]
    SylphVeto(GenericPayload),

    #[serde(rename = "pech.ledger")]
    PechLedger {
        payload: PechLedgerPayload,
        time: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        task_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        phase: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        plugin: Option<String>,
    },

    #[serde(rename = "crow.trust")]
    CrowTrust(GenericPayload),
    #[serde(rename = "djinn.anchor")]
    DjinnAnchor(GenericPayload),
    #[serde(rename = "djinn.drift")]
    DjinnDrift(GenericPayload),
    #[serde(rename = "gorgon.hotspot")]
    GorgonHotspot(GenericPayload),
    #[serde(rename = "naga.spec_check")]
    NagaSpecCheck(GenericPayload),
    #[serde(rename = "lich.review")]
    LichReview(GenericPayload),
    #[serde(rename = "emu.context_update")]
    EmuContextUpdate(GenericPayload),

    #[serde(rename = "task.created")]
    TaskCreated(GenericPayload),
    #[serde(rename = "task.started")]
    TaskStarted(GenericPayload),
    #[serde(rename = "task.updated")]
    TaskUpdated {
        task_id: String,
        session_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        status: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        intent: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        file_or_area: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        phase: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        risk: Option<String>,
        age_seconds: u64,
        time: f64,
    },
    #[serde(rename = "task.blocked")]
    TaskBlocked(GenericPayload),
    #[serde(rename = "task.completed")]
    TaskCompleted(GenericPayload),
    #[serde(rename = "task.failed")]
    TaskFailed(GenericPayload),

    #[serde(rename = "code.generated")]
    CodeGenerated(GenericPayload),
    #[serde(rename = "code.modified")]
    CodeModified {
        file: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        language: Option<String>,
        lines_added: u32,
        lines_removed: u32,
        lines_modified: u32,
        time: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        task_id: Option<String>,
    },

    #[serde(rename = "file.created")]
    FileCreated(GenericPayload),
    #[serde(rename = "file.modified")]
    FileModified(GenericPayload),

    #[serde(rename = "test.run")]
    TestRun(GenericPayload),
    #[serde(rename = "test.passed")]
    TestPassed(GenericPayload),
    #[serde(rename = "test.failed")]
    TestFailed(GenericPayload),

    #[serde(rename = "pr.created")]
    PrCreated(GenericPayload),

    /// v0.5 #4 — runtime asks the inspector for a human approve/veto on the
    /// trust-gate phase. Carries the `correlation_id` the inspector echoes
    /// back inside an outbound `approval.response`.
    #[serde(rename = "request.approval")]
    RequestApproval {
        correlation_id: String,
        plugin: String,
        reason: String,
        time: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        phase: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        payload: Option<serde_json::Value>,
    },
    /// Catch-all for events whose `type` discriminator isn't in the explicit
    /// list above. The producer (TS bridge) emits many `lifecycle.*`,
    /// `mcp.tool.*`, `*.appended`, `*.fired`, `*.scored` event names that the
    /// Rust enum hasn't enumerated. Without this, `parse_line` would error and
    /// the transport's malformed-line counter would tick on every emit.
    /// Populated by `parse_line` via fallback parse to `GenericPayload` —
    /// never by direct serde dispatch (hence `#[serde(skip)]`).
    #[serde(skip)]
    Unknown(GenericPayload),
}

impl Event {
    /// Wall-clock timestamp the runtime stamped on the event.
    pub fn time(&self) -> f64 {
        match self {
            Event::RuntimeMetrics { time, .. }
            | Event::ToolCall { time, .. }
            | Event::HydraVeto { time, .. }
            | Event::PechLedger { time, .. }
            | Event::TaskUpdated { time, .. }
            | Event::CodeModified { time, .. }
            | Event::RequestApproval { time, .. } => *time,

            Event::Unknown(p) => p.time,

            Event::SessionStarted(p)
            | Event::SessionOpened(p)
            | Event::SessionClosed(p)
            | Event::SessionEnded(p)
            | Event::PhaseEntered(p)
            | Event::PhaseCompleted(p)
            | Event::PluginLoaded(p)
            | Event::PluginHealth(p)
            | Event::ToolResult(p)
            | Event::ToolError(p)
            | Event::SylphVeto(p)
            | Event::CrowTrust(p)
            | Event::DjinnAnchor(p)
            | Event::DjinnDrift(p)
            | Event::GorgonHotspot(p)
            | Event::NagaSpecCheck(p)
            | Event::LichReview(p)
            | Event::EmuContextUpdate(p)
            | Event::TaskCreated(p)
            | Event::TaskStarted(p)
            | Event::TaskBlocked(p)
            | Event::TaskCompleted(p)
            | Event::TaskFailed(p)
            | Event::CodeGenerated(p)
            | Event::FileCreated(p)
            | Event::FileModified(p)
            | Event::TestRun(p)
            | Event::TestPassed(p)
            | Event::TestFailed(p)
            | Event::PrCreated(p) => p.time,
        }
    }

    /// The dotted discriminator string the wire format uses.
    pub fn type_tag(&self) -> &'static str {
        match self {
            Event::RuntimeMetrics { .. } => "runtime.metrics",
            Event::SessionStarted(_) => "session.started",
            Event::SessionOpened(_) => "session.opened",
            Event::SessionClosed(_) => "session.closed",
            Event::SessionEnded(_) => "session.ended",
            Event::PhaseEntered(_) => "phase.entered",
            Event::PhaseCompleted(_) => "phase.completed",
            Event::PluginLoaded(_) => "plugin.loaded",
            Event::PluginHealth(_) => "plugin.health",
            Event::ToolCall { .. } => "tool.call",
            Event::ToolResult(_) => "tool.result",
            Event::ToolError(_) => "tool.error",
            Event::HydraVeto { .. } => "hydra.veto",
            Event::SylphVeto(_) => "sylph.veto",
            Event::PechLedger { .. } => "pech.ledger",
            Event::CrowTrust(_) => "crow.trust",
            Event::DjinnAnchor(_) => "djinn.anchor",
            Event::DjinnDrift(_) => "djinn.drift",
            Event::GorgonHotspot(_) => "gorgon.hotspot",
            Event::NagaSpecCheck(_) => "naga.spec_check",
            Event::LichReview(_) => "lich.review",
            Event::EmuContextUpdate(_) => "emu.context_update",
            Event::TaskCreated(_) => "task.created",
            Event::TaskStarted(_) => "task.started",
            Event::TaskUpdated { .. } => "task.updated",
            Event::TaskBlocked(_) => "task.blocked",
            Event::TaskCompleted(_) => "task.completed",
            Event::TaskFailed(_) => "task.failed",
            Event::CodeGenerated(_) => "code.generated",
            Event::CodeModified { .. } => "code.modified",
            Event::FileCreated(_) => "file.created",
            Event::FileModified(_) => "file.modified",
            Event::TestRun(_) => "test.run",
            Event::TestPassed(_) => "test.passed",
            Event::TestFailed(_) => "test.failed",
            Event::PrCreated(_) => "pr.created",
            Event::RequestApproval { .. } => "request.approval",
            Event::Unknown(_) => "unknown",
        }
    }

    /// Plugin attribution if the event carries one.
    pub fn plugin(&self) -> Option<&str> {
        match self {
            Event::ToolCall { plugin, .. }
            | Event::HydraVeto { plugin, .. }
            | Event::PechLedger { plugin, .. } => plugin.as_deref(),

            Event::RequestApproval { plugin, .. } => Some(plugin.as_str()),

            Event::RuntimeMetrics { .. }
            | Event::TaskUpdated { .. }
            | Event::CodeModified { .. } => None,

            Event::SessionStarted(p)
            | Event::SessionOpened(p)
            | Event::SessionClosed(p)
            | Event::SessionEnded(p)
            | Event::PhaseEntered(p)
            | Event::PhaseCompleted(p)
            | Event::PluginLoaded(p)
            | Event::PluginHealth(p)
            | Event::ToolResult(p)
            | Event::ToolError(p)
            | Event::SylphVeto(p)
            | Event::CrowTrust(p)
            | Event::DjinnAnchor(p)
            | Event::DjinnDrift(p)
            | Event::GorgonHotspot(p)
            | Event::NagaSpecCheck(p)
            | Event::LichReview(p)
            | Event::EmuContextUpdate(p)
            | Event::TaskCreated(p)
            | Event::TaskStarted(p)
            | Event::TaskBlocked(p)
            | Event::TaskCompleted(p)
            | Event::TaskFailed(p)
            | Event::CodeGenerated(p)
            | Event::FileCreated(p)
            | Event::FileModified(p)
            | Event::TestRun(p)
            | Event::TestPassed(p)
            | Event::TestFailed(p)
            | Event::PrCreated(p) => p.plugin.as_deref(),

            Event::Unknown(p) => p.plugin.as_deref(),
        }
    }

    /// Originating session id if the event carries one.
    pub fn session_id(&self) -> Option<&str> {
        match self {
            Event::ToolCall { session_id, .. }
            | Event::HydraVeto { session_id, .. }
            | Event::PechLedger { session_id, .. }
            | Event::CodeModified { session_id, .. }
            | Event::RequestApproval { session_id, .. } => session_id.as_deref(),

            Event::TaskUpdated { session_id, .. } => Some(session_id.as_str()),

            Event::RuntimeMetrics { .. } => None,

            Event::SessionStarted(p)
            | Event::SessionOpened(p)
            | Event::SessionClosed(p)
            | Event::SessionEnded(p)
            | Event::PhaseEntered(p)
            | Event::PhaseCompleted(p)
            | Event::PluginLoaded(p)
            | Event::PluginHealth(p)
            | Event::ToolResult(p)
            | Event::ToolError(p)
            | Event::SylphVeto(p)
            | Event::CrowTrust(p)
            | Event::DjinnAnchor(p)
            | Event::DjinnDrift(p)
            | Event::GorgonHotspot(p)
            | Event::NagaSpecCheck(p)
            | Event::LichReview(p)
            | Event::EmuContextUpdate(p)
            | Event::TaskCreated(p)
            | Event::TaskStarted(p)
            | Event::TaskBlocked(p)
            | Event::TaskCompleted(p)
            | Event::TaskFailed(p)
            | Event::CodeGenerated(p)
            | Event::FileCreated(p)
            | Event::FileModified(p)
            | Event::TestRun(p)
            | Event::TestPassed(p)
            | Event::TestFailed(p)
            | Event::PrCreated(p) => p.session_id.as_deref(),

            Event::Unknown(p) => p.session_id.as_deref(),
        }
    }

    /// Task identifier if the event carries one. Covers the typed
    /// `task_id` fields on tuple variants plus the `task_id` slot in the
    /// shared `GenericPayload`.
    pub fn task_id(&self) -> Option<&str> {
        match self {
            Event::ToolCall { task_id, .. }
            | Event::PechLedger { task_id, .. }
            | Event::CodeModified { task_id, .. } => task_id.as_deref(),

            Event::TaskUpdated { task_id, .. } => Some(task_id.as_str()),

            Event::HydraVeto { .. } | Event::RuntimeMetrics { .. } | Event::RequestApproval { .. } => None,

            Event::SessionStarted(p)
            | Event::SessionOpened(p)
            | Event::SessionClosed(p)
            | Event::SessionEnded(p)
            | Event::PhaseEntered(p)
            | Event::PhaseCompleted(p)
            | Event::PluginLoaded(p)
            | Event::PluginHealth(p)
            | Event::ToolResult(p)
            | Event::ToolError(p)
            | Event::SylphVeto(p)
            | Event::CrowTrust(p)
            | Event::DjinnAnchor(p)
            | Event::DjinnDrift(p)
            | Event::GorgonHotspot(p)
            | Event::NagaSpecCheck(p)
            | Event::LichReview(p)
            | Event::EmuContextUpdate(p)
            | Event::TaskCreated(p)
            | Event::TaskStarted(p)
            | Event::TaskBlocked(p)
            | Event::TaskCompleted(p)
            | Event::TaskFailed(p)
            | Event::CodeGenerated(p)
            | Event::FileCreated(p)
            | Event::FileModified(p)
            | Event::TestRun(p)
            | Event::TestPassed(p)
            | Event::TestFailed(p)
            | Event::PrCreated(p) => p.task_id.as_deref(),

            Event::Unknown(p) => p.task_id.as_deref(),
        }
    }

    /// Severity level if the event carries one.
    pub fn severity(&self) -> Option<Severity> {
        match self {
            Event::HydraVeto { severity, .. } => Some(*severity),

            Event::RuntimeMetrics { .. }
            | Event::ToolCall { .. }
            | Event::PechLedger { .. }
            | Event::TaskUpdated { .. }
            | Event::CodeModified { .. }
            | Event::RequestApproval { .. } => None,

            Event::SessionStarted(p)
            | Event::SessionOpened(p)
            | Event::SessionClosed(p)
            | Event::SessionEnded(p)
            | Event::PhaseEntered(p)
            | Event::PhaseCompleted(p)
            | Event::PluginLoaded(p)
            | Event::PluginHealth(p)
            | Event::ToolResult(p)
            | Event::ToolError(p)
            | Event::SylphVeto(p)
            | Event::CrowTrust(p)
            | Event::DjinnAnchor(p)
            | Event::DjinnDrift(p)
            | Event::GorgonHotspot(p)
            | Event::NagaSpecCheck(p)
            | Event::LichReview(p)
            | Event::EmuContextUpdate(p)
            | Event::TaskCreated(p)
            | Event::TaskStarted(p)
            | Event::TaskBlocked(p)
            | Event::TaskCompleted(p)
            | Event::TaskFailed(p)
            | Event::CodeGenerated(p)
            | Event::FileCreated(p)
            | Event::FileModified(p)
            | Event::TestRun(p)
            | Event::TestPassed(p)
            | Event::TestFailed(p)
            | Event::PrCreated(p) => p.severity,

            Event::Unknown(p) => p.severity,
        }
    }
}

/// Tolerant single-line parser. Bubbles up errors (including unknown
/// discriminants) so the caller can log and skip, never panic.
pub fn parse_line(line: &str) -> anyhow::Result<Event> {
    // Try the strict tagged-enum parse first.
    match serde_json::from_str::<Event>(line) {
        Ok(event) => Ok(event),
        Err(strict_err) => {
            // Fall back to GenericPayload for events whose `type` discriminator
            // isn't in our explicit variant list. The producer emits many event
            // names (`lifecycle.*`, `mcp.tool.*`, `*.appended`, `*.fired`) that
            // we don't model individually but still want to surface in the UI.
            match serde_json::from_str::<GenericPayload>(line) {
                Ok(payload) => Ok(Event::Unknown(payload)),
                Err(_) => Err(anyhow::Error::from(strict_err).context("event parse failed")),
            }
        }
    }
}

#[cfg(test)]
impl Event {
    /// Test helper: produce a `runtime.metrics` event with the given open-session count.
    pub fn sample_runtime_metrics_with_open_sessions(open_sessions: u32) -> Event {
        Event::RuntimeMetrics {
            open_sessions,
            ongoing_tasks: 0,
            queued_tasks: 0,
            blocked_tasks: 0,
            code_written_lifetime_loc: 0,
            code_modified_lifetime_loc: 0,
            files_created_lifetime: 0,
            files_modified_lifetime: 0,
            tool_calls_lifetime: 0,
            prs_created_lifetime: 0,
            tests_run_lifetime: 0,
            tests_passed_rate: 0.0,
            total_spend_lifetime: 0.0,
            time: 0.0,
        }
    }

    /// Test helper: produce a `hydra.veto` event with the given reason.
    pub fn sample_hydra_veto(reason: &str) -> Event {
        Event::HydraVeto {
            policy: "policy".into(),
            reason: reason.into(),
            action: "block".into(),
            severity: Severity::Critical,
            payload: serde_json::Value::Null,
            time: 0.0,
            session_id: None,
            plugin: Some("hydra".into()),
            phase: None,
            workspace: None,
            env: None,
        }
    }

    /// Test helper: produce a no-op event (a `phase.entered` with empty payload).
    pub fn sample_noop() -> Event {
        Event::PhaseEntered(GenericPayload {
            time: 0.0,
            session_id: None,
            task_id: None,
            plugin: None,
            phase: None,
            severity: None,
            message: None,
            extra: BTreeMap::new(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_metrics_roundtrip() {
        let json = r#"{
            "type": "runtime.metrics",
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
            "total_spend_lifetime": 12.75,
            "time": 1714435200.5
        }"#;
        let evt = parse_line(json).expect("parse runtime.metrics");
        assert_eq!(evt.type_tag(), "runtime.metrics");
        assert!((evt.time() - 1714435200.5).abs() < f64::EPSILON);
        match &evt {
            Event::RuntimeMetrics {
                open_sessions,
                tests_passed_rate,
                ..
            } => {
                assert_eq!(*open_sessions, 3);
                assert!((tests_passed_rate - 0.94).abs() < 1e-9);
            }
            _ => panic!("wrong variant"),
        }
        let reser = serde_json::to_string(&evt).unwrap();
        let again: Event = serde_json::from_str(&reser).unwrap();
        assert_eq!(again.type_tag(), "runtime.metrics");
    }

    #[test]
    fn hydra_veto_roundtrip() {
        let json = r#"{
            "type": "hydra.veto",
            "policy": "no-secrets",
            "reason": "API key in diff",
            "action": "block",
            "severity": "critical",
            "payload": {"file": "src/lib.rs", "line": 42},
            "time": 1714435260.0,
            "session_id": "sess-abc",
            "plugin": "hydra",
            "phase": "pre-dispatch",
            "workspace": "/repo",
            "env": "dev"
        }"#;
        let evt = parse_line(json).expect("parse hydra.veto");
        assert_eq!(evt.type_tag(), "hydra.veto");
        assert_eq!(evt.severity(), Some(Severity::Critical));
        assert_eq!(evt.session_id(), Some("sess-abc"));
        assert_eq!(evt.plugin(), Some("hydra"));
        let reser = serde_json::to_string(&evt).unwrap();
        let again: Event = serde_json::from_str(&reser).unwrap();
        assert_eq!(again.severity(), Some(Severity::Critical));
    }

    #[test]
    fn task_updated_roundtrip() {
        let json = r#"{
            "type": "task.updated",
            "task_id": "task-7",
            "session_id": "sess-1",
            "status": "running",
            "intent": "refactor parser",
            "file_or_area": "src/event.rs",
            "phase": "dispatch",
            "risk": "low",
            "age_seconds": 42,
            "time": 1714435300.25
        }"#;
        let evt = parse_line(json).expect("parse task.updated");
        assert_eq!(evt.type_tag(), "task.updated");
        assert_eq!(evt.session_id(), Some("sess-1"));
        match &evt {
            Event::TaskUpdated {
                task_id,
                age_seconds,
                ..
            } => {
                assert_eq!(task_id, "task-7");
                assert_eq!(*age_seconds, 42);
            }
            _ => panic!("wrong variant"),
        }
        let reser = serde_json::to_string(&evt).unwrap();
        let again: Event = serde_json::from_str(&reser).unwrap();
        assert_eq!(again.type_tag(), "task.updated");
    }

    #[test]
    fn unknown_event_type_errors() {
        let json = r#"{"type": "totally.fake", "time": 1.0}"#;
        let result = parse_line(json);
        assert!(result.is_err(), "expected unknown discriminant to error");
    }

    #[test]
    fn pech_ledger_roundtrip() {
        let json = r#"{
            "type": "pech.ledger",
            "payload": {
                "input_tokens": 1200,
                "output_tokens": 340,
                "cost_usd": 0.012,
                "session_cost_usd": 0.45,
                "daily_cost_usd": 3.21
            },
            "time": 1714435400.0,
            "session_id": "sess-x",
            "plugin": "pech"
        }"#;
        let evt = parse_line(json).expect("parse pech.ledger");
        match &evt {
            Event::PechLedger { payload, .. } => {
                assert_eq!(payload.input_tokens, 1200);
                assert!((payload.daily_cost_usd - 3.21).abs() < 1e-9);
            }
            _ => panic!("wrong variant"),
        }
    }
}
