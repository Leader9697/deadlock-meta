//! Bundled website server. The installer ships the Next.js site (standalone build) and
//! a Node runtime as a sidecar; when `site_base` points at this PC and nothing is
//! listening there yet, the app starts it in the background and stops it on exit.
//! In `tauri dev` (no bundled files) or when the site already runs, nothing happens.

use std::collections::BTreeMap;
use std::fs::File;
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use tauri::{AppHandle, Manager};

/// `http://localhost:3000` → 3000. Only local addresses qualify.
pub fn local_port(site_base: &str) -> Option<u16> {
    let rest = site_base.strip_prefix("http://")?;
    let host_port = rest.split('/').next()?;
    let (host, port) = match host_port.rsplit_once(':') {
        Some((h, p)) => (h, p.parse().ok()?),
        None => (host_port, 80),
    };
    matches!(host, "localhost" | "127.0.0.1").then_some(port)
}

fn listening(port: u16) -> bool {
    TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], port)), Duration::from_millis(300)).is_ok()
}

fn node_path() -> Option<PathBuf> {
    let dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let p = dir.join(if cfg!(windows) { "node.exe" } else { "node" });
    p.exists().then_some(p)
}

pub fn start(app: &AppHandle, site_base: &str, api_key: Option<&str>, extra_env: &BTreeMap<String, String>) -> Option<Child> {
    let port = local_port(site_base)?;
    if listening(port) {
        return None; // dev server or another instance already serves it
    }
    let server = app.path().resource_dir().ok()?.join("web").join("apps").join("web").join("server.js");
    if !server.exists() {
        return None;
    }
    let node = node_path()?;
    let mut cmd = Command::new(node);
    cmd.arg(&server)
        .current_dir(server.parent()?)
        .env("PORT", port.to_string())
        .env("HOSTNAME", "127.0.0.1")
        .env("NODE_ENV", "production")
        .env("NEXT_TELEMETRY_DISABLED", "1")
        .env("DLM_PARENT_PID", std::process::id().to_string())
        .stdin(Stdio::null());
    if let Some(k) = api_key.filter(|k| !k.is_empty()) {
        cmd.env("DEADLOCK_API_KEY", k);
    }
    for (k, v) in extra_env {
        cmd.env(k, v);
    }
    // match logs written by the overlay live next to the app's other data
    if let Ok(data) = app.path().app_data_dir() {
        cmd.env("DLM_DATA_DIR", data.join("web-data"));
    }
    if let Ok(dir) = app.path().app_log_dir() {
        let _ = std::fs::create_dir_all(&dir);
        if let Ok(f) = File::create(dir.join("web-server.log")) {
            if let Ok(f2) = f.try_clone() {
                cmd.stdout(f).stderr(f2);
            }
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.spawn().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_local_site_bases_get_a_port() {
        assert_eq!(local_port("http://localhost:3000"), Some(3000));
        assert_eq!(local_port("http://127.0.0.1:3005/"), Some(3005));
        assert_eq!(local_port("http://localhost"), Some(80));
        assert_eq!(local_port("https://meta.example.com"), None);
        assert_eq!(local_port("http://192.168.1.5:3000"), None);
    }
}
