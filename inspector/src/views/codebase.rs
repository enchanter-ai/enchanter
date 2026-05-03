//! Codebase view — Gorgon hotspots + Naga spec health.
//!
//! Two columns: file activity heat (left) and spec-check status per file
//! (right). Bottom strip summarizes lifetime + session totals.

use ratatui::Frame;
use ratatui::layout::{Alignment, Constraint, Direction, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Cell, Paragraph, Row, Table};

use crate::event::Event;
use crate::state::AppState;
use crate::ui::{theme, widgets};

// ---- formatting helpers ---------------------------------------------------

/// `42`, `1.2k`, `42.8k`, `3.1M` — k/M shortening above 1000.
fn fmt_count_u64(n: u64) -> String {
    if n < 1_000 {
        format!("{n}")
    } else if n < 1_000_000 {
        format!("{:.1}k", n as f64 / 1_000.0)
    } else {
        format!("{:.1}M", n as f64 / 1_000_000.0)
    }
}

/// Best-effort string extraction from a generic-payload extras map.
fn extract_str<'a>(
    extra: &'a std::collections::BTreeMap<String, serde_json::Value>,
    key: &str,
) -> Option<&'a str> {
    extra.get(key).and_then(|v| v.as_str())
}

/// Best-effort u64 extraction for things like drift counts.
fn extract_u64(
    extra: &std::collections::BTreeMap<String, serde_json::Value>,
    key: &str,
) -> Option<u64> {
    extra.get(key).and_then(|v| v.as_u64())
}

/// Truncate a path for display while keeping the tail (file name) visible.
fn truncate_path(path: &str, max: usize) -> String {
    let chars: Vec<char> = path.chars().collect();
    if chars.len() <= max {
        return path.to_string();
    }
    let take = max.saturating_sub(1);
    let start = chars.len().saturating_sub(take);
    let mut out = String::from("\u{2026}");
    out.extend(chars[start..].iter());
    out
}

/// 10-cell heat bar `███▒▒▒░░░░` filled by the relative count.
fn heat_bar(count: u64, max: u64) -> String {
    if max == 0 {
        return "░".repeat(10);
    }
    let filled = ((count as f64 / max as f64) * 10.0).round().clamp(0.0, 10.0) as usize;
    let mut s = String::with_capacity(10);
    for _ in 0..filled {
        s.push('\u{2588}');
    }
    for _ in filled..10 {
        s.push('\u{2591}');
    }
    s
}

// ---- main render ----------------------------------------------------------

pub fn render(frame: &mut Frame, area: Rect, app: &AppState) {
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(8), Constraint::Length(5)])
        .split(area);

    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(60), Constraint::Percentage(40)])
        .split(rows[0]);

    render_hotspots(frame, cols[0], app);
    render_spec_health(frame, cols[1], app);
    render_summary_strip(frame, rows[1], app);
}

// ---- left: file hotspots --------------------------------------------------

fn render_hotspots(frame: &mut Frame, area: Rect, app: &AppState) {
    let block = widgets::panel_block("Hotspots", false);
    let inner = block.inner(area);
    frame.render_widget(block.clone(), area);

    // Count modification activity per file across the event ring.
    let mut counts: std::collections::HashMap<String, u64> = std::collections::HashMap::new();

    for ev in &app.events {
        let file_opt: Option<String> = match ev {
            Event::CodeModified { file, .. } => Some(file.clone()),
            Event::CodeGenerated(p) => extract_str(&p.extra, "file").map(str::to_string),
            Event::FileCreated(p) => extract_str(&p.extra, "file")
                .or_else(|| extract_str(&p.extra, "path"))
                .map(str::to_string),
            Event::FileModified(p) => extract_str(&p.extra, "file")
                .or_else(|| extract_str(&p.extra, "path"))
                .map(str::to_string),
            _ => None,
        };
        if let Some(file) = file_opt {
            *counts.entry(file).or_insert(0) += 1;
        }
    }

    if counts.is_empty() {
        let empty = Paragraph::new(Line::from(Span::styled(
            "(no hotspot data yet — codebase activity will populate when files are modified)",
            Style::default().fg(theme::TEXT_FAINT),
        )))
        .alignment(Alignment::Center);
        frame.render_widget(empty, inner);
        return;
    }

    let mut sorted: Vec<(String, u64)> = counts.into_iter().collect();
    sorted.sort_by(|a, b| b.1.cmp(&a.1));
    sorted.truncate(15);

    let max = sorted.iter().map(|(_, c)| *c).max().unwrap_or(1);
    // Quartile cutoffs by relative magnitude: high ≥ 0.66, medium ≥ 0.33.
    let high_cut = (max as f64 * 0.66).ceil() as u64;
    let med_cut = (max as f64 * 0.33).ceil() as u64;

    let header = Row::new(vec![
        Cell::from("file"),
        Cell::from("heat"),
        Cell::from("bar"),
        Cell::from("count"),
    ])
    .style(
        Style::default()
            .fg(theme::TEXT_DIM)
            .add_modifier(Modifier::BOLD),
    );

    let rows: Vec<Row> = sorted
        .iter()
        .map(|(path, count)| {
            let (label, color) = if *count >= high_cut {
                ("high", theme::STATUS_CRITICAL)
            } else if *count >= med_cut {
                ("medium", theme::STATUS_WARNING)
            } else {
                ("low", theme::STATUS_HEALTHY)
            };
            let bar = heat_bar(*count, max);
            Row::new(vec![
                Cell::from(truncate_path(path, 40)),
                Cell::from(Span::styled(label, Style::default().fg(color))),
                Cell::from(Span::styled(bar, Style::default().fg(color))),
                Cell::from(fmt_count_u64(*count)),
            ])
        })
        .collect();

    let table = Table::new(
        rows,
        [
            Constraint::Min(20),
            Constraint::Length(8),
            Constraint::Length(12),
            Constraint::Length(8),
        ],
    )
    .header(header)
    .style(Style::default().fg(theme::TEXT_PRIMARY));

    frame.render_widget(table, inner);
}

// ---- right: Naga spec health ----------------------------------------------

fn render_spec_health(frame: &mut Frame, area: Rect, app: &AppState) {
    let block = widgets::panel_block("Spec health (Naga)", false);
    let inner = block.inner(area);
    frame.render_widget(block.clone(), area);

    // Most-recent-per-file naga.spec_check.
    let mut latest: std::collections::HashMap<String, (f64, String, u64)> =
        std::collections::HashMap::new();

    for ev in &app.events {
        if let Event::NagaSpecCheck(p) = ev {
            let file = match extract_str(&p.extra, "file")
                .or_else(|| extract_str(&p.extra, "path"))
            {
                Some(f) => f.to_string(),
                None => continue,
            };
            let status = extract_str(&p.extra, "status")
                .unwrap_or("—")
                .to_string();
            let drift = extract_u64(&p.extra, "drift_count")
                .or_else(|| extract_u64(&p.extra, "drift"))
                .unwrap_or(0);
            let entry = latest.entry(file).or_insert((p.time, status.clone(), drift));
            if p.time >= entry.0 {
                *entry = (p.time, status, drift);
            }
        }
    }

    if latest.is_empty() {
        let empty = Paragraph::new(Line::from(Span::styled(
            "(no spec check data yet — naga.spec_check events will populate this panel)",
            Style::default().fg(theme::TEXT_FAINT),
        )))
        .alignment(Alignment::Center);
        frame.render_widget(empty, inner);
        return;
    }

    let mut entries: Vec<(String, (f64, String, u64))> = latest.into_iter().collect();
    entries.sort_by(|a, b| b.1 .0.partial_cmp(&a.1 .0).unwrap_or(std::cmp::Ordering::Equal));
    entries.truncate(15);

    let header = Row::new(vec![
        Cell::from("file"),
        Cell::from("status"),
        Cell::from("drift"),
    ])
    .style(
        Style::default()
            .fg(theme::TEXT_DIM)
            .add_modifier(Modifier::BOLD),
    );

    let rows: Vec<Row> = entries
        .into_iter()
        .map(|(file, (_t, status, drift))| {
            let is_clean = matches!(status.as_str(), "clean" | "ok" | "pass" | "passed");
            let (glyph, color) = if is_clean {
                ("\u{2713} clean", theme::STATUS_HEALTHY)
            } else {
                ("\u{2717} mismatch", theme::STATUS_CRITICAL)
            };
            Row::new(vec![
                Cell::from(truncate_path(&file, 28)),
                Cell::from(Span::styled(glyph, Style::default().fg(color))),
                Cell::from(fmt_count_u64(drift)),
            ])
        })
        .collect();

    let table = Table::new(
        rows,
        [
            Constraint::Min(20),
            Constraint::Length(14),
            Constraint::Length(8),
        ],
    )
    .header(header)
    .style(Style::default().fg(theme::TEXT_PRIMARY));

    frame.render_widget(table, inner);
}

// ---- bottom: summary strip ------------------------------------------------

fn render_summary_strip(frame: &mut Frame, area: Rect, app: &AppState) {
    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Percentage(25),
            Constraint::Percentage(25),
            Constraint::Percentage(25),
            Constraint::Percentage(25),
        ])
        .split(area);

    // Session line totals from code.modified events (best-effort).
    let (lines_added, lines_removed) =
        app.events
            .iter()
            .fold((0u64, 0u64), |(add, rem), ev| match ev {
                Event::CodeModified {
                    lines_added,
                    lines_removed,
                    ..
                } => (
                    add.saturating_add(*lines_added as u64),
                    rem.saturating_add(*lines_removed as u64),
                ),
                _ => (add, rem),
            });

    widgets::render_metric_card(
        frame,
        cols[0],
        "Files Created Lifetime",
        &fmt_count_u64(app.runtime_metrics.files_created_lifetime),
        None,
        theme::PLUGIN_NAGA,
    );
    widgets::render_metric_card(
        frame,
        cols[1],
        "Files Modified Lifetime",
        &fmt_count_u64(app.runtime_metrics.files_modified_lifetime),
        None,
        theme::PLUGIN_GORGON,
    );
    widgets::render_metric_card(
        frame,
        cols[2],
        "Lines Added (session)",
        &fmt_count_u64(lines_added),
        None,
        theme::STATUS_HEALTHY,
    );
    widgets::render_metric_card(
        frame,
        cols[3],
        "Lines Removed (session)",
        &fmt_count_u64(lines_removed),
        None,
        theme::STATUS_CRITICAL,
    );
}
