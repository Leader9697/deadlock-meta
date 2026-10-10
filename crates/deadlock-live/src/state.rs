use serde::{Deserialize, Serialize};

/// Mirrors `LivePlayer` in packages/core/src/live.ts (camelCase JSON).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LivePlayer {
    pub account_id: u32,
    pub hero_id: u32,
    pub team: u8,
    pub net_worth: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub souls: Option<i64>,
    pub kills: i64,
    pub deaths: i64,
    pub assists: i64,
    pub level: i64,
    pub item_ids: Vec<u32>,
    /// game time each item in `item_ids` was bought (−1 = unknown)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub item_times: Vec<f64>,
    /// Dead right now (as of the broadcast tick).
    #[serde(default)]
    pub dead: bool,
    /// Seconds until respawn, in broadcast time (subtract the broadcast delay for real time).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub respawn_in_s: Option<f64>,
    /// m_nAssignedLane; lane opponents share the same value.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lane: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hero_damage: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hero_healing: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub self_healing: Option<i64>,
}

/// Mirrors `LiveState` in packages/core/src/live.ts.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LiveState {
    pub match_id: Option<u64>,
    pub game_time_s: f64,
    pub my_account_id: u32,
    pub players: Vec<LivePlayer>,
    /// Set when GameOverEvent arrives (0 = Amber, 1 = Sapphire).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub winning_team: Option<u8>,
    /// Seconds until the next mid boss spawn (broadcast time).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mid_boss_in_s: Option<f64>,
    /// Objective bitmasks per team [Amber, Sapphire]; bit i = ECitadelTeamObjective i.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub objective_masks: Option<[u64; 2]>,
    /// My deaths this match (newest last, max 12), from the killfeed and the game's
    /// death recap (DeathReplayDataEvent).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub my_deaths: Vec<DeathRecord>,
    /// Unlocked flex item slots per team [Amber, Sapphire].
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flex_slots: Option<[u8; 2]>,
}

/// One damage source in a death recap.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeathDamage {
    pub attacker_hero_id: u32,
    pub ability_id: u32,
    pub damage: i64,
    pub hits: i64,
    pub damage_type: u32,
    pub crit_damage: f64,
    pub absorbed: f64,
    pub killing_blow: bool,
}

/// A buff/debuff that was on you during the recap window.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeathModifier {
    pub ability_id: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub caster_account: Option<u32>,
    pub start_s: f64,
    pub end_s: f64,
    pub debuff: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeathRecord {
    pub tick: i64,
    pub game_time_s: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub killer_account: Option<u32>,
    #[serde(default)]
    pub assister_accounts: Vec<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub killer_ability_id: Option<u32>,
    /// recap window length (end − start), seconds
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_s: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_damage: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lost_gold: Option<i64>,
    #[serde(default)]
    pub damage: Vec<DeathDamage>,
    #[serde(default)]
    pub modifiers: Vec<DeathModifier>,
    /// situation when it happened
    pub allies_alive: u32,
    pub enemies_alive: u32,
    pub net_worth: i64,
    #[serde(default)]
    pub item_ids: Vec<u32>,
}

impl LiveState {
    pub fn player_mut(&mut self, account_id: u32) -> &mut LivePlayer {
        if let Some(i) = self.players.iter().position(|p| p.account_id == account_id) {
            &mut self.players[i]
        } else {
            self.players.push(LivePlayer { account_id, ..Default::default() });
            self.players.last_mut().unwrap()
        }
    }
}

/// Everything the engine reports to the UI.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum EngineEvent {
    GameStarted,
    GameStopped,
    /// From console.log: a match id was seen.
    MatchDetected { match_id: u64, source: String },
    /// From console.log: lobby players seen (account ids), before the live stream is up.
    LobbyPlayers { account_ids: Vec<u32> },
    LiveConnected { match_id: u64 },
    /// Progress note for the status line (not an error).
    Status { message: String },
    LiveState(LiveState),
    LiveEnded { match_id: u64 },
    Error { message: String },
    /// Connection checklist for the overlay (sent every process check, ~3 s).
    Diag(Diag),
}

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
pub struct Diag {
    /// game considered running (detected, manual mode, or within the grace period)
    pub game: bool,
    /// "proses" | "Steam" | "tasklist" | "console.log" | "manual" | null
    pub found_by: Option<String>,
    pub force: bool,
    /// processes visible to the app (0 = it cannot read the process list)
    pub procs_seen: usize,
    /// Steam's RunningAppID (Deadlock = 1422450), Windows only
    pub steam_app: Option<u32>,
    pub log_path: Option<String>,
    pub log_exists: bool,
    /// seconds since console.log was last written
    pub log_age_s: Option<u64>,
    pub account_id: u32,
    pub match_id: Option<u64>,
    pub live_connected: bool,
}

pub const STEAM64_BASE: u64 = 76_561_197_960_265_728;

pub fn steam64_to_account(id: u64) -> Option<u32> {
    id.checked_sub(STEAM64_BASE).and_then(|v| u32::try_from(v).ok())
}
