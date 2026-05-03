//! Drift view — Djinn intent tracking.
//!
//! Shows anchor (stated) intent, current (inferred) intent, drift score,
//! drift-over-time sparkline, off-task warnings, and the intent timeline.

use ratatui::Frame;
use ratatui::layout::{Alignment, Constraint, Direction, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Cell, Paragraph, Row, Table};

use crate::event::{Event, Severity};
use crate::state::AppState;
use crate::ui::{theme, widgets};

// ---- formatting helpers ---------------------------------------------------

/// `0%`, `12%`, `100%`. Clamped to a sane range for display.
fn fmt_pct_int(pct: f32) -> String {
    let n = pct.round().clamp(0.0, 999.0) as i64;
    format!("{n}%")
}

/// Best-effort extraction of a string field from a generic payload's `extra`
/// map. Returns `None` if absent or not a JSON string.
fn extract_str<'a>(
    extra: &'a std::collections::BTreeMap<String, serde_json::Value>,
    key: &str,
) -> Option<&'a str> {
    extra.get(key).and_then(|v| v.as_str())
}

/// Best-effort extraction of a numeric drift value (0.0 ..= 1.0 or 0..=100).
fn extract_drift_value(extra: &std::collections::BTreeMap<String, serde_json::Value>) -> Option<f64> {
    for k in ["drift", "drift_score", "drift_pct", "score"] {
        if let Some(v) = extra.get(k).and_then(|v| v.as_f64()) {
            return Some(v);
        }
    }
    None
}

/// Truncate to `max` chars, suffix `…` if cut.
fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
        out.push('\u{2026}');
        out
    }
}

// ---- main render ----------------------------------------------------------

pub fn render(frame: &mut Frame, area: Rect, app: &AppState) {
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(5), // top cards
            Constraint::Length(5), // drift-over-time sparkline panel
            Constraint::Min(8),    // off-task warnings + intent timeline
        ])
        .split(area);

    render_top_cards(frame, rows[0], app);
    render_drift_chart(frame, rows[1], app);

    let bottom = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
        .split(rows[2]);

    render_off_task_warnings(frame, bottom[0], app);
    render_intent_timeline(frame, bottom[1], app);
}

// ---- top cards: anchor, current, drift score -----------------------------

fn render_top_cards(frame: &mut Frame, area: Rect, app: &AppState) {
    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Percentage(40),
            Constraint::Percentage(40),
            Constraint::Percentage(20),
        ])
        .split(area);

    // Most recent anchor + drift events.
    let anchor_intent = app
        .events
        .iter()
        .rev()
        .find_map(|e| match e {
            Event::DjinnAnchor(p) => extract_str(&p.extra, "intent")
                .or_else(|| p.message.as_deref())
                .map(|s| s.to_string()),
            _ => None,
        })
        .unwrap_or_else(|| "—".to_string());

    let current_intent = app
        .events
        .iter()
        .rev()
        .find_map(|e| match e {
            Event::DjinnDrift(p) => extract_str(&p.extra, "current_intent")
                .or_else(|| extract_str(&p.extra, "intent"))
                .or_else(|| p.message.as_deref())
                .map(|s| s.to_string()),
            _ => None,
        })
        .unwrap_or_else(|| "—".to_string());

    widgets::render_metric_card(
        frame,
        cols[0],
        "Anchor Intent",
        &truncate(&anchor_intent, 40),
        None,
        theme::PLUGIN_DJINN,
    );
    widgets::render_metric_card(
        frame,
        cols[1],
        "Current Intent",
        &truncate(&current_intent, 40),
        None,
        theme::ACCENT,
    );

    let drift = app.metrics.drift_session_pct;
    let drift_color = if drift >= 50.0 {
        theme::STATUS_CRITICAL
    } else if drift >= 20.0 {
        theme::STATUS_WARNING
    } else {
        theme::STATUS_HEALTHY
    };
    widgets::render_metric_card(
        frame,
        cols[2],
        "Drift Score",
        &fmt_pct_int(drift),
        None,
        drift_color,
    );
}

// ---- drift over time sparkline -------------------------------------------

fn render_drift_chart(frame: &mut Frame, area: Rect, app: &AppState) {
    let block = widgets::panel_block("Drift over time", false);
    let inner = block.inner(area);
    frame.render_widget(block, area);

    // Collect drift values from djinn.drift events, oldest → newest.
    let drift_series: Vec<f64> = app
        .events
        .iter()
        .filter_map(|e| match e {
            Event::DjinnDrift(p) => extract_drift_value(&p.extra),
            _ => None,
        })
        .collect();

    if drift_series.is_empty() {
        let empty = Paragraph::new(Line::from(Span::styled(
            "(no drift events — agent is on-task or drift detection disabled)",
            Style::default().fg(theme::TEXT_FAINT),
        )))
        .alignment(Alignment::Center);
        frame.render_widget(empty, inner);
        return;
    }

    // Scale to u64 for sparkline_string. Multiply by 1000 to retain precision.
    let scaled: Vec<u64> = drift_series
        .iter()
        .map(|v| (v.max(0.0) * 1000.0) as u64)
        .collect();

    let min_v = drift_series
        .iter()
        .copied()
        .fold(f64::INFINITY, f64::min);
    let max_v = drift_series
        .iter()
        .copied()
        .fold(f64::NEG_INFINITY, f64::max);

    let width = inner.width.saturating_sub(20).max(20) as usize;
    let spark = widgets::sparkline_string(&scaled, width);

    let label = format!(
        "min {min_v:.2}  max {max_v:.2}  n={}",
        drift_series.len()
    );

    let lines = vec![
        Line::from(Span::styled(
            spark,
            Style::default().fg(theme::PLUGIN_DJINN),
        )),
        Line::from(Span::styled(
            label,
            Style::default().fg(theme::TEXT_DIM),
        )),
    ];

    let p = Paragraph::new(lines).alignment(Alignment::Left);
    frame.render_widget(p, inner);
}

// ---- off-task warnings panel ---------------------------------------------

fn render_off_task_warnings(frame: &mut Frame, area: Rect, app: &AppState) {
    let block = widgets::panel_block("Off-task warnings", false);
    let inner = block.inner(area);
    frame.render_widget(block.clone(), area);

    let warnings: Vec<&Event> = app
        .events
        .iter()
        .rev()
        .filter(|e| match e {
            Event::DjinnDrift(p) => matches!(
                p.severity,
                Some(Severity::Warning) | Some(Severity::High) | Some(Severity::Critical)
            ),
            _ => false,
        })
        .take(20)
        .collect();

    if warnings.is_empty() {
        let empty = Paragraph::new(Line::from(Span::styled(
            "(no drift events — agent is on-task or drift detection disabled)",
            Style::default().fg(theme::TEXT_FAINT),
        )))
        .alignment(Alignment::Center);
        frame.render_widget(empty, inner);
        return;
    }

    let header = Row::new(vec![
        Cell::from("time"),
        Cell::from("intent"),
        Cell::from("Δ"),
        Cell::from("advice"),
    ])
    .style(
        Style::default()
            .fg(theme::TEXT_DIM)
            .add_modifier(Modifier::BOLD),
    );

    let rows: Vec<Row> = warnings
        .into_iter()
        .map(|ev| {
            if let Event::DjinnDrift(p) = ev {
                let secs = p.time as i64;
                let time_str = chrono::DateTime::<chrono::Utc>::from_timestamp(secs, 0)
                    .map(|dt| dt.format("%H:%M:%S").to_string())
                    .unwrap_or_else(|| "—".to_string());
                let intent = extract_str(&p.extra, "current_intent")
                    .or_else(|| extract_str(&p.extra, "intent"))
                    .unwrap_or("—");
                let delta = extract_drift_value(&p.extra)
                    .map(|v| format!("{v:.2}"))
                    .unwrap_or_else(|| "—".to_string());
                let advice = extract_str(&p.extra, "advice")
                    .or_else(|| p.message.as_deref())
                    .unwrap_or("—");
                let sev_color = p
                    .severity
                    .map(theme::severity_color)
                    .unwrap_or(theme::STATUS_WARNING);
                Row::new(vec![
                    Cell::from(time_str),
                    Cell::from(truncate(intent, 24)),
                    Cell::from(Span::styled(delta, Style::default().fg(sev_color))),
                    Cell::from(truncate(advice, 40)),
                ])
            } else {
                Row::new(vec![Cell::from("—")])
            }
        })
        .collect();

    let table = Table::new(
        rows,
        [
            Constraint::Length(10),
            Constraint::Min(16),
            Constraint::Length(8),
            Constraint::Min(20),
        ],
    )
    .header(header)
    .style(Style::default().fg(theme::TEXT_PRIMARY));

    frame.render_widget(table, inner);
}

// ---- intent timeline ------------------------------------------------------

fn render_intent_timeline(frame: &mut Frame, area: Rect, app: &AppState) {
    let block = widgets::panel_block("Intent timeline", false);
    let inner = block.inner(area);
    frame.render_widget(block.clone(), area);

    let anchors: Vec<&Event> = app
        .events
        .iter()
        .filter(|e| matches!(e, Event::DjinnAnchor(_)))
        .collect();

    if anchors.is_empty() {
        let empty = Paragraph::new(Line::from(Span::styled(
            "(no drift events — agent is on-task or drift detection disabled)",
            Style::default().fg(theme::TEXT_FAINT),
        )))
        .alignment(Alignment::Center);
        frame.render_widget(empty, inner);
        return;
    }

    // Most recent first.
    let lines: Vec<Line> = anchors
        .iter()
        .rev()
        .take(20)
        .filter_map(|ev| {
            if let Event::DjinnAnchor(p) = ev {
                let secs = p.time as i64;
                let time_str = chrono::DateTime::<chrono::Utc>::from_timestamp(secs, 0)
                    .map(|dt| dt.format("%H:%M:%S").to_string())
                    .unwrap_or_else(|| "—".to_string());
                let intent = extract_str(&p.extra, "intent")
                    .or_else(|| p.message.as_deref())
                    .unwrap_or("—");
                Some(Line::from(vec![
                    Span::styled(
                        format!("{time_str}  "),
                        Style::default().fg(theme::TEXT_DIM),
                    ),
                    Span::styled(
                        truncate(intent, 60),
                        Style::default().fg(theme::PLUGIN_DJINN),
                    ),
                ]))
            } else {
                None
            }
        })
        .collect();

    let p = Paragraph::new(lines);
    frame.render_widget(p, inner);
}
