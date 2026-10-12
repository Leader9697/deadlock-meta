mod webserver;
mod widgets;

use std::path::PathBuf;
use std::sync::Mutex;

use deadlock_live::{Command, Config, EngineEvent};
use serde::Serialize;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow, WindowEvent};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tokio::sync::mpsc;

/// Bundled website server process (installer builds only).
struct WebServer(Mutex<Option<std::process::Child>>);
/// What happened when the bundled site was started (shown when it cannot be reached).
struct WebNote(String);

struct AppState {
    cmd: mpsc::Sender<Command>,
    /// Latest key events, replayed to the UI on load (the engine can emit before the
    /// webview starts listening, e.g. a match found mid-game at startup).
    recent: Mutex<Vec<EngineEvent>>,
    click_through: Mutex<bool>,
    /// current match is finished (overlay hidden until the next match is detected)
    over: Mutex<bool>,
    settings: PublicSettings,
    layout: Mutex<widgets::Layout>,
    layout_path: Option<PathBuf>,
    editing: Mutex<bool>,
    widgets_shown: Mutex<bool>,
}

/// What the overlay UI needs to know about the config.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicSettings {
    site_base: String,
    account_id: Option<u32>,
    config_path: String,
    profile: Option<deadlock_live::steam::SteamProfile>,
}

#[tauri::command]
fn settings(state: State<'_, AppState>) -> PublicSettings {
    state.settings.clone()
}

#[tauri::command]
fn get_steam_profile() -> Option<deadlock_live::steam::SteamProfile> {
    deadlock_live::steam::local_steam_profile()
}

/// Why the local site is (not) up: start note, or the exit code + log tail if it died.
#[tauri::command]
fn web_status(
    app: tauri::AppHandle,
    server: State<'_, WebServer>,
    note: State<'_, WebNote>,
) -> String {
    let mut guard = server.0.lock().unwrap();
    if let Some(child) = guard.as_mut() {
        if let Ok(Some(status)) = child.try_wait() {
            let code = status.code().map_or("?".to_string(), |c| c.to_string());
            let tail = webserver::log_tail(&app);
            return format!("server lokal berhenti (kode {code}). {tail}");
        }
    }
    note.0.clone()
}

#[tauri::command]
fn engine_snapshot(state: State<'_, AppState>) -> Vec<EngineEvent> {
    state.recent.lock().unwrap().clone()
}

/// Keep game state, match, last status/error and last live state — enough to rebuild the UI.
fn remember(recent: &Mutex<Vec<EngineEvent>>, ev: &EngineEvent) {
    let mut r = recent.lock().unwrap();
    match ev {
        EngineEvent::GameStopped => r.clear(),
        EngineEvent::MatchDetected { .. } => r.retain(|e| matches!(e, EngineEvent::GameStarted)),
        _ => {}
    }
    let same_kind = |e: &EngineEvent| std::mem::discriminant(e) == std::mem::discriminant(ev);
    r.retain(|e| !same_kind(e));
    r.push(ev.clone());
}

#[tauri::command]
async fn set_match(state: State<'_, AppState>, match_id: u64) -> Result<(), String> {
    state
        .cmd
        .send(Command::SetMatch(match_id))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn force_game(state: State<'_, AppState>, on: bool) -> Result<(), String> {
    state
        .cmd
        .send(Command::ForceGame(on))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn stop_live(state: State<'_, AppState>) -> Result<(), String> {
    state
        .cmd
        .send(Command::StopLive)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn set_click_through(
    window: WebviewWindow,
    state: State<'_, AppState>,
    on: bool,
) -> Result<(), String> {
    *state.click_through.lock().unwrap() = on;
    window
        .set_ignore_cursor_events(on)
        .map_err(|e| e.to_string())?;
    window.emit("click-through", on).map_err(|e| e.to_string())
}

#[tauri::command]
fn toggle_edit_mode(app: AppHandle) -> bool {
    toggle_edit(&app)
}

#[tauri::command]
fn get_layout(state: State<'_, AppState>) -> widgets::Layout {
    state.layout.lock().unwrap().clone()
}

#[tauri::command]
fn toggle_widget(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
    enabled: bool,
) -> widgets::Layout {
    let mut l = state.layout.lock().unwrap();
    if let Some(w) = l.widgets.get_mut(&name) {
        w.enabled = enabled;
    }
    if let Some(p) = &state.layout_path {
        widgets::save(p, &l);
    }
    let shown = *state.widgets_shown.lock().unwrap();
    let _ = widgets::create(&app, &l);
    widgets::set_visible(&app, &l, shown);
    widgets::apply(&app, &l);
    l.clone()
}

#[tauri::command]
fn reset_layout(app: AppHandle, state: State<'_, AppState>) {
    let mut l = state.layout.lock().unwrap();
    *l = widgets::Layout::default();
    if let Some(p) = &state.layout_path {
        widgets::save(p, &l);
    }
    widgets::apply(&app, &l);
}

fn toggle_edit(app: &AppHandle) -> bool {
    let state = app.state::<AppState>();
    let on = {
        let mut e = state.editing.lock().unwrap();
        *e = !*e;
        *e
    };
    let shown = *state.widgets_shown.lock().unwrap();
    let mut l = state.layout.lock().unwrap();
    widgets::set_edit(app, &mut l, state.layout_path.as_deref(), on);
    if !on {
        widgets::set_visible(app, &l, shown);
        widgets::apply(app, &l);
    }
    on
}

/// Widgets appear when a match is going on and hide when the game closes.
fn widgets_visible(app: &AppHandle, on: bool) {
    let state = app.state::<AppState>();
    // Lock one mutex at a time (toggle_edit takes layout → widgets_shown).
    let editing = *state.editing.lock().unwrap();
    let changed = {
        let mut shown = state.widgets_shown.lock().unwrap();
        let changed = *shown != on;
        *shown = on;
        changed
    };
    if changed && !editing {
        let l = state.layout.lock().unwrap().clone();
        widgets::set_visible(app, &l, on);
    }
}

/// Match finished: HUD widgets go away now; launcher panel stays open to show the
/// result and let the player review stats or browse meta. Runs once per match.
fn match_over(app: &AppHandle) {
    let state = app.state::<AppState>();
    {
        let mut over = state.over.lock().unwrap();
        if *over {
            return;
        }
        *over = true;
    }
    widgets_visible(app, false);
}

fn toggle_visible(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("overlay") {
        let is_focused = w.is_focused().unwrap_or(false);
        let is_visible = w.is_visible().unwrap_or(false);
        let is_minimized = w.is_minimized().unwrap_or(false);

        // Only hide if the window is currently visible, focused, and not minimized
        if is_visible && is_focused && !is_minimized {
            let _ = w.hide();
        } else {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_always_on_top(true);
            let _ = w.set_focus();
        }
    }
}

fn show_panel(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("overlay") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_always_on_top(true);
        let _ = w.set_focus();
    }
}

/// System tray icon: left click shows/hides the panel, right click opens the menu.
/// Closing the panel (✕, Alt+F4) only hides it to the tray; "Keluar" really quits
/// (and stops the bundled site, see the Exit event below).
fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(
        app,
        "show",
        "Tampilkan panel (Ctrl+Shift+D)",
        true,
        None::<&str>,
    )?;
    let click = MenuItem::with_id(
        app,
        "click",
        "Mode klik-tembus (Ctrl+Shift+F)",
        true,
        None::<&str>,
    )?;
    let edit = MenuItem::with_id(
        app,
        "edit",
        "Atur posisi HUD (Ctrl+Shift+E)",
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "Keluar", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &show,
            &click,
            &edit,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip(format!("Deadlock Meta v{}", app.package_info().version))
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, ev| match ev.id.as_ref() {
            "show" => show_panel(app),
            "click" => toggle_click_through(app),
            "edit" => {
                toggle_edit(app);
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, ev| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = ev
            {
                toggle_visible(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

fn toggle_click_through(app: &AppHandle) {
    let state = app.state::<AppState>();
    let on = {
        let mut g = state.click_through.lock().unwrap();
        *g = !*g;
        *g
    };
    if let Some(w) = app.get_webview_window("overlay") {
        let _ = w.set_ignore_cursor_events(on);
        let _ = w.emit("click-through", on);
        if !on {
            let _ = w.set_focus();
        }
    }
}

/// Ctrl+Shift+D: show/hide main panel. Ctrl+Shift+F: click-through. Ctrl+Shift+E: edit HUD widgets.
fn shortcuts() -> (Shortcut, Shortcut, Shortcut) {
    let m = Some(Modifiers::CONTROL | Modifiers::SHIFT);
    (
        Shortcut::new(m, Code::KeyD),
        Shortcut::new(m, Code::KeyF),
        Shortcut::new(m, Code::KeyE),
    )
}

/// In-game hotkeys handled by the main window's script (HUD widgets are click-through):
/// Ctrl+Shift+B = "sudah beli" for the #1 item, Ctrl+Shift+H = HUD focus mode,
/// Ctrl+Shift+T = team view for 10 s in the HUD Lawan box.
fn game_shortcuts() -> (Shortcut, Shortcut, Shortcut) {
    let m = Some(Modifiers::CONTROL | Modifiers::SHIFT);
    (
        Shortcut::new(m, Code::KeyB),
        Shortcut::new(m, Code::KeyH),
        Shortcut::new(m, Code::KeyT),
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, sc, ev| {
                    if ev.state() != ShortcutState::Pressed {
                        return;
                    }
                    let (toggle, interact, edit) = shortcuts();
                    let (bought, focus, team) = game_shortcuts();
                    if *sc == bought {
                        let _ = app.emit("hotkey", "bought");
                    } else if *sc == team {
                        let _ = app.emit("hotkey", "team");
                    } else if *sc == focus {
                        let _ = app.emit("hotkey", "focus");
                    } else if *sc == toggle {
                        toggle_visible(app);
                    } else if *sc == interact {
                        toggle_click_through(app);
                    } else if *sc == edit {
                        toggle_edit(app);
                    }
                })
                .build(),
        )
        .on_window_event(|window, event| {
            // the panel never quits the app by itself: hide it to the tray instead
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "overlay" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(|app| {
            if let Err(e) = build_tray(app) {
                eprintln!("tray icon not created: {e}");
            }
            let (toggle, interact, edit) = shortcuts();
            // A hotkey taken by another program (or a second copy of this app) must not crash the app.
            let mut taken: Vec<&str> = Vec::new();
            let (bought, focus, team) = game_shortcuts();
            for (sc, label) in [
                (toggle, "Ctrl+Shift+D"),
                (interact, "Ctrl+Shift+F"),
                (edit, "Ctrl+Shift+E"),
                (bought, "Ctrl+Shift+B"),
                (focus, "Ctrl+Shift+H"),
                (team, "Ctrl+Shift+T"),
            ] {
                if let Err(e) = app.global_shortcut().register(sc) {
                    eprintln!("hotkey {label} not registered: {e}");
                    taken.push(label);
                }
            }

            let dir = app.path().app_config_dir()?;
            std::fs::create_dir_all(&dir)?;
            let config_path = dir.join("deadlock-live.toml");
            let cfg = Config::load(&config_path).unwrap_or_default();

            // installed app: run the bundled website so no terminal is needed
            let (child, note) = webserver::start(app.handle(), &cfg.site_base, cfg.api_key.as_deref(), &cfg.web_env);
            app.manage(WebServer(Mutex::new(child)));
            app.manage(WebNote(note));

            let (cmd_tx, cmd_rx) = mpsc::channel(16);
            let (ev_tx, mut ev_rx) = mpsc::channel::<EngineEvent>(256);

            let layout_path = widgets::layout_path(app.handle());
            let layout = layout_path.as_deref().map(widgets::load).unwrap_or_default();
            widgets::create(app.handle(), &layout)?;

            app.manage(AppState {
                cmd: cmd_tx,
                recent: Mutex::new(Vec::new()),
                layout: Mutex::new(layout),
                layout_path,
                editing: Mutex::new(false),
                widgets_shown: Mutex::new(false),
                click_through: Mutex::new(false),
                over: Mutex::new(false),
                settings: PublicSettings {
                    site_base: cfg.site_base.clone(),
                    account_id: cfg.account_id.or_else(deadlock_live::steam::local_account_id),
                    config_path: config_path.display().to_string(),
                    profile: deadlock_live::steam::local_steam_profile(),
                },
            });
            if !taken.is_empty() {
                let msg = format!(
                    "Hotkey {} dipakai program lain (Deadlock Meta lain yang masih jalan, Discord, NVIDIA/AMD overlay?). Overlay tetap jalan, hotkey itu saja yang tidak aktif.",
                    taken.join(", ")
                );
                remember(&app.state::<AppState>().recent, &EngineEvent::Error { message: msg });
            }

            if cfg.ingest_matches {
                let seen = dir.join("ingested-matches.txt");
                tauri::async_runtime::spawn(deadlock_live::ingest::run(cfg.api_base.clone(), seen));
            }
            tauri::async_runtime::spawn(deadlock_live::run(cfg, ev_tx, cmd_rx));

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                while let Some(ev) = ev_rx.recv().await {
                    remember(&handle.state::<AppState>().recent, &ev);
                    match &ev {
                        // game over (winner known) or stream finished: take the overlay off the screen
                        EngineEvent::LiveState(st) if st.winning_team.is_some() => match_over(&handle),
                        EngineEvent::LiveEnded { .. } => match_over(&handle),
                        EngineEvent::MatchDetected { .. } => {
                            *handle.state::<AppState>().over.lock().unwrap() = false;
                            widgets_visible(&handle, true);
                        }
                        EngineEvent::LiveState(_) | EngineEvent::LiveConnected { .. } => {
                            if !*handle.state::<AppState>().over.lock().unwrap() {
                                widgets_visible(&handle, true);
                            }
                        }
                        EngineEvent::GameStopped => widgets_visible(&handle, false),
                        _ => {}
                    }
                    // Auto-show the overlay when a match is found.
                    if matches!(ev, EngineEvent::MatchDetected { .. } | EngineEvent::LobbyPlayers { .. }) {
                        if let Some(w) = handle.get_webview_window("overlay") {
                            let _ = w.show();
                        }
                    }
                    let _ = handle.emit("engine", &ev);
                }
            });
            // Re-place widgets periodically (resolution / monitor / DPI changes).
            let h2 = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    let st = h2.state::<AppState>();
                    if !*st.editing.lock().unwrap() {
                        widgets::apply(&h2, &st.layout.lock().unwrap());
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            settings,
            get_steam_profile,
            web_status,
            engine_snapshot,
            set_match,
            stop_live,
            force_game,
            set_click_through,
            toggle_edit_mode,
            reset_layout,
            get_layout,
            toggle_widget
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, ev| {
            if let tauri::RunEvent::Exit = ev {
                if let Some(mut c) = app.state::<WebServer>().0.lock().unwrap().take() {
                    let _ = c.kill();
                }
            }
        });
}
