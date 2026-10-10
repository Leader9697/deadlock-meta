//! Live engine for the Deadlock Meta desktop app.
//!
//! Everything here is passive: process list, Steam config files, the game's own
//! console.log, Steam's http cache (match ids + salts, see `ingest`), and deadlock-api's
//! public spectator broadcast. No memory reading, no
//! injection, no input automation.

pub mod config;
pub mod engine;
pub mod ingest;
pub mod logwatch;
pub mod process;
pub mod state;
pub mod steam;
pub mod stream;

pub use config::Config;
pub use engine::{run, Command};
pub use state::{EngineEvent, LivePlayer, LiveState};
