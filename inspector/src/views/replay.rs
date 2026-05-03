//! Session Replay view — post-hoc inspection of a captured event stream.
//!
//! Static state only: this view reads `app.selected_event_index` and
//! `app.paused`, and renders the slice of `app.events` around the selection.
//! Actual playback animation (tick advance, jump-to-next-veto, etc.) is the
//! `app.rs` event loop's job; this view only surfaces what's already in state.

use ratatui::Frame;
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Cell, Paragraph, Row, Table, Wrap};

use crate::event::Event;
use crate::state::AppState;
use crate::ui::theme;
use crate::ui::widgets;

// ---- private formatting helpers (mirror conventions in overview.rs) -------

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

/// Format a relative offset (in seconds) from the first event as `+12.3s`,
/// `+1m04s`, or `+1h02m`. Negative offsets shouldn't happen but render anyway.
fn fmt_relative(secs: f64) -> String {
    let sign = if secs < 0.0 { "-" } else { "+" };
    let s = secs.abs();
    if s < 60.0 {
        format!("{sign}{s:>5.2}s")
    } else if s < 3600.0 {
        let m = (s / 60.0) as u64;
        let r = (s % 60.0) as u64;
        format!("{sign}{m}m{r:02}s")
    } else {
        let h = (s / 3600.0) as u64;
        let m = ((s % 3600.0) / 60.0) as u64;
        format!("{sign}{h}h{m:02}m")
    }
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

/// Pull a short message-ish summary out of an event's Debug repr by stripping
/// newlines and clamping length. Used for the timeline `message` column.
fn one_line_summary(ev: &Event) -> String {
    let raw = format!("{ev:?}");
    let mut compact = String::with_capacity(raw.len());
    let mut last_space = false;
    for c in raw.chars() {
        if c == '\n' || c == '\t' {
            if !last_space {
                compact.push(' ');
                last_space = true;
            }
        } else if c == ' ' {
            if !last_space {
                compact.push(' ');
                last_space = true;
            }
        } else {
            compact.push(c);
            last_space = false;
        }
    }
    compact
}

// ---- top-level render -----------------------------------------------------

pub fn render(frame: &mut Frame, area: Rect, app: &AppState) {
    let outer = widgets::panel_block("Session Replay", false);
    let inner = outer.inner(area);
    frame.render_widget(outer, area);

    if inner.height == 0 || inner.width == 0 {
        return;
    }

    // Vertical split: status bar (1) | main (rest) | toolbar (1).
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1),
            Constraint::Min(1),
            Constraint::Length(1),
        ])
        .split(inner);

    render_status_bar(frame, chunks[0], app);

    if app.events.is_empty() {
        let p = Paragraph::new(
            "(no events buffered \u{2014} replay needs an event stream first; pipe a JSONL file via --from <path>)",
        )
        .style(theme::dim_style());
        frame.render_widget(p, chunks[1]);
    } else {
        render_main(frame, chunks[1], app);
    }

    render_toolbar(frame, chunks[2]);
}

fn render_status_bar(frame: &mut Frame, area: Rect, app: &AppState) {
    let total = app.events.len();
    let pos = if total == 0 {
        0
    } else {
        app.selected_event_index.min(total.saturating_sub(1)) + 1
    };

    let toggle_hint = if app.paused {
        Span::styled("\u{25B6} Play (p)", Style::default().fg(theme::STATUS_HEALTHY))
    } else {
        Span::styled("\u{23F8} Pause (p)", Style::default().fg(theme::STATUS_WARNING))
    };

    let line = Line::from(vec![
        Span::styled(
            "Replay mode \u{00B7} paused",
            Style::default()
                .fg(theme::ACCENT)
                .add_modifier(Modifier::BOLD),
        ),
        Span::raw("   "),
        toggle_hint,
        Span::raw("   "),
        Span::styled(
            format!("{pos} / {total}"),
            Style::default().fg(theme::TEXT_DIM),
        ),
    ]);
    frame.render_widget(Paragraph::new(line), area);
}

fn render_toolbar(frame: &mut Frame, area: Rect) {
    let hint = "[space/p] play/pause \u{00B7} [\u{2192}] step \u{00B7} [\u{2190}] step back \u{00B7} [v] next veto \u{00B7} [t] next tool call \u{00B7} [e] next error \u{00B7} [Home/End] start/end";
    let p = Paragraph::new(Line::from(Span::styled(hint, theme::dim_style())));
    frame.render_widget(p, area);
}

fn render_main(frame: &mut Frame, area: Rect, app: &AppState) {
    // Detail pane uses ~40% of width when there's room; otherwise timeline only.
    let with_detail = area.width >= 80;
    let chunks = if with_detail {
        Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Percentage(60), Constraint::Percentage(40)])
            .split(area)
    } else {
        Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Min(1)])
            .split(area)
    };

    render_timeline(frame, chunks[0], app);
    if with_detail && chunks.len() > 1 {
        render_detail(frame, chunks[1], app);
    }
}

fn render_timeline(frame: &mut Frame, area: Rect, app: &AppState) {
    let inner_block = widgets::panel_block("Timeline", false);
    let inner = inner_block.inner(area);
    frame.render_widget(inner_block, area);

    if inner.height == 0 || inner.width == 0 {
        return;
    }

    let base_time = app.events.front().map(|e| e.time()).unwrap_or(0.0);

    let header_cells = ["t+", "source", "type", " ", "message"]
        .into_iter()
        .map(|h| Cell::from(h).style(theme::title_style()));
    let header = Row::new(header_cells).height(1);

    // message column gets whatever's left.
    let msg_width = (inner.width as usize).saturating_sub(10 + 1 + 10 + 1 + 18 + 1 + 3 + 1);
    let msg_width = msg_width.max(8);

    let total = app.events.len();
    let selected_pos = if total == 0 {
        None
    } else {
        Some(app.selected_event_index.min(total - 1))
    };

    let rows: Vec<Row> = app
        .events
        .iter()
        .map(|ev| {
            let rel = ev.time() - base_time;
            let source = ev
                .plugin()
                .map(|s| s.to_string())
                .unwrap_or_else(|| "\u{2014}".to_string());
            let source_color = ev
                .plugin()
                .map(theme::plugin_color)
                .unwrap_or(theme::TEXT_DIM);

            let sev = ev.severity();
            let dot_color = sev.map(theme::severity_color).unwrap_or(theme::TEXT_FAINT);

            let msg = truncate(&one_line_summary(ev), msg_width);

            Row::new(vec![
                Cell::from(fmt_relative(rel)).style(Style::default().fg(theme::TEXT_DIM)),
                Cell::from(source).style(Style::default().fg(source_color)),
                Cell::from(ev.type_tag().to_string())
                    .style(Style::default().fg(theme::ACCENT)),
                Cell::from("\u{25CF}").style(Style::default().fg(dot_color)),
                Cell::from(msg).style(Style::default().fg(theme::TEXT_PRIMARY)),
            ])
            .height(1)
        })
        .collect();

    let widths = [
        Constraint::Length(10),
        Constraint::Length(10),
        Constraint::Length(18),
        Constraint::Length(3),
        Constraint::Min(8),
    ];

    let mut table = Table::new(rows, widths)
        .header(header)
        .style(theme::panel_style());

    if let Some(pos) = selected_pos {
        table = table.highlight_style(
            Style::default()
                .bg(Color::Rgb(40, 60, 90))
                .add_modifier(Modifier::BOLD),
        );
        let mut state = ratatui::widgets::TableState::default();
        state.select(Some(pos));
        frame.render_stateful_widget(table, inner, &mut state);
    } else {
        frame.render_widget(table, inner);
    }
}

fn render_detail(frame: &mut Frame, area: Rect, app: &AppState) {
    let block = widgets::panel_block("Event Detail", false);
    let inner = block.inner(area);
    frame.render_widget(block, area);

    if inner.height == 0 || inner.width == 0 {
        return;
    }

    if app.events.is_empty() {
        let p = Paragraph::new("(select an event to inspect)").style(theme::dim_style());
        frame.render_widget(p, inner);
        return;
    }

    let idx = app
        .selected_event_index
        .min(app.events.len().saturating_sub(1));
    let ev = match app.events.get(idx) {
        Some(e) => e,
        None => return,
    };

    let dump = format!("{ev:#?}");
    // Truncate to fit roughly inner.height * inner.width chars; Paragraph
    // wrap will re-flow within the box.
    let cap = (inner.height as usize).saturating_mul(inner.width as usize);
    let text = if dump.len() > cap.saturating_mul(2) {
        let mut t: String = dump.chars().take(cap.saturating_mul(2)).collect();
        t.push_str("\n\u{2026}");
        t
    } else {
        dump
    };

    let p = Paragraph::new(text)
        .style(Style::default().fg(theme::TEXT_PRIMARY))
        .wrap(Wrap { trim: false });
    frame.render_widget(p, inner);
}
