//! Full scrollable event trace view.
//!
//! Shows a filterable, sortable list of every event in the ring buffer plus
//! a detail pane for the currently-selected event's full payload.

use ratatui::Frame;
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Cell, Paragraph, Row, Table, Wrap};

use crate::event::{Event, Severity};
use crate::state::{AppState, Panel, SortMode};
use crate::ui::theme;
use crate::ui::widgets;

fn fmt_time(t: f64) -> String {
    // 4 decimals as requested.
    let secs = t as i64;
    let frac = (t - secs as f64).abs();
    let h = (secs / 3600) % 24;
    let m = (secs / 60) % 60;
    let s = secs % 60;
    format!("{:02}:{:02}:{:02}.{:04}", h, m, s, (frac * 10_000.0) as u32)
}

fn truncate(s: &str, max: usize) -> String {
    if max == 0 {
        return String::new();
    }
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
        out.push('…');
        out
    }
}

/// Severity ordering with Critical first → Debug last for BySeverity sort.
fn severity_rank(s: Option<Severity>) -> u8 {
    match s {
        Some(Severity::Critical) => 0,
        Some(Severity::High) => 1,
        Some(Severity::Warning) => 2,
        Some(Severity::Info) => 3,
        Some(Severity::Debug) => 4,
        None => 5,
    }
}

/// Best-effort short message body extracted from an event for the list column.
/// Falls back to the type tag if no human-readable field is present.
fn event_message(ev: &Event) -> String {
    match ev {
        Event::HydraVeto { reason, action, .. } => format!("{} ({})", reason, action),
        Event::ToolCall { tool, .. } => format!("tool={}", tool),
        Event::CodeModified { file, lines_added, lines_removed, .. } => {
            format!("{} +{} -{}", file, lines_added, lines_removed)
        }
        Event::TaskUpdated { task_id, status, intent, .. } => {
            let status = status.as_deref().unwrap_or("?");
            let intent = intent.as_deref().unwrap_or("");
            format!("{} [{}] {}", task_id, status, intent)
        }
        Event::PechLedger { payload, .. } => format!(
            "in={} out={} ${:.4}",
            payload.input_tokens, payload.output_tokens, payload.cost_usd
        ),
        Event::RuntimeMetrics { open_sessions, ongoing_tasks, .. } => {
            format!("sessions={} tasks={}", open_sessions, ongoing_tasks)
        }
        // Fallback: generic-payload variants expose `message` indirectly via the
        // accessor pattern. Use Debug as a last resort, truncated.
        _ => {
            let dbg = format!("{:?}", ev);
            // Strip the Variant(...) prefix to keep it short.
            dbg.split_once('(').map(|(_, r)| r.trim_end_matches(')').to_string()).unwrap_or(dbg)
        }
    }
}

/// Source label shown in the source column. Plugin attribution wins; otherwise
/// fall back to the type-tag's prefix (e.g. "task" from "task.completed").
fn event_source(ev: &Event) -> String {
    if let Some(p) = ev.plugin() {
        return p.to_string();
    }
    let tag = ev.type_tag();
    tag.split('.').next().unwrap_or(tag).to_string()
}

/// Substring (case-insensitive) match used by the filter.
fn matches_filter(ev: &Event, q: &str) -> bool {
    if q.is_empty() {
        return true;
    }
    let needle = q.to_ascii_lowercase();
    let hay = format!(
        "{} {} {} {}",
        ev.type_tag(),
        ev.plugin().unwrap_or(""),
        ev.session_id().unwrap_or(""),
        event_message(ev),
    )
    .to_ascii_lowercase();
    hay.contains(&needle)
}

pub fn render(frame: &mut Frame, area: Rect, app: &AppState) {
    let focused = app.active_panel == Panel::Events;
    let outer = widgets::panel_block("Event Trace", focused);
    let inner = outer.inner(area);
    frame.render_widget(outer, area);

    if inner.height == 0 || inner.width == 0 {
        return;
    }

    // Top filter bar (1 row), main list (rest), optional bottom detail (8 rows
    // when there's room).
    let detail_h: u16 = if inner.height >= 14 { 8 } else { 0 };
    let constraints = if detail_h > 0 {
        vec![
            Constraint::Length(1),
            Constraint::Min(3),
            Constraint::Length(detail_h),
        ]
    } else {
        vec![Constraint::Length(1), Constraint::Min(3)]
    };
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints(constraints)
        .split(inner);

    render_filter_bar(frame, chunks[0], app);
    render_list(frame, chunks[1], app);
    if detail_h > 0 && chunks.len() > 2 {
        render_detail(frame, chunks[2], app);
    }
}

fn render_filter_bar(frame: &mut Frame, area: Rect, app: &AppState) {
    let line = if app.filter_query.is_empty() {
        Line::from(vec![
            Span::styled("hint: ", theme::dim_style()),
            Span::raw("/ to filter, p to pause, ↑↓ to scroll"),
        ])
    } else {
        Line::from(vec![
            Span::styled("filter: ", theme::dim_style()),
            Span::styled(
                app.filter_query.clone(),
                Style::default().fg(theme::ACCENT).add_modifier(Modifier::BOLD),
            ),
        ])
    };
    let p = Paragraph::new(line).style(theme::panel_style());
    frame.render_widget(p, area);
}

/// Build the filtered+sorted list of (original-index, &Event) pairs.
fn filtered_indices<'a>(app: &'a AppState) -> Vec<usize> {
    let mut idx: Vec<usize> = app
        .events
        .iter()
        .enumerate()
        .filter(|(_, ev)| matches_filter(ev, &app.filter_query))
        .map(|(i, _)| i)
        .collect();

    match app.sort_mode {
        SortMode::ByPlugin => {
            idx.sort_by(|a, b| {
                let ea = &app.events[*a];
                let eb = &app.events[*b];
                ea.plugin().unwrap_or("").cmp(eb.plugin().unwrap_or(""))
                    .then_with(|| eb.time().partial_cmp(&ea.time()).unwrap_or(std::cmp::Ordering::Equal))
            });
        }
        SortMode::BySeverity => {
            idx.sort_by(|a, b| {
                severity_rank(app.events[*a].severity())
                    .cmp(&severity_rank(app.events[*b].severity()))
                    .then_with(|| {
                        app.events[*b]
                            .time()
                            .partial_cmp(&app.events[*a].time())
                            .unwrap_or(std::cmp::Ordering::Equal)
                    })
            });
        }
        _ => {
            // Default / ByTime: newest first.
            idx.sort_by(|a, b| {
                app.events[*b]
                    .time()
                    .partial_cmp(&app.events[*a].time())
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
        }
    }
    idx
}

fn render_list(frame: &mut Frame, area: Rect, app: &AppState) {
    if area.height == 0 {
        return;
    }
    if app.events.is_empty() {
        let p = Paragraph::new("(no events received yet — waiting for runtime stream)")
            .style(theme::dim_style());
        frame.render_widget(p, area);
        return;
    }

    let order = filtered_indices(app);
    if order.is_empty() {
        let p = Paragraph::new("(no events match the current filter)")
            .style(theme::dim_style());
        frame.render_widget(p, area);
        return;
    }

    let header = Row::new(
        ["time", "sev", "source", "type", "message"]
            .into_iter()
            .map(|h| Cell::from(h).style(theme::title_style())),
    )
    .height(1);

    let msg_width = (area.width as usize)
        .saturating_sub(15 + 4 + 10 + 22 + 4)
        .max(10);

    let rows: Vec<Row> = order
        .iter()
        .map(|i| {
            let ev = &app.events[*i];
            let t = fmt_time(ev.time());
            let sev_dot = match ev.severity() {
                Some(s) => Span::styled("●", Style::default().fg(theme::severity_color(s))),
                None => Span::styled("·", Style::default().fg(theme::TEXT_FAINT)),
            };
            let source = event_source(ev);
            let source_color = theme::plugin_color(&source);
            let source_cell = Cell::from(truncate(&source, 10))
                .style(Style::default().fg(source_color));
            let tag = truncate(ev.type_tag(), 22);
            let msg = truncate(&event_message(ev), msg_width);

            Row::new(vec![
                Cell::from(t),
                Cell::from(Line::from(sev_dot)),
                source_cell,
                Cell::from(tag).style(Style::default().fg(theme::ACCENT)),
                Cell::from(msg),
            ])
        })
        .collect();

    let widths = [
        Constraint::Length(15),
        Constraint::Length(3),
        Constraint::Length(10),
        Constraint::Length(22),
        Constraint::Min(10),
    ];

    let table = Table::new(rows, widths)
        .header(header)
        .style(theme::panel_style())
        .highlight_style(
            Style::default()
                .bg(Color::Rgb(30, 40, 60))
                .add_modifier(Modifier::BOLD),
        );

    // Map selected_event_index (an index into app.events) to a position in the
    // filtered+sorted view.
    let selected_pos = order.iter().position(|i| *i == app.selected_event_index);
    let mut state = ratatui::widgets::TableState::default();
    state.select(selected_pos);
    frame.render_stateful_widget(table, area, &mut state);
}

fn render_detail(frame: &mut Frame, area: Rect, app: &AppState) {
    let outer = widgets::panel_block("Event Detail", false);
    let inner = outer.inner(area);
    frame.render_widget(outer, area);

    if inner.height == 0 || app.events.is_empty() {
        return;
    }

    let order = filtered_indices(app);
    let target_idx = if order.iter().any(|i| *i == app.selected_event_index) {
        app.selected_event_index
    } else if let Some(first) = order.first() {
        *first
    } else {
        return;
    };

    let ev = match app.events.get(target_idx) {
        Some(e) => e,
        None => return,
    };

    let raw = format!("{:#?}", ev);
    // Truncate to ~40 lines so we never blow the panel height.
    let lines: Vec<&str> = raw.lines().collect();
    let dump = if lines.len() > 40 {
        format!("{}\n…", lines[..40].join("\n"))
    } else {
        lines.join("\n")
    };

    let para = Paragraph::new(dump)
        .style(theme::panel_style())
        .wrap(Wrap { trim: false });
    frame.render_widget(para, inner);
}
