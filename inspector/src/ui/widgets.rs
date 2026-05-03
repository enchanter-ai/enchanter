//! Reusable composite widgets for the cockpit views.
//!
//! Each `render_*` function takes a mutable `Frame` and a `Rect` so it can
//! be dropped into any layout cell. Pure helpers (`sparkline_string`,
//! `status_dot_line`, `panel_block`) return values so views can compose
//! richer paragraphs around them.

use ratatui::Frame;
use ratatui::layout::{Alignment, Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Borders, Gauge, Paragraph};

use crate::event::Phase;
use crate::state::PluginStatus;
use crate::ui::theme;

// ---- panel_block ----------------------------------------------------------

/// Standard panel chrome — dim border, dim title, optional focused highlight.
pub fn panel_block<'a>(title: &'a str, focused: bool) -> Block<'a> {
    let border_color = if focused {
        theme::PANEL_BORDER_FOCUS
    } else {
        theme::PANEL_BORDER
    };
    panel_block_with_color(title, focused, border_color)
}

/// Panel chrome with an explicit border color (used by overview panels which
/// each get their own accent so the eye can scan categories at a glance).
/// When `focused` is true the focus color overrides `border_color`.
pub fn panel_block_with_color<'a>(title: &'a str, focused: bool, border_color: Color) -> Block<'a> {
    let actual_border = if focused {
        theme::PANEL_BORDER_FOCUS
    } else {
        border_color
    };
    let title_style = if focused {
        Style::default()
            .fg(theme::PANEL_BORDER_FOCUS)
            .add_modifier(Modifier::BOLD)
    } else {
        Style::default()
            .fg(border_color)
            .add_modifier(Modifier::BOLD)
    };
    Block::default()
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(Style::default().fg(actual_border))
        .title(Span::styled(format!(" {title} "), title_style))
        .style(Style::default().bg(theme::BG))
}

/// Pulse a color between full brightness and ~50% brightness based on a tick
/// counter. `period` is the number of ticks per half-cycle. The app loop ticks
/// at 4 Hz (250 ms), so `period = 2` gives a ~500 ms cycle.
pub fn pulse_color(base: Color, tick: u64, period: u64) -> Color {
    let period = period.max(1);
    let bright = (tick / period) % 2 == 0;
    if bright {
        base
    } else {
        match base {
            Color::Rgb(r, g, b) => Color::Rgb(r / 2, g / 2, b / 2),
            other => other,
        }
    }
}

// ---- render_metric_card ---------------------------------------------------

/// Bold value on top, dim label below, optional secondary line beneath.
pub fn render_metric_card(
    frame: &mut Frame,
    area: Rect,
    label: &str,
    value: &str,
    secondary: Option<&str>,
    accent: Color,
) {
    let block = panel_block("", false);
    let inner = block.inner(area);
    frame.render_widget(block, area);

    let mut lines = vec![
        Line::from(Span::styled(
            value.to_string(),
            Style::default().fg(accent).add_modifier(Modifier::BOLD),
        )),
        Line::from(Span::styled(
            label.to_string(),
            Style::default().fg(theme::TEXT_DIM),
        )),
    ];
    if let Some(s) = secondary {
        lines.push(Line::from(Span::styled(
            s.to_string(),
            Style::default().fg(theme::TEXT_FAINT),
        )));
    }

    let p = Paragraph::new(lines).alignment(Alignment::Left);
    frame.render_widget(p, inner);
}

// ---- status_dot_line ------------------------------------------------------

/// Colored unicode bullet (●) followed by a space and `text`.
///
/// The bullet's color is derived from `status` first; `color` is used as the
/// fallback / accent for the trailing label so callers can still tint by
/// plugin brand.
pub fn status_dot_line(status: PluginStatus, color: Color, text: &str) -> Line<'static> {
    let dot_color = match status {
        PluginStatus::Healthy => theme::STATUS_HEALTHY,
        PluginStatus::Warning => theme::STATUS_WARNING,
        PluginStatus::Error => theme::STATUS_CRITICAL,
        PluginStatus::Disabled => theme::TEXT_FAINT,
    };
    Line::from(vec![
        Span::styled("\u{25CF}", Style::default().fg(dot_color)),
        Span::raw(" "),
        Span::styled(text.to_string(), Style::default().fg(color)),
    ])
}

// ---- sparkline_string -----------------------------------------------------

/// Eight-level unicode block sparkline. Maps `min..=max` of `values` onto
/// `▁▂▃▄▅▆▇█`. If `values.len() > width`, takes the most recent `width`
/// samples (truncates from the front). Empty slice → "—" repeated to fill.
pub fn sparkline_string(values: &[u64], width: usize) -> String {
    const LEVELS: [char; 8] = ['\u{2581}', '\u{2582}', '\u{2583}', '\u{2584}',
                                '\u{2585}', '\u{2586}', '\u{2587}', '\u{2588}'];

    if width == 0 {
        return String::new();
    }
    if values.is_empty() {
        return "\u{2014}".repeat(width);
    }

    // Truncate from the start so the most recent samples always survive.
    let slice: &[u64] = if values.len() > width {
        &values[values.len() - width..]
    } else {
        values
    };

    let min = *slice.iter().min().unwrap();
    let max = *slice.iter().max().unwrap();
    let span = max.saturating_sub(min);

    let mut out = String::with_capacity(slice.len());
    for &v in slice {
        let level = if span == 0 {
            // Flat series — pick a mid-band glyph so the user sees activity
            // rather than a misleading all-empty line.
            3
        } else {
            // Map (v - min) onto 0..=7. Use u128 to dodge u64 overflow on the
            // multiply for very large values.
            let scaled = ((v - min) as u128) * 7 / (span as u128);
            scaled.min(7) as usize
        };
        out.push(LEVELS[level]);
    }
    out
}

// ---- render_phase_pipeline ------------------------------------------------

/// `● anchor ─ ● trust ─ ● pre-disp ─ ○ dispatch ─ …` strip.
///
/// Filled circles mark the current phase and any phase before it; empty
/// circles mark upcoming work. The current phase is the brightest accent;
/// completed phases shade to a slightly dimmer healthy green so the eye
/// can still see "where we are now".
pub fn render_phase_pipeline(frame: &mut Frame, area: Rect, current: Option<Phase>) {
    const PHASES: [(Phase, &str); 7] = [
        (Phase::Anchor, "anchor"),
        (Phase::TrustGate, "trust"),
        (Phase::PreDispatch, "pre-disp"),
        (Phase::Dispatch, "dispatch"),
        (Phase::PostResponse, "post-resp"),
        (Phase::PostSession, "post-sess"),
        (Phase::CrossSession, "cross-sess"),
    ];

    let current_idx = current.and_then(|c| PHASES.iter().position(|(p, _)| *p == c));

    let mut spans: Vec<Span> = Vec::with_capacity(PHASES.len() * 4);
    for (i, (_phase, label)) in PHASES.iter().enumerate() {
        let (glyph, glyph_color, label_color) = match current_idx {
            Some(cur) if i < cur => (
                "\u{25CF}",
                theme::STATUS_HEALTHY,
                theme::TEXT_DIM,
            ),
            Some(cur) if i == cur => (
                "\u{25CF}",
                theme::ACCENT,
                theme::ACCENT,
            ),
            _ => (
                "\u{25CB}",
                theme::TEXT_FAINT,
                theme::TEXT_FAINT,
            ),
        };
        spans.push(Span::styled(glyph, Style::default().fg(glyph_color)));
        spans.push(Span::raw(" "));
        spans.push(Span::styled(
            (*label).to_string(),
            Style::default().fg(label_color),
        ));
        if i + 1 < PHASES.len() {
            spans.push(Span::styled(
                " \u{2500} ",
                Style::default().fg(theme::TEXT_FAINT),
            ));
        }
    }

    let p = Paragraph::new(Line::from(spans)).alignment(Alignment::Left);
    frame.render_widget(p, area);
}

// ---- render_progress_row --------------------------------------------------

/// Horizontal bar with `label` left, gauge in the middle, `<value><unit>`
/// numeric on the right. `value` is clamped to `0..=max`.
pub fn render_progress_row(
    frame: &mut Frame,
    area: Rect,
    label: &str,
    value: f32,
    max: f32,
    unit: &str,
) {
    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Length(16),
            Constraint::Min(8),
            Constraint::Length(12),
        ])
        .split(area);

    let label_para = Paragraph::new(Line::from(Span::styled(
        label.to_string(),
        Style::default().fg(theme::TEXT_DIM),
    )));
    frame.render_widget(label_para, cols[0]);

    let safe_max = if max <= 0.0 { 1.0 } else { max };
    let ratio = (value / safe_max).clamp(0.0, 1.0) as f64;

    let bar_color = if ratio >= 0.9 {
        theme::STATUS_CRITICAL
    } else if ratio >= 0.75 {
        theme::STATUS_WARNING
    } else {
        theme::STATUS_HEALTHY
    };

    let gauge = Gauge::default()
        .gauge_style(Style::default().fg(bar_color).bg(theme::BG))
        .ratio(ratio)
        .label("");
    frame.render_widget(gauge, cols[1]);

    let num_text = format!("{value:.1}{unit}");
    let num_para = Paragraph::new(Line::from(Span::styled(
        num_text,
        Style::default().fg(theme::TEXT_PRIMARY),
    )))
    .alignment(Alignment::Right);
    frame.render_widget(num_para, cols[2]);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sparkline_string_length_matches_width_for_short_input() {
        let s = sparkline_string(&[1, 2, 3, 4], 8);
        // Short input keeps its own length, no padding.
        assert_eq!(s.chars().count(), 4);
    }

    #[test]
    fn sparkline_string_truncates_to_width_when_input_longer() {
        let values: Vec<u64> = (0..50).collect();
        let s = sparkline_string(&values, 10);
        assert_eq!(s.chars().count(), 10);
    }

    #[test]
    fn sparkline_string_empty_produces_dash_filled_width() {
        let s = sparkline_string(&[], 6);
        assert_eq!(s.chars().count(), 6);
        assert!(s.chars().all(|c| c == '\u{2014}'));
    }

    #[test]
    fn sparkline_string_zero_width_is_empty() {
        let s = sparkline_string(&[1, 2, 3], 0);
        assert!(s.is_empty());
    }

    #[test]
    fn sparkline_string_flat_series_is_non_empty() {
        // A constant series shouldn't render as all-blank; pick a mid glyph.
        let s = sparkline_string(&[5, 5, 5, 5], 4);
        assert_eq!(s.chars().count(), 4);
        for c in s.chars() {
            assert_ne!(c, ' ');
        }
    }

    #[test]
    fn status_dot_line_has_three_spans() {
        let line = status_dot_line(PluginStatus::Healthy, theme::PLUGIN_HYDRA, "hydra");
        assert_eq!(line.spans.len(), 3);
        // Bullet glyph first.
        assert!(line.spans[0].content.contains('\u{25CF}'));
        // Label text last.
        assert_eq!(line.spans[2].content, "hydra");
    }
}
