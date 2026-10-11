//! Local Steam discovery: install path, logged-in account, Deadlock install folder.
//! Reads plain config files only — nothing touches the game process.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::state::steam64_to_account;

pub const DEADLOCK_APP_ID: &str = "1422450";

/// Minimal Valve KeyValues (VDF) tree.
#[derive(Debug, Clone, PartialEq)]
pub enum Vdf {
    Str(String),
    Obj(BTreeMap<String, Vdf>),
}

impl Vdf {
    pub fn get(&self, key: &str) -> Option<&Vdf> {
        match self {
            Vdf::Obj(m) => m.iter().find(|(k, _)| k.eq_ignore_ascii_case(key)).map(|(_, v)| v),
            Vdf::Str(_) => None,
        }
    }
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Vdf::Str(s) => Some(s),
            Vdf::Obj(_) => None,
        }
    }
    pub fn entries(&self) -> impl Iterator<Item = (&String, &Vdf)> {
        let m = match self {
            Vdf::Obj(m) => Some(m),
            Vdf::Str(_) => None,
        };
        m.into_iter().flat_map(|m| m.iter())
    }
}

/// Parses text VDF (quoted keys/values, braces, `//` comments).
pub fn parse_vdf(src: &str) -> Vdf {
    let tokens = tokenize(src);
    let mut pos = 0;
    Vdf::Obj(parse_obj(&tokens, &mut pos))
}

#[derive(Debug, PartialEq)]
enum Tok {
    S(String),
    Open,
    Close,
}

fn tokenize(src: &str) -> Vec<Tok> {
    let mut out = Vec::new();
    let mut it = src.chars().peekable();
    while let Some(c) = it.next() {
        match c {
            '{' => out.push(Tok::Open),
            '}' => out.push(Tok::Close),
            '"' => {
                let mut s = String::new();
                while let Some(c) = it.next() {
                    match c {
                        '\\' => {
                            if let Some(n) = it.next() {
                                s.push(match n {
                                    'n' => '\n',
                                    't' => '\t',
                                    other => other,
                                });
                            }
                        }
                        '"' => break,
                        other => s.push(other),
                    }
                }
                out.push(Tok::S(s));
            }
            '/' if it.peek() == Some(&'/') => {
                for c in it.by_ref() {
                    if c == '\n' {
                        break;
                    }
                }
            }
            c if c.is_whitespace() => {}
            c => {
                // unquoted token
                let mut s = String::from(c);
                while let Some(&n) = it.peek() {
                    if n.is_whitespace() || n == '{' || n == '}' || n == '"' {
                        break;
                    }
                    s.push(n);
                    it.next();
                }
                out.push(Tok::S(s));
            }
        }
    }
    out
}

fn parse_obj(t: &[Tok], pos: &mut usize) -> BTreeMap<String, Vdf> {
    let mut m = BTreeMap::new();
    while *pos < t.len() {
        match &t[*pos] {
            Tok::Close => {
                *pos += 1;
                break;
            }
            Tok::S(k) => {
                let key = k.clone();
                *pos += 1;
                match t.get(*pos) {
                    Some(Tok::Open) => {
                        *pos += 1;
                        m.insert(key, Vdf::Obj(parse_obj(t, pos)));
                    }
                    Some(Tok::S(v)) => {
                        m.insert(key, Vdf::Str(v.clone()));
                        *pos += 1;
                    }
                    _ => break,
                }
            }
            Tok::Open => *pos += 1,
        }
    }
    m
}

/// Steam install directory (registry on Windows, common defaults elsewhere).
pub fn steam_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        use winreg::enums::HKEY_CURRENT_USER;
        if let Ok(key) = winreg::RegKey::predef(HKEY_CURRENT_USER).open_subkey("Software\\Valve\\Steam") {
            if let Ok(p) = key.get_value::<String, _>("SteamPath") {
                let p = PathBuf::from(p.replace('/', "\\"));
                if p.exists() {
                    return Some(p);
                }
            }
        }
        let def = PathBuf::from(r"C:\Program Files (x86)\Steam");
        if def.exists() {
            return Some(def);
        }
        None
    }
    #[cfg(not(windows))]
    {
        let home = std::env::var_os("HOME").map(PathBuf::from)?;
        [".steam/steam", ".local/share/Steam"].iter().map(|p| home.join(p)).find(|p| p.exists())
    }
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SteamProfile {
    pub account_id: u32,
    pub steam64: String,
    pub persona_name: String,
    pub account_name: String,
    pub avatar_url: Option<String>,
}

/// The account flagged `MostRecent` in config/loginusers.vdf, as a 32-bit account id.
pub fn most_recent_account(loginusers: &str) -> Option<u32> {
    most_recent_profile(loginusers).map(|(id, ..)| id)
}

/// Returns (account_id, steam64, persona_name, account_name) from loginusers.vdf
pub fn most_recent_profile(loginusers: &str) -> Option<(u32, String, String, String)> {
    let root = parse_vdf(loginusers);
    let users = root.get("users")?;
    let mut fallback = None;
    for (steam64, info) in users.entries() {
        let id = steam64.parse::<u64>().ok().and_then(steam64_to_account)?;
        let persona = info.get("PersonaName").and_then(Vdf::as_str).unwrap_or("Pemain Deadlock").to_string();
        let account = info.get("AccountName").and_then(Vdf::as_str).unwrap_or("").to_string();
        let recent = info.get("MostRecent").and_then(Vdf::as_str) == Some("1");
        let auto = info.get("AutoLogin").and_then(Vdf::as_str) == Some("1");
        let item = (id, steam64.clone(), persona, account);
        if recent || auto {
            return Some(item);
        }
        if fallback.is_none() {
            fallback = Some(item);
        }
    }
    fallback
}

pub fn find_steam_avatar_hash(steam_dir: &Path, account_id: u32, steam64: &str) -> Option<String> {
    let localconfig = steam_dir
        .join("userdata")
        .join(account_id.to_string())
        .join("config")
        .join("localconfig.vdf");
    let content = std::fs::read_to_string(localconfig).ok()?;

    if let Some(pos) = content.find(steam64) {
        let window = &content[pos..content.len().min(pos + 400)];
        if let Some(h_idx) = window.find("avatar_hash") {
            let rest = &window[h_idx..];
            for p in rest.split('"') {
                let trimmed = p.trim();
                if trimmed.len() == 40 && trimmed.chars().all(|c| c.is_ascii_hexdigit()) {
                    return Some(trimmed.to_string());
                }
            }
        }
    }

    for line in content.lines() {
        if line.contains("\"avatar\"") {
            for p in line.split('"') {
                let trimmed = p.trim();
                if trimmed.len() == 40 && trimmed != "0000000000000000000000000000000000000000" && trimmed.chars().all(|c| c.is_ascii_hexdigit()) {
                    return Some(trimmed.to_string());
                }
            }
        }
    }

    None
}

pub fn local_steam_profile() -> Option<SteamProfile> {
    let dir = steam_dir()?;
    let path = dir.join("config").join("loginusers.vdf");
    let content = std::fs::read_to_string(path).ok()?;
    let (account_id, steam64, persona_name, account_name) = most_recent_profile(&content)?;
    let avatar_url = find_steam_avatar_hash(&dir, account_id, &steam64)
        .map(|hash| format!("https://avatars.steamstatic.com/{}_full.jpg", hash));
    Some(SteamProfile {
        account_id,
        steam64,
        persona_name,
        account_name,
        avatar_url,
    })
}

pub fn local_account_id() -> Option<u32> {
    let path = steam_dir()?.join("config").join("loginusers.vdf");
    most_recent_account(&std::fs::read_to_string(path).ok()?)
}

/// Finds the Steam library that contains Deadlock, from steamapps/libraryfolders.vdf.
pub fn deadlock_dir_from_libraryfolders(libraryfolders: &str) -> Option<PathBuf> {
    let root = parse_vdf(libraryfolders);
    let folders = root.get("libraryfolders")?;
    for (_, lib) in folders.entries() {
        let has = lib.get("apps").map(|a| a.get(DEADLOCK_APP_ID).is_some()).unwrap_or(false);
        if has {
            let base = lib.get("path")?.as_str()?;
            return Some(Path::new(base).join("steamapps").join("common").join("Deadlock"));
        }
    }
    None
}

pub fn deadlock_dir() -> Option<PathBuf> {
    let steam = steam_dir()?;
    let lf = std::fs::read_to_string(steam.join("steamapps").join("libraryfolders.vdf")).ok();
    lf.as_deref()
        .and_then(deadlock_dir_from_libraryfolders)
        .or_else(|| Some(steam.join("steamapps").join("common").join("Deadlock")))
}

/// `-condebug` writes here.
pub fn console_log_path() -> Option<PathBuf> {
    Some(deadlock_dir()?.join("game").join("citadel").join("console.log"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const LOGINUSERS: &str = r#"
"users"
{
	"76561198000000001"
	{
		"AccountName"		"alt"
		"MostRecent"		"0"
	}
	"76561198012345678"
	{
		"AccountName"		"faris"
		"PersonaName"		"Faris \"F\""
		"MostRecent"		"1"
	}
}"#;

    const LIBRARYFOLDERS: &str = r#"
"libraryfolders"
{
	"0"
	{
		"path"		"C:\\Program Files (x86)\\Steam"
		"apps" { "228980" "0" }
	}
	"1"
	{
		"path"		"D:\\SteamLibrary"
		// comment
		"apps"
		{
			"1422450"		"30000000000"
		}
	}
}"#;

    #[test]
    fn finds_most_recent_account() {
        assert_eq!(most_recent_account(LOGINUSERS), Some(52_079_950));
    }

    #[test]
    fn finds_deadlock_library() {
        let p = deadlock_dir_from_libraryfolders(LIBRARYFOLDERS).unwrap();
        assert_eq!(p, Path::new(r"D:\SteamLibrary").join("steamapps").join("common").join("Deadlock"));
    }

    #[test]
    fn handles_escaped_quotes() {
        let v = parse_vdf(LOGINUSERS);
        let name = v.get("users").unwrap().get("76561198012345678").unwrap().get("PersonaName").unwrap();
        assert_eq!(name.as_str(), Some("Faris \"F\""));
    }
}
