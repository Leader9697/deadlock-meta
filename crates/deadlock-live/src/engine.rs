//! Orchestrates detection → match id → live stream, and reports `EngineEvent`s.

use std::collections::BTreeSet;
use std::time::{Duration, Instant};

use serde_json::Value;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio::time::interval;

use crate::config::Config;
use crate::logwatch::{backscan, LogEvent, LogTail, Matchers};
use crate::process::ProcessWatch;
use crate::state::{Diag, EngineEvent, LiveState};
use crate::steam;
use crate::config::NamedQuery;
use crate::stream::{Aggregator, Api};

#[derive(Debug, Clone)]
pub enum Command {
    /// Manually start the live stream for a match id (e.g. typed into the overlay).
    SetMatch(u64),
    StopLive,
    /// Treat the game as running even if no exe / Steam signal is found (manual mode).
    ForceGame(bool),
    Shutdown,
}

struct Live {
    match_id: u64,
    task: JoinHandle<()>,
    rows: mpsc::Receiver<Result<Value, String>>,
    agg: Aggregator,
    last_emit: Instant,
    dirty: bool,
    connected: bool,
}

pub async fn run(cfg: Config, events: mpsc::Sender<EngineEvent>, mut cmds: mpsc::Receiver<Command>) {
    let api = Api::new(&cfg.api_base, cfg.api_key.clone());
    let mut my_account = cfg.account_id.or_else(steam::local_account_id).unwrap_or(0);
    let log_path = cfg.console_log.clone().or_else(steam::console_log_path);
    let matchers = match Matchers::new(&cfg.log) {
        Ok(m) => Some(m),
        Err(e) => {
            let _ = events.send(EngineEvent::Error { message: format!("invalid log pattern: {e}") }).await;
            None
        }
    };

    let mut procs = ProcessWatch::new(&cfg.process_names);
    let mut proc_tick = interval(Duration::from_millis(cfg.poll_process_ms));
    let mut log_tick = interval(Duration::from_millis(cfg.poll_log_ms));
    let mut fallback_tick = interval(Duration::from_secs(60));

    let mut running = false;
    let mut last_seen: Option<Instant> = None;
    // manual mode: game assumed running; a manually started match survives detection gaps
    let mut force = false;
    let mut live_manual = false;
    let mut tail: Option<LogTail> = None;
    let mut lobby: BTreeSet<u32> = BTreeSet::new();
    let mut live: Option<Live> = None;
    let emit_every = Duration::from_millis(cfg.live.emit_every_ms);

    if my_account == 0 {
        let _ = events
            .send(EngineEvent::Error { message: "Steam account not found; set account_id in deadlock-live.toml".into() })
            .await;
    }

    loop {
        tokio::select! {
            _ = proc_tick.tick() => {
                // Process list, or console.log written in the last 30 s (covers renamed exes).
                let log_active = log_path.as_ref()
                    .and_then(|p| std::fs::metadata(p).ok()?.modified().ok()?.elapsed().ok())
                    .map(|age| age < Duration::from_secs(120))
                    .unwrap_or(false);
                let detected = procs.is_running() || log_active;
                // hysteresis: one missed check (menu, loading screen, flaky process list) is not "game closed"
                if detected { last_seen = Some(Instant::now()); }
                let now = detected || force || (running && last_seen.map(|t| t.elapsed() < Duration::from_secs(60)).unwrap_or(false));
                {
                    let log_age = log_path.as_ref()
                        .and_then(|p| std::fs::metadata(p).ok()?.modified().ok()?.elapsed().ok())
                        .map(|d| d.as_secs());
                    let found_by = procs.found_by.map(String::from)
                        .or_else(|| log_active.then(|| "console.log".to_string()))
                        .or_else(|| force.then(|| "manual".to_string()));
                    let _ = events.send(EngineEvent::Diag(Diag {
                        game: now,
                        found_by,
                        force,
                        procs_seen: procs.seen,
                        steam_app: crate::process::steam_running_app(),
                        log_path: log_path.as_ref().map(|p| p.display().to_string()),
                        log_exists: log_path.as_ref().map(|p| p.exists()).unwrap_or(false),
                        log_age_s: log_age,
                        account_id: my_account,
                        match_id: live.as_ref().map(|l| l.match_id),
                        live_connected: live.as_ref().map(|l| l.connected).unwrap_or(false),
                    })).await;
                }
                if now && !running {
                    running = true;
                    let by = if procs.found_by.is_some() { procs.found_by.unwrap() } else if force { "mode manual" } else { "console.log" };
                    let _ = events.send(EngineEvent::Status { message: format!("Deadlock terdeteksi (lewat {by})") }).await;
                    lobby.clear();
                    tail = log_path.clone().map(|p| LogTail::new(p, true));
                    let _ = events.send(EngineEvent::GameStarted).await;

                    // App opened mid-match: pick up the match id already in the log.
                    if live.is_none() {
                        if let (Some(p), Some(m)) = (log_path.as_ref(), matchers.as_ref()) {
                            if let Ok(content) = std::fs::read_to_string(p) {
                                let (mid, me) = backscan(&content, m, 90);
                                if let Some(a) = me { my_account = a; }
                                if let Some(id) = mid {
                                    let _ = events.send(EngineEvent::MatchDetected { match_id: id, source: "console.log (sudah berjalan)".into() }).await;
                                    live = Some(start_live(&api, &cfg, id, my_account, events.clone()));
                                }
                            }
                        }
                    }
                } else if !now && running {
                    running = false;
                    tail = None;
                    // a manually started match keeps running (and the UI keeps it) through detection gaps
                    if !live_manual {
                        if let Some(l) = live.take() { l.task.abort(); }
                        let _ = events.send(EngineEvent::GameStopped).await;
                    }
                }
            }

            _ = log_tick.tick(), if running && tail.is_some() && matchers.is_some() => {
                let lines = match tail.as_mut().unwrap().read_new_lines() {
                    Ok(l) => l,
                    Err(e) => { let _ = events.send(EngineEvent::Error { message: format!("console.log: {e}") }).await; vec![] }
                };
                let mut evs = vec![];
                for line in &lines { matchers.as_ref().unwrap().scan_line(line, &mut evs); }
                let before = lobby.len();
                for ev in evs {
                    match ev {
                        LogEvent::MatchId(id) if live.as_ref().map(|l| l.match_id) != Some(id) => {
                            live_manual = false;
                            let _ = events.send(EngineEvent::MatchDetected { match_id: id, source: "console.log".into() }).await;
                            live = Some(start_live(&api, &cfg, id, my_account, events.clone()));
                        }
                        // The running client's own login wins over loginusers.vdf (alt accounts).
                        LogEvent::SelfAccount(a) if a != my_account => {
                            my_account = a;
                            if let Some(l) = live.as_mut() { l.agg.state.my_account_id = a; }
                        }
                        LogEvent::Player(a) => { lobby.insert(a); }
                        LogEvent::MatchEnd => {
                            if let Some(l) = live.take() {
                                l.task.abort();
                                let _ = events.send(EngineEvent::LiveEnded { match_id: l.match_id }).await;
                            }
                            lobby.clear();
                        }
                        _ => {}
                    }
                }
                if lobby.len() != before && !lobby.is_empty() {
                    let _ = events.send(EngineEvent::LobbyPlayers { account_ids: lobby.iter().copied().collect() }).await;
                }
            }

            // Watch-tab fallback: only helps for top-200 matches, but costs one cheap call a minute.
            _ = fallback_tick.tick(), if running && live.is_none() && my_account > 0 => {
                if let Ok(Some(id)) = api.active_match_for(my_account).await {
                    let _ = events.send(EngineEvent::MatchDetected { match_id: id, source: "watch-tab".into() }).await;
                    live = Some(start_live(&api, &cfg, id, my_account, events.clone()));
                }
            }

            row = async { live.as_mut().unwrap().rows.recv().await }, if live.is_some() => {
                let l = live.as_mut().unwrap();
                match row {
                    Some(Ok(v)) => {
                        if !l.connected {
                            l.connected = true;
                            let _ = events.send(EngineEvent::LiveConnected { match_id: l.match_id }).await;
                        }
                        let was_over = l.agg.state.winning_team.is_some();
                        l.dirty |= l.agg.apply(&v);
                        let game_over = !was_over && l.agg.state.winning_team.is_some();
                        if l.dirty && (game_over || l.last_emit.elapsed() >= emit_every) {
                            l.last_emit = Instant::now();
                            l.dirty = false;
                            let _ = events.send(EngineEvent::LiveState(l.agg.state.clone())).await;
                        }
                    }
                    Some(Err(msg)) => {
                        let _ = events.send(EngineEvent::Error { message: msg }).await;
                    }
                    None => {
                        let l = live.take().unwrap();
                        if l.dirty && !l.agg.state.players.is_empty() {
                            let _ = events.send(EngineEvent::LiveState(l.agg.state.clone())).await;
                        }
                        let _ = events.send(EngineEvent::LiveEnded { match_id: l.match_id }).await;
                    }
                }
            }

            cmd = cmds.recv() => match cmd {
                Some(Command::SetMatch(id)) if live.as_ref().map(|l| l.match_id == id && !l.task.is_finished()).unwrap_or(false) => {
                    let _ = events.send(EngineEvent::Status { message: format!("Match #{id} sudah diproses, menunggu broadcast…") }).await;
                }
                Some(Command::SetMatch(id)) => {
                    if let Some(l) = live.take() { l.task.abort(); }
                    live_manual = true;
                    let _ = events.send(EngineEvent::MatchDetected { match_id: id, source: "manual".into() }).await;
                    live = Some(start_live(&api, &cfg, id, my_account, events.clone()));
                }
                Some(Command::StopLive) => {
                    live_manual = false;
                    if let Some(l) = live.take() { l.task.abort(); }
                }
                Some(Command::ForceGame(on)) => {
                    force = on;
                    let _ = events.send(EngineEvent::Status { message: if on {
                        "Mode manual: Deadlock dianggap jalan (deteksi exe diabaikan)".into()
                    } else {
                        "Mode otomatis: deteksi exe / Steam / console.log".into()
                    } }).await;
                }
                Some(Command::Shutdown) | None => {
                    if let Some(l) = live.take() { l.task.abort(); }
                    return;
                }
            },
        }
    }
}

fn start_live(api: &Api, cfg: &Config, match_id: u64, my_account: u32, events: mpsc::Sender<EngineEvent>) -> Live {
    let (tx, rx) = mpsc::channel::<Result<Value, String>>(1024);
    let api = api.clone();
    let queries = cfg.live.queries.clone();
    let task = tokio::spawn(async move {
        let Some(url) = resolve_url(&api, match_id, &events).await else {
            let _ = tx.send(Err("Broadcast tidak tersedia untuk match ini (setelah 15 menit mencoba).".into())).await;
            return;
        };
        let _ = events.send(EngineEvent::Status { message: "Broadcast ditemukan, menunggu data…".into() }).await;

        // One SSE stream per query (players / clock / purchases / game over).
        let streams: Vec<_> = queries.into_iter().map(|q| tokio::spawn(run_query(api.clone(), url.clone(), q, tx.clone()))).collect();
        for s in streams {
            let _ = s.await;
        }
    });

    Live {
        match_id,
        task,
        rows: rx,
        agg: Aggregator::new(LiveState { match_id: Some(match_id), my_account_id: my_account, ..Default::default() }),
        last_emit: Instant::now() - Duration::from_secs(3600),
        dirty: false,
        connected: false,
    }
}

/// Finds a broadcast URL without burning the spectate quota:
/// 1. poll the public live-URL list every 20 s (cheap),
/// 2. ask deadlock-api to spectate at most 3 times, spaced ≥3 min (6/hour per IP),
///    giving up after ~15 minutes.
async fn resolve_url(api: &Api, match_id: u64, events: &mpsc::Sender<EngineEvent>) -> Option<String> {
    let started = Instant::now();
    let mut spectate_tries = 0u32;
    let mut next_spectate = Instant::now(); // first spectate right away
    let mut quota_gone = false;
    while started.elapsed() < Duration::from_secs(15 * 60) {
        if let Ok(Some(u)) = api.listed_broadcast_url(match_id).await {
            return Some(u);
        }
        if !quota_gone && spectate_tries < 3 && Instant::now() >= next_spectate {
            spectate_tries += 1;
            match api.resolve_broadcast_url(match_id).await {
                Ok(u) => return Some(u),
                Err(e) => {
                    let status = e.downcast_ref::<crate::stream::SpectateError>().map(|s| s.status);
                    quota_gone = status == Some(429);
                    next_spectate = Instant::now() + Duration::from_secs(180);
                    let msg = match status {
                        Some(429) => "Kuota spectate habis (6/jam). Menunggu broadcast muncul di daftar publik…".to_string(),
                        Some(s) if s >= 500 => format!("deadlock-api belum bisa spectate (HTTP {s}), coba lagi {}/3 dalam 3 menit…", spectate_tries),
                        _ => format!("Spectate gagal: {e}"),
                    };
                    let _ = events.send(EngineEvent::Status { message: msg }).await;
                }
            }
        }
        tokio::time::sleep(Duration::from_secs(20)).await;
    }
    None
}

/// Keeps one query stream alive (reconnects are cheap with broadcast_url: 20/min).
async fn run_query(api: Api, url: String, q: NamedQuery, tx: mpsc::Sender<Result<Value, String>>) {
    for _ in 0..20 {
        let (rtx, mut rrx) = mpsc::channel::<Value>(512);
        let fwd = {
            let tx = tx.clone();
            tokio::spawn(async move {
                while let Some(v) = rrx.recv().await {
                    if tx.send(Ok(v)).await.is_err() {
                        break;
                    }
                }
            })
        };
        let res = api.stream_rows(&url, &q.sql, rtx).await;
        let _ = fwd.await;
        match res {
            Ok(()) => return, // broadcast finished
            Err(e) => {
                if tx.send(Err(format!("live stream '{}': {e}", q.name))).await.is_err() {
                    return;
                }
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
        }
    }
}
