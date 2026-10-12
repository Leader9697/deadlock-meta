//! Submits your own matches to deadlock-api, the same way the official
//! `deadlock-api-ingest` tool does: when the Deadlock client shows a match (match
//! history, post-game screen) it downloads `replayNNN.valve.net/1422450/<match>_<salt>.meta.bz2`
//! and Steam keeps that URL in `Steam/appcache/httpcache`. We read only the first few
//! hundred bytes of those cache files, pull out match id + salt, and POST them to
//! `/v1/matches/salts`. deadlock-api then fetches the match from Valve.
//!
//! Read-only on Steam's cache; nothing touches the game process.

use std::collections::BTreeSet;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use regex::bytes::Regex;
use serde::Serialize;

const APP_ID: &str = "1422450";
const HEAD_BYTES: usize = 512;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub struct MatchSalt {
    pub match_id: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cluster_id: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata_salt: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replay_salt: Option<u32>,
    pub username: String,
}

/// Extracts a salt from the head of one cache file.
pub fn parse_cache_head(head: &[u8]) -> Option<MatchSalt> {
    static_regex();
    let re_path = RE_PATH.get().unwrap();
    let re_host = RE_HOST.get().unwrap();
    let c = re_path.captures(head)?;
    let txt = |i: usize| std::str::from_utf8(&c[i]).ok().map(str::to_string);
    if txt(1)? != APP_ID {
        return None;
    }
    let match_id: u64 = txt(2)?.parse().ok()?;
    let salt: u32 = txt(3)?.parse().ok()?;
    let cluster_id = re_host
        .captures(head)
        .and_then(|h| std::str::from_utf8(&h[1]).ok()?.parse().ok());
    let meta = &c[4] == b"meta";
    Some(MatchSalt {
        match_id,
        cluster_id,
        metadata_salt: meta.then_some(salt),
        replay_salt: (!meta).then_some(salt),
        username: "deadlock-meta".into(),
    })
}

static RE_PATH: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
static RE_HOST: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
fn static_regex() {
    RE_PATH
        .get_or_init(|| Regex::new(r"/(\d{6,8})/(\d{5,12})_(\d{1,10})\.(meta|dem)\.bz2").unwrap());
    RE_HOST.get_or_init(|| Regex::new(r"replay(\d{1,5})\.valve\.net").unwrap());
}

pub fn httpcache_dir() -> Option<PathBuf> {
    let d = crate::steam::steam_dir()?
        .join("appcache")
        .join("httpcache");
    d.is_dir().then_some(d)
}

/// Walks the cache and returns salts found in files modified after `since`.
pub fn scan(dir: &Path, since: Option<SystemTime>) -> Vec<MatchSalt> {
    let mut out = BTreeSet::new();
    let mut stack = vec![dir.to_path_buf()];
    let mut buf = vec![0u8; HEAD_BYTES];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else {
            continue;
        };
        for e in rd.flatten() {
            let p = e.path();
            let Ok(md) = e.metadata() else { continue };
            if md.is_dir() {
                stack.push(p);
                continue;
            }
            if let (Some(since), Ok(m)) = (since, md.modified()) {
                if m < since {
                    continue;
                }
            }
            let Ok(mut f) = std::fs::File::open(&p) else {
                continue;
            };
            let n = f.read(&mut buf).unwrap_or(0);
            if let Some(s) = parse_cache_head(&buf[..n]) {
                out.insert(s);
            }
        }
    }
    out.into_iter().collect()
}

fn load_seen(path: &Path) -> BTreeSet<String> {
    std::fs::read_to_string(path)
        .map(|s| s.lines().map(str::to_string).collect())
        .unwrap_or_default()
}

fn key(s: &MatchSalt) -> String {
    format!(
        "{}:{}:{}",
        s.match_id,
        s.metadata_salt.unwrap_or(0),
        s.replay_salt.unwrap_or(0)
    )
}

/// Background loop: full scan at start, then every 2 minutes for new cache files.
pub async fn run(api_base: String, seen_path: PathBuf) {
    let Some(dir) = httpcache_dir() else {
        tracing::info!("ingest: Steam httpcache not found");
        return;
    };
    let http = reqwest::Client::builder()
        .user_agent("deadlock-meta-desktop/0.1")
        .build()
        .expect("http client");
    let url = format!("{}/v1/matches/salts", api_base.trim_end_matches('/'));
    let mut seen = load_seen(&seen_path);
    let mut since: Option<SystemTime> = None;
    loop {
        let started = SystemTime::now();
        let dir2 = dir.clone();
        let found = tokio::task::spawn_blocking(move || scan(&dir2, since))
            .await
            .unwrap_or_default();
        let fresh: Vec<MatchSalt> = found
            .into_iter()
            .filter(|s| !seen.contains(&key(s)))
            .collect();
        let mut ok = true;
        for chunk in fresh.chunks(100) {
            match http.post(&url).json(chunk).send().await {
                Ok(r) if r.status().is_success() => {
                    for s in chunk {
                        seen.insert(key(s));
                    }
                }
                Ok(r) => {
                    tracing::warn!("ingest: {} from {}", r.status(), url);
                    ok = false;
                }
                Err(e) => {
                    tracing::warn!("ingest: {e}");
                    ok = false;
                }
            }
        }
        if !fresh.is_empty() {
            let _ = std::fs::write(
                &seen_path,
                seen.iter().cloned().collect::<Vec<_>>().join("\n"),
            );
            tracing::info!("ingest: submitted {} match salt(s)", fresh.len());
        }
        // only move the window forward when everything was submitted
        if ok {
            since = Some(started - Duration::from_secs(5));
        }
        tokio::time::sleep(Duration::from_secs(120)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_meta_and_demo_urls_from_cache_heads() {
        let mut head = b"\x00\x01garbageHTTP/1.1 200 OK\nhttp://replay404.valve.net/1422450/38123456_1234567890.meta.bz2\x00\x00".to_vec();
        head.extend_from_slice(&[0u8; 50]);
        let s = parse_cache_head(&head).unwrap();
        assert_eq!(
            (s.match_id, s.cluster_id, s.metadata_salt, s.replay_salt),
            (38123456, Some(404), Some(1234567890), None)
        );

        let d = parse_cache_head(b"replay183.valve.net\x00/1422450/38000001_77.dem.bz2").unwrap();
        assert_eq!(
            (d.match_id, d.cluster_id, d.replay_salt),
            (38000001, Some(183), Some(77))
        );

        // other games' replays are ignored
        assert!(parse_cache_head(b"http://replay1.valve.net/570/7000000000_1.meta.bz2").is_none());
        assert!(parse_cache_head(b"nothing here").is_none());
    }

    #[test]
    fn scan_finds_new_files_only() {
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("a3");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(
            sub.join("x"),
            b"http://replay9.valve.net/1422450/31000000_5.meta.bz2",
        )
        .unwrap();
        std::fs::write(sub.join("y"), b"unrelated").unwrap();
        let all = scan(dir.path(), None);
        assert_eq!(all.len(), 1);
        let later = SystemTime::now() + Duration::from_secs(3600);
        assert!(scan(dir.path(), Some(later)).is_empty());
    }
}
