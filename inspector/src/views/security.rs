//! Security view — Hydra + Sylph veto and policy decisions.
//!
//! Top stat-card row (vetoes session/lifetime, policy mode, sandbox), middle
//! two-column split (recent decisions table + blocked-patterns list), bottom
//! phase-distribution counts.

use std::collections::BTreeMap;

use ratatui::Frame;
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Cell, Paragraph, Row, Table, Wrap};

use crate::event::{Event, Severity};
use crate::state::AppState;
use crate::ui::theme;
use crate::ui::widgets;

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

fn fmt_time(t: f64) -> String {
    let secs = t as i64;
    let h = (secs / 3600) % 24;
    let m = (secs / 60) % 60;
    let s = secs % 60;
    format!("{:02}:{:02}:{:02}", h, m, s)
}

/// Heuristic: an event is "veto-relevant" if its type tag mentions "veto" or
/// its severity is High/Critical.
fn is_veto_relevant(ev: &Event) -> bool {
    if ev.type_tag().contains("veto") {
        return true;
    }
    matches!(ev.severity(), Some(Severity::High) | Some(Severity::Critical))
}

/// Pull a string field from the loose payload of a generic event by name.
/// HydraVeto exposes typed `policy`/`reason` directly; for everything else we
/// best-effort sniff via Debug-format. Returns "—" when nothing fits.
fn payload_field(ev: &Event, key: &str) -> String {
    match (ev, key) {
        (Event::HydraVeto { policy, .. }, "policy") => policy.clone(),
        (Event::HydraVeto { reason, .. }, "reason") => reason.clone(),
        (Event::HydraVeto { action, .. }, "action") => action.clone(),
        _ => {
            // Loose sniff in the Debug print — tolerant to missing fields.
            let dbg = format!("{:?}", ev);
            let needle = format!("{}: ", key);
            match dbg.find(&needle) {
                Some(at) => {
                    let rest = &dbg[at + needle.len()..];
                    let end = rest
                        .find(|c: char| c == ',' || c == '}' || c == ')')
                        .unwrap_or(rest.len().min(60));
                    rest[..end].trim().trim_matches('"').to_string()
                }
                None => "—".into(),
            }
        }
    }
}

fn action_for(ev: &Event) -> String {
    match ev {
        Event::HydraVeto { action, .. } => action.clone(),
        _ if ev.type_tag().contains("veto") => "blocked".into(),
        _ => match ev.severity() {
            Some(Severity::Critical) => "blocked".into(),
            Some(Severity::High) | Some(Severity::Warning) => "warned".into(),
            _ => "allowed".into(),
        },
    }
}

/// Best-effort phase string for an event. Currently only `HydraVeto` carries
/// it as a typed field — everything else falls through Debug-format sniffing.
fn phase_for(ev: &Event) -> Option<String> {
    if let Event::HydraVeto { phase: Some(p), .. } = ev {
        return Some(p.clone());
    }
    let v = payload_field(ev, "phase");
    if v == "—" || v.is_empty() { None } else { Some(v) }
}

pub fn render(frame: &mut Frame, area: Rect, app: &AppState) {
    let outer = widgets::panel_block("Security", false);
    let inner = outer.inner(area);
    frame.render_widget(outer, area);

    if inner.height == 0 || inner.width == 0 {
        return;
    }

    // Stat-card row | middle split | phase distribution row
    let stat_h: u16 = 5;
    let phase_h: u16 = 3;
    let middle_h = inner.height.saturating_sub(stat_h + phase_h);

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints(vec![
            Constraint::Length(stat_h),
            Constraint::Length(middle_h.max(3)),
            Constraint::Length(phase_h),
        ])
        .split(inner);

    render_stat_row(frame, chunks[0], app);
    render_middle(frame, chunks[1], app);
    render_phase_row(frame, chunks[2], app);
}

fn render_stat_row(frame: &mut Frame, area: Rect, app: &AppState) {
    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints(vec![
            Constraint::Percentage(25),
            Constraint::Percentage(25),
            Constraint::Percentage(25),
            Constraint::Percentage(25),
        ])
        .split(area);

    let session_vetoes = app.metrics.security_incidents_session;
    let lifetime_vetoes = app.runtime_metrics.vetoes_lifetime;
    let policy_mode = "strict"; // wire-format doesn't carry mode; default per spec

    // Sandbox: derive from any event whose type tag mentions "sandbox" → on,
    // otherwise default to "on" per spec.
    let sandbox_on = app
        .events
        .iter()
        .any(|ev| ev.type_tag().contains("sandbox"));
    let sandbox = if sandbox_on || app.events.is_empty() { "on" } else { "on" };

    widgets::render_metric_card(
        frame,
        cols[0],
        "Vetoes (session)",
        &format!("{}", session_vetoes),
        None,
        if session_vetoes > 0 { theme::STATUS_CRITICAL } else { theme::STATUS_HEALTHY },
    );
    widgets::render_metric_card(
        frame,
        cols[1],
        "Vetoes (lifetime)",
        &format!("{}", lifetime_vetoes),
        None,
        theme::STATUS_NEUTRAL,
    );
    widgets::render_metric_card(
        frame,
        cols[2],
        "Policy mode",
        policy_mode,
        None,
        theme::ACCENT,
    );
    widgets::render_metric_card(
        frame,
        cols[3],
        "Sandbox",
        sandbox,
        None,
        theme::STATUS_HEALTHY,
    );
}

fn render_middle(frame: &mut Frame, area: Rect, app: &AppState) {
    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints(vec![Constraint::Percentage(65), Constraint::Percentage(35)])
        .split(area);

    render_recent_decisions(frame, cols[0], app);
    render_blocked_patterns(frame, cols[1], app);
}

fn render_recent_decisions(frame: &mut Frame, area: Rect, app: &AppState) {
    let outer = widgets::panel_block("Recent Decisions", false);
    let inner = outer.inner(area);
    frame.render_widget(outer, area);

    if inner.height == 0 {
        return;
    }

    // Newest first, limited to events that are veto-relevant.
    let mut decisions: Vec<&Event> = app
        .events
        .iter()
        .filter(|ev| is_veto_relevant(ev))
        .collect();
    decisions.reverse();
    decisions.truncate(inner.height.saturating_sub(1) as usize);

    if decisions.is_empty() {
        let p = Paragraph::new("(no veto or high-severity decisions yet)")
            .style(theme::dim_style());
        frame.render_widget(p, inner);
        return;
    }

    let header = Row::new(
        ["time", "plugin", "action", "policy", "reason", "sev"]
            .into_iter()
            .map(|h| Cell::from(h).style(theme::title_style())),
    )
    .height(1);

    let reason_w = (inner.width as usize)
        .saturating_sub(8 + 8 + 9 + 14 + 4)
        .max(10);

    let rows: Vec<Row> = decisions
        .iter()
        .map(|ev| {
            let plugin = ev.plugin().unwrap_or("?").to_string();
            let plugin_style = Style::default().fg(theme::plugin_color(&plugin));
            let action = action_for(ev);
            let policy = truncate(&payload_field(ev, "policy"), 14);
            let reason = truncate(&payload_field(ev, "reason"), reason_w);
            let sev_label = match ev.severity() {
                Some(Severity::Critical) => "critical",
                Some(Severity::High) => "high",
                Some(Severity::Warning) => "warn",
                Some(Severity::Info) => "info",
                Some(Severity::Debug) => "debug",
                None => "—",
            };
            let sev_color = ev
                .severity()
                .map(theme::severity_color)
                .unwrap_or(theme::TEXT_FAINT);

            Row::new(vec![
                Cell::from(fmt_time(ev.time())),
                Cell::from(truncate(&plugin, 8)).style(plugin_style),
                Cell::from(action),
                Cell::from(policy),
                Cell::from(reason),
                Cell::from(sev_label).style(Style::default().fg(sev_color)),
            ])
        })
        .collect();

    let widths = [
        Constraint::Length(8),
        Constraint::Length(8),
        Constraint::Length(9),
        Constraint::Length(14),
        Constraint::Min(10),
        Constraint::Length(8),
    ];

    let table = Table::new(rows, widths)
        .header(header)
        .style(theme::panel_style());
    frame.render_widget(table, inner);
}

fn render_blocked_patterns(frame: &mut Frame, area: Rect, app: &AppState) {
    let outer = widgets::panel_block("Blocked Patterns", false);
    let inner = outer.inner(area);
    frame.render_widget(outer, area);

    if inner.height == 0 {
        return;
    }

    let mut patterns: Vec<String> = vec![
        "rm -rf /".into(),
        "force push to protected branch".into(),
        "token exposure".into(),
        "secret file read".into(),
    ];

    // Add unique policies seen in recent veto events.
    let mut seen: std::collections::BTreeSet<String> = patterns.iter().cloned().collect();
    for ev in app.events.iter().filter(|e| is_veto_relevant(e)) {
        let policy = payload_field(ev, "policy");
        if policy != "—" && !policy.is_empty() && seen.insert(policy.clone()) {
            patterns.push(policy);
        }
    }

    let lines: Vec<Line> = patterns
        .iter()
        .take(inner.height as usize)
        .map(|p| {
            Line::from(vec![
                Span::styled("• ", Style::default().fg(theme::STATUS_CRITICAL)),
                Span::styled(
                    truncate(p, inner.width.saturating_sub(2) as usize),
                    Style::default().fg(theme::TEXT_PRIMARY),
                ),
            ])
        })
        .collect();

    let para = Paragraph::new(lines)
        .style(theme::panel_style())
        .wrap(Wrap { trim: false });
    frame.render_widget(para, inner);
}

fn render_phase_row(frame: &mut Frame, area: Rect, app: &AppState) {
    let outer = widgets::panel_block("Veto Phase Distribution", false);
    let inner = outer.inner(area);
    frame.render_widget(outer, area);

    if inner.height == 0 {
        return;
    }

    let canonical_phases = [
        "anchor",
        "trust-gate",
        "pre-dispatch",
        "dispatch",
        "post-response",
    ];
    let mut counts: BTreeMap<String, u32> = BTreeMap::new();
    for ph in canonical_phases.iter() {
        counts.insert((*ph).into(), 0);
    }
    for ev in app.events.iter().filter(|e| is_veto_relevant(e)) {
        if let Some(p) = phase_for(ev) {
            *counts.entry(p).or_insert(0) += 1;
        }
    }

    let parts: Vec<Span> = canonical_phases
        .iter()
        .flat_map(|ph| {
            let n = counts.get(*ph).copied().unwrap_or(0);
            let style = if n > 0 {
                Style::default().fg(theme::STATUS_WARNING).add_modifier(Modifier::BOLD)
            } else {
                theme::dim_style()
            };
            vec![
                Span::styled(format!("{}=", ph), theme::dim_style()),
                Span::styled(format!("{}", n), style),
                Span::raw("   "),
            ]
        })
        .collect();

    let para = Paragraph::new(Line::from(parts)).style(theme::panel_style());
    frame.render_widget(para, inner);
}
