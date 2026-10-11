//! HUD widgets: small transparent, click-through windows placed around the Deadlock HUD.
//!
//! Positions are stored as fractions of the game monitor (Deadlock runs borderless
//! fullscreen), with an anchor so a widget keeps hugging the same HUD element at any
//! resolution. Edit mode (Ctrl+Shift+E) makes them draggable; leaving it saves the
//! layout to `hud-layout.json` in the app config dir.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Monitor, PhysicalPosition, PhysicalSize, Position, Size, WebviewUrl, WebviewWindowBuilder};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Anchor {
    /// x is the widget's left edge
    Tl,
    /// x is the widget's horizontal centre
    Tc,
    /// x is the widget's right edge
    Tr,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WidgetPos {
    /// fraction of monitor width / height
    pub fx: f64,
    pub fy: f64,
    pub anchor: Anchor,
    /// logical size before `Layout.scale`
    pub w: f64,
    pub h: f64,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Layout {
    /// index into the monitor list; None = primary monitor
    pub monitor: Option<usize>,
    pub scale: f64,
    pub widgets: BTreeMap<String, WidgetPos>,
}

impl Default for Layout {
    /// Defaults around Deadlock's HUD: coach under the top hero bar, win/econ and enemy
    /// list on the left edge, next-buy on the right edge. Adjust once in edit mode.
    fn default() -> Self {
        let w = |fx, fy, anchor, w, h| WidgetPos { fx, fy, anchor, w, h, enabled: true };
        let mut widgets = BTreeMap::new();
        widgets.insert("coach".into(), w(0.5, 0.105, Anchor::Tc, 440.0, 92.0));
        widgets.insert("win".into(), w(0.012, 0.25, Anchor::Tl, 300.0, 175.0));
        widgets.insert("enemies".into(), w(0.012, 0.52, Anchor::Tl, 290.0, 370.0));
        widgets.insert("buy".into(), w(0.988, 0.30, Anchor::Tr, 300.0, 330.0));
        Self { monitor: None, scale: 1.0, widgets }
    }
}

pub fn layout_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("hud-layout.json"))
}

pub fn load(path: &Path) -> Layout {
    let mut l: Layout = std::fs::read_to_string(path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    // new widgets added in later versions get their defaults
    for (k, v) in Layout::default().widgets {
        l.widgets.entry(k).or_insert(v);
    }
    // the coach widget used to be 520×200 and covered the fight: move old default sizes to the compact one
    if let Some(c) = l.widgets.get_mut("coach") {
        if c.w == 520.0 && c.h == 200.0 {
            c.w = 440.0;
            c.h = 92.0;
        }
    }
    // the win widget became the compact "situasi" card
    if let Some(c) = l.widgets.get_mut("win") {
        if c.w == 270.0 && c.h == 265.0 {
            c.w = 300.0;
            c.h = 175.0;
        }
    }
    if !(0.5..=2.5).contains(&l.scale) {
        l.scale = 1.0;
    }
    l
}

pub fn save(path: &Path, l: &Layout) {
    if let Ok(s) = serde_json::to_string_pretty(l) {
        let _ = std::fs::write(path, s);
    }
}

pub fn label(name: &str) -> String {
    format!("w-{name}")
}

fn monitor(app: &AppHandle, l: &Layout) -> Option<Monitor> {
    if let Some(i) = l.monitor {
        if let Some(m) = app.available_monitors().ok().and_then(|ms| ms.into_iter().nth(i)) {
            return Some(m);
        }
    }
    app.primary_monitor().ok().flatten()
}

/// Physical (x, y, w, h) of a widget on a monitor.
pub fn place(mon_pos: (i32, i32), mon_size: (u32, u32), sf: f64, scale: f64, p: &WidgetPos) -> (i32, i32, u32, u32) {
    let w = (p.w * sf * scale).round() as u32;
    let h = (p.h * sf * scale).round() as u32;
    let ax = mon_pos.0 as f64 + p.fx * mon_size.0 as f64;
    let x = match p.anchor {
        Anchor::Tl => ax,
        Anchor::Tc => ax - w as f64 / 2.0,
        Anchor::Tr => ax - w as f64,
    };
    let y = mon_pos.1 as f64 + p.fy * mon_size.1 as f64;
    (x.round() as i32, y.round() as i32, w, h)
}

/// Inverse of `place`: fractions from a window's physical top-left corner.
pub fn unplace(mon_pos: (i32, i32), mon_size: (u32, u32), x: i32, y: i32, w: u32, anchor: Anchor) -> (f64, f64) {
    let ax = x as f64
        + match anchor {
            Anchor::Tl => 0.0,
            Anchor::Tc => w as f64 / 2.0,
            Anchor::Tr => w as f64,
        };
    let fx = (ax - mon_pos.0 as f64) / mon_size.0.max(1) as f64;
    let fy = (y as f64 - mon_pos.1 as f64) / mon_size.1.max(1) as f64;
    (fx.clamp(0.0, 1.0), fy.clamp(0.0, 1.0))
}

/// Creates the widget windows (hidden, click-through).
pub fn create(app: &AppHandle, l: &Layout) -> tauri::Result<()> {
    for (name, p) in &l.widgets {
        if !p.enabled || app.get_webview_window(&label(name)).is_some() {
            continue;
        }
        let w = WebviewWindowBuilder::new(app, label(name), WebviewUrl::App(format!("index.html?widget={name}").into()))
            .title(format!("Deadlock Meta · {name}"))
            .transparent(true)
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .shadow(false)
            .resizable(false)
            .focused(false)
            .visible(false)
            .inner_size(p.w * l.scale, p.h * l.scale)
            .build()?;
        // Position/click-through are set when the widget is first shown: calling window
        // setters on a never-shown window crashes tao's GTK backend (Linux).
        let _ = w;
    }
    Ok(())
}

/// Moves/resizes every widget to its layout position on the game monitor.
pub fn apply(app: &AppHandle, l: &Layout) {
    let Some(m) = monitor(app, l) else { return };
    let (mp, ms, sf) = ((m.position().x, m.position().y), (m.size().width, m.size().height), m.scale_factor());
    for (name, p) in &l.widgets {
        if let Some(win) = app.get_webview_window(&label(name)) {
            if !win.is_visible().unwrap_or(false) {
                continue;
            }
            let (x, y, w, h) = place(mp, ms, sf, l.scale, p);
            let _ = win.set_size(Size::Physical(PhysicalSize::new(w, h)));
            let _ = win.set_position(Position::Physical(PhysicalPosition::new(x, y)));
        }
    }
}

pub fn set_visible(app: &AppHandle, l: &Layout, on: bool) {
    for (name, p) in &l.widgets {
        if let Some(w) = app.get_webview_window(&label(name)) {
            if on && p.enabled {
                let _ = w.show();
                let _ = w.set_ignore_cursor_events(true);
            } else {
                let _ = w.hide();
            }
        }
    }
    if on {
        apply(app, l);
    }
}

/// Edit mode on: widgets become draggable and visible. Off: read positions back and save.
pub fn set_edit(app: &AppHandle, l: &mut Layout, path: Option<&Path>, on: bool) {
    let mon = monitor(app, l);
    for (name, p) in l.widgets.iter_mut() {
        let Some(w) = app.get_webview_window(&label(name)) else { continue };
        if on {
            let _ = w.show();
            let _ = w.set_ignore_cursor_events(false);
        } else {
            if let (Some(m), Ok(pos), Ok(size)) = (mon.as_ref(), w.outer_position(), w.outer_size()) {
                let (fx, fy) = unplace((m.position().x, m.position().y), (m.size().width, m.size().height), pos.x, pos.y, size.width, p.anchor);
                p.fx = fx;
                p.fy = fy;
            }
            let _ = w.set_ignore_cursor_events(true);
        }
    }
    if on {
        apply(app, l);
    } else if let Some(path) = path {
        save(path, l);
    }
    let _ = app.emit("edit-mode", on);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn place_and_unplace_roundtrip_for_all_anchors() {
        let mon = ((1920, 0), (2560u32, 1440u32));
        for anchor in [Anchor::Tl, Anchor::Tc, Anchor::Tr] {
            let p = WidgetPos { fx: 0.3, fy: 0.2, anchor, w: 300.0, h: 200.0, enabled: true };
            let (x, y, w, _) = place(mon.0, mon.1, 1.25, 1.0, &p);
            let (fx, fy) = unplace(mon.0, mon.1, x, y, w, anchor);
            assert!((fx - 0.3).abs() < 1e-3 && (fy - 0.2).abs() < 1e-3, "{anchor:?}: {fx} {fy}");
        }
    }

    #[test]
    fn defaults_do_not_overlap() {
        let l = Layout::default();
        let r: Vec<_> = l.widgets.values().map(|p| place((0, 0), (1920, 1080), 1.0, 1.0, p)).collect();
        for i in 0..r.len() {
            for j in i + 1..r.len() {
                let (a, b) = (r[i], r[j]);
                let overlap = a.0 < b.0 + b.2 as i32 && b.0 < a.0 + a.2 as i32 && a.1 < b.1 + b.3 as i32 && b.1 < a.1 + a.3 as i32;
                assert!(!overlap, "{a:?} overlaps {b:?}");
            }
        }
    }

    #[test]
    fn defaults_fit_on_a_1080p_screen() {
        let l = Layout::default();
        for (name, p) in &l.widgets {
            let (x, y, w, h) = place((0, 0), (1920, 1080), 1.0, l.scale, p);
            assert!(x >= 0 && y >= 0 && x as u32 + w <= 1920 && y as u32 + h <= 1080, "{name} off-screen: {x},{y} {w}x{h}");
        }
    }

    #[test]
    fn missing_widgets_get_defaults_and_bad_scale_resets() {
        let dir = std::env::temp_dir().join(format!("hud-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("hud-layout.json");
        std::fs::write(&p, r#"{"scale": 9, "widgets": {"coach": {"fx":0.4,"fy":0.1,"anchor":"tc","w":500,"h":180,"enabled":true}}}"#).unwrap();
        let l = load(&p);
        assert_eq!(l.scale, 1.0);
        assert_eq!(l.widgets["coach"].fx, 0.4);
        assert!(l.widgets.contains_key("buy") && l.widgets.contains_key("enemies"));
        let _ = std::fs::remove_dir_all(dir);
    }
}
