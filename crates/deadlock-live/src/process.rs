//! Is Deadlock running? Read-only checks only — no handles are opened on the game.
//!
//! Three independent signals, so one broken source does not leave the overlay stuck:
//!  1. process list (sysinfo): name from config, or any exe inside `…\Deadlock\game\bin\`;
//!  2. Steam's own `HKCU\Software\Valve\Steam\RunningAppID` (= 1422450 while Deadlock runs);
//!  3. `tasklist` (Windows, at most every 15 s) in case sysinfo cannot read the list.

use std::time::{Duration, Instant};

use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, RefreshKind, System, UpdateKind};

pub struct ProcessWatch {
    sys: System,
    names: Vec<String>,
    last_tasklist: Option<Instant>,
    tasklist_hit: bool,
    /// how the game was found last time (for the status line)
    pub found_by: Option<&'static str>,
    /// number of processes sysinfo could see on the last check (0 = it is blind)
    pub seen: usize,
}

impl ProcessWatch {
    pub fn new(names: &[String]) -> Self {
        Self {
            sys: System::new_with_specifics(RefreshKind::nothing()),
            names: names.iter().map(|n| n.to_ascii_lowercase()).collect(),
            last_tasklist: None,
            tasklist_hit: false,
            found_by: None,
            seen: 0,
        }
    }

    pub fn is_running(&mut self) -> bool {
        self.found_by = self.check();
        self.found_by.is_some()
    }

    fn check(&mut self) -> Option<&'static str> {
        self.sys.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing().with_exe(UpdateKind::OnlyIfNotSet),
        );
        self.seen = self.sys.processes().len();
        let by_list = self.sys.processes().values().any(|p| {
            let name = p.name().to_string_lossy().to_ascii_lowercase();
            if name_matches(&name, &self.names) {
                return true;
            }
            p.exe()
                .map(|e| is_deadlock_exe(&e.to_string_lossy()))
                .unwrap_or(false)
        });
        if by_list {
            return Some("proses");
        }
        if steam_running_app() == Some(DEADLOCK_APP_NUM) {
            return Some("Steam");
        }
        // tasklist is a process spawn: rate-limit it, and reuse the last answer in between
        let due = self
            .last_tasklist
            .map(|t| t.elapsed() >= Duration::from_secs(15))
            .unwrap_or(true);
        if due {
            self.last_tasklist = Some(Instant::now());
            self.tasklist_hit = tasklist_has(&self.names);
        }
        if self.tasklist_hit {
            return Some("tasklist");
        }
        None
    }
}

const DEADLOCK_APP_NUM: u32 = 1422450;

/// Steam writes the app id of the running game here (0 when none).
#[cfg(windows)]
pub fn steam_running_app() -> Option<u32> {
    use winreg::enums::HKEY_CURRENT_USER;
    let key = winreg::RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey("Software\\Valve\\Steam")
        .ok()?;
    key.get_value::<u32, _>("RunningAppID").ok()
}
#[cfg(not(windows))]
pub fn steam_running_app() -> Option<u32> {
    None
}

#[cfg(windows)]
fn tasklist_has(names: &[String]) -> bool {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let out = std::process::Command::new("tasklist")
        .args(["/NH", "/FO", "CSV"])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    match out {
        Ok(o) => tasklist_contains(&String::from_utf8_lossy(&o.stdout), names),
        Err(_) => false,
    }
}
#[cfg(not(windows))]
fn tasklist_has(_names: &[String]) -> bool {
    false
}

/// `"deadlock.exe","1234","Console","1","2.000.000 K"` lines → any first column in `names`.
pub fn tasklist_contains(csv: &str, names: &[String]) -> bool {
    csv.lines().any(|l| {
        let first = l
            .trim()
            .trim_start_matches('"')
            .split('"')
            .next()
            .unwrap_or("")
            .to_ascii_lowercase();
        name_matches(&first, names)
    })
}

/// Exact name from config, or any exe that starts like the game's (`deadlock*.exe`,
/// `project8*.exe`, `citadel*.exe`) — but never this app itself (`deadlock-meta…`, `Deadlock Meta.exe`).
pub fn name_matches(name: &str, names: &[String]) -> bool {
    let n = name.to_ascii_lowercase();
    if names.contains(&n) {
        return true;
    }
    if n.contains("meta") || n.contains("live") {
        return false;
    }
    n.ends_with(".exe")
        && ["deadlock", "project8", "citadel"]
            .iter()
            .any(|p| n.starts_with(p))
}

pub fn is_deadlock_exe(path: &str) -> bool {
    let p = path.to_ascii_lowercase().replace('/', "\\");
    p.contains("\\deadlock\\game\\bin\\") && p.ends_with(".exe")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_install_path() {
        assert!(is_deadlock_exe(
            r"C:\Program Files (x86)\Steam\steamapps\common\Deadlock\game\bin\win64\project8.exe"
        ));
        assert!(is_deadlock_exe(
            "D:/SteamLibrary/steamapps/common/Deadlock/game/bin/win64/deadlock.exe"
        ));
        assert!(!is_deadlock_exe(
            r"C:\dev\deadlock-meta\target\debug\deadlock-meta-desktop.exe"
        ));
    }

    #[test]
    fn parses_tasklist() {
        let names = vec!["deadlock.exe".to_string(), "project8.exe".to_string()];
        let csv = "\"System Idle Process\",\"0\",\"Services\",\"0\",\"8 K\"\r\n\"Deadlock.exe\",\"4120\",\"Console\",\"1\",\"3.102.448 K\"\r\n";
        assert!(tasklist_contains(csv, &names));
        assert!(name_matches("Deadlock.exe", &names));
        assert!(name_matches("deadlock_x64.exe", &names));
        assert!(!name_matches("deadlock-meta-desktop.exe", &names));
        assert!(!name_matches("Deadlock Meta.exe", &names));
        assert!(!tasklist_contains(
            "\"steam.exe\",\"1\",\"Console\",\"1\",\"9 K\"",
            &names
        ));
    }
}
