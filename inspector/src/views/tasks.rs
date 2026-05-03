//! Active Tasks view — cross-session in-flight work.
//!
//! Top: status counters. Middle: sortable table over `app.tasks`. Bottom:
//! detail pane for the selected row. Empty state when the runtime is idle.

use ratatui::Frame;
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Cell, Paragraph, Row, Table, Wrap};

use crate::event::Phase;
use crate::state::{AppState, Risk, SortMode, TaskState, TaskStatus};
use crate::ui::theme;
use crate::ui::widgets;

// ---- private formatting helpers -------------------------------------------

/// Format a duration in seconds as `23s`, `1m42s`, `4m10s`, `2h05m`.
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
        format!("{h}h{m:02}m")
    }
}

#[allow(dead_code)]
fn fmt_count_short(n: u64) -> String {
    if n >= 1_000 {
        let k = (n as f64) / 1000.0;
        format!("{k:.1}k")
    } else {
        format!("{n}")
    }
}

#[allow(dead_code)]
fn fmt_money(usd: f64) -> String {
    format!("${usd:.2}")
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
        out.push('\u{2026}');
        out
    }
}

fn status_label(s: TaskStatus) -> &'static str {
    match s {
        TaskStatus::Queued => "Queued",
        TaskStatus::Running => "Running",
        TaskStatus::WaitingTool => "WaitTool",
        TaskStatus::WaitingReview => "WaitRev",
        TaskStatus::Blocked => "Blocked",
        TaskStatus::Failed => "Failed",
        TaskStatus::Completed => "Done",
    }
}

fn status_color(s: TaskStatus) -> Color {
    match s {
        TaskStatus::Running => theme::STATUS_HEALTHY,
        TaskStatus::WaitingTool => theme::STATUS_NEUTRAL,
        TaskStatus::WaitingReview => theme::STATUS_NEUTRAL,
        TaskStatus::Blocked => theme::STATUS_CRITICAL,
        TaskStatus::Queued => theme::TEXT_DIM,
        TaskStatus::Failed => theme::STATUS_CRITICAL,
        TaskStatus::Completed => theme::TEXT_DIM,
    }
}

fn risk_label(r: Risk) -> &'static str {
    match r {
        Risk::Low => "Low",
        Risk::Medium => "Med",
        Risk::High => "High",
        Risk::Critical => "Crit",
    }
}

fn risk_color(r: Risk) -> Color {
    match r {
        Risk::Low => theme::STATUS_HEALTHY,
        Risk::Medium => theme::STATUS_WARNING,
        // Distinct orange-ish high vs. red critical.
        Risk::High => Color::Rgb(255, 140, 80),
        Risk::Critical => theme::STATUS_CRITICAL,
    }
}

fn phase_label(p: Option<Phase>) -> &'static str {
    match p {
        Some(Phase::Anchor) => "anchor",
        Some(Phase::TrustGate) => "trust-gate",
        Some(Phase::PreDispatch) => "pre-disp",
        Some(Phase::Dispatch) => "dispatch",
        Some(Phase::PostResponse) => "post-resp",
        Some(Phase::PostSession) => "post-sess",
        Some(Phase::CrossSession) => "cross-sess",
        None => "\u{2014}",
    }
}

fn truncate_session(id: &str) -> String {
    if id.chars().count() <= 8 {
        id.to_string()
    } else {
        id.chars().take(8).collect()
    }
}

/// Format a unix-seconds timestamp as a relative offset from now using the
/// app's frame of reference: just shows `Ns ago` / `Nm ago` / `Nh ago`.
fn fmt_relative_now(then: f64) -> String {
    let now = chrono::Utc::now().timestamp() as f64;
    let delta = (now - then).max(0.0) as u64;
    if delta < 60 {
        format!("{delta}s ago")
    } else if delta < 3600 {
        format!("{}m ago", delta / 60)
    } else {
        format!("{}h ago", delta / 3600)
    }
}

// ---- sorting --------------------------------------------------------------

fn sorted_indices(app: &AppState) -> Vec<usize> {
    let mut idx: Vec<usize> = (0..app.tasks.len()).collect();
    match app.sort_mode {
        SortMode::ByTime => {
            // Most recently updated first.
            idx.sort_by(|a, b| {
                app.tasks[*b]
                    .updated_at
                    .partial_cmp(&app.tasks[*a].updated_at)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
        }
        _ => {
            // Default: oldest age first → "age desc" means longest-lived first.
            idx.sort_by(|a, b| app.tasks[*b].age_seconds.cmp(&app.tasks[*a].age_seconds));
        }
    }
    idx
}

// ---- top-level render -----------------------------------------------------

pub fn render(frame: &mut Frame, area: Rect, app: &AppState) {
    let outer = widgets::panel_block("Active Tasks", false);
    let inner = outer.inner(area);
    frame.render_widget(outer, area);

    if inner.height == 0 || inner.width == 0 {
        return;
    }

    // Stat row 4 lines (3 inside the cards + chrome), table flexible, detail
    // bottom 6 lines if room allows.
    let stat_h: u16 = if inner.height >= 14 { 4 } else { 0 };
    let detail_h: u16 = if inner.height >= 18 { 6 } else { 0 };
    let table_h = inner
        .height
        .saturating_sub(stat_h)
        .saturating_sub(detail_h)
        .max(1);

    let mut constraints: Vec<Constraint> = Vec::new();
    if stat_h > 0 {
        constraints.push(Constraint::Length(stat_h));
    }
    constraints.push(Constraint::Length(table_h));
    if detail_h > 0 {
        constraints.push(Constraint::Length(detail_h));
    }

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints(constraints)
        .split(inner);

    let mut cur = 0usize;

    if stat_h > 0 {
        render_stat_row(frame, chunks[cur], app);
        cur += 1;
    }

    if app.tasks.is_empty() {
        let p = Paragraph::new("(no active tasks \u{2014} runtime is idle)")
            .style(theme::dim_style());
        frame.render_widget(p, chunks[cur]);
    } else {
        render_table(frame, chunks[cur], app);
    }
    cur += 1;

    if detail_h > 0 && cur < chunks.len() {
        render_detail(frame, chunks[cur], app);
    }
}

fn render_stat_row(frame: &mut Frame, area: Rect, app: &AppState) {
    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Ratio(1, 5),
            Constraint::Ratio(1, 5),
            Constraint::Ratio(1, 5),
            Constraint::Ratio(1, 5),
            Constraint::Ratio(1, 5),
        ])
        .split(area);

    let mut running = 0u64;
    let mut queued = 0u64;
    let mut waiting = 0u64;
    let mut blocked = 0u64;
    let mut failed = 0u64;

    for t in &app.tasks {
        match t.status {
            TaskStatus::Running => running += 1,
            TaskStatus::Queued => queued += 1,
            TaskStatus::WaitingTool | TaskStatus::WaitingReview => waiting += 1,
            TaskStatus::Blocked => blocked += 1,
            TaskStatus::Failed => failed += 1,
            TaskStatus::Completed => {}
        }
    }

    widgets::render_metric_card(
        frame,
        cols[0],
        "Running",
        &running.to_string(),
        None,
        theme::STATUS_HEALTHY,
    );
    widgets::render_metric_card(
        frame,
        cols[1],
        "Queued",
        &queued.to_string(),
        None,
        theme::TEXT_DIM,
    );
    widgets::render_metric_card(
        frame,
        cols[2],
        "Waiting",
        &waiting.to_string(),
        None,
        theme::STATUS_NEUTRAL,
    );
    widgets::render_metric_card(
        frame,
        cols[3],
        "Blocked",
        &blocked.to_string(),
        None,
        theme::STATUS_CRITICAL,
    );
    widgets::render_metric_card(
        frame,
        cols[4],
        "Failed",
        &failed.to_string(),
        None,
        theme::STATUS_CRITICAL,
    );
}

fn render_table(frame: &mut Frame, area: Rect, app: &AppState) {
    if area.height == 0 {
        return;
    }

    let order = sorted_indices(app);

    let header_cells = [
        "task_id", "session", "status", "intent", "where", "phase", "risk", "age",
    ]
    .into_iter()
    .map(|h| Cell::from(h).style(theme::title_style()));
    let header = Row::new(header_cells).height(1);

    let selected_row_pos = order
        .iter()
        .position(|i| *i == app.selected_task_index);

    // Width budget for the flexible "intent" column.
    let fixed = 12 + 1 + 8 + 1 + 9 + 1 + 18 + 1 + 10 + 1 + 5 + 1 + 7;
    let intent_width = (area.width as usize).saturating_sub(fixed).max(8);

    let rows: Vec<Row> = order
        .iter()
        .map(|i| {
            let t: &TaskState = &app.tasks[*i];
            let intent = truncate(&t.intent, intent_width);
            let where_ = truncate(&t.file_or_area, 18);
            let task_id_short = truncate(&t.task_id, 12);

            Row::new(vec![
                Cell::from(task_id_short).style(Style::default().fg(theme::ACCENT)),
                Cell::from(truncate_session(&t.session_id))
                    .style(Style::default().fg(theme::TEXT_DIM)),
                Cell::from(status_label(t.status))
                    .style(Style::default().fg(status_color(t.status))),
                Cell::from(intent).style(Style::default().fg(theme::TEXT_PRIMARY)),
                Cell::from(where_).style(Style::default().fg(theme::TEXT_DIM)),
                Cell::from(phase_label(t.phase))
                    .style(Style::default().fg(theme::TEXT_DIM)),
                Cell::from(risk_label(t.risk))
                    .style(Style::default().fg(risk_color(t.risk))),
                Cell::from(fmt_age_seconds(t.age_seconds))
                    .style(Style::default().fg(theme::TEXT_DIM)),
            ])
            .height(1)
        })
        .collect();

    let widths = [
        Constraint::Length(12),
        Constraint::Length(8),
        Constraint::Length(9),
        Constraint::Min(8),
        Constraint::Length(18),
        Constraint::Length(10),
        Constraint::Length(5),
        Constraint::Length(7),
    ];

    let mut table = Table::new(rows, widths)
        .header(header)
        .style(theme::panel_style());

    if let Some(pos) = selected_row_pos {
        table = table.highlight_style(
            Style::default()
                .bg(Color::Rgb(30, 40, 60))
                .add_modifier(Modifier::BOLD),
        );
        let mut state = ratatui::widgets::TableState::default();
        state.select(Some(pos));
        frame.render_stateful_widget(table, area, &mut state);
    } else {
        frame.render_widget(table, area);
    }
}

fn render_detail(frame: &mut Frame, area: Rect, app: &AppState) {
    let block = widgets::panel_block("Selected Task Detail", false);
    let inner = block.inner(area);
    frame.render_widget(block, area);

    if inner.height == 0 || inner.width == 0 {
        return;
    }

    if app.tasks.is_empty() {
        let p =
            Paragraph::new("(select a task to inspect)").style(theme::dim_style());
        frame.render_widget(p, inner);
        return;
    }

    let idx = app.selected_task_index.min(app.tasks.len() - 1);
    let t = &app.tasks[idx];

    let mut lines: Vec<Line> = Vec::new();

    lines.push(Line::from(vec![
        Span::styled(
            t.task_id.clone(),
            Style::default()
                .fg(theme::ACCENT)
                .add_modifier(Modifier::BOLD),
        ),
        Span::raw("  "),
        Span::styled(
            status_label(t.status).to_string(),
            Style::default().fg(status_color(t.status)),
        ),
        Span::raw("  "),
        Span::styled(
            format!("risk: {}", risk_label(t.risk)),
            Style::default().fg(risk_color(t.risk)),
        ),
    ]));

    lines.push(Line::from(vec![
        Span::styled("intent  ", theme::dim_style()),
        Span::styled(t.intent.clone(), Style::default().fg(theme::TEXT_PRIMARY)),
    ]));

    lines.push(Line::from(vec![
        Span::styled("phase   ", theme::dim_style()),
        Span::styled(
            phase_label(t.phase).to_string(),
            Style::default().fg(theme::TEXT_PRIMARY),
        ),
        Span::raw("    "),
        Span::styled("where   ", theme::dim_style()),
        Span::styled(
            t.file_or_area.clone(),
            Style::default().fg(theme::TEXT_PRIMARY),
        ),
    ]));

    if let Some(reason) = &t.blocked_reason {
        lines.push(Line::from(vec![
            Span::styled("blocked ", Style::default().fg(theme::STATUS_CRITICAL)),
            Span::styled(reason.clone(), Style::default().fg(theme::TEXT_PRIMARY)),
        ]));
    }

    lines.push(Line::from(vec![
        Span::styled("created ", theme::dim_style()),
        Span::styled(
            fmt_relative_now(t.created_at),
            Style::default().fg(theme::TEXT_PRIMARY),
        ),
        Span::raw("    "),
        Span::styled("updated ", theme::dim_style()),
        Span::styled(
            fmt_relative_now(t.updated_at),
            Style::default().fg(theme::TEXT_PRIMARY),
        ),
    ]));

    let suggestion = match t.status {
        TaskStatus::WaitingReview => Some("Press 'a' to approve"),
        TaskStatus::Blocked => Some("Press 'u' to unblock"),
        TaskStatus::Failed => Some("Press 'r' to retry"),
        _ => None,
    };
    if let Some(s) = suggestion {
        lines.push(Line::from(Span::styled(
            s.to_string(),
            Style::default().fg(theme::ACCENT),
        )));
    }

    let para = Paragraph::new(lines)
        .style(theme::panel_style())
        .wrap(Wrap { trim: false });
    frame.render_widget(para, inner);
}
