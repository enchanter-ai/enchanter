//! Responsive layout calculator for the cockpit views.
//!
//! Three breakpoints based on terminal width:
//!
//! - `Wide`   — ≥120 cols: full overview with three side-by-side metric boxes
//! - `Medium` — 90–119 cols: metric boxes still side-by-side but tighter
//! - `Narrow` — 60–89 cols: metric boxes stack vertically
//! - `Tiny`   — <60 cols: minimum viable cockpit (top bar, summary, events, footer)
//!
//! `compute_overview_layout` returns a flat struct of `Rect` slots so view
//! renderers don't have to recompute splits themselves.

use ratatui::layout::{Constraint, Direction, Layout, Rect};

/// Width band the current terminal falls into.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Width {
    Wide,
    Medium,
    Narrow,
    Tiny,
}

/// Map a viewport `Rect` to a width band. Bands are inclusive at the lower
/// bound: 120 → Wide, 119 → Medium, 90 → Medium, 89 → Narrow, …
pub fn detect_width(area: Rect) -> Width {
    match area.width {
        w if w >= 120 => Width::Wide,
        w if w >= 90 => Width::Medium,
        w if w >= 60 => Width::Narrow,
        _ => Width::Tiny,
    }
}

/// Concrete pixel rectangles for every panel of the overview view.
///
/// Renderers consume this directly; rectangles that don't apply to the
/// current width band collapse to zero-area `Rect`s so the renderer can
/// safely skip them via `area.area() == 0`.
#[derive(Debug, Clone, Copy)]
pub struct OverviewLayout {
    /// Width band the layout was solved for; informational, lets the
    /// renderer choose compact vs. full content.
    pub width: Width,

    /// 1-row top status bar (always present).
    pub top_bar: Rect,

    /// Active-session prominence box (workspace / user / task / file / risk).
    pub active_session: Rect,

    /// Per-section box rects sitting in the metrics row. On Narrow they
    /// stack vertically; on Wide/Medium they sit side-by-side.
    pub session_metrics: Rect,
    pub runtime_metrics: Rect,
    pub system_health: Rect,

    /// 3-row phase pipeline strip (its own bordered box).
    pub phase_pipeline: Rect,
    /// Plugins table panel.
    pub plugins_panel: Rect,
    /// Recent events panel.
    pub events_panel: Rect,
    /// 1-row footer; collapsed to zero on very narrow widths.
    pub footer: Rect,
}

impl OverviewLayout {
    /// Sentinel zero-area rect used when a panel doesn't exist for the
    /// current width band.
    fn empty() -> Rect {
        Rect::new(0, 0, 0, 0)
    }
}

/// Solve the layout for the overview view at the given viewport rectangle.
pub fn compute_overview_layout(area: Rect) -> OverviewLayout {
    let width = detect_width(area);
    match width {
        Width::Wide => wide(area),
        Width::Medium => medium(area),
        Width::Narrow => narrow(area),
        Width::Tiny => tiny(area),
    }
}

// ---------------------------------------------------------------------------
// Wide  ≥120 cols
// ---------------------------------------------------------------------------
fn wide(area: Rect) -> OverviewLayout {
    let v = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3),  // top bar (bordered box)
            Constraint::Length(7), // active session (5 content rows + 2 borders) — 3-column sub-box layout
            Constraint::Length(12), // metrics row (border + max-of-three: 10 content rows)
            Constraint::Length(3),  // phase pipeline (bordered box)
            Constraint::Min(8),     // plugins
            Constraint::Min(8),     // events
        ])
        .split(area);

    let metrics_row = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Ratio(1, 3),
            Constraint::Ratio(1, 3),
            Constraint::Ratio(1, 3),
        ])
        .split(v[2]);

    OverviewLayout {
        width: Width::Wide,
        top_bar: v[0],
        active_session: v[1],
        session_metrics: metrics_row[0],
        runtime_metrics: metrics_row[1],
        system_health: metrics_row[2],
        phase_pipeline: v[3],
        plugins_panel: v[4],
        events_panel: v[5],
        footer: OverviewLayout::empty(),
    }
}

// ---------------------------------------------------------------------------
// Medium  90..=119 cols
// ---------------------------------------------------------------------------
fn medium(area: Rect) -> OverviewLayout {
    let v = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3),
            Constraint::Length(7), // active session (5 content rows + 2 borders)
            Constraint::Length(12), // metrics row (border + max-of-three: 10 content rows)
            Constraint::Length(3),
            Constraint::Min(8),
            Constraint::Min(8),
        ])
        .split(area);

    let metrics_row = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Ratio(1, 3),
            Constraint::Ratio(1, 3),
            Constraint::Ratio(1, 3),
        ])
        .split(v[2]);

    OverviewLayout {
        width: Width::Medium,
        top_bar: v[0],
        active_session: v[1],
        session_metrics: metrics_row[0],
        runtime_metrics: metrics_row[1],
        system_health: metrics_row[2],
        phase_pipeline: v[3],
        plugins_panel: v[4],
        events_panel: v[5],
        footer: OverviewLayout::empty(),
    }
}

// ---------------------------------------------------------------------------
// Narrow  60..=89 cols — metric boxes stack
// ---------------------------------------------------------------------------
fn narrow(area: Rect) -> OverviewLayout {
    let v = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3),  // top bar (bordered box)
            Constraint::Length(7), // active session (5 content rows + 2 borders) — 3-column sub-box layout
            Constraint::Length(12), // session metrics (10 rows stacked + 2 borders)
            Constraint::Length(11), // runtime metrics (9 rows + 2 borders)
            Constraint::Length(12), // system health (10 rows + 2 borders)
            Constraint::Length(3),  // phase pipeline
            Constraint::Min(6),     // plugins
            Constraint::Min(6),     // events
        ])
        .split(area);

    OverviewLayout {
        width: Width::Narrow,
        top_bar: v[0],
        active_session: v[1],
        session_metrics: v[2],
        runtime_metrics: v[3],
        system_health: v[4],
        phase_pipeline: v[5],
        plugins_panel: v[6],
        events_panel: v[7],
        footer: OverviewLayout::empty(),
    }
}

// ---------------------------------------------------------------------------
// Tiny  <60 cols
// ---------------------------------------------------------------------------
fn tiny(area: Rect) -> OverviewLayout {
    let v = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3), // top bar (bordered box)
            Constraint::Length(1), // metrics summary line
            Constraint::Min(3),    // events flex
        ])
        .split(area);

    OverviewLayout {
        width: Width::Tiny,
        top_bar: v[0],
        active_session: OverviewLayout::empty(),
        session_metrics: v[1],
        runtime_metrics: OverviewLayout::empty(),
        system_health: OverviewLayout::empty(),
        phase_pipeline: OverviewLayout::empty(),
        plugins_panel: OverviewLayout::empty(),
        events_panel: v[2],
        footer: OverviewLayout::empty(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(w: u16, h: u16) -> Rect {
        Rect::new(0, 0, w, h)
    }

    #[test]
    fn detect_width_bands() {
        assert_eq!(detect_width(rect(200, 50)), Width::Wide);
        assert_eq!(detect_width(rect(120, 50)), Width::Wide);
        assert_eq!(detect_width(rect(119, 50)), Width::Medium);
        assert_eq!(detect_width(rect(90, 50)), Width::Medium);
        assert_eq!(detect_width(rect(89, 50)), Width::Narrow);
        assert_eq!(detect_width(rect(60, 50)), Width::Narrow);
        assert_eq!(detect_width(rect(59, 50)), Width::Tiny);
        assert_eq!(detect_width(rect(40, 50)), Width::Tiny);
    }

    #[test]
    fn wide_layout_populates_metric_row() {
        let l = compute_overview_layout(rect(160, 50));
        assert_eq!(l.width, Width::Wide);
        assert!(l.active_session.area() > 0);
        assert!(l.session_metrics.area() > 0);
        assert!(l.runtime_metrics.area() > 0);
        assert!(l.system_health.area() > 0);
        assert!(l.phase_pipeline.area() > 0);
        assert_eq!(l.top_bar.height, 3);
        // Footer was hoisted into the ACTIVE SESSION box; the slot is now empty.
        assert_eq!(l.footer.area(), 0);
    }

    #[test]
    fn medium_layout_keeps_metrics_row() {
        let l = compute_overview_layout(rect(100, 50));
        assert_eq!(l.width, Width::Medium);
        assert!(l.session_metrics.area() > 0);
        assert!(l.runtime_metrics.area() > 0);
        assert!(l.system_health.area() > 0);
    }

    #[test]
    fn narrow_layout_stacks_metric_boxes() {
        let l = compute_overview_layout(rect(80, 60));
        assert_eq!(l.width, Width::Narrow);
        assert!(l.session_metrics.area() > 0);
        assert!(l.runtime_metrics.area() > 0);
        assert!(l.system_health.area() > 0);
        assert!(l.plugins_panel.area() > 0);
        assert!(l.events_panel.area() > 0);
    }

    #[test]
    fn tiny_layout_is_minimum_viable() {
        let l = compute_overview_layout(rect(40, 30));
        assert_eq!(l.width, Width::Tiny);
        assert!(l.top_bar.area() > 0);
        assert!(l.events_panel.area() > 0);
        // Footer dropped — info hoisted into the active-session header instead.
        assert_eq!(l.footer.area(), 0);
        assert_eq!(l.plugins_panel.area(), 0);
        assert_eq!(l.runtime_metrics.area(), 0);
        assert_eq!(l.system_health.area(), 0);
    }
}
