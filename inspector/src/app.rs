//! App — main async event loop, terminal lifecycle, input dispatch.
//!
//! Wires together the transport receiver (incoming JSON events), the keyboard
//! input stream, a tick timer (so animations / uptime advance even when idle),
//! state mutation, and view rendering. Terminal init and teardown are bracketed
//! by a Drop-guard so panics never leave the user in raw mode.

use std::io::{self, IsTerminal, Stdout};
use std::time::Duration;

use crossterm::{
    event::{
        DisableMouseCapture, EnableMouseCapture, Event as CtEvent, KeyCode, KeyEvent,
        KeyEventKind, KeyModifiers,
    },
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use ratatui::{backend::CrosstermBackend, Frame, Terminal};
use tokio::sync::mpsc;

use crate::event::Event;
use crate::state::{AppState, Panel, View};
use crate::transport::{Source as TSource, Transport};
use crate::{Config, Source};

/// Main entry point. Sets up the terminal, spawns transport + input + tick
/// tasks, runs the select-loop until the user quits, and tears the terminal
/// down on the way out (including on panic via `TerminalGuard::Drop`).
pub async fn run(config: Config) -> anyhow::Result<()> {
    tracing::info!(?config, "starting enchanter-inspector");

    // Stamp process start so RUNTIME's "Inspector uptime" row is honest.
    let _ = crate::state::STARTED_AT.set(std::time::Instant::now());

    // Terminal init — bracketed by a Drop-guard so panics don't strand the user.
    let mut guard = TerminalGuard::enter()?;
    let terminal = &mut guard.terminal;

    // Demo-mode trigger: stdin source AND no pipe (terminal stdin) → skip
    // the real transport and run the built-in synthetic emitter so the
    // dashboard always shows life on a bare `enchanter.exe` launch.
    let demo_mode = matches!(config.source, Source::Stdin) && io::stdin().is_terminal();

    // Build the unified event receiver — either from real transport or demo.
    let mut event_rx: mpsc::Receiver<Event> = if demo_mode {
        let (tx, rx) = mpsc::channel::<Event>(1024);
        crate::demo::spawn_demo_emitter(tx);
        rx
    } else {
        Transport::spawn(map_source(config.source), 1024).into_receiver()
    };

    // Keyboard: poll-on-blocking-thread, forward Crossterm events over a channel.
    let (key_tx, mut key_rx) = mpsc::channel::<CtEvent>(64);
    let _key_handle = spawn_key_reader(key_tx);

    // Tick: drives idle redraws (uptime, spinners) at 4 Hz.
    let mut tick = tokio::time::interval(Duration::from_millis(250));

    let mut app = AppState::default();
    app.demo_mode = demo_mode;
    // Populate session identity so the ACTIVE SESSION box shows real values
    // even before any session.* event has arrived.
    app.session.workspace = crate::state::detect_claude_workspace();
    app.session.env = crate::state::detect_env();
    app.session.github_user = crate::state::detect_github_user();
    app.session.claude_user = crate::state::detect_claude_user();
    // Plan is detected eagerly (cheap — one tiny JSON read); usage requires
    // walking project session JSONLs so we kick that off here too with the
    // 100ms wall-clock cap baked into the helper.
    let (tokens, messages) = crate::state::detect_claude_usage_today();
    app.session.claude_tokens_today = tokens;
    app.session.claude_messages_today = messages;
    let mut help_visible = false;
    let mut dirty = true;

    loop {
        if dirty {
            terminal.draw(|frame| draw_app(frame, &app, help_visible))?;
            dirty = false;
        }

        tokio::select! {
            biased;

            maybe_input = key_rx.recv() => {
                let Some(input) = maybe_input else { break };
                let outcome = handle_input(&mut app, input, &mut help_visible);
                if matches!(outcome, InputOutcome::Quit) {
                    break;
                }
                dirty = true;
            }

            maybe_event = event_rx.recv() => {
                match maybe_event {
                    Some(event) => {
                        if !app.paused {
                            app.apply(event);
                            dirty = true;
                        }
                    }
                    None => {
                        // Transport ended. Keep the UI alive so the user can
                        // inspect the final state until they press q.
                        tracing::info!("transport stream ended");
                    }
                }
            }

            _ = tick.tick() => {
                app.bump_tick();
                // Refresh Claude token/message totals every ~60s
                // (240 ticks × 250ms). Cheap because the helper caps its
                // own wall-clock budget.
                if app.tick % 240 == 0 {
                    let (t, m) = crate::state::detect_claude_usage_today();
                    app.session.claude_tokens_today = t;
                    app.session.claude_messages_today = m;
                }
                dirty = true;
            }
        }
    }

    // guard.drop runs on the way out → terminal restored.
    Ok(())
}

// ---------------------------------------------------------------------------
// Source mapping
// ---------------------------------------------------------------------------

fn map_source(s: Source) -> TSource {
    match s {
        Source::Stdin => TSource::Stdin,
        Source::File(path) => TSource::File(path),
        Source::Socket(addr) => TSource::Socket(addr),
    }
}

// ---------------------------------------------------------------------------
// Terminal guard — restores raw-mode / alt-screen even on panic
// ---------------------------------------------------------------------------

struct TerminalGuard {
    terminal: Terminal<CrosstermBackend<Stdout>>,
}

impl TerminalGuard {
    fn enter() -> anyhow::Result<Self> {
        enable_raw_mode()?;
        let mut out = io::stdout();
        execute!(out, EnterAlternateScreen, EnableMouseCapture)?;
        let backend = CrosstermBackend::new(io::stdout());
        let terminal = Terminal::new(backend)?;
        Ok(Self { terminal })
    }
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        // Best-effort teardown. Errors here are not actionable — the process
        // is already on its way out.
        let _ = disable_raw_mode();
        let _ = execute!(io::stdout(), LeaveAlternateScreen, DisableMouseCapture);
        let _ = self.terminal.show_cursor();
    }
}

// ---------------------------------------------------------------------------
// Keyboard reader
// ---------------------------------------------------------------------------

fn spawn_key_reader(tx: mpsc::Sender<CtEvent>) -> tokio::task::JoinHandle<()> {
    tokio::task::spawn_blocking(move || {
        loop {
            // Poll with a short timeout so we don't burn a core but stay
            // responsive to incoming keystrokes.
            match crossterm::event::poll(Duration::from_millis(50)) {
                Ok(true) => match crossterm::event::read() {
                    Ok(ev) => {
                        if tx.blocking_send(ev).is_err() {
                            return; // consumer dropped → exit reader
                        }
                    }
                    Err(err) => {
                        tracing::warn!(%err, "crossterm read error, exiting key reader");
                        return;
                    }
                },
                Ok(false) => continue,
                Err(err) => {
                    tracing::warn!(%err, "crossterm poll error, exiting key reader");
                    return;
                }
            }
        }
    })
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

fn draw_app(frame: &mut Frame, app: &AppState, help_visible: bool) {
    let area = frame.area();
    match app.active_view {
        View::Overview => crate::views::overview::render(frame, area, app),
        View::Plugins => crate::views::plugins::render(frame, area, app),
        View::EventTrace => crate::views::events::render(frame, area, app),
        View::Security => crate::views::security::render(frame, area, app),
        View::Cost => crate::views::cost::render(frame, area, app),
        View::Drift => crate::views::drift::render(frame, area, app),
        View::Codebase => crate::views::codebase::render(frame, area, app),
        View::SessionReplay => crate::views::replay::render(frame, area, app),
        View::RuntimeTotals => crate::views::runtime::render(frame, area, app),
        View::ActiveTasks => crate::views::tasks::render(frame, area, app),
    }

    if help_visible {
        draw_help_overlay(frame);
    }
}

fn draw_help_overlay(frame: &mut Frame) {
    use ratatui::layout::{Alignment, Direction, Layout, Rect};
    use ratatui::style::{Color, Style};
    use ratatui::widgets::{Block, Borders, Clear, Paragraph};

    let area = frame.area();
    // Center a 60x18 modal (or as much as fits).
    let w = area.width.min(60);
    let h = area.height.min(18);
    let x = area.x + (area.width.saturating_sub(w)) / 2;
    let y = area.y + (area.height.saturating_sub(h)) / 2;
    let modal = Rect::new(x, y, w, h);

    let _ = Layout::default().direction(Direction::Vertical); // suppress unused-import lints

    let body = "\
        q / Ctrl-C   Quit\n\
        1..9, 0      Switch view\n\
        Tab          Cycle panel\n\
        Up / Down    Move selection\n\
        Enter        Open detail\n\
        Esc          Close detail / clear filter\n\
        /            Filter mode\n\
        p            Pause / resume stream\n\
        s            Cycle sort mode\n\
        c            Clear events (Events view) / Cost view otherwise\n\
        ?            Toggle this help\n";

    let block = Block::default()
        .borders(Borders::ALL)
        .title(" Help — keys ")
        .style(Style::default().bg(Color::Black).fg(Color::White));

    let para = Paragraph::new(body)
        .block(block)
        .alignment(Alignment::Left);

    frame.render_widget(Clear, modal);
    frame.render_widget(para, modal);
}

// ---------------------------------------------------------------------------
// Input handling
// ---------------------------------------------------------------------------

/// What the input handler tells the main loop to do next.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputOutcome {
    Continue,
    Quit,
}

fn handle_input(app: &mut AppState, ev: CtEvent, help_visible: &mut bool) -> InputOutcome {
    match ev {
        CtEvent::Key(KeyEvent {
            code,
            modifiers,
            kind,
            ..
        }) => {
            // Only react to Press to avoid double-firing on terminals that
            // emit Press + Release.
            if kind != KeyEventKind::Press && kind != KeyEventKind::Repeat {
                return InputOutcome::Continue;
            }
            handle_key(app, code, modifiers, help_visible)
        }
        // Mouse / Resize / Paste events ignored for MVP.
        _ => InputOutcome::Continue,
    }
}

fn handle_key(
    app: &mut AppState,
    code: KeyCode,
    modifiers: KeyModifiers,
    help_visible: &mut bool,
) -> InputOutcome {
    // Ctrl-C is a hard quit regardless of other state.
    if matches!(code, KeyCode::Char('c')) && modifiers.contains(KeyModifiers::CONTROL) {
        return InputOutcome::Quit;
    }

    match code {
        KeyCode::Char('q') => InputOutcome::Quit,

        KeyCode::Char('1') => {
            app.active_view = View::Overview;
            InputOutcome::Continue
        }
        KeyCode::Char('2') => {
            app.active_view = View::Plugins;
            InputOutcome::Continue
        }
        KeyCode::Char('3') => {
            app.active_view = View::EventTrace;
            InputOutcome::Continue
        }
        KeyCode::Char('4') => {
            app.active_view = View::Security;
            InputOutcome::Continue
        }
        KeyCode::Char('5') => {
            app.active_view = View::Cost;
            InputOutcome::Continue
        }
        KeyCode::Char('6') => {
            app.active_view = View::Drift;
            InputOutcome::Continue
        }
        KeyCode::Char('7') => {
            app.active_view = View::Codebase;
            InputOutcome::Continue
        }
        KeyCode::Char('8') => {
            app.active_view = View::SessionReplay;
            InputOutcome::Continue
        }
        KeyCode::Char('9') => {
            app.active_view = View::RuntimeTotals;
            InputOutcome::Continue
        }
        KeyCode::Char('0') => {
            app.active_view = View::ActiveTasks;
            InputOutcome::Continue
        }

        KeyCode::Tab => {
            app.active_panel = cycle_panel(app.active_panel);
            InputOutcome::Continue
        }

        KeyCode::Up => {
            adjust_selection(app, -1);
            InputOutcome::Continue
        }
        KeyCode::Down => {
            adjust_selection(app, 1);
            InputOutcome::Continue
        }

        KeyCode::Enter => {
            // Detail-open is an optional capability on AppState; we do not
            // mutate state.rs to add it. No-op when absent.
            InputOutcome::Continue
        }

        KeyCode::Esc => {
            // Close detail (no-op if absent) and clear filter.
            app.filter_query.clear();
            InputOutcome::Continue
        }

        KeyCode::Char('/') => {
            // MVP: clear and let the user re-type. Full text-input is a v2 chore.
            app.filter_query.clear();
            InputOutcome::Continue
        }

        KeyCode::Char('p') => {
            app.toggle_pause();
            InputOutcome::Continue
        }

        KeyCode::Char('s') => {
            app.sort_mode = app.sort_mode.next();
            InputOutcome::Continue
        }

        KeyCode::Char('c') => {
            if matches!(app.active_panel, Panel::Events) {
                app.clear_events();
            } else {
                app.active_view = View::Cost;
            }
            InputOutcome::Continue
        }

        KeyCode::Char('?') => {
            *help_visible = !*help_visible;
            InputOutcome::Continue
        }

        _ => InputOutcome::Continue,
    }
}

fn cycle_panel(current: Panel) -> Panel {
    // Best-effort cycle. AppState owns the canonical panel list; if it grows,
    // either expose a `Panel::next()` there or update this match. For MVP we
    // round-trip through the four panels documented in the spec.
    match current {
        Panel::Plugins => Panel::Events,
        Panel::Events => Panel::Health,
        Panel::Health => Panel::Insights,
        Panel::Insights => Panel::Tasks,
        Panel::Tasks => Panel::Detail,
        Panel::Detail => Panel::Plugins,
    }
}

fn adjust_selection(app: &mut AppState, delta: i32) {
    // Saturating index adjustment. AppState is expected to expose a uniform
    // `move_selection(delta)` once panels stabilize; until then we route via
    // `selected_index` on the active panel. We use saturating arithmetic on
    // a usize via i64 to honor the spec's "saturating" contract.
    let cur = app.selected_index() as i64;
    let next = cur.saturating_add(delta as i64).max(0) as usize;
    app.set_selected_index(next);
}

// ---------------------------------------------------------------------------
// Test-friendly pure key handler
// ---------------------------------------------------------------------------

/// Pure key handler for tests — no terminal, no async. Mirrors `handle_key`
/// with no modifiers and a throwaway `help_visible` flag.
pub fn handle_key_for_test(app: &mut AppState, code: KeyCode) -> InputOutcome {
    let mut help = false;
    handle_key(app, code, KeyModifiers::NONE, &mut help)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn q_returns_quit() {
        let mut app = AppState::default();
        let outcome = handle_key_for_test(&mut app, KeyCode::Char('q'));
        assert_eq!(outcome, InputOutcome::Quit);
    }

    #[test]
    fn digit_two_sets_plugins_view() {
        let mut app = AppState::default();
        let outcome = handle_key_for_test(&mut app, KeyCode::Char('2'));
        assert_eq!(outcome, InputOutcome::Continue);
        assert!(matches!(app.active_view, View::Plugins));
    }

    #[test]
    fn p_toggles_pause() {
        let mut app = AppState::default();
        let before = app.paused;
        let outcome = handle_key_for_test(&mut app, KeyCode::Char('p'));
        assert_eq!(outcome, InputOutcome::Continue);
        assert_ne!(app.paused, before, "p should toggle the pause flag");
    }

    #[test]
    fn ctrl_c_quits() {
        let mut app = AppState::default();
        let mut help = false;
        let outcome = handle_key(
            &mut app,
            KeyCode::Char('c'),
            KeyModifiers::CONTROL,
            &mut help,
        );
        assert_eq!(outcome, InputOutcome::Quit);
    }
}
