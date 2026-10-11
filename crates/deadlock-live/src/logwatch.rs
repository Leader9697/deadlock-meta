//! Tails Deadlock's console.log (written by the `-condebug` launch option).
//! Read-only file access, so it is invisible to the game and anti-cheat.

use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;

use regex::Regex;

use crate::config::LogPatterns;
use crate::state::steam64_to_account;

#[derive(Debug, Clone, PartialEq)]
pub enum LogEvent {
    MatchId(u64),
    /// Our own account (from the Steam auth line).
    SelfAccount(u32),
    Player(u32),
    MatchEnd,
    HeroLoaded { entity: u32, hero: String },
    HeroRespawn(String),
    GameState { state: u32, name: String },
}

pub struct Matchers {
    match_id: Vec<Regex>,
    self_steam: Vec<Regex>,
    player: Vec<Regex>,
    match_end: Vec<Regex>,
    hero_loaded: Vec<Regex>,
    hero_respawn: Vec<Regex>,
    game_state: Vec<Regex>,
}

impl Matchers {
    pub fn new(p: &LogPatterns) -> anyhow::Result<Self> {
        let compile = |xs: &[String]| xs.iter().map(|x| Regex::new(x)).collect::<Result<Vec<_>, _>>();
        Ok(Self {
            match_id: compile(&p.match_id)?,
            self_steam: compile(&p.self_steam)?,
            player: compile(&p.player)?,
            match_end: compile(&p.match_end)?,
            hero_loaded: compile(&p.hero_loaded)?,
            hero_respawn: compile(&p.hero_respawn)?,
            game_state: compile(&p.game_state)?,
        })
    }

    pub fn scan_line(&self, line: &str, out: &mut Vec<LogEvent>) {
        let mut matched_match_id = false;
        for re in &self.match_id {
            for c in re.captures_iter(line) {
                if let Some(id) = c.name("id").and_then(|m| m.as_str().parse().ok()) {
                    out.push(LogEvent::MatchId(id));
                    matched_match_id = true;
                    break;
                }
            }
            if matched_match_id {
                break;
            }
        }
        for re in &self.self_steam {
            if let Some(c) = re.captures(line) {
                if let Some(id_str) = c.name("id").map(|m| m.as_str()) {
                    if let Ok(raw) = id_str.parse::<u64>() {
                        let acc = if raw > u32::MAX as u64 { steam64_to_account(raw) } else { Some(raw as u32) };
                        if let Some(a) = acc.filter(|a| *a > 0) {
                            out.push(LogEvent::SelfAccount(a));
                        }
                    }
                }
            }
        }
        for re in &self.player {
            for c in re.captures_iter(line) {
                if let Some(raw) = c.name("id").and_then(|m| m.as_str().parse::<u64>().ok()) {
                    let acc = if raw > u32::MAX as u64 { steam64_to_account(raw) } else { Some(raw as u32) };
                    if let Some(a) = acc.filter(|a| *a > 0) {
                        out.push(LogEvent::Player(a));
                    }
                }
            }
        }
        if self.match_end.iter().any(|re| re.is_match(line)) {
            out.push(LogEvent::MatchEnd);
        }
        for re in &self.hero_loaded {
            if let Some(c) = re.captures(line) {
                let entity = c.name("entity").and_then(|m| m.as_str().parse().ok()).unwrap_or(0);
                if let Some(hero) = c.name("hero").map(|m| m.as_str().to_string()) {
                    out.push(LogEvent::HeroLoaded { entity, hero });
                }
            }
        }
        for re in &self.hero_respawn {
            if let Some(c) = re.captures(line) {
                if let Some(hero) = c.name("hero").map(|m| m.as_str().to_string()) {
                    out.push(LogEvent::HeroRespawn(hero));
                }
            }
        }
        for re in &self.game_state {
            if let Some(c) = re.captures(line) {
                let state = c.name("state").and_then(|m| m.as_str().parse().ok()).unwrap_or(0);
                let name = c.name("name").map(|m| m.as_str().to_string()).unwrap_or_default();
                out.push(LogEvent::GameState { state, name });
            }
        }
    }
}

/// `MM/DD HH:MM:SS` prefix → minutes since Jan 1 (approximate, good for comparing
/// lines within one log).
fn line_minutes(line: &str) -> Option<i64> {
    let b = line.as_bytes();
    if b.len() < 14 || b[2] != b'/' || b[5] != b' ' || b[8] != b':' || b[11] != b':' {
        return None;
    }
    let n = |r: std::ops::Range<usize>| line.get(r)?.parse::<i64>().ok();
    let (mo, d, h, mi) = (n(0..2)?, n(3..5)?, n(6..8)?, n(9..11)?);
    Some(((mo - 1) * 31 + (d - 1)) * 1440 + h * 60 + mi)
}

/// For when the app starts mid-match: the latest match id in the existing log, if it
/// was printed within `max_age_min` of the log's last line. Also returns our account.
pub fn backscan(content: &str, m: &Matchers, max_age_min: i64) -> (Option<u64>, Option<u32>) {
    let mut last_match: Option<(u64, Option<i64>)> = None;
    let mut me = None;
    let mut last_ts = None;
    let mut ev = Vec::new();
    for line in content.lines() {
        let ts = line_minutes(line);
        if ts.is_some() {
            last_ts = ts;
        }
        ev.clear();
        m.scan_line(line, &mut ev);
        for e in &ev {
            match e {
                LogEvent::MatchId(id) => last_match = Some((*id, ts)),
                LogEvent::SelfAccount(a) => me = Some(*a),
                LogEvent::MatchEnd => last_match = None,
                _ => {}
            }
        }
    }
    let recent = last_match.and_then(|(id, ts)| match (ts, last_ts) {
        (Some(a), Some(b)) if b - a <= max_age_min && b >= a => Some(id),
        (None, _) | (_, None) => Some(id),
        _ => None,
    });
    (recent, me)
}

/// Incremental reader. Starts at the end of the file so old matches are ignored, and
/// restarts from 0 if the game truncated the log (new session).
pub struct LogTail {
    path: PathBuf,
    offset: u64,
    partial: String,
}

impl LogTail {
    pub fn new(path: PathBuf, from_end: bool) -> Self {
        let offset = if from_end { std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0) } else { 0 };
        Self { path, offset, partial: String::new() }
    }

    pub fn path(&self) -> &PathBuf {
        &self.path
    }

    /// Returns complete new lines since the last call.
    pub fn read_new_lines(&mut self) -> std::io::Result<Vec<String>> {
        let mut f = match std::fs::File::open(&self.path) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
            Err(e) => return Err(e),
        };
        let len = f.metadata()?.len();
        if len < self.offset {
            self.offset = 0;
            self.partial.clear();
        }
        if len == self.offset {
            return Ok(vec![]);
        }
        f.seek(SeekFrom::Start(self.offset))?;
        let mut buf = Vec::with_capacity((len - self.offset) as usize);
        f.take(len - self.offset).read_to_end(&mut buf)?;
        self.offset += buf.len() as u64;

        self.partial.push_str(&String::from_utf8_lossy(&buf));
        let mut lines: Vec<String> = self.partial.split('\n').map(|l| l.trim_end_matches('\r').to_string()).collect();
        self.partial = lines.pop().unwrap_or_default(); // last piece may be incomplete
        Ok(lines.into_iter().filter(|l| !l.is_empty()).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// Lines copied verbatim from a real console.log (build 6763, Street Brawl).
    const REAL: &str = "10/09 00:15:26 [SteamNetSockets] AuthStatus (steamid:76561198802383751):  Attempting  (Requesting cert)
10/09 00:15:31 [SteamNetSockets] AuthStatus (steamid:76561198802383751):  OK  (OK)
10/09 00:15:34 [SteamNetSockets] AuthStatus (steamid:90294378156787722):  OK  (OK)
10/09 00:15:28 Local bot match: Init. -citadel_local_lobby='', -citadel_local_report_port=0
10/09 00:16:52 [SteamNetSockets] Received Steam datagram ticket for server steamid:90294376860387333 vport -1. match_id=112973749
10/09 00:16:52 Lobby 174168628286840337 for Match 112973749 created
10/09 00:16:52 Persisting reconnect info to disk: server_steam_id: 90294376860387333 lobby_id: 174168628286840337 time_updated: 1791479812
10/09 00:16:54 [Client] Players: 7 (0 bots) / 31 humans";

    #[test]
    fn real_log_lines() {
        let m = Matchers::new(&LogPatterns::default()).unwrap();
        let mut ev = vec![];
        for l in REAL.lines() {
            m.scan_line(l, &mut ev);
        }
        // 76561198802383751 - 76561197960265728 = 842118023
        assert_eq!(ev, vec![LogEvent::SelfAccount(842_118_023), LogEvent::MatchId(112_973_749), LogEvent::MatchId(112_973_749)]);
    }

    #[test]
    fn backscan_finds_recent_match_only() {
        let m = Matchers::new(&LogPatterns::default()).unwrap();
        let fresh = format!("{REAL}\n10/09 00:40:00 [Client] something later");
        assert_eq!(backscan(&fresh, &m, 90), (Some(112_973_749), Some(842_118_023)));
        let stale = format!("{REAL}\n10/09 03:00:00 [Client] hours later");
        assert_eq!(backscan(&stale, &m, 90).0, None);
    }

    #[test]
    fn tails_incrementally_and_handles_truncation() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("console.log");
        std::fs::write(&p, "old line\n").unwrap();
        let mut t = LogTail::new(p.clone(), true);
        assert!(t.read_new_lines().unwrap().is_empty());

        let mut f = std::fs::OpenOptions::new().append(true).open(&p).unwrap();
        write!(f, "a\r\nb\npart").unwrap();
        assert_eq!(t.read_new_lines().unwrap(), vec!["a", "b"]);
        write!(f, "ial\n").unwrap();
        assert_eq!(t.read_new_lines().unwrap(), vec!["partial"]);

        std::fs::write(&p, "new session\n").unwrap(); // truncated
        assert_eq!(t.read_new_lines().unwrap(), vec!["new session"]);
    }
}
