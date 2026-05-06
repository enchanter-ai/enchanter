//! Central application state for the Enchanter inspector TUI.
//!
//! `AppState` is the single source of truth shared by the event loop, the
//! input handlers (`&mut AppState`) and the view renderers (`&AppState`).
//! All sub-state structs derive `Debug + Clone` so views can cheaply snapshot
//! what they need.

use crate::event::{Event, Severity};
use std::collections::VecDeque;

/// Best-effort string field extraction from a `GenericPayload.extra` map.
fn payload_str(
    extra: &std::collections::BTreeMap<String, serde_json::Value>,
    key: &str,
) -> Option<String> {
    extra.get(key).and_then(|v| v.as_str()).map(|s| s.to_string())
}

fn payload_f32(
    extra: &std::collections::BTreeMap<String, serde_json::Value>,
    key: &str,
) -> Option<f32> {
    extra.get(key).and_then(|v| v.as_f64()).map(|f| f as f32)
}

fn parse_task_status(s: Option<&str>) -> Option<TaskStatus> {
    let s = s?.to_ascii_lowercase();
    match s.as_str() {
        "queued" => Some(TaskStatus::Queued),
        "running" => Some(TaskStatus::Running),
        "waiting_tool" | "waiting-tool" | "waiting tool" => Some(TaskStatus::WaitingTool),
        "waiting_review" | "waiting-review" | "waiting review" => Some(TaskStatus::WaitingReview),
        "blocked" => Some(TaskStatus::Blocked),
        "failed" => Some(TaskStatus::Failed),
        "completed" | "done" => Some(TaskStatus::Completed),
        _ => None,
    }
}

/// Best-effort "what phase is this event in" extraction off any event shape.
/// Reads the typed `phase` field where present, otherwise digs into the
/// generic payload's `phase` slot. Unknown variants carry the field on
/// `GenericPayload` directly.
fn generic_phase(ev: &Event) -> Option<String> {
    use crate::event::Event as E;
    match ev {
        E::ToolCall { phase, .. }
        | E::HydraVeto { phase, .. }
        | E::PechLedger { phase, .. }
        | E::RequestApproval { phase, .. } => phase.clone(),
        E::TaskUpdated { phase, .. } => phase.clone(),
        E::SessionStarted(p)
        | E::SessionOpened(p)
        | E::SessionClosed(p)
        | E::SessionEnded(p)
        | E::PhaseEntered(p)
        | E::PhaseCompleted(p)
        | E::PluginLoaded(p)
        | E::PluginHealth(p)
        | E::ToolResult(p)
        | E::ToolError(p)
        | E::SylphVeto(p)
        | E::CrowTrust(p)
        | E::DjinnAnchor(p)
        | E::DjinnDrift(p)
        | E::GorgonHotspot(p)
        | E::NagaSpecCheck(p)
        | E::LichReview(p)
        | E::EmuContextUpdate(p)
        | E::TaskCreated(p)
        | E::TaskStarted(p)
        | E::TaskBlocked(p)
        | E::TaskCompleted(p)
        | E::TaskFailed(p)
        | E::CodeGenerated(p)
        | E::FileCreated(p)
        | E::FileModified(p)
        | E::TestRun(p)
        | E::TestPassed(p)
        | E::TestFailed(p)
        | E::PrCreated(p)
        | E::Unknown(p) => p.phase.clone(),
        E::RuntimeMetrics { .. } | E::CodeModified { .. } => None,
    }
}

fn parse_phase(s: &str) -> Option<crate::event::Phase> {
    use crate::event::Phase;
    match s {
        "anchor" => Some(Phase::Anchor),
        "trust-gate" => Some(Phase::TrustGate),
        "pre-dispatch" => Some(Phase::PreDispatch),
        "dispatch" => Some(Phase::Dispatch),
        "post-response" => Some(Phase::PostResponse),
        "post-session" => Some(Phase::PostSession),
        "cross-session" => Some(Phase::CrossSession),
        _ => None,
    }
}

fn parse_plugin_status(s: Option<&str>) -> Option<PluginStatus> {
    let s = s?.to_ascii_lowercase();
    match s.as_str() {
        "healthy" | "ok" => Some(PluginStatus::Healthy),
        "warning" | "warn" => Some(PluginStatus::Warning),
        "error" | "critical" => Some(PluginStatus::Error),
        "disabled" | "off" => Some(PluginStatus::Disabled),
        _ => None,
    }
}

/// Maximum number of events held in the in-memory ring buffer.
pub const EVENT_RING_CAPACITY: usize = 2000;
/// Number of samples retained per plugin sparkline.
pub const SPARKLINE_HISTORY: usize = 24;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum View {
    Overview,
    Plugins,
    EventTrace,
    Security,
    Cost,
    Drift,
    Codebase,
    SessionReplay,
    RuntimeTotals,
    ActiveTasks,
}

impl View {
    /// Ordered list of views used by next/prev cycling.
    pub const ALL: [View; 10] = [
        View::Overview,
        View::Plugins,
        View::EventTrace,
        View::Security,
        View::Cost,
        View::Drift,
        View::Codebase,
        View::SessionReplay,
        View::RuntimeTotals,
        View::ActiveTasks,
    ];
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Panel {
    Plugins,
    Events,
    Health,
    Insights,
    Tasks,
    Detail,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SortMode {
    Default,
    ByTime,
    ByPlugin,
    BySeverity,
    ByCost,
}

impl SortMode {
    /// Cycle through sort modes in declared order.
    pub fn next(self) -> Self {
        match self {
            SortMode::Default => SortMode::ByTime,
            SortMode::ByTime => SortMode::ByPlugin,
            SortMode::ByPlugin => SortMode::BySeverity,
            SortMode::BySeverity => SortMode::ByCost,
            SortMode::ByCost => SortMode::Default,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PluginStatus {
    Healthy,
    Warning,
    Error,
    Disabled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskStatus {
    Queued,
    Running,
    WaitingTool,
    WaitingReview,
    Blocked,
    Failed,
    Completed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Risk {
    Low,
    Medium,
    High,
    Critical,
}

#[derive(Debug, Clone)]
pub struct PluginState {
    pub name: String,
    pub status: PluginStatus,
    pub color: ratatui::style::Color,
    pub enabled: bool,
    pub health: f32,
    pub last_event: Option<f64>,
    pub calls: u64,
    pub errors: u64,
    pub latency_p95_ms: f32,
    pub latency_p99_ms: f32,
    pub display_value: String,
    pub usage_series: VecDeque<u64>,
}

impl PluginState {
    fn new(name: &str, color: ratatui::style::Color) -> Self {
        Self {
            name: name.into(),
            status: PluginStatus::Healthy,
            color,
            enabled: true,
            health: 1.0,
            last_event: None,
            calls: 0,
            errors: 0,
            latency_p95_ms: 0.0,
            latency_p99_ms: 0.0,
            display_value: "—".into(),
            usage_series: VecDeque::with_capacity(SPARKLINE_HISTORY),
        }
    }

    fn push_usage(&mut self, sample: u64) {
        if self.usage_series.len() == SPARKLINE_HISTORY {
            self.usage_series.pop_front();
        }
        self.usage_series.push_back(sample);
    }
}

#[derive(Debug, Clone)]
pub struct MetricState {
    pub turns: (u32, u32),
    pub spent_session_usd: f64,
    pub spend_rate_per_hour_usd: f64,
    pub security_incidents_session: u32,
    pub drift_session_pct: f32,
    pub p99_latency_ms: f32,
    pub p95_latency_ms: f32,
    pub events_count: u64,
}

impl Default for MetricState {
    fn default() -> Self {
        Self {
            turns: (0, 0),
            spent_session_usd: 0.0,
            spend_rate_per_hour_usd: 0.0,
            security_incidents_session: 0,
            drift_session_pct: 0.0,
            p99_latency_ms: 0.0,
            p95_latency_ms: 0.0,
            events_count: 0,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct RuntimeMetricState {
    pub open_sessions: u32,
    pub ongoing_tasks: u32,
    pub queued_tasks: u32,
    pub blocked_tasks: u32,
    pub code_written_lifetime_loc: u64,
    pub code_modified_lifetime_loc: u64,
    pub files_created_lifetime: u64,
    pub files_modified_lifetime: u64,
    pub tool_calls_lifetime: u64,
    pub prs_created_lifetime: u64,
    pub tests_run_lifetime: u64,
    pub tests_passed_rate: f32,
    pub successful_tasks_lifetime: u64,
    pub failed_tasks_lifetime: u64,
    pub vetoes_lifetime: u64,
    pub total_spend_lifetime_usd: f64,
}

#[derive(Debug, Clone, Default)]
pub struct HealthState {
    pub cpu_pct: f32,
    pub memory_pct: f32,
    pub event_loop_ms: f32,
    pub disk_io_mbps: f32,
    pub network_mbps: f32,
}

#[derive(Debug, Clone)]
pub struct BudgetState {
    pub daily_spend_usd: f64,
    pub daily_limit_usd: f64,
    pub context_tokens: u64,
    pub context_limit_tokens: u64,
}

impl Default for BudgetState {
    fn default() -> Self {
        Self {
            daily_spend_usd: 0.0,
            daily_limit_usd: 50.0,
            context_tokens: 0,
            context_limit_tokens: 200_000,
        }
    }
}

#[derive(Debug, Clone)]
pub struct SessionState {
    pub workspace: String,
    pub env: String,
    pub github_user: String,
    pub claude_user: String,
    /// Pretty-printed Claude subscription tier — "Pro" / "Max" / "Team" /
    /// "Enterprise" / "Free" / "Unknown". Detected at startup from
    /// `~/.claude.json` (`oauthAccount.organizationType`).
    pub claude_plan: String,
    /// Sum of `usage.input_tokens + cache_creation_input_tokens +
    /// cache_read_input_tokens + output_tokens` across all assistant turns
    /// in the last 24 hours, summed across every project's session JSONL.
    /// Populated lazily by `detect_claude_usage_today` so AppState
    /// construction stays cheap.
    pub claude_tokens_today: u64,
    /// Count of assistant turns observed in the same 24-hour window.
    pub claude_messages_today: u64,
    pub session_id: String,
    pub uptime_seconds: u64,
    pub pending_count: u32,
    pub current_phase: Option<crate::event::Phase>,
    pub active_task_id: Option<String>,
}

impl Default for SessionState {
    fn default() -> Self {
        Self {
            workspace: String::new(),
            env: String::new(),
            github_user: String::new(),
            claude_user: String::new(),
            claude_plan: detect_claude_plan(),
            claude_tokens_today: 0,
            claude_messages_today: 0,
            session_id: String::new(),
            uptime_seconds: 0,
            pending_count: 0,
            current_phase: None,
            active_task_id: None,
        }
    }
}

/// Best-effort detection of the current user's email or username. Tries
/// `git config user.email`, then `$USER` / `$USERNAME`, then `"unknown"`.
pub fn detect_user() -> String {
    use std::process::Command;
    if let Ok(output) = Command::new("git")
        .args(["config", "user.email"])
        .output()
    {
        if output.status.success() {
            let s = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !s.is_empty() {
                return s;
            }
        }
    }
    if let Ok(u) = std::env::var("USER") {
        if !u.is_empty() {
            return u;
        }
    }
    if let Ok(u) = std::env::var("USERNAME") {
        if !u.is_empty() {
            return u;
        }
    }
    "unknown".to_string()
}

/// Best-effort detection of the GitHub login. Tries `gh api user --jq .login`,
/// then `git config user.name`, then `"unknown"`.
pub fn detect_github_user() -> String {
    use std::process::Command;
    if let Ok(output) = Command::new("gh")
        .args(["api", "user", "--jq", ".login"])
        .output()
    {
        if output.status.success() {
            let s = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !s.is_empty() {
                return s;
            }
        }
    }
    if let Ok(output) = Command::new("git")
        .args(["config", "user.name"])
        .output()
    {
        if output.status.success() {
            let s = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !s.is_empty() {
                return s;
            }
        }
    }
    "unknown".to_string()
}

/// Best-effort detection of the Claude Code account identifier.
///
/// Resolution order (returns the first that yields a non-empty value):
///   1. `~/.claude/.credentials.json` — JWT `id_token` middle segment, decoded
///      and scanned for `email` / `preferred_username` / `sub`.
///   2. `~/.claude/.credentials.json` — tolerant key-walk for any plausible
///      identity field (email, login, etc.).
///   3. `~/.claude/settings.json` — same tolerant key-walk.
///   4. Recursive scan of `~/.claude/projects/*/memory/MEMORY.md`
///      (3 most-recent project dirs by mtime) for an `# userEmail` line or
///      any embedded email-shaped token.
///   5. `$ANTHROPIC_USER` env var.
///   6. `"unknown"`. We deliberately do NOT fall back to OS user — the OS
///      logon name is misleading and the user complained about that.
pub fn detect_claude_user() -> String {
    let home = std::env::var("HOME")
        .ok()
        .or_else(|| std::env::var("USERPROFILE").ok());

    if let Some(home) = home.as_deref() {
        let home_path = std::path::Path::new(home);
        let claude = home_path.join(".claude");

        // 1: ~/.claude.json — Claude Code's main config; the `oauthAccount`
        // block stamps the logged-in account email here. This is the most
        // reliable single source on a real machine, so probe it first.
        let dotclaudejson = home_path.join(".claude.json");
        if let Ok(bytes) = std::fs::read(&dotclaudejson) {
            if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                if let Some(s) = find_user_string(&value) {
                    return s;
                }
            }
        }

        // 2 + 3: credentials.json — JWT first, then tolerant key walk.
        let creds = claude.join(".credentials.json");
        if let Ok(bytes) = std::fs::read(&creds) {
            if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                if let Some(s) = find_jwt_email(&value) {
                    return s;
                }
                if let Some(s) = find_user_string(&value) {
                    return s;
                }
            }
        }

        // 4: settings.json
        let settings = claude.join("settings.json");
        if let Ok(bytes) = std::fs::read(&settings) {
            if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                if let Some(s) = find_user_string(&value) {
                    return s;
                }
            }
        }

        // 5: per-project MEMORY.md scan, 3 most-recent.
        let projects = claude.join("projects");
        if let Some(s) = scan_memory_for_email(&projects, 3) {
            return s;
        }
    }

    // 5: ANTHROPIC_USER env var.
    if let Ok(u) = std::env::var("ANTHROPIC_USER") {
        if !u.is_empty() {
            return u;
        }
    }

    // 6: deliberate fallback. NOT OS user — the Windows logon name is
    // misleading for a Claude account display.
    "unknown".to_string()
}

/// Walk a JSON value looking for an email-like or user-name field. Returns
/// the first plausible match in BFS order. Tolerant of unknown shapes.
fn find_user_string(v: &serde_json::Value) -> Option<String> {
    use serde_json::Value;
    // First pass: look for keys that strongly imply identity.
    const KEYS: &[&str] = &["emailAddress", "email", "user_email", "account_email", "preferred_username", "login", "user", "username", "name", "account", "subject"];
    fn walk(v: &Value, keys: &[&str]) -> Option<String> {
        match v {
            Value::Object(map) => {
                for k in keys {
                    if let Some(Value::String(s)) = map.get(*k) {
                        let trimmed = s.trim();
                        if !trimmed.is_empty() {
                            return Some(trimmed.to_string());
                        }
                    }
                }
                for (_, child) in map {
                    if let Some(s) = walk(child, keys) {
                        return Some(s);
                    }
                }
                None
            }
            Value::Array(arr) => {
                for child in arr {
                    if let Some(s) = walk(child, keys) {
                        return Some(s);
                    }
                }
                None
            }
            _ => None,
        }
    }
    walk(v, KEYS)
}

/// Scan a JSON value for any string field that looks like a JWT
/// (three base64url segments separated by dots), decode the middle segment,
/// and pull `email` / `preferred_username` / `sub` from the resulting JSON.
fn find_jwt_email(v: &serde_json::Value) -> Option<String> {
    use serde_json::Value;
    fn walk(v: &Value) -> Option<String> {
        match v {
            Value::String(s) if looks_like_jwt(s) => decode_jwt_email(s),
            Value::Object(map) => {
                // Prefer keys whose name suggests a token first.
                for key in ["id_token", "idToken", "access_token", "accessToken"] {
                    if let Some(Value::String(s)) = map.get(key) {
                        if let Some(found) = decode_jwt_email(s) {
                            return Some(found);
                        }
                    }
                }
                for (_, child) in map {
                    if let Some(found) = walk(child) {
                        return Some(found);
                    }
                }
                None
            }
            Value::Array(arr) => arr.iter().find_map(walk),
            _ => None,
        }
    }
    walk(v)
}

fn looks_like_jwt(s: &str) -> bool {
    let parts: Vec<&str> = s.split('.').collect();
    parts.len() == 3
        && parts.iter().all(|p| !p.is_empty())
        && s.chars().all(|c| {
            c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' || c == '='
        })
}

/// Decode a JWT and pull an email-shaped identity field from its payload.
fn decode_jwt_email(token: &str) -> Option<String> {
    let mid = token.split('.').nth(1)?;
    let bytes = b64url_decode(mid).ok()?;
    let json: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    for key in ["email", "preferred_username", "upn", "sub"] {
        if let Some(s) = json.get(key).and_then(|v| v.as_str()) {
            let s = s.trim();
            if !s.is_empty() {
                return Some(s.to_string());
            }
        }
    }
    None
}

/// Tiny base64url decoder (no padding required). Keeps the dep footprint flat
/// — `serde_json` doesn't ship base64 and we don't want a fresh top-level dep
/// for a 30-line decoder.
fn b64url_decode(input: &str) -> Result<Vec<u8>, ()> {
    // Translate base64url → standard alphabet, strip padding/whitespace, then
    // re-pad to a multiple of 4 with '='.
    let mut s: String = input
        .chars()
        .filter(|c| *c != '=' && !c.is_whitespace())
        .map(|c| match c {
            '-' => '+',
            '_' => '/',
            other => other,
        })
        .collect();
    while s.len() % 4 != 0 {
        s.push('=');
    }

    fn val(c: u8) -> Result<u8, ()> {
        match c {
            b'A'..=b'Z' => Ok(c - b'A'),
            b'a'..=b'z' => Ok(c - b'a' + 26),
            b'0'..=b'9' => Ok(c - b'0' + 52),
            b'+' => Ok(62),
            b'/' => Ok(63),
            _ => Err(()),
        }
    }

    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    for chunk in bytes.chunks(4) {
        if chunk.len() < 4 {
            return Err(());
        }
        let mut quad = [0u8; 4];
        let mut pad = 0usize;
        for (i, &b) in chunk.iter().enumerate() {
            if b == b'=' {
                pad += 1;
                quad[i] = 0;
            } else {
                quad[i] = val(b)?;
            }
        }
        let n = ((quad[0] as u32) << 18)
            | ((quad[1] as u32) << 12)
            | ((quad[2] as u32) << 6)
            | (quad[3] as u32);
        out.push(((n >> 16) & 0xFF) as u8);
        if pad < 2 {
            out.push(((n >> 8) & 0xFF) as u8);
        }
        if pad < 1 {
            out.push((n & 0xFF) as u8);
        }
    }
    Ok(out)
}

/// Scan the most-recently-modified `take` project dirs under `projects_root`
/// for a `memory/MEMORY.md` containing an `# userEmail` heading or any
/// email-shaped token. The first plausible email wins.
fn scan_memory_for_email(projects_root: &std::path::Path, take: usize) -> Option<String> {
    let dir = std::fs::read_dir(projects_root).ok()?;
    let mut entries: Vec<(std::time::SystemTime, std::path::PathBuf)> = dir
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let path = e.path();
            if !path.is_dir() {
                return None;
            }
            let mtime = e
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(std::time::UNIX_EPOCH);
            Some((mtime, path))
        })
        .collect();
    entries.sort_by(|a, b| b.0.cmp(&a.0));

    for (_, dir) in entries.into_iter().take(take) {
        let memory = dir.join("memory").join("MEMORY.md");
        let Ok(text) = std::fs::read_to_string(&memory) else {
            continue;
        };
        // Walk lines: prefer the line right after a `# userEmail` heading.
        let mut after_heading = false;
        for line in text.lines() {
            if after_heading {
                if let Some(addr) = first_email_in(line) {
                    return Some(addr);
                }
                // The heading's "value" can also be on the same line further
                // down; try a couple of follow-up lines before resetting.
            }
            if line.trim().eq_ignore_ascii_case("# userEmail") {
                after_heading = true;
                continue;
            }
            // Fallback: any email-shaped token in any line counts.
            if let Some(addr) = first_email_in(line) {
                return Some(addr);
            }
        }
    }
    None
}

/// Tiny ad-hoc email matcher: scan for the first run that satisfies
/// `local@domain.tld`. Mirrors the regex
/// `[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}` without pulling `regex` in.
fn first_email_in(s: &str) -> Option<String> {
    fn is_local(c: char) -> bool {
        c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '%' | '+' | '-')
    }
    fn is_domain(c: char) -> bool {
        c.is_ascii_alphanumeric() || c == '.' || c == '-'
    }
    let bytes: Vec<char> = s.chars().collect();
    let n = bytes.len();
    let mut i = 0;
    while i < n {
        if bytes[i] == '@' {
            // Walk back to find local-part start.
            let mut start = i;
            while start > 0 && is_local(bytes[start - 1]) {
                start -= 1;
            }
            // Walk forward to find domain end.
            let mut end = i + 1;
            while end < n && is_domain(bytes[end]) {
                end += 1;
            }
            if start < i && end > i + 1 {
                let candidate: String = bytes[start..end].iter().collect();
                // Need at least one dot in the domain part with a 2+ TLD.
                if let Some(dot) = candidate.rfind('.') {
                    let tld = &candidate[dot + 1..];
                    if tld.len() >= 2 && tld.chars().all(|c| c.is_ascii_alphabetic()) {
                        return Some(candidate);
                    }
                }
            }
            i = end;
        } else {
            i += 1;
        }
    }
    None
}

/// Tracing-log file size in **bytes**. Looks at `~/.cache/enchanter/inspector.log`
/// (and the Windows-equivalents `%LOCALAPPDATA%\enchanter\inspector.log`,
/// `%USERPROFILE%\.cache\enchanter\inspector.log`). Returns 0 when none exist
/// or metadata is unreadable. Cheap enough to call on a tick refresh — pure
/// metadata read, no scan. Skips paths that resolve to directories so the
/// formatter doesn't have to deal with platform-dependent dir-size values.
pub fn tracing_log_size_bytes() -> u64 {
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(home) = std::env::var("HOME") {
        candidates.push(
            std::path::Path::new(&home)
                .join(".cache")
                .join("enchanter")
                .join("inspector.log"),
        );
    }
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        candidates.push(
            std::path::Path::new(&local)
                .join("enchanter")
                .join("inspector.log"),
        );
    }
    if let Ok(profile) = std::env::var("USERPROFILE") {
        candidates.push(
            std::path::Path::new(&profile)
                .join(".cache")
                .join("enchanter")
                .join("inspector.log"),
        );
    }
    for path in candidates {
        if let Ok(meta) = std::fs::metadata(&path) {
            if meta.is_file() {
                return meta.len();
            }
        }
    }
    0
}

/// Best-effort current-workspace name: basename of the current working
/// directory. Falls back to `"workspace"` on any error.
pub fn detect_workspace() -> String {
    std::env::current_dir()
        .ok()
        .and_then(|p| p.file_name().map(|s| s.to_string_lossy().to_string()))
        .unwrap_or_else(|| "workspace".to_string())
}

/// Best-effort current-workspace name from Claude Code's actual cwd.
///
/// Scans `~/.claude/projects/*/*.jsonl` for the most-recently-modified
/// transcript file, then walks up to the first 50 lines looking for the
/// first record that carries a top-level string `cwd` field — typically a
/// `user`-type record a few lines into the transcript. The first match
/// wins (most representative — that's the cwd at the start of the
/// session). Falls back to decoding the project-slug-encoded directory
/// path, then to `detect_workspace()`. Hard-capped at 100 ms wall-clock
/// so startup isn't held up by a flaky filesystem.
pub fn detect_claude_workspace() -> String {
    use std::io::{BufRead, BufReader};
    use std::time::{Duration, Instant};

    let started = Instant::now();
    let budget = Duration::from_millis(100);

    let home = std::env::var("HOME")
        .ok()
        .or_else(|| std::env::var("USERPROFILE").ok());
    let Some(home) = home else { return detect_workspace() };
    let projects = std::path::Path::new(&home).join(".claude").join("projects");
    let Ok(project_iter) = std::fs::read_dir(&projects) else { return detect_workspace() };

    // Collect (mtime, jsonl path) for every transcript, then pick the freshest.
    let mut newest: Option<(std::time::SystemTime, std::path::PathBuf, std::path::PathBuf)> = None;
    'outer: for project_entry in project_iter.flatten() {
        if started.elapsed() >= budget {
            break;
        }
        let project_path = project_entry.path();
        if !project_path.is_dir() {
            continue;
        }
        let Ok(file_iter) = std::fs::read_dir(&project_path) else { continue };
        for file_entry in file_iter.flatten() {
            if started.elapsed() >= budget {
                break 'outer;
            }
            let file_path = file_entry.path();
            if file_path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
                continue;
            }
            let Ok(meta) = file_entry.metadata() else { continue };
            let Ok(mtime) = meta.modified() else { continue };
            let take = match &newest {
                Some((cur, _, _)) => mtime > *cur,
                None => true,
            };
            if take {
                newest = Some((mtime, file_path, project_path.clone()));
            }
        }
    }

    let Some((_, jsonl, project_dir)) = newest else { return detect_workspace() };

    // The first ~3 lines of a Claude transcript are typically queue-operation
    // records that don't carry `cwd`; the field shows up on the first `user`
    // record a few lines in. Walk up to 50 lines and take the first match.
    if let Ok(file) = std::fs::File::open(&jsonl) {
        let reader = BufReader::new(file);
        for line in reader.lines().map_while(Result::ok).take(50) {
            if started.elapsed() >= budget {
                break;
            }
            if line.is_empty() {
                continue;
            }
            // Tolerant: skip lines that fail to parse or lack a string `cwd`.
            let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            let Some(cwd) = value.get("cwd").and_then(|v| v.as_str()) else {
                continue;
            };
            // Strip trailing path separators before extracting basename so
            // "C:\foo\bar\" still yields "bar".
            let trimmed = cwd.trim_end_matches(|c| c == '/' || c == '\\');
            if trimmed.is_empty() {
                continue;
            }
            if let Some(base) = std::path::Path::new(trimmed)
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
            {
                if !base.is_empty() {
                    return base;
                }
            }
        }
    }

    // Fallback: project-dir name is a slug-encoded version of the cwd
    // (e.g. `C--git-enchanter-inspector` for `C:/git/enchanter-inspector`).
    // Take the slug's last `-`-separated segment as a best-effort basename.
    if let Some(slug) = project_dir.file_name().and_then(|s| s.to_str()) {
        if let Some(last) = slug.rsplit('-').next() {
            if !last.is_empty() {
                return last.to_string();
            }
        }
    }

    detect_workspace()
}

/// Wall-clock time the inspector binary started. Set once by `app::run`.
/// Reads return `None` until then.
pub static STARTED_AT: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();

/// Process uptime in whole seconds since `STARTED_AT` was initialized.
/// Returns 0 when uninitialized so callers don't have to guard `Option`.
pub fn process_uptime_seconds() -> u64 {
    STARTED_AT
        .get()
        .map(|t| t.elapsed().as_secs())
        .unwrap_or(0)
}

/// Best-effort env label: `$ENCHANTER_ENV` or `"local"`.
pub fn detect_env() -> String {
    std::env::var("ENCHANTER_ENV").unwrap_or_else(|_| "local".to_string())
}

/// Pending human-in-the-loop approval (v0.5 #4). Pushed onto
/// `AppState::pending_approvals` when a `request.approval` event arrives;
/// popped when the user keys `a` or `v` in the active view.
#[derive(Debug, Clone)]
pub struct PendingApproval {
    pub correlation_id: String,
    pub plugin: String,
    pub reason: String,
    pub phase: Option<String>,
    pub session_id: Option<String>,
    pub received_at: f64,
}

#[derive(Debug, Clone)]
pub struct TaskState {
    pub task_id: String,
    pub session_id: String,
    pub status: TaskStatus,
    pub intent: String,
    pub file_or_area: String,
    pub phase: Option<crate::event::Phase>,
    pub risk: Risk,
    pub age_seconds: u64,
    pub created_at: f64,
    pub updated_at: f64,
    pub blocked_reason: Option<String>,
}

#[derive(Debug, Clone)]
pub struct AppState {
    pub running: bool,
    pub paused: bool,
    pub active_view: View,
    pub active_panel: Panel,
    pub selected_event_index: usize,
    pub selected_plugin_index: usize,
    pub selected_task_index: usize,
    pub filter_query: String,
    pub sort_mode: SortMode,
    pub events: VecDeque<Event>,
    pub plugins: Vec<PluginState>,
    pub metrics: MetricState,
    pub runtime_metrics: RuntimeMetricState,
    pub health: HealthState,
    pub budgets: BudgetState,
    pub session: SessionState,
    pub tasks: Vec<TaskState>,
    pub insights: Vec<String>,
    pub started_at: chrono::DateTime<chrono::Utc>,
    /// Monotonic UI tick counter — bumped on every event-loop tick by
    /// `app::run`. Renderers consume it for animations (e.g. pulsing LIVE).
    pub tick: u64,
    /// True when the inspector launched into the built-in demo emitter
    /// (no real event source on stdin / file / socket).
    pub demo_mode: bool,
    /// v0.5 #4 — outstanding approval requests from the runtime, ordered
    /// newest-first (most recent push goes to position 0). The active view's
    /// banner shows the head; `a` / `v` keys consume head and serialize a
    /// response over the bidirectional control channel.
    pub pending_approvals: VecDeque<PendingApproval>,
}

impl AppState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Find a plugin by case-insensitive name prefix match (e.g. "hydra"
    /// matches `PluginState { name: "hydra", .. }`). Returns `None` when no
    /// plugin matches.
    fn plugin_index_by_name(&self, name: &str) -> Option<usize> {
        let needle = name.to_ascii_lowercase();
        self.plugins
            .iter()
            .position(|p| p.name.to_ascii_lowercase() == needle)
    }

    fn upsert_task(&mut self, task: TaskState) {
        if let Some(slot) = self.tasks.iter_mut().find(|t| t.task_id == task.task_id) {
            *slot = task;
        } else {
            self.tasks.push(task);
        }
    }

    fn push_event(&mut self, ev: Event) {
        if self.events.len() == EVENT_RING_CAPACITY {
            self.events.pop_front();
        }
        self.events.push_back(ev);
        self.metrics.events_count = self.metrics.events_count.saturating_add(1);
    }

    /// Set a plugin's display value by name. No-op when plugin not found.
    fn set_plugin_display(&mut self, name: &str, value: String) {
        if let Some(idx) = self.plugin_index_by_name(name) {
            self.plugins[idx].display_value = value;
        }
    }

    /// Push a sample into a plugin's usage series by name.
    fn push_plugin_usage(&mut self, name: &str, sample: u64) {
        if let Some(idx) = self.plugin_index_by_name(name) {
            self.plugins[idx].push_usage(sample);
        }
    }

    /// Synthesize plausible system-health values from event volume.
    fn synthesize_health(&mut self) {
        // Memory: ring-buffer fill ratio.
        self.health.memory_pct =
            (self.events.len() as f32 / EVENT_RING_CAPACITY as f32) * 100.0;

        // CPU + event-loop ms: derived from interarrival times of the most
        // recent up-to-50 events.
        let n = self.events.len().min(50);
        if n >= 2 {
            let take = self.events.len() - n;
            let recent: Vec<f64> = self
                .events
                .iter()
                .skip(take)
                .map(|e| e.time())
                .collect();
            let span = (recent.last().copied().unwrap_or(0.0)
                - recent.first().copied().unwrap_or(0.0))
                .max(0.0);
            let events_per_sec = if span > 0.0 {
                (n as f64) / span
            } else {
                n as f64
            };
            // CPU synthesis: events-per-second normalized against a 100/s
            // throughput target, capped at 80% so a burst doesn't make the
            // cockpit lie about being saturated. TODO: replace with real
            // process-CPU once a tokio-metrics integration lands.
            self.health.cpu_pct =
                ((events_per_sec as f32 / 100.0).clamp(0.0, 0.8) * 100.0).max(0.0);

            // Average interarrival in milliseconds.
            let avg_ms = if n > 1 {
                (span * 1000.0) / ((n - 1) as f64)
            } else {
                0.0
            };
            self.health.event_loop_ms = avg_ms as f32;
        }

        // Static plausible values for the two not derivable from the stream.
        if self.health.disk_io_mbps == 0.0 {
            self.health.disk_io_mbps = 18.0;
        }
        if self.health.network_mbps == 0.0 {
            self.health.network_mbps = 23.0;
        }
    }

    /// Rebuild the insights vector from current state.
    pub fn refresh_insights(&mut self) {
        let mut out: Vec<String> = Vec::new();

        // Security incidents.
        if self.metrics.security_incidents_session == 0 {
            out.push("✓ No security incidents.".into());
        } else {
            out.push(format!(
                "! {} security veto(es) this session",
                self.metrics.security_incidents_session
            ));
        }

        // Plugin health.
        let unhealthy: Vec<(&str, PluginStatus)> = self
            .plugins
            .iter()
            .filter(|p| matches!(p.status, PluginStatus::Warning | PluginStatus::Error))
            .map(|p| (p.name.as_str(), p.status))
            .collect();
        if unhealthy.is_empty() {
            out.push("✓ All critical plugins healthy.".into());
        } else {
            for (name, status) in unhealthy {
                out.push(format!("! Plugin {name} status: {status:?}"));
            }
        }

        // Spend rate.
        if self.metrics.spend_rate_per_hour_usd > 10.0 {
            out.push("! Spend rate elevated".into());
        } else {
            out.push("✓ Spend rate normal.".into());
        }

        // Blocked tasks.
        if self.runtime_metrics.blocked_tasks > 0 {
            out.push(format!(
                "! {} task(s) blocked",
                self.runtime_metrics.blocked_tasks
            ));
        }

        // Hotspot file: most code.modified hits in the recent buffer.
        let mut file_counts: std::collections::HashMap<String, u32> =
            std::collections::HashMap::new();
        for e in &self.events {
            if let Event::CodeModified { file, .. } = e {
                *file_counts.entry(file.clone()).or_insert(0) += 1;
            }
        }
        if let Some((file, _)) = file_counts.into_iter().max_by_key(|(_, c)| *c) {
            out.push(format!("⚡ {file} is the current hotspot"));
        }

        out.truncate(6);
        self.insights = out;
    }

    /// Apply a single event to the state.
    pub fn apply(&mut self, ev: Event) {
        match &ev {
            // ---- runtime.metrics ----------------------------------------
            Event::RuntimeMetrics {
                open_sessions,
                ongoing_tasks,
                queued_tasks,
                blocked_tasks,
                tool_calls_lifetime,
                files_created_lifetime,
                files_modified_lifetime,
                code_written_lifetime_loc,
                code_modified_lifetime_loc,
                prs_created_lifetime,
                tests_run_lifetime,
                tests_passed_rate,
                total_spend_lifetime,
                ..
            } => {
                self.runtime_metrics.open_sessions = *open_sessions;
                self.runtime_metrics.ongoing_tasks = *ongoing_tasks;
                self.runtime_metrics.queued_tasks = *queued_tasks;
                self.runtime_metrics.blocked_tasks = *blocked_tasks;
                self.runtime_metrics.tool_calls_lifetime = *tool_calls_lifetime;
                self.runtime_metrics.files_created_lifetime = *files_created_lifetime;
                self.runtime_metrics.files_modified_lifetime = *files_modified_lifetime;
                self.runtime_metrics.code_written_lifetime_loc = *code_written_lifetime_loc;
                self.runtime_metrics.code_modified_lifetime_loc = *code_modified_lifetime_loc;
                self.runtime_metrics.prs_created_lifetime = *prs_created_lifetime;
                self.runtime_metrics.tests_run_lifetime = *tests_run_lifetime;
                self.runtime_metrics.tests_passed_rate = *tests_passed_rate as f32;
                self.runtime_metrics.total_spend_lifetime_usd = *total_spend_lifetime;
            }

            // ---- tool.call / tool.result -------------------------------
            Event::ToolCall { plugin, .. } => {
                if let Some(name) = plugin.as_deref() {
                    if let Some(idx) = self.plugin_index_by_name(name) {
                        let p = &mut self.plugins[idx];
                        p.calls = p.calls.saturating_add(1);
                        p.push_usage(p.calls);
                    }
                }
                self.runtime_metrics.tool_calls_lifetime =
                    self.runtime_metrics.tool_calls_lifetime.saturating_add(1);
            }
            Event::ToolResult(p) => {
                if let Some(name) = p.plugin.as_deref() {
                    if let Some(idx) = self.plugin_index_by_name(name) {
                        let plugin = &mut self.plugins[idx];
                        if matches!(p.severity, Some(Severity::High) | Some(Severity::Critical)) {
                            plugin.errors = plugin.errors.saturating_add(1);
                            plugin.status = PluginStatus::Error;
                        }
                    }
                }
            }

            // ---- security vetoes ---------------------------------------
            Event::HydraVeto { .. } => {
                self.metrics.security_incidents_session =
                    self.metrics.security_incidents_session.saturating_add(1);
                self.runtime_metrics.vetoes_lifetime =
                    self.runtime_metrics.vetoes_lifetime.saturating_add(1);
                let n = self.metrics.security_incidents_session;
                self.set_plugin_display("hydra", format!("{n} vetoes"));
            }
            Event::SylphVeto(_p) => {
                self.metrics.security_incidents_session =
                    self.metrics.security_incidents_session.saturating_add(1);
                self.runtime_metrics.vetoes_lifetime =
                    self.runtime_metrics.vetoes_lifetime.saturating_add(1);
                let n = self.metrics.security_incidents_session;
                self.set_plugin_display("sylph", format!("{n} vetoes"));
            }

            // ---- pech ledger -------------------------------------------
            Event::PechLedger { payload, .. } => {
                self.metrics.spent_session_usd = payload.session_cost_usd;
                self.budgets.daily_spend_usd = payload.daily_cost_usd;
                self.budgets.context_tokens = self
                    .budgets
                    .context_tokens
                    .saturating_add(payload.input_tokens)
                    .saturating_add(payload.output_tokens);
                let display = format!("${:.2}", payload.session_cost_usd);
                let cents = (payload.cost_usd * 100.0).round().max(0.0) as u64;
                self.set_plugin_display("pech", display);
                self.push_plugin_usage("pech", cents);
            }

            // ---- session lifecycle -------------------------------------
            Event::SessionStarted(p) | Event::SessionOpened(p) => {
                if let Some(sid) = p.session_id.as_deref() {
                    self.session.session_id = sid.to_string();
                }
                if let Some(ws) = payload_str(&p.extra, "workspace") {
                    self.session.workspace = ws;
                }
                if let Some(env) = payload_str(&p.extra, "env") {
                    self.session.env = env;
                }
            }

            // ---- phase pipeline ----------------------------------------
            Event::PhaseEntered(p) => {
                let phase_name = p
                    .phase
                    .clone()
                    .or_else(|| payload_str(&p.extra, "phase"));
                if let Some(name) = phase_name.as_deref() {
                    if let Some(ph) = parse_phase(name) {
                        self.session.current_phase = Some(ph);
                    }
                }
            }
            // PhaseCompleted intentionally does NOT clear current_phase —
            // the next entered drives the transition.
            Event::PhaseCompleted(_) => {}

            // ---- per-plugin display updates ----------------------------
            Event::EmuContextUpdate(p) => {
                let turn = p.extra.get("turn_estimate")
                    .and_then(|v| v.as_i64())
                    .map(|n| n.to_string())
                    .unwrap_or_else(|| "?".into());
                self.set_plugin_display("emu", format!("{turn}±3"));
                if let Some(ctx) = p.extra.get("context_size").and_then(|v| v.as_u64()) {
                    self.push_plugin_usage("emu", ctx);
                }
            }
            Event::CrowTrust(p) => {
                let trust = p
                    .extra
                    .get("trust_score")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(0.0);
                self.set_plugin_display("crow", format!("{trust:.2} trust"));
            }
            Event::DjinnAnchor(_p) => {
                self.set_plugin_display("djinn", "on task ✓".into());
            }
            Event::DjinnDrift(p) => {
                let score = p
                    .extra
                    .get("drift_score")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(0.0);
                let display = if score < 0.1 {
                    "on task ✓".to_string()
                } else {
                    format!("drift {:.0}%", score * 100.0)
                };
                self.set_plugin_display("djinn", display);
                self.metrics.drift_session_pct = (score * 100.0) as f32;
            }
            Event::GorgonHotspot(p) => {
                let file = p
                    .extra
                    .get("file")
                    .and_then(|v| v.as_str())
                    .unwrap_or("?")
                    .to_string();
                self.set_plugin_display("gorgon", format!("{file} hotspot"));
            }
            Event::NagaSpecCheck(p) => {
                let status = p
                    .extra
                    .get("status")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let display = if status == "clean" {
                    "clean ✓".to_string()
                } else {
                    "drift".to_string()
                };
                self.set_plugin_display("naga", display);
            }
            Event::LichReview(_p) => {
                self.set_plugin_display("lich", "clean ✓".into());
            }

            // ---- code.modified -----------------------------------------
            Event::CodeModified { .. } => {
                // Hotspot synthesis happens in refresh_insights.
            }

            // ---- task lifecycle ----------------------------------------
            Event::TaskCreated(p) => {
                let task_id = p.task_id.clone().unwrap_or_default();
                if !task_id.is_empty() {
                    let session_id = p.session_id.clone().unwrap_or_default();
                    let intent = payload_str(&p.extra, "intent")
                        .or_else(|| p.message.clone())
                        .unwrap_or_default();
                    let file_or_area = payload_str(&p.extra, "file_or_area")
                        .or_else(|| payload_str(&p.extra, "file"))
                        .unwrap_or_default();
                    let risk = match payload_str(&p.extra, "risk")
                        .as_deref()
                        .map(|s| s.to_ascii_lowercase())
                        .as_deref()
                    {
                        Some("medium") => Risk::Medium,
                        Some("high") => Risk::High,
                        Some("critical") => Risk::Critical,
                        _ => Risk::Low,
                    };
                    let status = parse_task_status(payload_str(&p.extra, "status").as_deref())
                        .unwrap_or(TaskStatus::Queued);
                    self.session.active_task_id = Some(task_id.clone());
                    self.upsert_task(TaskState {
                        task_id,
                        session_id,
                        status,
                        intent,
                        file_or_area,
                        phase: None,
                        risk,
                        age_seconds: 0,
                        created_at: p.time,
                        updated_at: p.time,
                        blocked_reason: None,
                    });
                }
            }
            Event::TaskStarted(p) => {
                if let Some(task_id) = p.task_id.as_deref() {
                    if let Some(t) = self.tasks.iter_mut().find(|t| t.task_id == task_id) {
                        t.status = TaskStatus::Running;
                        t.updated_at = p.time;
                    }
                    self.session.active_task_id = Some(task_id.to_string());
                }
            }
            Event::TaskUpdated {
                task_id,
                status,
                phase,
                age_seconds,
                time,
                intent,
                file_or_area,
                ..
            } => {
                let new_status = parse_task_status(status.as_deref());
                let new_phase = phase.as_deref().and_then(parse_phase);
                if let Some(t) = self.tasks.iter_mut().find(|t| &t.task_id == task_id) {
                    if let Some(s) = new_status {
                        t.status = s;
                    }
                    if new_phase.is_some() {
                        t.phase = new_phase;
                    }
                    if let Some(i) = intent.as_deref() {
                        t.intent = i.to_string();
                    }
                    if let Some(f) = file_or_area.as_deref() {
                        t.file_or_area = f.to_string();
                    }
                    t.age_seconds = *age_seconds;
                    t.updated_at = *time;
                }
                if matches!(
                    new_status,
                    Some(TaskStatus::Running)
                        | Some(TaskStatus::WaitingTool)
                        | Some(TaskStatus::WaitingReview)
                ) {
                    self.session.active_task_id = Some(task_id.clone());
                }
            }
            Event::TaskBlocked(p) => {
                if let Some(task_id) = p.task_id.as_deref() {
                    let reason = payload_str(&p.extra, "blocked_reason")
                        .or_else(|| payload_str(&p.extra, "reason"))
                        .or_else(|| p.message.clone())
                        .unwrap_or_default();
                    if let Some(t) = self.tasks.iter_mut().find(|t| t.task_id == task_id) {
                        t.status = TaskStatus::Blocked;
                        t.blocked_reason = Some(reason);
                        t.updated_at = p.time;
                    }
                    if self.session.active_task_id.as_deref() == Some(task_id) {
                        self.session.active_task_id = None;
                    }
                }
            }
            Event::TaskCompleted(p) => {
                if let Some(task_id) = p.task_id.as_deref() {
                    if let Some(t) = self.tasks.iter_mut().find(|t| t.task_id == task_id) {
                        t.status = TaskStatus::Completed;
                        t.updated_at = p.time;
                    }
                    if self.session.active_task_id.as_deref() == Some(task_id) {
                        self.session.active_task_id = None;
                    }
                }
                self.runtime_metrics.successful_tasks_lifetime = self
                    .runtime_metrics
                    .successful_tasks_lifetime
                    .saturating_add(1);
            }
            Event::TaskFailed(p) => {
                let reason = payload_str(&p.extra, "reason")
                    .or_else(|| p.message.clone())
                    .unwrap_or_default();
                if let Some(task_id) = p.task_id.as_deref() {
                    if let Some(t) = self.tasks.iter_mut().find(|t| t.task_id == task_id) {
                        t.status = TaskStatus::Failed;
                        t.blocked_reason = Some(reason);
                        t.updated_at = p.time;
                    }
                    if self.session.active_task_id.as_deref() == Some(task_id) {
                        self.session.active_task_id = None;
                    }
                }
                self.runtime_metrics.failed_tasks_lifetime =
                    self.runtime_metrics.failed_tasks_lifetime.saturating_add(1);
            }

            // ---- plugin health -----------------------------------------
            Event::PluginHealth(p) => {
                if let Some(name) = p.plugin.as_deref() {
                    let status_str = payload_str(&p.extra, "status");
                    let new_status = parse_plugin_status(status_str.as_deref());
                    let health = payload_f32(&p.extra, "health");
                    let p95 = payload_f32(&p.extra, "latency_p95_ms");
                    let p99 = payload_f32(&p.extra, "latency_p99_ms");
                    if let Some(idx) = self.plugin_index_by_name(name) {
                        let plugin = &mut self.plugins[idx];
                        if let Some(s) = new_status {
                            plugin.status = s;
                        }
                        if let Some(h) = health {
                            plugin.health = h;
                        }
                        if let Some(v) = p95 {
                            plugin.latency_p95_ms = v;
                        }
                        if let Some(v) = p99 {
                            plugin.latency_p99_ms = v;
                        }
                    }
                }
            }

            // ---- request.approval (v0.5 #4) ----------------------------
            Event::RequestApproval {
                correlation_id,
                plugin,
                reason,
                phase,
                session_id,
                time,
                ..
            } => {
                self.push_pending_approval(PendingApproval {
                    correlation_id: correlation_id.clone(),
                    plugin: plugin.clone(),
                    reason: reason.clone(),
                    phase: phase.clone(),
                    session_id: session_id.clone(),
                    received_at: *time,
                });
            }

            // ---- catch-all for wire-side type names not in the strict
            //      enum: route Event::Unknown(GenericPayload) by `type` tag
            //      so the cockpit's lifetime/per-plugin counters move when
            //      `mcp.tool.*`, `crow.trust.scored`, `lifecycle.*`, etc.
            //      land on the bus.
            Event::Unknown(p) => {
                self.apply_unknown(p);
            }

            // ---- everything else ---------------------------------------
            _ => {}
        }

        // Refresh `current_phase` from any event that carries a phase string.
        // Done generically so Unknown variants (lifecycle.*, mcp.tool.*) keep
        // the phase pipeline indicator current.
        if let Some(phase_str) = generic_phase(&ev) {
            if let Some(ph) = parse_phase(&phase_str) {
                self.session.current_phase = Some(ph);
            }
        }

        // Bump per-plugin last_event timestamp so the overview can render
        // a "last seen" column. Done before push_event so the borrow is local.
        if let Some(name) = ev.plugin() {
            let needle = name.to_ascii_lowercase();
            let t = ev.time();
            if let Some(p) = self
                .plugins
                .iter_mut()
                .find(|p| p.name.to_ascii_lowercase() == needle)
            {
                p.last_event = Some(t);
            }
        }

        self.push_event(ev);
        self.synthesize_health();
        self.refresh_insights();
    }

    /// Route an `Event::Unknown` (catch-all for wire-side names not enumerated
    /// in the strict Rust enum) to the same per-plugin / per-metric updates
    /// the typed variants get. Reads the original `type` tag from the
    /// flattened-payload `extra["type"]` field — `parse_line`'s fallback path
    /// preserves it there. Called by `apply()` so the bump-last_event logic
    /// downstream still runs.
    fn apply_unknown(&mut self, p: &crate::event::GenericPayload) {
        let type_tag = p
            .extra
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        // lifecycle.<phase> — refresh current_phase from the suffix.
        if let Some(suffix) = type_tag.strip_prefix("lifecycle.") {
            if let Some(ph) = parse_phase(suffix) {
                self.session.current_phase = Some(ph);
            }
            return;
        }

        match type_tag {
            "mcp.tool.call.requested" => {
                self.runtime_metrics.tool_calls_lifetime =
                    self.runtime_metrics.tool_calls_lifetime.saturating_add(1);
            }
            "mcp.tool.result.received" => {
                if let Some(name) = p.plugin.as_deref() {
                    if let Some(idx) = self.plugin_index_by_name(name) {
                        let plug = &mut self.plugins[idx];
                        plug.calls = plug.calls.saturating_add(1);
                        plug.push_usage(plug.calls);
                    }
                }
            }
            "crow.trust.scored" => {
                let posterior = p
                    .extra
                    .get("posterior_mean")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(0.0);
                self.set_plugin_display("crow", format!("{:.2} trust", posterior));
                if let Some(idx) = self.plugin_index_by_name("crow") {
                    let plug = &mut self.plugins[idx];
                    plug.calls = plug.calls.saturating_add(1);
                }
            }
            "djinn.anchor.set" => {
                self.set_plugin_display("djinn", "anchored".into());
                if let Some(idx) = self.plugin_index_by_name("djinn") {
                    let plug = &mut self.plugins[idx];
                    plug.calls = plug.calls.saturating_add(1);
                }
            }
            "djinn.drift.observed" => {
                if let Some(d) = p
                    .extra
                    .get("drift")
                    .or_else(|| p.extra.get("drift_score"))
                    .and_then(|v| v.as_f64())
                {
                    self.metrics.drift_session_pct = (d * 100.0) as f32;
                }
            }
            "pech.ledger.appended" => {
                let session_cost = p
                    .extra
                    .get("session_cost_usd")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(0.0);
                let cost_usd = p
                    .extra
                    .get("cost_usd")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(0.0);
                let daily = p
                    .extra
                    .get("daily_cost_usd")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(0.0);
                self.metrics.spent_session_usd = session_cost;
                if daily > 0.0 {
                    self.budgets.daily_spend_usd = daily;
                }
                self.set_plugin_display("pech", format!("${:.2}", session_cost));
                let cents = (cost_usd * 100.0).round().max(0.0) as u64;
                self.push_plugin_usage("pech", cents);
                if let Some(idx) = self.plugin_index_by_name("pech") {
                    let plug = &mut self.plugins[idx];
                    plug.calls = plug.calls.saturating_add(1);
                }
            }
            "hydra.veto.fired" => {
                self.metrics.security_incidents_session =
                    self.metrics.security_incidents_session.saturating_add(1);
                self.runtime_metrics.vetoes_lifetime =
                    self.runtime_metrics.vetoes_lifetime.saturating_add(1);
                let n = self.metrics.security_incidents_session;
                self.set_plugin_display("hydra", format!("{n} vetoes"));
                if let Some(idx) = self.plugin_index_by_name("hydra") {
                    let plug = &mut self.plugins[idx];
                    plug.calls = plug.calls.saturating_add(1);
                }
            }
            "hydra.secret.masked" => {
                if let Some(idx) = self.plugin_index_by_name("hydra") {
                    let plug = &mut self.plugins[idx];
                    plug.calls = plug.calls.saturating_add(1);
                }
            }
            "sylph.destructive.veto" => {
                self.metrics.security_incidents_session =
                    self.metrics.security_incidents_session.saturating_add(1);
                self.runtime_metrics.vetoes_lifetime =
                    self.runtime_metrics.vetoes_lifetime.saturating_add(1);
                let n = self.metrics.security_incidents_session;
                self.set_plugin_display("sylph", format!("{n} vetoes"));
                if let Some(idx) = self.plugin_index_by_name("sylph") {
                    let plug = &mut self.plugins[idx];
                    plug.calls = plug.calls.saturating_add(1);
                }
            }
            "naga.spec_check"
            | "lich.review"
            | "emu.context_update"
            | "gorgon.hotspot" => {
                // Strict-enum siblings of the same names already handle the
                // typed shape; for the wire-format fallthroughs, just bump the
                // matching plugin's call counter. last_event refresh happens
                // generically downstream off `ev.plugin()`.
                if let Some(name) = p.plugin.as_deref() {
                    if let Some(idx) = self.plugin_index_by_name(name) {
                        let plug = &mut self.plugins[idx];
                        plug.calls = plug.calls.saturating_add(1);
                    }
                }
            }
            _ => {
                // Anything else — still let the generic plugin-name lookup
                // bump calls, so unknown wire types still register.
                if let Some(name) = p.plugin.as_deref() {
                    if let Some(idx) = self.plugin_index_by_name(name) {
                        let plug = &mut self.plugins[idx];
                        plug.calls = plug.calls.saturating_add(1);
                    }
                }
            }
        }
    }

    /// Currently-selected index for the active panel.
    pub fn selected_index(&self) -> usize {
        match self.active_panel {
            Panel::Plugins => self.selected_plugin_index,
            Panel::Events => self.selected_event_index,
            Panel::Tasks => self.selected_task_index,
            Panel::Detail | Panel::Health | Panel::Insights => 0,
        }
    }

    /// Update the selection index for the active panel.
    pub fn set_selected_index(&mut self, idx: usize) {
        match self.active_panel {
            Panel::Plugins => {
                let max = self.plugins.len().saturating_sub(1);
                self.selected_plugin_index = idx.min(max);
            }
            Panel::Events => {
                let max = self.events.len().saturating_sub(1);
                self.selected_event_index = idx.min(max);
            }
            Panel::Tasks => {
                let max = self.tasks.len().saturating_sub(1);
                self.selected_task_index = idx.min(max);
            }
            Panel::Detail | Panel::Health | Panel::Insights => {}
        }
    }

    pub fn next_view(&mut self) {
        let cur = View::ALL.iter().position(|v| *v == self.active_view).unwrap_or(0);
        self.active_view = View::ALL[(cur + 1) % View::ALL.len()];
    }

    pub fn prev_view(&mut self) {
        let cur = View::ALL.iter().position(|v| *v == self.active_view).unwrap_or(0);
        self.active_view = View::ALL[(cur + View::ALL.len() - 1) % View::ALL.len()];
    }

    pub fn set_view(&mut self, v: View) {
        self.active_view = v;
    }

    pub fn toggle_pause(&mut self) {
        self.paused = !self.paused;
    }

    pub fn clear_events(&mut self) {
        self.events.clear();
        self.selected_event_index = 0;
    }

    /// Bump the UI tick counter. Called by the app loop's tick branch.
    pub fn bump_tick(&mut self) {
        self.tick = self.tick.wrapping_add(1);
    }

    /// Push a new pending approval onto the front of the queue (newest-first).
    pub fn push_pending_approval(&mut self, req: PendingApproval) {
        self.pending_approvals.push_front(req);
    }

    /// Remove and return the pending approval matching `correlation_id`.
    /// O(n) but n is bounded by user attention — typically 0..3.
    pub fn consume_approval(&mut self, correlation_id: &str) -> Option<PendingApproval> {
        let idx = self
            .pending_approvals
            .iter()
            .position(|p| p.correlation_id == correlation_id)?;
        self.pending_approvals.remove(idx)
    }

    /// Peek the head pending approval (the one the banner displays).
    pub fn peek_pending_approval(&self) -> Option<&PendingApproval> {
        self.pending_approvals.front()
    }
}

impl Default for AppState {
    fn default() -> Self {
        use ratatui::style::Color;

        // Brand colors per the plugin icon set.
        // orange = pech, yellow = emu/crow, green = hydra/naga, cyan = sylph,
        // blue = lich, purple = djinn, pink = gorgon, magenta = wixie.
        let orange = Color::Rgb(255, 165, 0);
        let pink = Color::Rgb(255, 105, 180);
        let purple = Color::Rgb(160, 32, 240);

        let plugins = vec![
            PluginState::new("pech", orange),
            PluginState::new("emu", Color::Yellow),
            PluginState::new("hydra", Color::Green),
            PluginState::new("sylph", Color::Cyan),
            PluginState::new("lich", Color::Blue),
            PluginState::new("naga", Color::Green),
            PluginState::new("crow", Color::Yellow),
            PluginState::new("djinn", purple),
            PluginState::new("gorgon", pink),
            PluginState::new("wixie", Color::Magenta),
        ];

        Self {
            running: true,
            paused: false,
            active_view: View::Overview,
            active_panel: Panel::Plugins,
            selected_event_index: 0,
            selected_plugin_index: 0,
            selected_task_index: 0,
            filter_query: String::new(),
            sort_mode: SortMode::Default,
            events: VecDeque::with_capacity(EVENT_RING_CAPACITY),
            plugins,
            metrics: MetricState::default(),
            runtime_metrics: RuntimeMetricState::default(),
            health: HealthState::default(),
            budgets: BudgetState::default(),
            session: SessionState::default(),
            tasks: Vec::new(),
            insights: Vec::new(),
            started_at: chrono::Utc::now(),
            tick: 0,
            demo_mode: false,
            pending_approvals: VecDeque::new(),
        }
    }
}

/// Best-effort detection of the user's Claude subscription tier.
///
/// Reads `~/.claude.json` (`oauthAccount.organizationType` — observed values
/// include `claude_max`, `claude_pro`, `claude_team`, `claude_enterprise`,
/// `claude_free`) and returns a capitalized label. Falls back to
/// `oauthAccount.organizationRateLimitTier` when `organizationType` is absent.
/// Returns `"Unknown"` on any error or unrecognized value. Never panics.
pub fn detect_claude_plan() -> String {
    let home = std::env::var("HOME")
        .ok()
        .or_else(|| std::env::var("USERPROFILE").ok());
    let Some(home) = home else { return "Unknown".to_string() };
    let path = std::path::Path::new(&home).join(".claude.json");
    let Ok(bytes) = std::fs::read(&path) else { return "Unknown".to_string() };
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return "Unknown".to_string();
    };

    let oauth = value.get("oauthAccount");
    let raw = oauth
        .and_then(|o| o.get("organizationType"))
        .and_then(|v| v.as_str())
        .or_else(|| {
            oauth
                .and_then(|o| o.get("organizationRateLimitTier"))
                .and_then(|v| v.as_str())
        })
        .unwrap_or("");

    plan_label_from_raw(raw)
}

/// Map a Claude config raw plan/tier string to a pretty label. Pulled out
/// for unit testing.
fn plan_label_from_raw(raw: &str) -> String {
    let lower = raw.to_ascii_lowercase();
    if lower.contains("enterprise") {
        "Enterprise".to_string()
    } else if lower.contains("team") {
        "Team".to_string()
    } else if lower.contains("max") {
        "Max".to_string()
    } else if lower.contains("pro") {
        "Pro".to_string()
    } else if lower.contains("free") || lower.contains("trial") {
        "Free".to_string()
    } else {
        "Unknown".to_string()
    }
}

/// Walk every `~/.claude/projects/*/*.jsonl` modified in the last 24 hours
/// and sum (a) total tokens (input + cache_creation + cache_read + output)
/// and (b) assistant-turn count across `usage` records.
///
/// Hard-capped at 100 ms wall-clock — if the scan takes longer, returns
/// what's been counted so far. Tolerant of missing dirs, unreadable files,
/// and malformed JSON lines (silently skipped). Never panics.
pub fn detect_claude_usage_today() -> (u64, u64) {
    use std::io::{BufRead, BufReader};
    use std::time::{Duration, Instant, SystemTime};

    let started = Instant::now();
    let budget = Duration::from_millis(100);

    let home = std::env::var("HOME")
        .ok()
        .or_else(|| std::env::var("USERPROFILE").ok());
    let Some(home) = home else { return (0, 0) };
    let projects = std::path::Path::new(&home).join(".claude").join("projects");
    let Ok(project_iter) = std::fs::read_dir(&projects) else { return (0, 0) };

    let cutoff = SystemTime::now()
        .checked_sub(Duration::from_secs(24 * 60 * 60))
        .unwrap_or(SystemTime::UNIX_EPOCH);

    let mut tokens: u64 = 0;
    let mut messages: u64 = 0;

    'outer: for project_entry in project_iter.flatten() {
        if started.elapsed() >= budget {
            break;
        }
        let project_path = project_entry.path();
        if !project_path.is_dir() {
            continue;
        }
        let Ok(file_iter) = std::fs::read_dir(&project_path) else { continue };
        for file_entry in file_iter.flatten() {
            if started.elapsed() >= budget {
                break 'outer;
            }
            let file_path = file_entry.path();
            // Only top-level *.jsonl files (transcript logs).
            if file_path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
                continue;
            }
            // Skip files older than the 24h window — fast mtime gate.
            let mtime = file_entry
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(SystemTime::UNIX_EPOCH);
            if mtime < cutoff {
                continue;
            }
            let Ok(file) = std::fs::File::open(&file_path) else { continue };
            let reader = BufReader::new(file);
            for line in reader.lines().map_while(Result::ok) {
                if started.elapsed() >= budget {
                    break 'outer;
                }
                if line.is_empty() {
                    continue;
                }
                let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
                    continue;
                };
                // Filter to records inside the 24h window via record timestamp
                // when present; otherwise count (file-level mtime gate is the
                // outer filter).
                if let Some(ts) = value.get("timestamp").and_then(|v| v.as_str()) {
                    if let Some(t) = chrono::DateTime::parse_from_rfc3339(ts).ok() {
                        let cutoff_dt = chrono::Utc::now() - chrono::Duration::hours(24);
                        if t.with_timezone(&chrono::Utc) < cutoff_dt {
                            continue;
                        }
                    }
                }
                let Some(usage) = value.get("message").and_then(|m| m.get("usage")) else {
                    continue;
                };
                let i = usage.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                let cc = usage
                    .get("cache_creation_input_tokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let cr = usage
                    .get("cache_read_input_tokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let o = usage.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                tokens = tokens.saturating_add(i).saturating_add(cc).saturating_add(cr).saturating_add(o);
                if value.get("type").and_then(|v| v.as_str()) == Some("assistant") {
                    messages = messages.saturating_add(1);
                }
            }
        }
    }

    (tokens, messages)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::Event;

    #[test]
    fn plan_label_recognizes_known_tiers() {
        assert_eq!(plan_label_from_raw("claude_max"), "Max");
        assert_eq!(plan_label_from_raw("claude_pro"), "Pro");
        assert_eq!(plan_label_from_raw("claude_team"), "Team");
        assert_eq!(plan_label_from_raw("claude_enterprise"), "Enterprise");
        assert_eq!(plan_label_from_raw("claude_free"), "Free");
        assert_eq!(plan_label_from_raw("default_claude_max_20x"), "Max");
        assert_eq!(plan_label_from_raw(""), "Unknown");
        assert_eq!(plan_label_from_raw("garbage"), "Unknown");
    }

    #[test]
    fn detect_claude_usage_today_never_panics() {
        // Just exercise the call path; values depend on local state.
        let (_t, _m) = detect_claude_usage_today();
    }

    #[test]
    fn default_initializes_ten_plugins() {
        let s = AppState::default();
        assert_eq!(s.plugins.len(), 10);
        let names: Vec<&str> = s.plugins.iter().map(|p| p.name.as_str()).collect();
        for expected in [
            "pech", "emu", "hydra", "sylph", "lich", "naga", "crow", "djinn", "gorgon", "wixie",
        ] {
            assert!(names.contains(&expected), "missing plugin {expected}");
        }
        for p in &s.plugins {
            assert_eq!(p.display_value, "—");
            assert_eq!(p.calls, 0);
            assert_eq!(p.errors, 0);
        }
        assert!(s.running);
        assert!(!s.paused);
        assert_eq!(s.active_view, View::Overview);
    }

    #[test]
    fn runtime_metrics_event_updates_open_sessions() {
        let mut s = AppState::new();
        let ev = Event::sample_runtime_metrics_with_open_sessions(7);
        s.apply(ev);
        assert_eq!(s.runtime_metrics.open_sessions, 7);
    }

    #[test]
    fn hydra_veto_increments_security_incidents() {
        let mut s = AppState::new();
        let before = s.metrics.security_incidents_session;
        s.apply(Event::sample_hydra_veto("policy:fs.write outside workspace"));
        assert_eq!(s.metrics.security_incidents_session, before + 1);
        // Insights are now derived: a non-zero veto count produces a "!" line.
        assert!(s
            .insights
            .iter()
            .any(|i| i.contains("security veto") && i.starts_with("!")));
        // Hydra plugin's display value reflects the veto count.
        let hydra = s.plugins.iter().find(|p| p.name == "hydra").unwrap();
        assert!(hydra.display_value.contains("vetoes"));
    }

    #[test]
    fn ring_buffer_caps_at_capacity() {
        let mut s = AppState::new();
        for _ in 0..3000 {
            s.apply(Event::sample_noop());
        }
        assert_eq!(s.events.len(), EVENT_RING_CAPACITY);
        assert_eq!(s.metrics.events_count, 3000);
    }

    /// Helper: build an Event::Unknown with the given wire-side type tag and
    /// arbitrary extras (jammed into the `extra` map).
    fn mk_unknown(type_tag: &str, plugin: Option<&str>, extras: &[(&str, serde_json::Value)]) -> Event {
        let mut extra = std::collections::BTreeMap::new();
        extra.insert("type".to_string(), serde_json::json!(type_tag));
        for (k, v) in extras {
            extra.insert((*k).to_string(), v.clone());
        }
        Event::Unknown(crate::event::GenericPayload {
            time: 1_778_086_945.5,
            session_id: None,
            task_id: None,
            plugin: plugin.map(|p| p.to_string()),
            phase: None,
            severity: None,
            message: None,
            extra,
        })
    }

    #[test]
    fn unknown_mcp_tool_call_bumps_lifetime_tool_calls() {
        let mut s = AppState::new();
        let before = s.runtime_metrics.tool_calls_lifetime;
        s.apply(mk_unknown("mcp.tool.call.requested", Some("mcp-client"), &[]));
        assert_eq!(s.runtime_metrics.tool_calls_lifetime, before + 1);
        // Generic events bump events_count too.
        assert_eq!(s.metrics.events_count, 1);
    }

    #[test]
    fn unknown_crow_trust_scored_updates_display_value() {
        let mut s = AppState::new();
        s.apply(mk_unknown(
            "crow.trust.scored",
            Some("crow"),
            &[("posterior_mean", serde_json::json!(0.73))],
        ));
        let crow = s.plugins.iter().find(|p| p.name == "crow").unwrap();
        assert_eq!(crow.display_value, "0.73 trust");
        assert_eq!(crow.calls, 1);
        assert!(crow.last_event.is_some(), "last_event must update on Unknown");
    }

    #[test]
    fn unknown_djinn_anchor_set_updates_display_and_calls() {
        let mut s = AppState::new();
        s.apply(mk_unknown("djinn.anchor.set", Some("djinn"), &[]));
        let djinn = s.plugins.iter().find(|p| p.name == "djinn").unwrap();
        assert_eq!(djinn.display_value, "anchored");
        assert_eq!(djinn.calls, 1);
    }

    #[test]
    fn unknown_pech_ledger_appended_updates_spend_and_display() {
        let mut s = AppState::new();
        s.apply(mk_unknown(
            "pech.ledger.appended",
            Some("pech"),
            &[
                ("session_cost_usd", serde_json::json!(0.42)),
                ("cost_usd", serde_json::json!(0.05)),
                ("daily_cost_usd", serde_json::json!(3.21)),
            ],
        ));
        assert!((s.metrics.spent_session_usd - 0.42).abs() < 1e-9);
        assert!((s.budgets.daily_spend_usd - 3.21).abs() < 1e-9);
        let pech = s.plugins.iter().find(|p| p.name == "pech").unwrap();
        assert_eq!(pech.display_value, "$0.42");
    }

    #[test]
    fn unknown_hydra_veto_fired_increments_security_and_lifetime_vetoes() {
        let mut s = AppState::new();
        s.apply(mk_unknown("hydra.veto.fired", Some("hydra"), &[]));
        assert_eq!(s.metrics.security_incidents_session, 1);
        assert_eq!(s.runtime_metrics.vetoes_lifetime, 1);
        let hydra = s.plugins.iter().find(|p| p.name == "hydra").unwrap();
        assert!(hydra.display_value.contains("vetoes"));
    }

    #[test]
    fn unknown_sylph_destructive_veto_increments_security_and_lifetime() {
        let mut s = AppState::new();
        s.apply(mk_unknown("sylph.destructive.veto", Some("sylph"), &[]));
        assert_eq!(s.metrics.security_incidents_session, 1);
        assert_eq!(s.runtime_metrics.vetoes_lifetime, 1);
    }

    #[test]
    fn unknown_lifecycle_dispatch_sets_current_phase() {
        let mut s = AppState::new();
        assert!(s.session.current_phase.is_none());
        s.apply(mk_unknown("lifecycle.dispatch", Some("orchestrator"), &[]));
        assert_eq!(s.session.current_phase, Some(crate::event::Phase::Dispatch));
    }

    #[test]
    fn unknown_lifecycle_trust_gate_sets_current_phase() {
        let mut s = AppState::new();
        s.apply(mk_unknown("lifecycle.trust-gate", Some("orchestrator"), &[]));
        assert_eq!(s.session.current_phase, Some(crate::event::Phase::TrustGate));
    }

    #[test]
    fn unknown_event_with_plugin_refreshes_last_event() {
        let mut s = AppState::new();
        // Pick an arbitrary unknown wire type that goes through the catch-all
        // arm; the post-apply block must still refresh last_event.
        s.apply(mk_unknown("naga.spec_check", Some("naga"), &[]));
        let naga = s.plugins.iter().find(|p| p.name == "naga").unwrap();
        assert!(naga.last_event.is_some(), "last_event must populate on every Unknown plugin event");
        assert!(naga.calls >= 1);
    }
}
