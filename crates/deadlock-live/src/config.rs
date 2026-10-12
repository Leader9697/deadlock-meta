//! User-editable settings (deadlock-live.toml next to the app). Anything that depends on
//! data we have not verified yet — console.log line formats and the live SQL — lives
//! here so it can be fixed without recompiling.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    /// Bumped when built-in log patterns / live queries change; older files get those
    /// sections replaced on load.
    #[serde(default)]
    pub version: u32,
    /// deadlock-api base URL.
    pub api_base: String,
    /// Optional deadlock-api key (raises rate limits).
    pub api_key: Option<String>,
    /// Your Deadlock Meta website (serves /api/hero, /api/scout, /api/live).
    pub site_base: String,
    /// Override the detected Steam account (32-bit account id).
    pub account_id: Option<u32>,
    /// Override console.log location.
    pub console_log: Option<PathBuf>,
    pub process_names: Vec<String>,
    pub poll_process_ms: u64,
    pub poll_log_ms: u64,
    pub log: LogPatterns,
    pub live: LiveQuery,
    /// Extra environment for the bundled local website server, e.g.
    /// `HTTPS_PROXY = "http://proxy.kantor:8080"`.
    pub web_env: BTreeMap<String, String>,
    /// Submit your own matches (from Steam's http cache) to deadlock-api so your full
    /// history and post-match reviews are available. Same as the official ingest tool.
    pub ingest_matches: bool,
}

/// Regexes run on every new console.log line. Named group `id` is required.
///
/// Defaults verified against a real console.log (build 6763). The log prints the match
/// id when matchmaking hands out the server ticket, and our own SteamID on login. It
/// does NOT list other players — those come from the live broadcast.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct LogPatterns {
    pub match_id: Vec<String>,
    /// Our own SteamID64 (fallback when loginusers.vdf is unavailable).
    pub self_steam: Vec<String>,
    /// Other players' SteamID64 / `[U:1:n]`, if a future build logs them. Empty by default.
    pub player: Vec<String>,
    /// Lines that mean the match is over / we left. Empty by default: the live stream's
    /// GameOverEvent and stream end are used instead.
    pub match_end: Vec<String>,
    /// Zero-delay hero spawn/loaded lines from local console.log
    pub hero_loaded: Vec<String>,
    /// Zero-delay hero respawn events
    pub hero_respawn: Vec<String>,
    /// Zero-delay game state changes (e.g. HeroSelection, GameInProgress)
    pub game_state: Vec<String>,
}

/// SQL streams for `/v1/matches/demo/live/query`, one SSE connection each. Rows are
/// routed by their aliased columns, so any query just has to alias to these names:
///
/// - player rows: `account_id` (+ `slot, team, hero_id, net_worth, souls, kills, deaths,
///   assists, level`)
/// - clock rows: `game_time_s`
/// - purchase rows: `purchase_slot, item_id, sold`
/// - end rows: `winning_team`
///
/// Table/column names verified against `/v1/matches/demo/schema` (columns use `__`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct LiveQuery {
    pub queries: Vec<NamedQuery>,
    /// Push a LiveState to the UI at most this often.
    pub emit_every_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NamedQuery {
    pub name: String,
    pub sql: String,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            version: CONFIG_VERSION,
            api_base: "https://api.deadlock-api.com".into(),
            api_key: None,
            site_base: "http://localhost:3000".into(),
            account_id: None,
            console_log: None,
            process_names: vec![
                "deadlock.exe".into(),
                "project8.exe".into(),
                "citadel.exe".into(),
            ],
            poll_process_ms: 1500,
            poll_log_ms: 500,
            log: LogPatterns::default(),
            live: LiveQuery::default(),
            web_env: BTreeMap::new(),
            ingest_matches: true,
        }
    }
}

impl Default for LogPatterns {
    fn default() -> Self {
        Self {
            match_id: vec![
                // [SteamNetSockets] Received Steam datagram ticket for server steamid:… vport -1. match_id=112973749
                r"Received Steam datagram ticket for server .*\bmatch_id=(?P<id>\d{6,})".into(),
                // Lobby 174168628286840337 for Match 112973749 created
                r"^(?:\S+ \S+ )?Lobby \d+ for Match (?P<id>\d{6,}) created".into(),
                // General match_id lines (e.g. match_id=12345678, match_id: 12345678, match_id 12345678)
                r"\bmatch_?id\b[^\d\n\r]{1,16}(?P<id>\d{6,12})".into(),
                r#"["']?match_id["']?\s*[:=]\s*["']?(?P<id>\d{6,12})["']?"#.into(),
                // Match 12345678 created / Entering match 12345678 / Match: 12345678
                r"\bMatch(?:[:\s]+|#)(?P<id>\d{6,})".into(),
                // Connecting to [U:1:...] / match_id=12345678
                r"Connecting to .*match_id=(?P<id>\d{6,})".into(),
                r"server_steam_id:.*match_id=(?P<id>\d{6,12})".into(),
            ],
            // [SteamNetSockets] AuthStatus (steamid:76561198802383751):  OK  (OK)
            self_steam: vec![
                r"AuthStatus \(steamid:(?P<id>7656119\d{10})\):\s+OK".into(),
                r#"\[Server\] SV:\s+"[^"]*<\[U:1:(?P<id>\d+)\]><>"\s+STEAM USERID validated"#
                    .into(),
            ],
            player: vec![
                r#"\[Server\] SV:\s+"[^"]*<\[U:1:(?P<id>\d+)\]><>"\s+STEAM USERID validated"#
                    .into(),
            ],
            match_end: vec![
                r"Disconnecting from server: NETWORK_DISCONNECT_".into(),
                r"\bEntering game state:\s*6\b".into(),
                r"\bChangeGameState:\s*(?:POST_GAME|GAME_STATE_POST_GAME)\b".into(),
                r"\bCitadel(?:GameRules)?:\s*Match (?:ended|over)\b".into(),
                r"\bMatch outcome:\s*(?:Team|winner)".into(),
                r"\bHost_Disconnect\b".into(),
            ],
            hero_loaded: vec![
                r#"\[Server\] Loaded hero (?P<entity>\d+)/(?P<hero>hero_\w+)"#.into(),
            ],
            hero_respawn: vec![r"(?P<hero>hero_\w+)\s+respawned".into()],
            game_state: vec![
                r"Entering game state:\s*(?P<state>\d+)\s*\((?P<name>\w+)\)".into(),
                r"ChangeGameState:\s*(?P<name>\w+)\s*\((?P<state>\d+)\)".into(),
            ],
        }
    }
}

impl Default for LiveQuery {
    fn default() -> Self {
        let q = |name: &str, sql: &str| NamedQuery {
            name: name.into(),
            sql: sql.into(),
        };
        Self {
            queries: vec![
                // DataFusion lower-cases unquoted identifiers: every mixed-case column must
                // be double-quoted. Table names resolve case-insensitively.
                q(
                    "players",
                    r#"SELECT tick,
  "m_steamID"                                AS account_id,
  entity_index - 1                           AS slot,
  "m_iTeamNum"                               AS team,
  "m_PlayerDataGlobal__m_nHeroID"            AS hero_id,
  "m_PlayerDataGlobal__m_iGoldNetWorth"      AS net_worth,
  "m_PlayerDataGlobal__m_iGold"              AS souls,
  "m_PlayerDataGlobal__m_iPlayerKills"       AS kills,
  "m_PlayerDataGlobal__m_iDeaths"            AS deaths,
  "m_PlayerDataGlobal__m_iPlayerAssists"     AS assists,
  "m_PlayerDataGlobal__m_iLevel"             AS level,
  "m_PlayerDataGlobal__m_bAlive"             AS alive,
  "m_PlayerDataGlobal__m_flRespawnTime"      AS respawn_at,
  "m_nAssignedLane"                          AS lane,
  "m_PlayerDataGlobal__m_iHeroDamage"        AS hero_damage,
  "m_PlayerDataGlobal__m_iHeroHealing"       AS hero_healing,
  "m_PlayerDataGlobal__m_iSelfHealing"       AS self_healing,
  "m_hHeroPawn" & 32767                      AS pawn
FROM CCitadelPlayerController
WHERE "m_steamID" > 0"#,
                ),
                // MatchClockAtLastUpdate only changes on pause/unpause; the aggregator adds
                // (current tick − update tick) / 60 (server tickrate, from console.log stats).
                q(
                    "clock",
                    r#"SELECT tick,
  "m_pGameRules__m_flMatchClockAtLastUpdate" AS clock_s,
  "m_pGameRules__m_nMatchClockUpdateTick"    AS clock_tick,
  "m_pGameRules__m_flGameStartTime"          AS game_start_s,
  "m_pGameRules__m_nTotalPausedTicks"        AS paused_ticks,
  "m_pGameRules__m_tNextMidBossSpawnTime"    AS mid_boss_at,
  "m_pGameRules__m_eGameMode"                AS game_mode,
  "m_pGameRules__m_eMatchMode"               AS match_mode
FROM CCitadelGameRulesProxy"#,
                ),
                // userid on game events is the player slot (= controller entity_index - 1).
                q(
                    "purchases",
                    "SELECT tick, userid AS purchase_slot, ability_id AS item_id, sell AS sold
FROM ItemPurchaseNotificationEvent",
                ),
                q("game_over", "SELECT tick, winning_team FROM GameOverEvent"),
                // killfeed: entindex_* are hero pawns (mapped through the players' `pawn`)
                q(
                    "kills",
                    "SELECT tick, entindex_victim AS kill_victim, entindex_attacker AS kill_attacker, entindex_assisters AS kill_assisters, killer_ability_id
FROM HeroKilledEvent",
                ),
                // unlocked flex item slots per team (one row per unlock)
                q("flex_slots", "SELECT tick, team_number AS flex_team, flexslot_unlocked FROM FlexSlotUnlockedEvent"),
                // the game's own death recap: who hit you with what, and which debuffs were on you
                q("death_recaps", "SELECT tick, damage_summary AS death_recap FROM DeathReplayDataEvent"),
                q(
                    "objectives",
                    "SELECT tick, objective_mask_team0 AS obj_mask_0, objective_mask_team1 AS obj_mask_1
FROM ObjectiveMaskEvent",
                ),
            ],
            emit_every_ms: 3000,
        }
    }
}

/// v2: quoted mixed-case columns for DataFusion, verified log patterns.
/// v3: match clock from clock tick anchor.
/// v4: clock falls back to game start time (anchor is 0 until the first pause).
/// v5: respawn timers, mid boss timer, objective masks.
/// v6: lane, hero damage and healing per player (adaptive coach).
/// v7: killfeed + death recap, hero pawn index.
/// v8: flex slot unlocks.
/// v9: game_mode and match_mode detection (street brawl vs normal / ranked).
/// v10: zero-delay local console events (loaded heroes, respawns, game states).
/// v11: expanded match_id detection regex patterns for broader game console log variations.
pub const CONFIG_VERSION: u32 = 11;

impl Config {
    /// Older config files keep the user's own settings but get the current built-in
    /// `[log]` and `[live]` sections (those were wrong before v2).
    pub fn migrate(mut self) -> (Self, bool) {
        if self.version >= CONFIG_VERSION {
            return (self, false);
        }
        let d = Self::default();
        self.log = d.log;
        self.live = d.live;
        self.version = CONFIG_VERSION;
        (self, true)
    }

    pub fn load(path: &std::path::Path) -> anyhow::Result<Self> {
        match std::fs::read_to_string(path) {
            Ok(s) => {
                let (c, changed) = toml::from_str::<Self>(&s)?.migrate();
                if changed {
                    let _ = std::fs::write(path, toml::to_string_pretty(&c)?);
                }
                Ok(c)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let c = Self::default();
                // write defaults so the user has something to edit
                let _ = std::fs::write(path, toml::to_string_pretty(&c)?);
                Ok(c)
            }
            Err(e) => Err(e.into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_roundtrip_through_toml() {
        let s = toml::to_string_pretty(&Config::default()).unwrap();
        let c: Config = toml::from_str(&s).unwrap();
        assert_eq!(c.live.queries, Config::default().live.queries);
        assert_eq!(c.log.match_id.len(), 7);
    }

    #[test]
    fn old_file_gets_new_queries_but_keeps_user_settings() {
        let old = r#"site_base = "http://localhost:3001"
account_id = 5
[live]
emit_every_ms = 1000
[[live.queries]]
name = "players"
sql = "SELECT m_steamID AS account_id FROM CCitadelPlayerController"
"#;
        let (c, changed) = toml::from_str::<Config>(old).unwrap().migrate();
        assert!(changed);
        assert_eq!(c.version, CONFIG_VERSION);
        assert_eq!(c.site_base, "http://localhost:3001");
        assert_eq!(c.account_id, Some(5));
        assert!(c.live.queries[0].sql.contains("\"m_steamID\""));
        assert_eq!(c.live.queries.len(), 8);
        let (_, again) = c.migrate();
        assert!(!again);
    }

    #[test]
    fn partial_file_keeps_defaults() {
        let c: Config = toml::from_str(
            "site_base = \"https://meta.example\"\n[log]\nmatch_id = [\"x(?P<id>\\\\d+)\"]",
        )
        .unwrap();
        assert_eq!(c.site_base, "https://meta.example");
        assert_eq!(c.log.match_id, vec!["x(?P<id>\\d+)".to_string()]);
        assert_eq!(c.log.self_steam.len(), 2); // untouched → default (authstatus + server validated)
        assert_eq!(c.poll_log_ms, 500);
    }
}
