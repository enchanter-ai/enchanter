//! Runtime totals view — lifetime / cross-session impact.
//!
//! 16 metric cards in a 4×4 grid plus a bottom Trend strip. All numbers come
//! from `app.runtime_metrics`; the Trend strip falls back to em-dash
//! placeholders when no event-derived series is available yet.

use ratatui::Frame;
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::Style;
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;

use crate::state::AppState;
use crate::ui::theme;
use crate::ui::widgets;

// ---- private formatting helpers -------------------------------------------

#[allow(dead_code)]
fn fmt_age_seconds(secs: u64) -> String {
    if secs < 60 {
        format!("{secs}s")
    } else {
        let m = secs / 60;
        let s = secs % 60;
        format!("{m}m{s:02}s")
    }
}

/// Compact integer formatting: 999 → "999", 9_400 → "9.4k", 42_800 → "42.8k".
fn fmt_count_short(n: u64) -> String {
    if n >= 1_000 {
        let k = (n as f64) / 1000.0;
        format!("{k:.1}k")
    } else {
        format!("{n}")
    }
}

fn fmt_money(usd: f64) -> String {
    format!("${usd:.2}")
}

fn fmt_pct(rate: f32) -> String {
    let pct = (rate * 100.0).round() as i32;
    format!("{pct}%")
}

// ---- top-level render -----------------------------------------------------

pub fn render(frame: &mut Frame, area: Rect, app: &AppState) {
    let outer = widgets::panel_block("Runtime Totals", false);
    let inner = outer.inner(area);
    frame.render_widget(outer, area);

    if inner.height == 0 || inner.width == 0 {
        return;
    }

    // 4 grid rows + 1 trend row. Cards want ~3 lines each; trend wants 5-ish.
    // If the box is too short, collapse the trend section.
    let trend_h: u16 = if inner.height >= 18 { 6 } else { 0 };
    let grid_h = inner.height.saturating_sub(trend_h);

    let outer_chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints(if trend_h > 0 {
            vec![Constraint::Length(grid_h), Constraint::Length(trend_h)]
        } else {
            vec![Constraint::Length(grid_h)]
        })
        .split(inner);

    render_grid(frame, outer_chunks[0], app);
    if trend_h > 0 && outer_chunks.len() > 1 {
        render_trend(frame, outer_chunks[1], app);
    }
}

fn render_grid(frame: &mut Frame, area: Rect, app: &AppState) {
    if area.height == 0 {
        return;
    }
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Ratio(1, 4),
            Constraint::Ratio(1, 4),
            Constraint::Ratio(1, 4),
            Constraint::Ratio(1, 4),
        ])
        .split(area);

    let row_cells = |r: Rect| {
        Layout::default()
            .direction(Direction::Horizontal)
            .constraints([
                Constraint::Ratio(1, 4),
                Constraint::Ratio(1, 4),
                Constraint::Ratio(1, 4),
                Constraint::Ratio(1, 4),
            ])
            .split(r)
    };

    let m = &app.runtime_metrics;

    // ---- Row 1 — current activity (STATUS_NEUTRAL) -----------------------
    let r1 = row_cells(rows[0]);
    widgets::render_metric_card(
        frame,
        r1[0],
        "Open Sessions",
        &fmt_count_short(m.open_sessions as u64),
        None,
        theme::STATUS_NEUTRAL,
    );
    widgets::render_metric_card(
        frame,
        r1[1],
        "Ongoing Tasks",
        &fmt_count_short(m.ongoing_tasks as u64),
        None,
        theme::STATUS_NEUTRAL,
    );
    widgets::render_metric_card(
        frame,
        r1[2],
        "Queued Tasks",
        &fmt_count_short(m.queued_tasks as u64),
        None,
        theme::STATUS_NEUTRAL,
    );
    widgets::render_metric_card(
        frame,
        r1[3],
        "Blocked Tasks",
        &fmt_count_short(m.blocked_tasks as u64),
        None,
        theme::STATUS_NEUTRAL,
    );

    // ---- Row 2 — code (TEXT_PRIMARY) -------------------------------------
    let r2 = row_cells(rows[1]);
    widgets::render_metric_card(
        frame,
        r2[0],
        "Code Written (LOC)",
        &fmt_count_short(m.code_written_lifetime_loc),
        None,
        theme::TEXT_PRIMARY,
    );
    widgets::render_metric_card(
        frame,
        r2[1],
        "Code Modified (LOC)",
        &fmt_count_short(m.code_modified_lifetime_loc),
        None,
        theme::TEXT_PRIMARY,
    );
    widgets::render_metric_card(
        frame,
        r2[2],
        "Files Created",
        &fmt_count_short(m.files_created_lifetime),
        None,
        theme::TEXT_PRIMARY,
    );
    widgets::render_metric_card(
        frame,
        r2[3],
        "Files Modified",
        &fmt_count_short(m.files_modified_lifetime),
        None,
        theme::TEXT_PRIMARY,
    );

    // ---- Row 3 — work output (STATUS_HEALTHY) ----------------------------
    let r3 = row_cells(rows[2]);
    widgets::render_metric_card(
        frame,
        r3[0],
        "Tool Calls",
        &fmt_count_short(m.tool_calls_lifetime),
        None,
        theme::STATUS_HEALTHY,
    );
    widgets::render_metric_card(
        frame,
        r3[1],
        "PRs Created",
        &fmt_count_short(m.prs_created_lifetime),
        None,
        theme::STATUS_HEALTHY,
    );
    widgets::render_metric_card(
        frame,
        r3[2],
        "Tests Run",
        &fmt_count_short(m.tests_run_lifetime),
        None,
        theme::STATUS_HEALTHY,
    );
    widgets::render_metric_card(
        frame,
        r3[3],
        "Test Pass Rate",
        &fmt_pct(m.tests_passed_rate),
        None,
        theme::STATUS_HEALTHY,
    );

    // ---- Row 4 — outcomes (mixed) ----------------------------------------
    let r4 = row_cells(rows[3]);
    widgets::render_metric_card(
        frame,
        r4[0],
        "Successful Tasks",
        &fmt_count_short(m.successful_tasks_lifetime),
        None,
        theme::STATUS_HEALTHY,
    );
    widgets::render_metric_card(
        frame,
        r4[1],
        "Failed Tasks",
        &fmt_count_short(m.failed_tasks_lifetime),
        None,
        theme::STATUS_WARNING,
    );
    widgets::render_metric_card(
        frame,
        r4[2],
        "Vetoes",
        &fmt_count_short(m.vetoes_lifetime),
        None,
        theme::STATUS_CRITICAL,
    );
    widgets::render_metric_card(
        frame,
        r4[3],
        "Total Spend",
        &fmt_money(m.total_spend_lifetime_usd),
        None,
        theme::PLUGIN_PECH,
    );
}

fn render_trend(frame: &mut Frame, area: Rect, _app: &AppState) {
    let block = widgets::panel_block("Trend", false);
    let inner = block.inner(area);
    frame.render_widget(block, area);

    if inner.height == 0 || inner.width == 0 {
        return;
    }

    // Synthesize-from-history is out of scope here (we don't keep per-minute
    // bucketed series in AppState). Render placeholders at 60-cell width so
    // the layout is right; a future iteration can fill these in.
    let width: usize = (inner.width as usize).min(60).max(8);
    let placeholder = widgets::sparkline_string(&[], width);

    let label_color = theme::TEXT_DIM;

    let lines = vec![
        Line::from(vec![
            Span::styled(
                format!("{:<22}", "tool calls/min"),
                Style::default().fg(label_color),
            ),
            Span::styled(
                placeholder.clone(),
                Style::default().fg(theme::STATUS_HEALTHY),
            ),
        ]),
        Line::from(vec![
            Span::styled(
                format!("{:<22}", "vetoes/hour"),
                Style::default().fg(label_color),
            ),
            Span::styled(
                placeholder.clone(),
                Style::default().fg(theme::STATUS_CRITICAL),
            ),
        ]),
        Line::from(vec![
            Span::styled(
                format!("{:<22}", "spend/hour"),
                Style::default().fg(label_color),
            ),
            Span::styled(placeholder.clone(), Style::default().fg(theme::PLUGIN_PECH)),
        ]),
        Line::from(vec![
            Span::styled(
                format!("{:<22}", "sessions over time"),
                Style::default().fg(label_color),
            ),
            Span::styled(placeholder, Style::default().fg(theme::STATUS_NEUTRAL)),
        ]),
    ];

    let p = Paragraph::new(lines).style(theme::panel_style());
    frame.render_widget(p, inner);
}
