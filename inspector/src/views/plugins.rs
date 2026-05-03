//! Detailed plugin listing view.
//!
//! Renders a table of all plugins with status, health, latency, throughput and
//! a recent-activity sparkline, plus a sub-panel showing the selected plugin's
//! role description and recent events.

use ratatui::Frame;
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Cell, Paragraph, Row, Table, Wrap};

use crate::event::Event;
use crate::state::{AppState, Panel, PluginState, PluginStatus, SortMode};
use crate::ui::theme;
use crate::ui::widgets;

/// One-line role descriptions for each known plugin. Hard-coded by spec so
/// the view doesn't have to reach into other modules for branding text.
fn role_description(name: &str) -> &'static str {
    match name {
        "pech" => "Cost, token, and budget ledger.",
        "emu" => "Context, memory, and turn estimation.",
        "hydra" => "Security policy and action veto engine.",
        "sylph" => "Git, branch, PR, and repository workflow guard.",
        "lich" => "Sandboxed review and trust gate.",
        "naga" => "Source-as-spec matching and consistency checks.",
        "crow" => "Bayesian change trust and confidence.",
        "djinn" => "Intent drift detection.",
        "gorgon" => "Codebase topology, hotspots, and structure.",
        "wixie" => "Prompt engineering, convergence, and agent behavior refinement.",
        _ => "(unknown plugin)",
    }
}

fn status_label(s: PluginStatus) -> &'static str {
    match s {
        PluginStatus::Healthy => "Healthy",
        PluginStatus::Warning => "Warning",
        PluginStatus::Error => "Error",
        PluginStatus::Disabled => "Disabled",
    }
}

fn status_color(s: PluginStatus) -> Color {
    match s {
        PluginStatus::Healthy => theme::STATUS_HEALTHY,
        PluginStatus::Warning => theme::STATUS_WARNING,
        PluginStatus::Error => theme::STATUS_CRITICAL,
        PluginStatus::Disabled => theme::TEXT_FAINT,
    }
}

/// Critical-first ordering when SortMode::ByPlugin is in effect.
fn status_rank(s: PluginStatus) -> u8 {
    match s {
        PluginStatus::Error => 0,
        PluginStatus::Warning => 1,
        PluginStatus::Healthy => 2,
        PluginStatus::Disabled => 3,
    }
}

/// Format a wall-clock timestamp (unix-seconds, possibly fractional) as HH:MM:SS.
/// Falls back to "—" when no timestamp is recorded.
fn fmt_time(opt: Option<f64>) -> String {
    match opt {
        Some(t) => {
            let secs = t as i64;
            let h = (secs / 3600) % 24;
            let m = (secs / 60) % 60;
            let s = secs % 60;
            format!("{:02}:{:02}:{:02}", h, m, s)
        }
        None => "—".into(),
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
        out.push('…');
        out
    }
}

/// Snapshot the recent series for a plugin into a width-bounded sparkline.
fn plugin_sparkline(p: &PluginState, width: usize) -> String {
    let samples: Vec<u64> = p.usage_series.iter().copied().collect();
    widgets::sparkline_string(&samples, width)
}

/// Sort the plugin indices for display, honouring the requested sort mode.
fn sorted_indices(app: &AppState) -> Vec<usize> {
    let mut idx: Vec<usize> = (0..app.plugins.len()).collect();
    match app.sort_mode {
        SortMode::ByPlugin => {
            idx.sort_by(|a, b| {
                let pa = &app.plugins[*a];
                let pb = &app.plugins[*b];
                status_rank(pa.status)
                    .cmp(&status_rank(pb.status))
                    .then_with(|| pa.name.cmp(&pb.name))
            });
        }
        _ => {
            idx.sort_by(|a, b| app.plugins[*a].name.cmp(&app.plugins[*b].name));
        }
    }
    idx
}

pub fn render(frame: &mut Frame, area: Rect, app: &AppState) {
    let focused = app.active_panel == Panel::Plugins;
    let outer = widgets::panel_block("Plugins", focused);
    let inner = outer.inner(area);
    frame.render_widget(outer, area);

    if inner.height == 0 || inner.width == 0 {
        return;
    }

    // Reserve the bottom 6 rows (or all rows if too small) for the detail panel.
    let detail_h: u16 = if inner.height > 8 { 6 } else { 0 };
    let table_h = inner.height.saturating_sub(detail_h);

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints(if detail_h > 0 {
            vec![Constraint::Length(table_h), Constraint::Length(detail_h)]
        } else {
            vec![Constraint::Length(table_h)]
        })
        .split(inner);

    render_table(frame, chunks[0], app);
    if detail_h > 0 && chunks.len() > 1 {
        render_detail(frame, chunks[1], app);
    }
}

fn render_table(frame: &mut Frame, area: Rect, app: &AppState) {
    if area.height == 0 {
        return;
    }

    let order = sorted_indices(app);
    let header_cells = [
        "", "name", "status", "health", "calls", "errors", "p95ms", "p99ms", "last", "value",
        "trend",
    ]
    .into_iter()
    .map(|h| Cell::from(h).style(theme::title_style()));
    let header = Row::new(header_cells).height(1);

    // Selected row in the *original* indexing; map through `order`.
    let selected_row_pos = order
        .iter()
        .position(|i| *i == app.selected_plugin_index);

    // Sparkline column gets the leftover width.
    let spark_width = area.width.saturating_sub(2 + 8 + 9 + 7 + 7 + 7 + 7 + 7 + 9 + 14 + 11) as usize;
    let spark_width = spark_width.max(8);

    let rows: Vec<Row> = order.iter().enumerate().map(|(_pos, i)| {
        let p = &app.plugins[*i];
        let dot = if p.enabled { "●" } else { "○" };
        let dot_style = Style::default().fg(if p.enabled { p.color } else { theme::TEXT_FAINT });

        let name_style = Style::default().fg(theme::plugin_color(&p.name)).add_modifier(Modifier::BOLD);
        let status_style = Style::default().fg(status_color(p.status));

        let health_pct = format!("{:>3.0}%", (p.health * 100.0).clamp(0.0, 100.0));
        let calls = format!("{}", p.calls);
        let errors = format!("{}", p.errors);
        let p95 = format!("{:.1}", p.latency_p95_ms);
        let p99 = format!("{:.1}", p.latency_p99_ms);
        let last = fmt_time(p.last_event);
        let value = truncate(&p.display_value, 12);
        let spark = plugin_sparkline(p, spark_width);

        Row::new(vec![
            Cell::from(dot).style(dot_style),
            Cell::from(p.name.clone()).style(name_style),
            Cell::from(status_label(p.status)).style(status_style),
            Cell::from(health_pct),
            Cell::from(calls),
            Cell::from(errors),
            Cell::from(p95),
            Cell::from(p99),
            Cell::from(last),
            Cell::from(value),
            Cell::from(spark).style(Style::default().fg(p.color)),
        ])
        .height(1)
    }).collect();

    let widths = [
        Constraint::Length(2),
        Constraint::Length(8),
        Constraint::Length(9),
        Constraint::Length(6),
        Constraint::Length(7),
        Constraint::Length(7),
        Constraint::Length(7),
        Constraint::Length(7),
        Constraint::Length(9),
        Constraint::Length(14),
        Constraint::Min(8),
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
    let outer = widgets::panel_block("Plugin Detail", false);
    let inner = outer.inner(area);
    frame.render_widget(outer, area);

    if inner.height == 0 || inner.width == 0 {
        return;
    }

    if app.plugins.is_empty() {
        let p = Paragraph::new("(no plugins registered yet)").style(theme::dim_style());
        frame.render_widget(p, inner);
        return;
    }

    let idx = app.selected_plugin_index.min(app.plugins.len() - 1);
    let plugin = &app.plugins[idx];
    let role = role_description(&plugin.name);

    let mut lines: Vec<Line> = Vec::new();
    lines.push(Line::from(vec![
        Span::styled(
            plugin.name.clone(),
            Style::default()
                .fg(theme::plugin_color(&plugin.name))
                .add_modifier(Modifier::BOLD),
        ),
        Span::raw("  "),
        Span::styled(role, theme::dim_style()),
    ]));

    let spark = {
        let samples: Vec<u64> = plugin.usage_series.iter().copied().collect();
        widgets::sparkline_string(&samples, 60)
    };
    lines.push(Line::from(vec![
        Span::styled("trend ", theme::dim_style()),
        Span::styled(spark, Style::default().fg(plugin.color)),
    ]));

    // Recent events filtered by this plugin (newest first, max 5).
    let mut recent: Vec<&Event> = app
        .events
        .iter()
        .filter(|ev| ev.plugin().map(|p| p.eq_ignore_ascii_case(&plugin.name)).unwrap_or(false))
        .collect();
    recent.reverse();
    recent.truncate(5);

    if recent.is_empty() {
        lines.push(Line::from(Span::styled(
            "  (no recent events for this plugin)",
            theme::dim_style(),
        )));
    } else {
        for ev in recent {
            let t = fmt_time(Some(ev.time()));
            let tag = ev.type_tag();
            let msg = match ev {
                _ => format!("{:?}", ev),
            };
            let msg = truncate(&msg, (inner.width.saturating_sub(20)) as usize);
            lines.push(Line::from(vec![
                Span::styled(format!("  {} ", t), theme::dim_style()),
                Span::styled(format!("{:<20}", tag), Style::default().fg(theme::ACCENT)),
                Span::raw(" "),
                Span::raw(msg),
            ]));
        }
    }

    let para = Paragraph::new(lines)
        .style(theme::panel_style())
        .wrap(Wrap { trim: false });
    frame.render_widget(para, inner);
}
