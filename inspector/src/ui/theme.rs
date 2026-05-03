//! Color palette and style helpers for the dark-themed cockpit.
//!
//! All raw RGB constants live here; views and widgets consume them via
//! the named getters below so that any palette tweak is one-file.

use ratatui::style::{Color, Modifier, Style};

use crate::event::Severity;

// ---- Background / structure ------------------------------------------------

pub const BG: Color = Color::Rgb(12, 14, 22);
pub const PANEL_BORDER: Color = Color::Rgb(60, 70, 90);
pub const PANEL_BORDER_FOCUS: Color = Color::Rgb(120, 200, 255);
pub const TEXT_PRIMARY: Color = Color::Rgb(220, 225, 235);
pub const TEXT_DIM: Color = Color::Rgb(120, 130, 150);
pub const TEXT_FAINT: Color = Color::Rgb(70, 80, 100);
pub const ACCENT: Color = Color::Rgb(120, 220, 200);
pub const BRAND_PRIMARY: Color = ACCENT;
pub const SELECTION_BG: Color = Color::Rgb(30, 40, 55);

// ---- Severity / status -----------------------------------------------------

pub const STATUS_HEALTHY: Color = Color::Rgb(80, 220, 130);
pub const STATUS_WARNING: Color = Color::Rgb(255, 200, 80);
pub const STATUS_CRITICAL: Color = Color::Rgb(255, 95, 110);
pub const STATUS_NEUTRAL: Color = Color::Rgb(120, 180, 255);

// ---- Plugin colors (per spec color_hint) ----------------------------------

pub const PLUGIN_PECH: Color = Color::Rgb(255, 165, 70);
pub const PLUGIN_EMU: Color = Color::Rgb(245, 220, 90);
pub const PLUGIN_HYDRA: Color = Color::Rgb(80, 220, 130);
pub const PLUGIN_SYLPH: Color = Color::Rgb(110, 220, 240);
pub const PLUGIN_LICH: Color = Color::Rgb(110, 160, 255);
pub const PLUGIN_NAGA: Color = Color::Rgb(120, 200, 110);
pub const PLUGIN_CROW: Color = Color::Rgb(230, 200, 110);
pub const PLUGIN_DJINN: Color = Color::Rgb(180, 130, 240);
pub const PLUGIN_GORGON: Color = Color::Rgb(255, 130, 200);
pub const PLUGIN_WIXIE: Color = Color::Rgb(220, 100, 220);

// ---- Per-box border colors (overview layout) -------------------------------
// Distinct accents from the existing palette so the eye can scan boxes by
// category. All chosen from constants above to keep palette discipline.

pub const BORDER_TITLE: Color = Color::Rgb(255, 200, 70); // top bar — warm gold, distinct from cool palette
pub const BORDER_SESSION: Color = ACCENT;            // active session — cyan
pub const BORDER_METRICS: Color = PLUGIN_PECH;       // session metrics — orange
pub const BORDER_RUNTIME: Color = STATUS_NEUTRAL;    // runtime — blue
pub const BORDER_HEALTH: Color = STATUS_HEALTHY;     // system health — green
pub const BORDER_PLUGINS: Color = PLUGIN_DJINN;      // plugins — purple
pub const BORDER_EVENTS: Color = TEXT_DIM;           // events — grey
pub const BORDER_PIPELINE: Color = PLUGIN_WIXIE;     // phase pipeline — magenta

/// Map a plugin name (lowercase) to its accent color. Unknown names fall back
/// to `TEXT_PRIMARY` so callers never have to handle an `Option`.
pub fn plugin_color(name: &str) -> Color {
    match name {
        "pech" => PLUGIN_PECH,
        "emu" => PLUGIN_EMU,
        "hydra" => PLUGIN_HYDRA,
        "sylph" => PLUGIN_SYLPH,
        "lich" => PLUGIN_LICH,
        "naga" => PLUGIN_NAGA,
        "crow" => PLUGIN_CROW,
        "djinn" => PLUGIN_DJINN,
        "gorgon" => PLUGIN_GORGON,
        "wixie" => PLUGIN_WIXIE,
        _ => TEXT_PRIMARY,
    }
}

// ---- Style helpers ---------------------------------------------------------

/// Default panel chrome: dim border, primary text, dark background.
pub fn panel_style() -> Style {
    Style::default()
        .fg(TEXT_PRIMARY)
        .bg(BG)
}

/// Focused-panel chrome: bright cyan border to draw the eye.
pub fn panel_focused_style() -> Style {
    Style::default()
        .fg(TEXT_PRIMARY)
        .bg(BG)
        .add_modifier(Modifier::BOLD)
}

/// Bold accent style for panel titles and section headings.
pub fn title_style() -> Style {
    Style::default()
        .fg(ACCENT)
        .add_modifier(Modifier::BOLD)
}

/// Dim style for secondary labels and inactive rows.
pub fn dim_style() -> Style {
    Style::default().fg(TEXT_DIM)
}

/// Style keyed off a textual status name. Unknown statuses get the neutral
/// blue treatment so the UI never silently drops to default-on-default.
pub fn status_style(status: &str) -> Style {
    let color = match status {
        "healthy" => STATUS_HEALTHY,
        "warning" => STATUS_WARNING,
        "critical" => STATUS_CRITICAL,
        "neutral" => STATUS_NEUTRAL,
        _ => STATUS_NEUTRAL,
    };
    Style::default().fg(color)
}

/// Severity → palette color, total over the `Severity` enum.
pub fn severity_color(s: Severity) -> Color {
    match s {
        Severity::Debug => TEXT_FAINT,
        Severity::Info => STATUS_NEUTRAL,
        Severity::Warning => STATUS_WARNING,
        Severity::High => STATUS_WARNING,
        Severity::Critical => STATUS_CRITICAL,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plugin_color_covers_all_ten() {
        let names = [
            "pech", "emu", "hydra", "sylph", "lich", "naga", "crow", "djinn", "gorgon", "wixie",
        ];
        let expected = [
            PLUGIN_PECH,
            PLUGIN_EMU,
            PLUGIN_HYDRA,
            PLUGIN_SYLPH,
            PLUGIN_LICH,
            PLUGIN_NAGA,
            PLUGIN_CROW,
            PLUGIN_DJINN,
            PLUGIN_GORGON,
            PLUGIN_WIXIE,
        ];
        for (n, e) in names.iter().zip(expected.iter()) {
            assert_eq!(plugin_color(n), *e, "wrong color for plugin {n}");
        }
        // Unknown name → fallback, never panics.
        assert_eq!(plugin_color("unknown-plugin"), TEXT_PRIMARY);
    }

    #[test]
    fn severity_color_is_total() {
        // Every variant produces a color (no panic, no default-fallthrough).
        let _ = severity_color(Severity::Debug);
        let _ = severity_color(Severity::Info);
        let _ = severity_color(Severity::Warning);
        let _ = severity_color(Severity::High);
        let _ = severity_color(Severity::Critical);
        // Critical is the most severe; sanity-check it maps to the critical color.
        assert_eq!(severity_color(Severity::Critical), STATUS_CRITICAL);
        assert_eq!(severity_color(Severity::Debug), TEXT_FAINT);
    }

    #[test]
    fn status_style_known_statuses() {
        assert_eq!(status_style("healthy").fg, Some(STATUS_HEALTHY));
        assert_eq!(status_style("warning").fg, Some(STATUS_WARNING));
        assert_eq!(status_style("critical").fg, Some(STATUS_CRITICAL));
        assert_eq!(status_style("neutral").fg, Some(STATUS_NEUTRAL));
        // Unknown → neutral fallback, never None.
        assert_eq!(status_style("garbage").fg, Some(STATUS_NEUTRAL));
    }
}
