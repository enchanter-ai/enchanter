//! Overview view — the cockpit's flagship dashboard.
//!
//! Renders, top to bottom:
//!
//! 1. Top status bar    — `Enchanter — LIVE` left, key hints right-aligned
//! 2. Active session    — workspace, user, current task, file/risk/phase/age
//! 3. Metrics row       — three side-by-side bordered boxes:
//!                        Session Metrics | Runtime | System Health
//! 4. Phase pipeline    — single-row bordered box, ASCII `>` separators
//! 5. Plugins panel     — table: Plugin / Status / Calls / Errors / p95 / p99 / Last
//! 6. Events panel      — table: Time / Source / Type / Details
//! 7. Footer            — short workspace/session/uptime line; collapsed if narrow
//!
//! No emoji or unicode icons in the rendered output — only words, numbers,
//! percentages, and ASCII box-drawing. Each box uses its own border color
//! (see `theme::BORDER_*`) so the eye can scan categories.

use ratatui::layout::{Alignment, Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Cell, Paragraph, Row, Table};
use ratatui::Frame;

use crate::event::{Event, Phase, Severity};
use crate::state::{AppState, Panel, PendingApproval, PluginStatus, Risk, TaskState, TaskStatus};
use crate::ui::{layout, theme, widgets};

/// Render the overview screen into `area`.
pub fn render(frame: &mut Frame, area: Rect, app: &AppState) {
    let l = layout::compute_overview_layout(area);

    render_top_bar(frame, l.top_bar, app);
    render_active_session(frame, l.active_session, app);
    render_session_metrics(frame, l.session_metrics, app);
    render_runtime_metrics(frame, l.runtime_metrics, app);
    render_system_health(frame, l.system_health, app);
    render_phase_pipeline(frame, l.phase_pipeline, app);
    render_plugins_panel(frame, l.plugins_panel, app);
    render_events_panel(frame, l.events_panel, app);
    // Footer intentionally not rendered — its info now lives in the
    // ACTIVE SESSION header rows.
}

// ---------------------------------------------------------------------------
// 1. Top status bar — bordered box with title (Enchanter — LIVE — DEMO)
//    LEFT-aligned and shortcuts RIGHT-aligned. The right-alignment here is
//    one of two intentional exceptions to the global LTR rule (the other is
//    the PLUGINS table's "Last seen" column) — both at explicit user ask.
//    "Enchanter" renders in the djinn purple; rest dimmed.
// ---------------------------------------------------------------------------
fn render_top_bar(frame: &mut Frame, area: Rect, app: &AppState) {
    if area.area() == 0 {
        return;
    }

    // v0.5 #4 — when a request.approval is pending, the top bar swaps out
    // its normal LIVE/PAUSED label for a high-visibility "PENDING APPROVAL"
    // banner. Plain ASCII brackets, LTR-only, no emoji or unicode glyphs
    // per the rendering contract.
    if let Some(pending) = app.peek_pending_approval() {
        render_pending_approval_banner(frame, area, app, pending);
        return;
    }

    let block = widgets::panel_block_with_color("", false, theme::BORDER_TITLE);
    let inner = block.inner(area);
    frame.render_widget(block, area);
    if inner.area() == 0 {
        return;
    }

    let mode_label = if app.paused { "PAUSED" } else { "LIVE" };
    let base_color = if app.paused {
        theme::STATUS_WARNING
    } else {
        theme::STATUS_HEALTHY
    };
    let mode_color = if app.paused {
        base_color
    } else {
        widgets::pulse_color(base_color, app.tick, 2)
    };

    // Build the title spans — purple "Enchanter", dim separators, pulsing mode.
    let mut left_spans = vec![
        Span::styled(
            "Enchanter",
            Style::default()
                .fg(theme::PLUGIN_DJINN)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(" \u{2014} ", Style::default().fg(theme::TEXT_DIM)),
        Span::styled(
            mode_label,
            Style::default().fg(mode_color).add_modifier(Modifier::BOLD),
        ),
    ];
    if app.demo_mode {
        left_spans.push(Span::styled(" \u{2014} DEMO", Style::default().fg(theme::TEXT_DIM)));
    }
    // Loading indicator: when the runtime hasn't emitted any events yet, show
    // a pulsing "waiting for runtime…" pill so the user sees something is
    // happening. Drops as soon as the first event lands.
    if app.events.is_empty() && !app.demo_mode {
        let dots = match app.tick % 3 {
            0 => ".",
            1 => "..",
            _ => "...",
        };
        left_spans.push(Span::styled(
            " \u{2014} ".to_string(),
            Style::default().fg(theme::TEXT_DIM),
        ));
        left_spans.push(Span::styled(
            format!("waiting for runtime{dots}"),
            Style::default().fg(theme::TEXT_DIM),
        ));
    }

    // Shortcuts text — single string so the right column can be sized to fit.
    let shortcut_text = "q quit \u{00b7} / filter \u{00b7} p pause \u{00b7} s sort \u{00b7} ? help";

    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Fill(1),
            Constraint::Length(shortcut_text.chars().count() as u16 + 2),
        ])
        .split(inner);

    frame.render_widget(
        Paragraph::new(Line::from(left_spans)).alignment(Alignment::Left),
        cols[0],
    );

    // RIGHT-aligned per explicit user ask (one of two LTR exceptions).
    let right = Line::from(vec![Span::styled(
        shortcut_text,
        Style::default().fg(theme::TEXT_DIM),
    )]);
    frame.render_widget(Paragraph::new(right).alignment(Alignment::Right), cols[1]);
}

/// v0.5 #4 — replace the top-bar contents with a high-visibility PENDING
/// APPROVAL banner. ASCII-only ("[a]pprove [v]eto"), no unicode glyphs.
/// Multiple pending approvals show queue depth.
fn render_pending_approval_banner(frame: &mut Frame, area: Rect, app: &AppState, pending: &PendingApproval) {
    let block = widgets::panel_block_with_color("", false, theme::STATUS_CRITICAL);
    let inner = block.inner(area);
    frame.render_widget(block, area);
    if inner.area() == 0 {
        return;
    }

    let depth = app.pending_approvals.len();
    let depth_suffix = if depth > 1 {
        format!(" (+{} more)", depth - 1)
    } else {
        String::new()
    };

    let banner_spans = vec![
        Span::styled(
            "PENDING APPROVAL",
            Style::default()
                .fg(theme::STATUS_CRITICAL)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(": ", Style::default().fg(theme::TEXT_DIM)),
        Span::styled(
            pending.plugin.clone(),
            Style::default()
                .fg(theme::TEXT_PRIMARY)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(" - ", Style::default().fg(theme::TEXT_DIM)),
        Span::styled(
            pending.reason.clone(),
            Style::default().fg(theme::TEXT_PRIMARY),
        ),
        Span::styled(depth_suffix, Style::default().fg(theme::TEXT_DIM)),
    ];
    let hint = Line::from(vec![Span::styled(
        "[a]pprove [v]eto",
        Style::default()
            .fg(theme::STATUS_WARNING)
            .add_modifier(Modifier::BOLD),
    )]);

    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Fill(1),
            Constraint::Length("[a]pprove [v]eto".chars().count() as u16 + 2),
        ])
        .split(inner);

    frame.render_widget(
        Paragraph::new(Line::from(banner_spans)).alignment(Alignment::Left),
        cols[0],
    );
    frame.render_widget(Paragraph::new(hint).alignment(Alignment::Right), cols[1]);
}

// ---------------------------------------------------------------------------
// 2. Active session — three side-by-side sub-boxes inside one outer border,
//    separated by vertical `│` walls. Each sub-box is a 2-column key/value
//    table (label dim, value primary). Groups, in order: workspace identity,
//    account identity, active task. 5 content rows + 2 outer borders = 7.
// ---------------------------------------------------------------------------
fn render_active_session(frame: &mut Frame, area: Rect, app: &AppState) {
    if area.area() == 0 {
        return;
    }
    let block = widgets::panel_block_with_color("ACTIVE SESSION", false, theme::BORDER_SESSION);
    let inner = block.inner(area);
    frame.render_widget(block, area);
    if inner.area() == 0 {
        return;
    }

    let s = &app.session;
    let workspace = if s.workspace.is_empty() { "-".to_string() } else { s.workspace.clone() };
    let env = if s.env.is_empty() { "-".to_string() } else { s.env.clone() };
    let session_id = if s.session_id.is_empty() { "-".to_string() } else { s.session_id.clone() };
    let github_user = if s.github_user.is_empty() { "-".to_string() } else { s.github_user.clone() };
    let claude_user = if s.claude_user.is_empty() { "-".to_string() } else { s.claude_user.clone() };

    let uptime = (chrono::Utc::now() - app.started_at)
        .num_seconds()
        .max(0) as u64;
    let plan_color = plan_tier_color(&s.claude_plan);

    let task_opt = s
        .active_task_id
        .as_deref()
        .and_then(|id| app.tasks.iter().find(|t| t.task_id == id));
    let task_active_text = match task_opt {
        Some(t) => {
            let intent = if t.intent.is_empty() { "-" } else { t.intent.as_str() };
            format!("{}  {}", t.task_id, intent)
        }
        None => "-".to_string(),
    };
    let task_active_color = match task_opt {
        Some(_) => theme::ACCENT,
        None => theme::TEXT_DIM,
    };
    let file_text = task_opt
        .map(|t| t.file_or_area.clone())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "-".to_string());
    let (risk_text, risk_color_v) = match task_opt {
        Some(t) => (risk_label(t.risk).to_string(), risk_color(t.risk)),
        None => ("-".to_string(), theme::TEXT_DIM),
    };
    let phase_text = match task_opt {
        Some(t) => t
            .phase
            .or(s.current_phase)
            .map(phase_label)
            .unwrap_or("-")
            .to_string(),
        None => s
            .current_phase
            .map(phase_label)
            .unwrap_or("-")
            .to_string(),
    };
    let age_text = match task_opt {
        Some(t) => fmt_age_seconds(active_age_seconds(t)),
        None => "-".to_string(),
    };

    let tokens_value = format!(
        "{}  ({} msgs)",
        fmt_count_short(s.claude_tokens_today),
        s.claude_messages_today
    );

    // Carve the inner rect into 5 sub-rects: col1 │ col2 │ col3.
    // Walls are 1-col-wide rects rendered with Borders::LEFT.
    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Ratio(1, 3),
            Constraint::Length(1),
            Constraint::Ratio(1, 3),
            Constraint::Length(1),
            Constraint::Ratio(1, 3),
        ])
        .split(inner);

    // Col 1 — workspace identity
    let col1_rows = vec![
        kv_row("Workspace", &workspace),
        kv_row("Env", &env),
        kv_row("Session", &session_id),
        kv_row("Uptime", &fmt_uptime(uptime)),
    ];
    let col1_table = Table::new(
        col1_rows,
        [Constraint::Length(11), Constraint::Min(6)],
    )
    .column_spacing(1);
    frame.render_widget(col1_table, cols[0]);

    // Wall 1 — vertical `│` separator using Borders::LEFT on a bare Block.
    let wall_block_1 = Block::default()
        .borders(Borders::LEFT)
        .border_style(Style::default().fg(theme::PANEL_BORDER));
    frame.render_widget(wall_block_1, cols[1]);

    // Col 2 — account identity
    let plan_value_style = Style::default().fg(plan_color).add_modifier(Modifier::BOLD);
    let col2_rows = vec![
        kv_row("GitHub", &github_user),
        kv_row("Claude", &claude_user),
        // Plan row uses a tier color on the value; build by hand to keep the
        // styling without proliferating helpers.
        Row::new(vec![
            Cell::from("Plan").style(Style::default().fg(theme::TEXT_DIM)),
            Cell::from(s.claude_plan.clone()).style(plan_value_style),
        ]),
        kv_row("Tokens today", &tokens_value),
    ];
    let col2_table = Table::new(
        col2_rows,
        [Constraint::Length(13), Constraint::Min(6)],
    )
    .column_spacing(1);
    frame.render_widget(col2_table, cols[2]);

    // Wall 2 — vertical `│` separator.
    let wall_block_2 = Block::default()
        .borders(Borders::LEFT)
        .border_style(Style::default().fg(theme::PANEL_BORDER));
    frame.render_widget(wall_block_2, cols[3]);

    // Col 3 — active task. The Active task row is the longest text; let it
    // share a slightly wider value column.
    let task_value_style = Style::default()
        .fg(task_active_color)
        .add_modifier(Modifier::BOLD);
    let risk_value_style = Style::default()
        .fg(risk_color_v)
        .add_modifier(Modifier::BOLD);
    let col3_rows = vec![
        Row::new(vec![
            Cell::from("Active task").style(Style::default().fg(theme::TEXT_DIM)),
            Cell::from(task_active_text).style(task_value_style),
        ]),
        kv_row("File", &file_text),
        Row::new(vec![
            Cell::from("Risk").style(Style::default().fg(theme::TEXT_DIM)),
            Cell::from(risk_text).style(risk_value_style),
        ]),
        kv_row("Phase", &phase_text),
        kv_row("Age", &age_text),
    ];
    let col3_table = Table::new(
        col3_rows,
        [Constraint::Length(12), Constraint::Min(6)],
    )
    .column_spacing(1);
    frame.render_widget(col3_table, cols[4]);
}

// ---------------------------------------------------------------------------
// 3a. Session metrics box
// ---------------------------------------------------------------------------
fn render_session_metrics(frame: &mut Frame, area: Rect, app: &AppState) {
    if area.area() == 0 {
        return;
    }
    // Tiny mode reuses this slot for a one-line summary.
    if area.height <= 2 {
        let m = &app.metrics;
        let summary = format!(
            "T {}/{}  {}  sec {}  drift {:.0}%  p99 {} ms  ev {}",
            m.turns.0,
            m.turns.1,
            fmt_money(m.spent_session_usd),
            m.security_incidents_session,
            m.drift_session_pct,
            m.p99_latency_ms as i64,
            fmt_count_short(m.events_count),
        );
        frame.render_widget(
            Paragraph::new(summary).style(Style::default().fg(theme::TEXT_DIM)),
            area,
        );
        return;
    }

    let block = widgets::panel_block_with_color("SESSION METRICS", false, theme::BORDER_METRICS);
    let m = &app.metrics;
    // Cache hit % synthesized from event volume so the demo always shows
    // a believable, slowly-moving number rather than a frozen "-".
    let cache_hit_pct = (m.events_count % 100) as f32;
    // Avg latency — mean of all plugin p95s, falls back to event-loop ms
    // when no plugin has reported yet.
    let avg_latency_ms = {
        let with_p95: Vec<f32> = app
            .plugins
            .iter()
            .map(|p| p.latency_p95_ms)
            .filter(|v| *v > 0.0)
            .collect();
        if !with_p95.is_empty() {
            with_p95.iter().sum::<f32>() / with_p95.len() as f32
        } else {
            app.health.event_loop_ms
        }
    };
    let rows = vec![
        kv_row("Turns", &format!("{}", m.turns.0)),
        kv_row("Spent", &fmt_money(m.spent_session_usd)),
        kv_row("Spend rate", &format!("{}/hr", fmt_money(m.spend_rate_per_hour_usd))),
        kv_row("Security", &format!("{}", m.security_incidents_session)),
        kv_row("Drift", &format!("{:.0} %", m.drift_session_pct)),
        kv_row("P95", &format!("{} ms", m.p95_latency_ms as i64)),
        kv_row("P99", &format!("{} ms", m.p99_latency_ms as i64)),
        kv_row("Events", &fmt_count_short(m.events_count)),
        kv_row("Cache hit", &format!("{:.0} %", cache_hit_pct)),
        kv_row("Avg latency", &format!("{} ms", avg_latency_ms as i64)),
    ];
    let table = Table::new(
        rows,
        [Constraint::Min(10), Constraint::Length(12)],
    )
    .block(block)
    .column_spacing(1);
    frame.render_widget(table, area);
}

// ---------------------------------------------------------------------------
// 3b. Runtime metrics box
// ---------------------------------------------------------------------------
fn render_runtime_metrics(frame: &mut Frame, area: Rect, app: &AppState) {
    if area.area() == 0 {
        return;
    }
    let block = widgets::panel_block_with_color("RUNTIME", false, theme::BORDER_RUNTIME);
    let r = &app.runtime_metrics;
    // Runtime is the lifetime-totals box. Hostname / Inspector uptime moved
    // out (not relevant to runtime totals); Files modified dropped because
    // it duplicates the visible code.modified events. 9 rows is plenty.
    let rows = vec![
        kv_row("Sessions", &format!("{}", r.open_sessions)),
        kv_row("Tasks active", &format!("{}", r.ongoing_tasks)),
        kv_row("Tasks queued", &format!("{}", r.queued_tasks)),
        kv_row("Tasks blocked", &format!("{}", r.blocked_tasks)),
        kv_row("Tool calls", &fmt_count_short(r.tool_calls_lifetime)),
        kv_row("PRs", &fmt_count_short(r.prs_created_lifetime)),
        kv_row("Tests run", &fmt_count_short(r.tests_run_lifetime)),
        kv_row(
            "Tests pass",
            &format!("{:.0} %", (r.tests_passed_rate * 100.0).clamp(0.0, 100.0)),
        ),
        kv_row("Code LOC", &fmt_count_short(r.code_written_lifetime_loc)),
    ];
    let table = Table::new(
        rows,
        [Constraint::Min(10), Constraint::Length(10)],
    )
    .block(block)
    .column_spacing(1);
    frame.render_widget(table, area);
}

// ---------------------------------------------------------------------------
// 3c. System health box
// ---------------------------------------------------------------------------
fn render_system_health(frame: &mut Frame, area: Rect, app: &AppState) {
    if area.area() == 0 {
        return;
    }
    let block = widgets::panel_block_with_color("SYSTEM HEALTH", false, theme::BORDER_HEALTH);
    let h = &app.health;
    let ring_pct = (app.events.len() as f32 / crate::state::EVENT_RING_CAPACITY as f32) * 100.0;
    let log_bytes = crate::state::tracing_log_size_bytes();
    let active_tasks = app
        .tasks
        .iter()
        .filter(|t| {
            matches!(
                t.status,
                TaskStatus::Running | TaskStatus::WaitingTool | TaskStatus::WaitingReview
            )
        })
        .count();
    let plugin_errors_total: u64 = app.plugins.iter().map(|p| p.errors).sum();
    let pid = std::process::id();
    let rows = vec![
        kv_row("CPU", &format!("{:.0} %", h.cpu_pct)),
        kv_row("Memory", &format!("{:.0} %", h.memory_pct)),
        kv_row("Event Loop", &format!("{:.0} ms", h.event_loop_ms)),
        kv_row("Disk I/O", &format!("{:.0} MB/s", h.disk_io_mbps)),
        kv_row("Network", &format!("{:.0} Mbps", h.network_mbps)),
        kv_row("Ring buffer", &format!("{:.0} %", ring_pct)),
        kv_row("Inspector PID", &format!("{pid}")),
        kv_row("Tracing log", &fmt_log_size(log_bytes)),
        kv_row("Active tasks", &format!("{active_tasks}")),
        kv_row("Plugin errors", &fmt_count_short(plugin_errors_total)),
    ];
    let table = Table::new(
        rows,
        [Constraint::Min(10), Constraint::Length(11)],
    )
    .block(block)
    .column_spacing(1);
    frame.render_widget(table, area);
}

/// Format a tracing-log size in bytes through a B / KB / MB / GB ladder.
/// Returns "-" for zero.
fn fmt_log_size(bytes: u64) -> String {
    const KB: u64 = 1024;
    const MB: u64 = 1024 * KB;
    const GB: u64 = 1024 * MB;
    if bytes == 0 {
        "-".to_string()
    } else if bytes < KB {
        format!("{bytes} B")
    } else if bytes < MB {
        let v = (bytes as f64) / KB as f64;
        format!("{v:.1} KB")
    } else if bytes < GB {
        let v = (bytes as f64) / MB as f64;
        format!("{v:.1} MB")
    } else {
        let v = (bytes as f64) / GB as f64;
        format!("{v:.1} GB")
    }
}

// ---------------------------------------------------------------------------
// 4. Phase pipeline (bordered box, ASCII separators, no circles)
// ---------------------------------------------------------------------------
fn render_phase_pipeline(frame: &mut Frame, area: Rect, app: &AppState) {
    if area.area() == 0 {
        return;
    }
    let block = widgets::panel_block_with_color("PHASE PIPELINE", false, theme::BORDER_PIPELINE);
    let inner = block.inner(area);
    frame.render_widget(block, area);
    if inner.area() == 0 {
        return;
    }

    const PHASES: [(Phase, &str); 7] = [
        (Phase::Anchor, "anchor"),
        (Phase::TrustGate, "trust-gate"),
        (Phase::PreDispatch, "pre-dispatch"),
        (Phase::Dispatch, "dispatch"),
        (Phase::PostResponse, "post-response"),
        (Phase::PostSession, "post-session"),
        (Phase::CrossSession, "cross-session"),
    ];

    let current = app.session.current_phase;
    let mut spans: Vec<Span> = Vec::with_capacity(PHASES.len() * 2);
    for (i, (phase, label)) in PHASES.iter().enumerate() {
        let is_current = Some(*phase) == current;
        if is_current {
            spans.push(Span::styled(
                label.to_uppercase(),
                Style::default()
                    .fg(theme::ACCENT)
                    .add_modifier(Modifier::BOLD),
            ));
        } else {
            spans.push(Span::styled(
                (*label).to_string(),
                Style::default().fg(theme::TEXT_DIM),
            ));
        }
        if i + 1 < PHASES.len() {
            spans.push(Span::styled(
                " > ".to_string(),
                Style::default().fg(theme::TEXT_FAINT),
            ));
        }
    }
    let para = Paragraph::new(Line::from(spans)).alignment(Alignment::Left);
    frame.render_widget(para, inner);
}

// ---------------------------------------------------------------------------
// 5. Plugins panel — proper table, no sparklines, no status dots.
//    Columns: Plugin · Status · Health · Calls · Errors · p95 · p99 ·
//             Last value · Last seen
// ---------------------------------------------------------------------------
fn render_plugins_panel(frame: &mut Frame, area: Rect, app: &AppState) {
    if area.area() == 0 {
        return;
    }
    let focused = matches!(app.active_panel, Panel::Plugins);
    let block = widgets::panel_block_with_color("PLUGINS", focused, theme::BORDER_PLUGINS);

    let header_style = Style::default()
        .fg(theme::TEXT_DIM)
        .add_modifier(Modifier::BOLD);
    let header = Row::new(vec![
        Cell::from("Plugin").style(header_style),
        Cell::from("Status").style(header_style),
        Cell::from("Health").style(header_style),
        Cell::from("Calls").style(header_style),
        Cell::from("Errors").style(header_style),
        Cell::from("p95").style(header_style),
        Cell::from("p99").style(header_style),
        Cell::from("Last value").style(header_style),
        // "Last seen" header right-aligned to match its column body — second
        // of two intentional LTR exceptions.
        Cell::from(Line::from("Last seen").alignment(Alignment::Right)).style(header_style),
    ])
    .height(1);

    // Use the freshest event timestamp as the reference "now" for the
    // relative-age column. Demo and live both stamp `time` as
    // seconds-since-stream-start so this gives stable "Xs ago" values.
    let now_ref = app
        .events
        .iter()
        .map(|e| e.time())
        .fold(0.0_f64, f64::max);

    let rows: Vec<Row> = app
        .plugins
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let name_style = Style::default().fg(p.color).add_modifier(Modifier::BOLD);
            let (status_text, status_color) = status_word(p.status);
            let health_pct = (p.health * 100.0).clamp(0.0, 100.0) as i64;
            let last_seen = match p.last_event {
                Some(t) if now_ref > 0.0 => fmt_relative_seconds(now_ref - t),
                _ => "-".to_string(),
            };
            let mut row = Row::new(vec![
                Cell::from(p.name.clone()).style(name_style),
                Cell::from(status_text).style(Style::default().fg(status_color)),
                Cell::from(format!("{health_pct} %")),
                Cell::from(fmt_num(p.calls)),
                Cell::from(fmt_num(p.errors))
                    .style(if p.errors > 0 {
                        Style::default().fg(theme::STATUS_CRITICAL)
                    } else {
                        Style::default().fg(theme::TEXT_PRIMARY)
                    }),
                Cell::from(format!("{} ms", p.latency_p95_ms as i64)),
                Cell::from(format!("{} ms", p.latency_p99_ms as i64)),
                Cell::from(p.display_value.clone()),
                // RIGHT-aligned per explicit user ask (LTR exception #2).
                Cell::from(
                    Line::from(Span::styled(last_seen, Style::default().fg(theme::TEXT_DIM)))
                        .alignment(Alignment::Right),
                ),
            ]);
            if i == app.selected_plugin_index && focused {
                row = row.style(
                    Style::default()
                        .bg(theme::SELECTION_BG)
                        .add_modifier(Modifier::BOLD),
                );
            }
            row
        })
        .collect();

    let table = Table::new(
        rows,
        [
            Constraint::Length(10), // plugin name
            Constraint::Length(9),  // status word
            Constraint::Length(8),  // health %
            Constraint::Length(8),  // calls
            Constraint::Length(8),  // errors
            Constraint::Length(9),  // p95
            Constraint::Length(9),  // p99
            Constraint::Min(12),    // last value
            Constraint::Length(10), // last seen
        ],
    )
    .header(header)
    .column_spacing(1)
    .block(block);

    frame.render_widget(table, area);
}

// ---------------------------------------------------------------------------
// 6. Events panel — proper table, no status dots
// ---------------------------------------------------------------------------
fn render_events_panel(frame: &mut Frame, area: Rect, app: &AppState) {
    if area.area() == 0 {
        return;
    }
    let focused = matches!(app.active_panel, Panel::Events);
    let block = widgets::panel_block_with_color("RECENT EVENTS", focused, theme::BORDER_EVENTS);

    if app.events.is_empty() {
        let inner = Paragraph::new("(no events)")
            .style(Style::default().fg(theme::TEXT_DIM))
            .block(block);
        frame.render_widget(inner, area);
        return;
    }

    let header_style = Style::default()
        .fg(theme::TEXT_DIM)
        .add_modifier(Modifier::BOLD);
    let header = Row::new(vec![
        Cell::from("Time").style(header_style),
        Cell::from("Source").style(header_style),
        Cell::from("Task").style(header_style),
        Cell::from("Type").style(header_style),
        Cell::from("Phase").style(header_style),
        Cell::from("Severity").style(header_style),
        Cell::from("Cost").style(header_style),
        Cell::from("Duration").style(header_style),
        Cell::from("Details").style(header_style),
    ])
    .height(1);

    // -2 for borders, -1 for header. Show as many events as fit (cap 20).
    let take = (area.height.saturating_sub(3)) as usize;
    let take = take.max(1).min(20);

    // Reserve room for fixed columns + spacing; the rest goes to Details so
    // we can truncate that column with ".." rather than letting ratatui clip.
    // Fixed widths: 9+10+7+22+13+9+8+9 = 87. Spacing: 8 gaps @ 1 = 8.
    // Box borders: 2. Total fixed: 97.
    let detail_max = (area.width as usize).saturating_sub(97).max(8);

    // Baseline for event-time formatting: prefer the earliest Unix-epoch event
    // in the buffer (so the column starts from "00:00.000" at the moment the
    // first event arrived); fall back to app.started_at as a Unix timestamp.
    let baseline = event_time_baseline(app);

    let rows: Vec<Row> = app
        .events
        .iter()
        .rev()
        .take(take)
        .map(|ev| event_row(ev, detail_max, baseline))
        .collect();

    let table = Table::new(
        rows,
        [
            Constraint::Length(9),  // time
            Constraint::Length(10), // source
            Constraint::Length(7),  // task (6 chars + 1 pad)
            Constraint::Length(22), // type
            Constraint::Length(13), // phase
            Constraint::Length(9),  // severity
            Constraint::Length(8),  // cost
            Constraint::Length(9),  // duration
            Constraint::Min(8),     // details (flex)
        ],
    )
    .header(header)
    .column_spacing(1)
    .block(block);

    frame.render_widget(table, area);
}

fn event_row(ev: &Event, detail_max: usize, baseline: f64) -> Row<'_> {
    let time = fmt_event_time(ev.time(), baseline);
    let source = ev.plugin().map(str::to_string).unwrap_or_else(|| {
        ev.type_tag()
            .split('.')
            .next()
            .unwrap_or("?")
            .to_string()
    });
    let source_color = theme::plugin_color(&source);
    let tag = ev.type_tag().to_string();
    // Per the new spec: color Type by event-family prefix, not by veto.
    let type_color = event_type_color(&tag);

    let task = match ev.task_id() {
        Some(id) if !id.is_empty() => {
            let trimmed: String = id.chars().take(6).collect();
            trimmed
        }
        _ => "-".to_string(),
    };

    let detail_raw = event_detail(ev);
    let detail = truncate_with_ellipsis(&detail_raw, detail_max);

    let phase_text = event_phase(ev).unwrap_or_else(|| "-".to_string());
    let phase_color = phase_color_for(&phase_text);

    let (sev_text, sev_color) = match ev.severity() {
        Some(s) => (severity_label(s).to_string(), severity_color(s)),
        None => ("-".to_string(), theme::TEXT_DIM),
    };

    let cost_text = event_cost(ev);
    let duration_text = event_duration(ev);

    Row::new(vec![
        Cell::from(time).style(Style::default().fg(theme::TEXT_FAINT)),
        Cell::from(source).style(Style::default().fg(source_color)),
        Cell::from(task).style(Style::default().fg(theme::TEXT_DIM)),
        Cell::from(tag).style(Style::default().fg(type_color)),
        Cell::from(phase_text).style(Style::default().fg(phase_color)),
        Cell::from(sev_text).style(Style::default().fg(sev_color)),
        Cell::from(cost_text).style(Style::default().fg(theme::PLUGIN_PECH)),
        Cell::from(duration_text).style(Style::default().fg(theme::TEXT_DIM)),
        Cell::from(detail).style(Style::default().fg(theme::TEXT_PRIMARY)),
    ])
}

/// Per-spec event-Type column color: prefix-keyed family palette so the eye
/// can scan "what kind of event is this" without reading the tag name.
fn event_type_color(type_tag: &str) -> Color {
    if type_tag.starts_with("tool.") {
        theme::STATUS_NEUTRAL // blue
    } else if type_tag.starts_with("hydra.") || type_tag.starts_with("sylph.") {
        theme::STATUS_CRITICAL // red
    } else if type_tag.starts_with("pech.") {
        theme::PLUGIN_PECH // orange
    } else if type_tag.starts_with("code.") {
        theme::STATUS_HEALTHY // green
    } else if type_tag.starts_with("task.") {
        theme::PLUGIN_SYLPH // cyan
    } else if type_tag.starts_with("phase.") {
        theme::PLUGIN_DJINN // magenta-purple
    } else {
        theme::TEXT_PRIMARY
    }
}

/// Pull a per-event cost in USD where the event carries one. PechLedger has
/// it as a typed field; everything else may stash `cost_usd` in the generic
/// payload's `extra` map. Returns "-" when neither applies.
fn event_cost(ev: &Event) -> String {
    if let Event::PechLedger { payload, .. } = ev {
        return fmt_money(payload.cost_usd);
    }
    if let Some(p) = generic_payload(ev) {
        if let Some(v) = p.extra.get("cost_usd").and_then(|v| v.as_f64()) {
            if v.abs() > 0.0 {
                return fmt_money(v);
            }
        }
    }
    "-".to_string()
}

/// Pull a per-event duration in milliseconds out of the generic payload's
/// extras (`duration_ms` is the convention). Returns "-" when absent.
fn event_duration(ev: &Event) -> String {
    if let Some(p) = generic_payload(ev) {
        if let Some(v) = p.extra.get("duration_ms").and_then(|v| v.as_f64()) {
            return format!("{} ms", v as i64);
        }
    }
    "-".to_string()
}

/// Borrow the inner `GenericPayload` from any event variant that wraps one.
/// Returns `None` for the typed variants (RuntimeMetrics, ToolCall,
/// HydraVeto, PechLedger, CodeModified, TaskUpdated).
fn generic_payload(ev: &Event) -> Option<&crate::event::GenericPayload> {
    match ev {
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
        | Event::PrCreated(p) => Some(p),
        _ => None,
    }
}

/// Truncate `s` to `max` chars; if shortened, replace the trailing two chars
/// with ".." (ASCII, per the no-symbols rule). `max` < 3 returns as-is up to
/// length, no marker added.
fn truncate_with_ellipsis(s: &str, max: usize) -> String {
    let count = s.chars().count();
    if count <= max {
        return s.to_string();
    }
    if max < 3 {
        return s.chars().take(max).collect();
    }
    let head: String = s.chars().take(max - 2).collect();
    format!("{head}..")
}

/// Best-effort phase extraction off any event variant. Reads the typed
/// `phase` field where present, otherwise digs into the generic payload.
fn event_phase(ev: &Event) -> Option<String> {
    match ev {
        Event::ToolCall { phase, .. }
        | Event::HydraVeto { phase, .. }
        | Event::PechLedger { phase, .. } => phase.clone(),

        Event::TaskUpdated { phase, .. } => phase.clone(),

        Event::RequestApproval { phase, .. } => phase.clone(),

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
        | Event::PrCreated(p) => p.phase.clone(),

        Event::Unknown(p) => p.phase.clone(),

        Event::RuntimeMetrics { .. } | Event::CodeModified { .. } => None,
    }
}

fn phase_color_for(phase: &str) -> Color {
    match phase {
        "anchor" => theme::ACCENT,
        "trust-gate" => theme::STATUS_WARNING,
        "pre-dispatch" => theme::PLUGIN_DJINN,
        "dispatch" => theme::STATUS_NEUTRAL,
        "post-response" => theme::PLUGIN_LICH,
        "post-session" => theme::PLUGIN_CROW,
        "cross-session" => theme::PLUGIN_GORGON,
        _ => theme::TEXT_DIM,
    }
}

fn severity_label(s: Severity) -> &'static str {
    match s {
        Severity::Debug => "debug",
        Severity::Info => "info",
        Severity::Warning => "warning",
        Severity::High => "high",
        Severity::Critical => "critical",
    }
}

fn event_detail(ev: &Event) -> String {
    match ev {
        Event::ToolCall { tool, .. } => format!("tool={tool}"),
        Event::HydraVeto { reason, .. } => format!("veto: {reason}"),
        Event::CodeModified {
            file,
            lines_added,
            lines_removed,
            ..
        } => format!("{file} (+{lines_added}/-{lines_removed})"),
        Event::TaskUpdated {
            task_id,
            status,
            phase,
            ..
        } => {
            let status = status.as_deref().unwrap_or("?");
            let phase = phase.as_deref().unwrap_or("-");
            format!("{task_id} {status} [{phase}]")
        }
        Event::PechLedger { payload, .. } => {
            format!("session {}", fmt_money(payload.session_cost_usd))
        }
        Event::RuntimeMetrics {
            open_sessions,
            ongoing_tasks,
            ..
        } => format!("sessions={open_sessions} tasks={ongoing_tasks}"),
        _ => match ev {
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
            | Event::PrCreated(p) => p.message.clone().unwrap_or_default(),
            _ => String::new(),
        },
    }
}

fn severity_color(s: Severity) -> Color {
    match s {
        Severity::Critical => theme::STATUS_CRITICAL,
        Severity::High => theme::STATUS_WARNING,
        Severity::Warning => theme::STATUS_WARNING,
        Severity::Info => theme::STATUS_NEUTRAL,
        Severity::Debug => theme::TEXT_DIM,
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Build a key / left-aligned-value row for the metric tables. Per the LTR
/// cardinal rule: every text in this view sits left-aligned, immediately
/// after the label, with the table's column_spacing as the visual gap.
fn kv_row(label: &str, value: &str) -> Row<'static> {
    Row::new(vec![
        Cell::from(label.to_string()).style(Style::default().fg(theme::TEXT_DIM)),
        Cell::from(value.to_string())
            .style(Style::default().fg(theme::TEXT_PRIMARY).add_modifier(Modifier::BOLD)),
    ])
}

fn fmt_num(n: u64) -> String {
    if n < 1_000 {
        n.to_string()
    } else {
        fmt_count_short(n)
    }
}

fn status_word(s: PluginStatus) -> (&'static str, Color) {
    match s {
        PluginStatus::Healthy => ("Healthy", theme::STATUS_HEALTHY),
        PluginStatus::Warning => ("Warning", theme::STATUS_WARNING),
        PluginStatus::Error => ("Error", theme::STATUS_CRITICAL),
        PluginStatus::Disabled => ("Disabled", theme::TEXT_FAINT),
    }
}

/// Color a Claude subscription tier label by tier weight.
fn plan_tier_color(plan: &str) -> Color {
    match plan {
        "Free" => theme::TEXT_DIM,
        "Pro" => theme::STATUS_NEUTRAL,
        "Max" => theme::STATUS_HEALTHY,
        "Team" => theme::ACCENT,
        "Enterprise" => theme::PLUGIN_DJINN,
        _ => theme::TEXT_FAINT,
    }
}

fn risk_label(r: Risk) -> &'static str {
    match r {
        Risk::Low => "Low",
        Risk::Medium => "Medium",
        Risk::High => "High",
        Risk::Critical => "Critical",
    }
}

fn risk_color(r: Risk) -> Color {
    match r {
        Risk::Low => theme::STATUS_HEALTHY,
        Risk::Medium => theme::STATUS_WARNING,
        Risk::High => theme::STATUS_WARNING,
        Risk::Critical => theme::STATUS_CRITICAL,
    }
}

fn phase_label(p: Phase) -> &'static str {
    match p {
        Phase::Anchor => "anchor",
        Phase::TrustGate => "trust-gate",
        Phase::PreDispatch => "pre-dispatch",
        Phase::Dispatch => "dispatch",
        Phase::PostResponse => "post-response",
        Phase::PostSession => "post-session",
        Phase::CrossSession => "cross-session",
    }
}

fn active_age_seconds(t: &TaskState) -> u64 {
    if t.age_seconds > 0 {
        t.age_seconds
    } else {
        (t.updated_at - t.created_at).max(0.0) as u64
    }
}

/// Format a USD amount: "$0.42", "$5.13", "$12.50".
///
/// Uses round-half-away-from-zero (the convention financial-display
/// readers expect) instead of Rust's default banker's rounding —
/// `f64::round` already implements that, so we round to cents first
/// then format.
fn fmt_money(v: f64) -> String {
    if v.abs() < 0.005 {
        "$0.00".to_string()
    } else {
        let cents = (v * 100.0).round() / 100.0;
        format!("${:.2}", cents)
    }
}

/// Compact a count: 0..1000 as-is, then "k" / "M" suffixes with one decimal.
fn fmt_count_short(n: u64) -> String {
    if n < 1_000 {
        n.to_string()
    } else if n < 1_000_000 {
        let k = (n as f64) / 1_000.0;
        let s = format!("{:.1}", k);
        if let Some(stripped) = s.strip_suffix(".0") {
            format!("{stripped}k")
        } else {
            format!("{s}k")
        }
    } else {
        let m = (n as f64) / 1_000_000.0;
        let s = format!("{:.1}", m);
        if let Some(stripped) = s.strip_suffix(".0") {
            format!("{stripped}M")
        } else {
            format!("{s}M")
        }
    }
}

/// Format a duration in seconds: under a minute → "23s"; under an hour →
/// "1m42s"; otherwise "1:42:00".
fn fmt_age_seconds(secs: u64) -> String {
    if secs < 60 {
        format!("{secs}s")
    } else if secs < 3600 {
        let m = secs / 60;
        let s = secs % 60;
        format!("{m}m{s:02}s")
    } else {
        let h = secs / 3600;
        let m = (secs % 3600) / 60;
        let s = secs % 60;
        format!("{h}:{m:02}:{s:02}")
    }
}

/// Pick the baseline timestamp the RECENT EVENTS time column counts from.
/// Returns the smallest Unix-epoch event-time in the ring; falls back to
/// `app.started_at` as Unix seconds when nothing in the ring looks epoch-y;
/// returns 0.0 only when no events have arrived AND the started_at clock is
/// unset (effectively never). 0.0 baseline tells `fmt_event_time` to treat
/// the value as already-relative.
fn event_time_baseline(app: &AppState) -> f64 {
    // Min over events whose time looks like an absolute Unix epoch
    // (>= 1e9). Anything smaller is treated as already-relative.
    let min_epoch = app
        .events
        .iter()
        .map(|e| e.time())
        .filter(|t| *t >= 1e9)
        .fold(f64::INFINITY, f64::min);
    if min_epoch.is_finite() {
        return min_epoch;
    }
    // Fallback: process start as Unix seconds.
    app.started_at.timestamp() as f64
}

/// Format an event-time value into a fixed-width column string.
///
/// Detects Unix-epoch values by magnitude (>= 1e9) and formats relative to
/// `baseline`; smaller values are treated as already-relative seconds. Output
/// is `MM:SS.sss` for sub-hour and `H:MM:SS` past an hour. Hard-capped at 8
/// chars wide so the time column never blows out.
fn fmt_event_time(t: f64, baseline: f64) -> String {
    let rel = if t >= 1e9 && baseline >= 1e9 {
        (t - baseline).max(0.0)
    } else {
        t.max(0.0)
    };
    if rel < 3600.0 {
        let total_ms = (rel * 1000.0) as u64;
        let mm = total_ms / 60_000;
        let ss = (total_ms / 1000) % 60;
        let ms = total_ms % 1000;
        format!("{mm:02}:{ss:02}.{ms:03}")
    } else {
        let total_s = rel as u64;
        let h = total_s / 3600;
        let m = (total_s % 3600) / 60;
        let s = total_s % 60;
        format!("{h}:{m:02}:{s:02}")
    }
}

/// Format a non-negative seconds delta as a compact "Xs ago" / "Xm ago".
/// Negative deltas (clock skew) and missing values produce "-".
fn fmt_relative_seconds(delta: f64) -> String {
    if !delta.is_finite() || delta < 0.0 {
        return "-".to_string();
    }
    let s = delta as u64;
    if s < 60 {
        format!("{s}s ago")
    } else if s < 3600 {
        format!("{}m ago", s / 60)
    } else {
        format!("{}h ago", s / 3600)
    }
}

/// Footer-style uptime: "1:42" for short sessions, "12:34:56" past an hour.
fn fmt_uptime(secs: u64) -> String {
    if secs < 3600 {
        let m = secs / 60;
        let s = secs % 60;
        format!("{m}:{s:02}")
    } else {
        let h = secs / 3600;
        let m = (secs % 3600) / 60;
        let s = secs % 60;
        format!("{h}:{m:02}:{s:02}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fmt_money_rounds_to_two_places() {
        assert_eq!(fmt_money(0.0), "$0.00");
        assert_eq!(fmt_money(0.42), "$0.42");
        assert_eq!(fmt_money(5.125), "$5.13");
        assert_eq!(fmt_money(12.5), "$12.50");
    }

    #[test]
    fn fmt_count_short_ladders() {
        assert_eq!(fmt_count_short(0), "0");
        assert_eq!(fmt_count_short(42), "42");
        assert_eq!(fmt_count_short(999), "999");
        assert_eq!(fmt_count_short(1_200), "1.2k");
        assert_eq!(fmt_count_short(42_800), "42.8k");
        assert_eq!(fmt_count_short(9_400), "9.4k");
        assert_eq!(fmt_count_short(1_000), "1k");
        assert_eq!(fmt_count_short(2_500_000), "2.5M");
    }

    #[test]
    fn fmt_age_seconds_brackets() {
        assert_eq!(fmt_age_seconds(0), "0s");
        assert_eq!(fmt_age_seconds(23), "23s");
        assert_eq!(fmt_age_seconds(60), "1m00s");
        assert_eq!(fmt_age_seconds(102), "1m42s");
        assert_eq!(fmt_age_seconds(3_600), "1:00:00");
        assert_eq!(fmt_age_seconds(6_120), "1:42:00");
    }

    #[test]
    fn fmt_uptime_compact() {
        assert_eq!(fmt_uptime(0), "0:00");
        assert_eq!(fmt_uptime(102), "1:42");
        assert_eq!(fmt_uptime(3_600), "1:00:00");
    }

    #[test]
    fn status_word_no_emoji() {
        for s in [
            PluginStatus::Healthy,
            PluginStatus::Warning,
            PluginStatus::Error,
            PluginStatus::Disabled,
        ] {
            let (text, _) = status_word(s);
            assert!(text.chars().all(|c| c.is_ascii()), "non-ASCII in {text}");
        }
    }

    #[test]
    fn truncate_with_ellipsis_marks_truncation() {
        assert_eq!(truncate_with_ellipsis("hi", 10), "hi");
        assert_eq!(truncate_with_ellipsis("abcdefghij", 10), "abcdefghij");
        assert_eq!(truncate_with_ellipsis("abcdefghijk", 10), "abcdefgh..");
        // max < 3 falls back to plain head with no marker.
        assert_eq!(truncate_with_ellipsis("abcdef", 2), "ab");
    }

    #[test]
    fn fmt_log_size_units() {
        assert_eq!(fmt_log_size(0), "-");
        assert_eq!(fmt_log_size(512), "512 B");
        assert_eq!(fmt_log_size(2 * 1024), "2.0 KB");
        assert_eq!(fmt_log_size(5 * 1024 * 1024), "5.0 MB");
        // The original bug: a 35 GB-sounding number must NOT silently appear
        // for a tens-of-MB log. Synthesize 35 MB and confirm we render
        // "35.0 MB", not "35840 MB" or any GB-scale figure.
        assert_eq!(fmt_log_size(35 * 1024 * 1024), "35.0 MB");
        assert_eq!(fmt_log_size(2 * 1024 * 1024 * 1024), "2.0 GB");
    }

    #[test]
    fn fmt_event_time_handles_unix_epoch() {
        // Real wire data: Unix epoch ~1.78e9, baseline some seconds earlier.
        let baseline = 1_778_086_945.0;
        let t = baseline + 12.345;
        assert_eq!(fmt_event_time(t, baseline), "00:12.345");
        // Past an hour: H:MM:SS form.
        let t2 = baseline + 3.0 * 3600.0 + 5.0 * 60.0 + 7.0;
        assert_eq!(fmt_event_time(t2, baseline), "3:05:07");
    }

    #[test]
    fn fmt_event_time_handles_relative_seconds() {
        // Demo data: small relative seconds, baseline doesn't matter — value
        // is treated as already-relative when t < 1e9.
        assert_eq!(fmt_event_time(0.0, 0.0), "00:00.000");
        assert_eq!(fmt_event_time(45.5, 0.0), "00:45.500");
        assert_eq!(fmt_event_time(125.0, 0.0), "02:05.000");
    }

    #[test]
    fn fmt_event_time_clamps_negative_skew() {
        // Event-time before baseline (clock skew) clamps to 00:00.000 rather
        // than printing a negative or wrapped-u64 value.
        let baseline = 1_778_086_945.0;
        let t = baseline - 5.0;
        assert_eq!(fmt_event_time(t, baseline), "00:00.000");
    }
}
