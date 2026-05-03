//! Cost view — Pech ledger visibility.
//!
//! Surfaces session spend, daily budget, lifetime spend, per-plugin token /
//! cost breakdown, and the recent ledger tail. Read-only over `AppState`.

use ratatui::Frame;
use ratatui::layout::{Alignment, Constraint, Direction, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Cell, Gauge, Paragraph, Row, Table};

use crate::event::Event;
use crate::state::AppState;
use crate::ui::{theme, widgets};

// ---- formatting helpers ---------------------------------------------------

/// `$0.42`, `$5.12`, `$184.20` — always two decimals.
fn fmt_usd(v: f64) -> String {
    format!("${v:.2}")
}

/// `25%` — integer percent for display.
fn fmt_pct(ratio: f64) -> String {
    let pct = (ratio * 100.0).round().clamp(0.0, 999.0) as i64;
    format!("{pct}%")
}

/// `42`, `1.2k`, `42.8k`, `3.1M` — k/M shortening above 1000.
fn fmt_count(n: u64) -> String {
    if n < 1_000 {
        format!("{n}")
    } else if n < 1_000_000 {
        format!("{:.1}k", n as f64 / 1_000.0)
    } else {
        format!("{:.1}M", n as f64 / 1_000_000.0)
    }
}

// ---- main render ----------------------------------------------------------

pub fn render(frame: &mut Frame, area: Rect, app: &AppState) {
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(5),  // top metric cards
            Constraint::Length(6),  // gauges (daily + context)
            Constraint::Min(8),     // per-plugin breakdown table
            Constraint::Length(12), // recent ledger entries
        ])
        .split(area);

    render_top_cards(frame, rows[0], app);
    render_gauges(frame, rows[1], app);
    render_plugin_breakdown(frame, rows[2], app);
    render_recent_ledger(frame, rows[3], app);
}

// ---- top: 4 metric cards --------------------------------------------------

fn render_top_cards(frame: &mut Frame, area: Rect, app: &AppState) {
    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Percentage(25),
            Constraint::Percentage(25),
            Constraint::Percentage(25),
            Constraint::Percentage(25),
        ])
        .split(area);

    let session_value = fmt_usd(app.metrics.spent_session_usd);
    widgets::render_metric_card(
        frame,
        cols[0],
        "Session",
        &session_value,
        None,
        theme::PLUGIN_PECH,
    );

    let rate_value = format!("{}/hr", fmt_usd(app.metrics.spend_rate_per_hour_usd));
    widgets::render_metric_card(
        frame,
        cols[1],
        "Rate",
        &rate_value,
        None,
        theme::STATUS_NEUTRAL,
    );

    let limit = if app.budgets.daily_limit_usd > 0.0 {
        app.budgets.daily_limit_usd
    } else {
        1.0
    };
    let daily_ratio = (app.budgets.daily_spend_usd / limit).clamp(0.0, 9.99);
    let daily_value = format!(
        "{} / {} ({})",
        fmt_usd(app.budgets.daily_spend_usd),
        fmt_usd(app.budgets.daily_limit_usd),
        fmt_pct(daily_ratio),
    );
    let daily_color = if daily_ratio >= 0.9 {
        theme::STATUS_CRITICAL
    } else if daily_ratio >= 0.75 {
        theme::STATUS_WARNING
    } else {
        theme::STATUS_HEALTHY
    };
    widgets::render_metric_card(frame, cols[2], "Daily Budget", &daily_value, None, daily_color);

    let lifetime_value = fmt_usd(app.runtime_metrics.total_spend_lifetime_usd);
    widgets::render_metric_card(
        frame,
        cols[3],
        "Lifetime",
        &lifetime_value,
        None,
        theme::ACCENT,
    );
}

// ---- middle: daily-spend + context-window gauges --------------------------

fn render_gauges(frame: &mut Frame, area: Rect, app: &AppState) {
    let block = widgets::panel_block("Budget", false);
    let inner = block.inner(area);
    frame.render_widget(block, area);

    let cols = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(2), Constraint::Length(2)])
        .split(inner);

    // Daily spend gauge
    let daily_limit = if app.budgets.daily_limit_usd > 0.0 {
        app.budgets.daily_limit_usd
    } else {
        1.0
    };
    let daily_ratio = (app.budgets.daily_spend_usd / daily_limit).clamp(0.0, 1.0);
    let daily_label = format!(
        "Daily {} / {}",
        fmt_usd(app.budgets.daily_spend_usd),
        fmt_usd(app.budgets.daily_limit_usd),
    );
    let daily_color = if daily_ratio >= 0.9 {
        theme::STATUS_CRITICAL
    } else if daily_ratio >= 0.75 {
        theme::STATUS_WARNING
    } else {
        theme::STATUS_HEALTHY
    };
    let daily_gauge = Gauge::default()
        .gauge_style(Style::default().fg(daily_color).bg(theme::BG))
        .ratio(daily_ratio)
        .label(daily_label);
    frame.render_widget(daily_gauge, cols[0]);

    // Context window gauge
    let ctx_limit = if app.budgets.context_limit_tokens > 0 {
        app.budgets.context_limit_tokens
    } else {
        1
    };
    let ctx_ratio =
        (app.budgets.context_tokens as f64 / ctx_limit as f64).clamp(0.0, 1.0);
    let ctx_label = format!(
        "Context {} tok / {} tok",
        fmt_count(app.budgets.context_tokens),
        fmt_count(app.budgets.context_limit_tokens),
    );
    let ctx_color = if ctx_ratio >= 0.9 {
        theme::STATUS_CRITICAL
    } else if ctx_ratio >= 0.75 {
        theme::STATUS_WARNING
    } else {
        theme::STATUS_NEUTRAL
    };
    let ctx_gauge = Gauge::default()
        .gauge_style(Style::default().fg(ctx_color).bg(theme::BG))
        .ratio(ctx_ratio)
        .label(ctx_label);
    frame.render_widget(ctx_gauge, cols[1]);
}

// ---- per-plugin cost breakdown -------------------------------------------

fn render_plugin_breakdown(frame: &mut Frame, area: Rect, app: &AppState) {
    let block = widgets::panel_block("Per-plugin breakdown", false);
    let inner = block.inner(area);
    frame.render_widget(block.clone(), area);

    // Aggregate from the event ring: cost + tokens + calls per plugin.
    let mut agg: std::collections::HashMap<String, (f64, u64, u64, u64)> =
        std::collections::HashMap::new();
    for ev in &app.events {
        if let Event::PechLedger { payload, plugin, .. } = ev {
            let key = plugin.clone().unwrap_or_else(|| "—".to_string());
            let entry = agg.entry(key).or_insert((0.0, 0, 0, 0));
            entry.0 += payload.cost_usd;
            entry.1 = entry.1.saturating_add(payload.input_tokens);
            entry.2 = entry.2.saturating_add(payload.output_tokens);
            entry.3 = entry.3.saturating_add(1);
        }
    }

    if agg.is_empty() {
        let empty = Paragraph::new(Line::from(Span::styled(
            "(no cost events yet — waiting for pech.ledger stream)",
            Style::default().fg(theme::TEXT_FAINT),
        )))
        .alignment(Alignment::Center);
        frame.render_widget(empty, inner);
        return;
    }

    let header = Row::new(vec![
        Cell::from("plugin"),
        Cell::from("cost"),
        Cell::from("tokens"),
        Cell::from("calls"),
        Cell::from("trend"),
    ])
    .style(
        Style::default()
            .fg(theme::TEXT_DIM)
            .add_modifier(Modifier::BOLD),
    );

    let mut rows: Vec<Row> = Vec::with_capacity(agg.len());
    // Stable iteration order based on app.plugins for visual consistency.
    for plugin in &app.plugins {
        let key = plugin.name.to_ascii_lowercase();
        if let Some((cost, in_tok, out_tok, calls)) = agg.get(&key) {
            let usage: Vec<u64> = plugin.usage_series.iter().copied().collect();
            let spark = widgets::sparkline_string(&usage, 24);
            let total_tokens = in_tok.saturating_add(*out_tok);
            rows.push(Row::new(vec![
                Cell::from(Span::styled(
                    plugin.name.clone(),
                    Style::default().fg(theme::plugin_color(&key)),
                )),
                Cell::from(fmt_usd(*cost)),
                Cell::from(fmt_count(total_tokens)),
                Cell::from(fmt_count(*calls)),
                Cell::from(Span::styled(
                    spark,
                    Style::default().fg(theme::plugin_color(&key)),
                )),
            ]));
        }
    }
    // Plugins absent from app.plugins (fallback to "—" key, etc.)
    for (key, (cost, in_tok, out_tok, calls)) in &agg {
        if !app
            .plugins
            .iter()
            .any(|p| p.name.to_ascii_lowercase() == *key)
        {
            let total_tokens = in_tok.saturating_add(*out_tok);
            rows.push(Row::new(vec![
                Cell::from(Span::styled(
                    key.clone(),
                    Style::default().fg(theme::TEXT_PRIMARY),
                )),
                Cell::from(fmt_usd(*cost)),
                Cell::from(fmt_count(total_tokens)),
                Cell::from(fmt_count(*calls)),
                Cell::from("—"),
            ]));
        }
    }

    let table = Table::new(
        rows,
        [
            Constraint::Length(10),
            Constraint::Length(10),
            Constraint::Length(10),
            Constraint::Length(8),
            Constraint::Min(24),
        ],
    )
    .header(header)
    .style(Style::default().fg(theme::TEXT_PRIMARY));

    frame.render_widget(table, inner);
}

// ---- recent ledger entries (last 10) -------------------------------------

fn render_recent_ledger(frame: &mut Frame, area: Rect, app: &AppState) {
    let block = widgets::panel_block("Recent ledger entries", false);
    let inner = block.inner(area);
    frame.render_widget(block.clone(), area);

    // Walk the ring back-to-front, take the last 10 pech.ledger.
    let recent: Vec<&Event> = app
        .events
        .iter()
        .rev()
        .filter(|e| matches!(e, Event::PechLedger { .. }))
        .take(10)
        .collect();

    if recent.is_empty() {
        let empty = Paragraph::new(Line::from(Span::styled(
            "(no cost events yet — waiting for pech.ledger stream)",
            Style::default().fg(theme::TEXT_FAINT),
        )))
        .alignment(Alignment::Center);
        frame.render_widget(empty, inner);
        return;
    }

    let header = Row::new(vec![
        Cell::from("time"),
        Cell::from("task_id"),
        Cell::from("in_tok"),
        Cell::from("out_tok"),
        Cell::from("cost"),
    ])
    .style(
        Style::default()
            .fg(theme::TEXT_DIM)
            .add_modifier(Modifier::BOLD),
    );

    let rows: Vec<Row> = recent
        .into_iter()
        .map(|ev| {
            if let Event::PechLedger {
                payload,
                time,
                task_id,
                ..
            } = ev
            {
                let secs = *time as i64;
                let time_str = chrono::DateTime::<chrono::Utc>::from_timestamp(secs, 0)
                    .map(|dt| dt.format("%H:%M:%S").to_string())
                    .unwrap_or_else(|| "—".to_string());
                let task = task_id.clone().unwrap_or_else(|| "—".to_string());
                Row::new(vec![
                    Cell::from(time_str),
                    Cell::from(task),
                    Cell::from(fmt_count(payload.input_tokens)),
                    Cell::from(fmt_count(payload.output_tokens)),
                    Cell::from(fmt_usd(payload.cost_usd)),
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
            Constraint::Min(20),
            Constraint::Length(10),
            Constraint::Length(10),
            Constraint::Length(10),
        ],
    )
    .header(header)
    .style(Style::default().fg(theme::TEXT_PRIMARY));

    frame.render_widget(table, inner);
}
