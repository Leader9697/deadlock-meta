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
    TcpStream::connect_timeout(
        &SocketAddr::from(([127, 0, 0, 1], port)),
        Duration::from_millis(300),
    )
    .is_ok()
}

/// Windows hands out `\\?\C:\…` paths; Node and several build tools choke on them, so drop it.
fn plain(p: PathBuf) -> PathBuf {
    match p.to_str().and_then(|s| s.strip_prefix(r"\\?\")) {
        Some(rest) => PathBuf::from(rest),
        None => p,
    }
}

fn node_path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("lokasi app tidak terbaca: {e}"))?;
    let dir = exe
        .parent()
        .ok_or("lokasi app tidak terbaca")?
        .to_path_buf();
    let p = plain(dir.join(if cfg!(windows) { "node.exe" } else { "node" }));
    if p.exists() {
        Ok(p)
    } else {
        Err(format!(
            "node.exe tidak ada di {} (dihapus antivirus? pasang ulang installer)",
            p.display()
        ))
    }
}

/// Last lines of the server log, for the status screen.
pub fn log_tail(app: &AppHandle) -> String {
    let Ok(dir) = app.path().app_log_dir() else {
        return String::new();
    };
    let Ok(text) = std::fs::read_to_string(dir.join("web-server.log")) else {
        return String::new();
    };
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    let tail = lines[lines.len().saturating_sub(4)..].join(" | ");
    tail.chars().take(500).collect()
}

/// Starts the bundled site. The note says what happened (shown in the overlay when the
/// site cannot be reached), so a failure is never silent.
pub fn start(
    app: &AppHandle,
    site_base: &str,
    api_key: Option<&str>,
    token: &str,
    extra_env: &BTreeMap<String, String>,
) -> (Option<Child>, String) {
    let Some(port) = local_port(site_base) else {
        return (
            None,
            format!("site_base ({site_base}) bukan alamat lokal, server bawaan tidak dinyalakan"),
        );
    };
    if listening(port) {
        // dev server or another instance already serves it
        return (None, format!("port {port} sudah dipakai program lain; kalau data tetap gagal, ganti site_base di config ke port lain (mis. http://localhost:3217)"));
    }
    let Some(res) = app.path().resource_dir().ok().map(plain) else {
        return (None, "folder resource app tidak terbaca".into());
    };
    let server = res.join("web").join("apps").join("web").join("server.js");
    if !server.exists() {
        return (
            None,
            format!(
                "server.js tidak ada di {} (mode dev, atau installer tidak lengkap)",
                server.display()
            ),
        );
    }
    let node = match node_path() {
        Ok(n) => n,
        Err(e) => return (None, e),
    };
    let Some(workdir) = server.parent() else {
        return (None, "folder server tidak valid".into());
    };
    let mut cmd = Command::new(node);
    cmd.arg(&server)
        .current_dir(workdir)
        .env("PORT", port.to_string())
        .env("HOSTNAME", "127.0.0.1")
        .env("NODE_ENV", "production")
        .env("NEXT_TELEMETRY_DISABLED", "1")
        .env("DLM_PARENT_PID", std::process::id().to_string())
        // private routes (/api/me/log) only answer requests that carry this token
        .env("DLM_INTERNAL_TOKEN", token)
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
    match cmd.spawn() {
        Ok(child) => {
            let note = format!("server lokal dinyalakan (pid {}), port {port}", child.id());
            (Some(child), note)
        }
        Err(e) => (
            None,
            format!("node tidak bisa dijalankan: {e} (diblokir antivirus/AppLocker?)"),
        ),
    }
}

/// Token shared by the overlay and the bundled site, kept in a file so a site that is
/// still running from the previous start accepts it too.
pub fn load_or_create_token(path: &std::path::Path) -> String {
    if let Ok(t) = std::fs::read_to_string(path) {
        let t = t.trim();
        if t.len() >= 32 && t.chars().all(|c| c.is_ascii_hexdigit()) {
            return t.to_string();
        }
    }
    let t = new_token();
    let _ = std::fs::write(path, &t);
    t
}

/// 128 random bits as hex, from the OS-seeded hasher keys (no extra crate needed).
fn new_token() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let part = |salt: u64| {
        let mut h = RandomState::new().build_hasher();
        h.write_u64(salt);
        h.write_u128(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default(),
        );
        h.write_u32(std::process::id());
        h.finish()
    };
    format!("{:016x}{:016x}", part(1), part(2))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extended_length_prefix_is_dropped() {
        assert_eq!(
            plain(PathBuf::from(r"\\?\C:\Apps\web")),
            PathBuf::from(r"C:\Apps\web")
        );
        assert_eq!(plain(PathBuf::from("/opt/app")), PathBuf::from("/opt/app"));
    }

    #[test]
    fn token_is_created_once_and_reused() {
        let dir = std::env::temp_dir().join(format!("dlm-token-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("web-token.txt");
        let _ = std::fs::remove_file(&path);
        let a = load_or_create_token(&path);
        assert_eq!(a.len(), 32);
        assert_eq!(load_or_create_token(&path), a);
        assert_ne!(new_token(), new_token());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_local_site_bases_get_a_port() {
        assert_eq!(local_port("http://localhost:3000"), Some(3000));
        assert_eq!(local_port("http://127.0.0.1:3005/"), Some(3005));
        assert_eq!(local_port("http://localhost"), Some(80));
        assert_eq!(local_port("https://meta.example.com"), None);
        assert_eq!(local_port("http://192.168.1.5:3000"), None);
    }
}
