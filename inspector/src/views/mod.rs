//! Per-view rendering. Each module owns one screen of the cockpit.
//!
//! Bound to number-keys 1..0 in the order declared below; see README for the
//! authoritative key map.

pub mod overview;
pub mod plugins;
pub mod events;
pub mod security;
pub mod cost;
pub mod drift;
pub mod codebase;
pub mod replay;
pub mod runtime;
pub mod tasks;
