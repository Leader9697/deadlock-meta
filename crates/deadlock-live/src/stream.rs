//! Live broadcast stream via deadlock-api's `/v1/matches/demo/live/query` (SSE).
//!
//! Notes from the API docs:
//! - The broadcast lags real game time (Valve's spectate delay, roughly 60–90 s).
//! - Resolving by `match_id` is limited to 6 req/hour per IP, so we resolve the
//!   broadcast URL once and then query with `broadcast_url` (20 req/min).

use std::collections::HashMap;

use futures_util::StreamExt;
use serde_json::Value;
use tokio::sync::mpsc;

use crate::state::{steam64_to_account, DeathDamage, DeathModifier, DeathRecord, LiveState};

#[derive(Clone)]
pub struct Api {
    pub http: reqwest::Client,
    pub base: String,
    pub key: Option<String>,
}

impl Api {
    pub fn new(base: &str, key: Option<String>) -> Self {
        let http = reqwest::Client::builder()
            .user_agent("deadlock-meta-desktop/0.1")
            .build()
            .expect("http client");
        Self { http, base: base.trim_end_matches('/').to_string(), key }
    }

    fn req(&self, path: &str) -> reqwest::RequestBuilder {
        let r = self.http.get(format!("{}{}", self.base, path));
        match &self.key {
            Some(k) => r.header("X-API-KEY", k),
            None => r,
        }
    }

    pub async fn resolve_broadcast_url(&self, match_id: u64) -> anyhow::Result<String> {
        let res = self.req(&format!("/v1/matches/{match_id}/live/url")).send().await?;
        let status = res.status();
        let body = res.text().await?;
        if !status.is_success() {
            return Err(SpectateError { status: status.as_u16(), body: body.chars().take(200).collect() }.into());
        }
        extract_url(&body).ok_or_else(|| anyhow::anyhow!("no broadcast url in response: {body}"))
    }

    /// Looks the match up in the public list of live broadcasts (cheap: 100 req/s).
    pub async fn listed_broadcast_url(&self, match_id: u64) -> anyhow::Result<Option<String>> {
        let v: Value = self.req("/v1/matches/live/urls").send().await?.error_for_status()?.json().await?;
        Ok(v.as_array().and_then(|a| {
            a.iter()
                .find(|x| x.get("match_id").and_then(Value::as_u64) == Some(match_id))
                .and_then(|x| x.get("broadcast_url").and_then(Value::as_str).map(str::to_string))
        }))
    }

    /// Account's match in the Watch tab (top ~200 live matches only). Fallback detector.
    pub async fn active_match_for(&self, account_id: u32) -> anyhow::Result<Option<u64>> {
        let v: Value = self
            .req(&format!("/v1/matches/active?account_id={account_id}"))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        Ok(v.as_array().and_then(|a| a.first()).and_then(|m| m.get("match_id")).and_then(Value::as_u64))
    }

    /// Streams rows until the broadcast ends or `stop` fires. Each parsed row is sent on `rows`.
    pub async fn stream_rows(&self, broadcast_url: &str, sql: &str, rows: mpsc::Sender<Value>) -> anyhow::Result<()> {
        let res = self
            .http
            .get(format!("{}/v1/matches/demo/live/query", self.base))
            .query(&[("query", sql), ("broadcast_url", broadcast_url)])
            .header("accept", "text/event-stream")
            .send()
            .await?;
        let status = res.status();
        if !status.is_success() {
            let body = res.text().await.unwrap_or_default();
            anyhow::bail!("live query {status}: {}", body.chars().take(300).collect::<String>());
        }

        let mut sse = SseParser::default();
        let mut body = res.bytes_stream();
        while let Some(chunk) = body.next().await {
            for ev in sse.push(&chunk?) {
                if ev.event.as_deref() == Some("error") {
                    anyhow::bail!("live query error: {}", ev.data);
                }
                if matches!(ev.event.as_deref(), Some("end") | Some("done")) {
                    return Ok(());
                }
                let Ok(v) = serde_json::from_str::<Value>(&ev.data) else { continue };
                for row in flatten_rows(v) {
                    if rows.send(row).await.is_err() {
                        return Ok(()); // receiver dropped → stop
                    }
                }
            }
        }
        Ok(())
    }
}

/// Non-2xx from the spectate endpoint (429 = our hourly quota is gone).
#[derive(Debug)]
pub struct SpectateError {
    pub status: u16,
    pub body: String,
}

impl std::fmt::Display for SpectateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "live/url {}: {}", self.status, self.body)
    }
}

impl std::error::Error for SpectateError {}

fn extract_url(body: &str) -> Option<String> {
    let t = body.trim();
    match serde_json::from_str::<Value>(t) {
        Ok(Value::String(s)) => Some(s),
        Ok(Value::Object(o)) => ["broadcast_url", "url", "live_url"]
            .iter()
            .find_map(|k| o.get(*k).and_then(Value::as_str).map(str::to_string)),
        _ if t.starts_with("http") => Some(t.to_string()),
        _ => None,
    }
}

#[derive(Debug, Default, PartialEq)]
pub struct SseEvent {
    pub event: Option<String>,
    pub data: String,
}

/// Incremental Server-Sent Events parser (handles chunks split anywhere).
#[derive(Default)]
pub struct SseParser {
    buf: String,
}

impl SseParser {
    pub fn push(&mut self, bytes: &[u8]) -> Vec<SseEvent> {
        self.buf.push_str(&String::from_utf8_lossy(bytes));
        self.buf = self.buf.replace("\r\n", "\n");
        let mut out = vec![];
        while let Some(idx) = self.buf.find("\n\n") {
            let block: String = self.buf.drain(..idx + 2).collect();
            let mut ev = SseEvent::default();
            let mut data = vec![];
            for line in block.lines() {
                if let Some(v) = line.strip_prefix("data:") {
                    data.push(v.strip_prefix(' ').unwrap_or(v).to_string());
                } else if let Some(v) = line.strip_prefix("event:") {
                    ev.event = Some(v.trim().to_string());
                }
            }
            if !data.is_empty() || ev.event.is_some() {
                ev.data = data.join("\n");
                out.push(ev);
            }
        }
        out
    }
}

/// Accepts a row object, an array of rows, or `{ "rows": [...] }`.
pub fn flatten_rows(v: Value) -> Vec<Value> {
    match v {
        Value::Array(a) => a.into_iter().flat_map(flatten_rows).collect(),
        Value::Object(ref o) if o.get("rows").map(Value::is_array).unwrap_or(false) => {
            flatten_rows(o.get("rows").cloned().unwrap_or(Value::Null))
        }
        Value::Object(_) => vec![v],
        _ => vec![],
    }
}

fn num(v: Option<&Value>) -> Option<f64> {
    match v? {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.parse().ok(),
        Value::Bool(b) => Some(*b as u8 as f64),
        _ => None,
    }
}

/// Source 2 team numbers 2/3 → 0 (Amber) / 1 (Sapphire), like the match metadata.
fn map_team(t: i64) -> u8 {
    if t >= 2 {
        (t - 2) as u8
    } else {
        t as u8
    }
}

/// Merges rows from all live queries into one `LiveState`.
///
/// Items come from purchase events keyed by player slot; the slot→account mapping comes
/// from player rows (`slot` alias). Either can arrive first, so both are buffered.
#[derive(Debug, Default)]
pub struct Aggregator {
    pub state: LiveState,
    /// (clock seconds, tick at which that clock value was taken)
    clock_anchor: Option<(f64, i64)>,
    /// (game start in server seconds, total paused ticks)
    game_start: Option<(f64, i64)>,
    latest_tick: i64,
    /// account → respawn time in server seconds (only while dead)
    respawn_at: HashMap<u32, f64>,
    mid_boss_at: Option<f64>,
    slots: HashMap<i64, u32>,
    items: HashMap<i64, Vec<u32>>,
    /// hero pawn entity index → account
    pawns: HashMap<i64, u32>,
    /// (slot, item) → game time of purchase
    bought_at: HashMap<(i64, u32), f64>,
    /// team → unlocked flex slot ids
    flex_unlocked: HashMap<usize, std::collections::BTreeSet<i64>>,
}

/// Deaths of the same victim within this many ticks are one death (killfeed + recap).
const DEATH_MERGE_TICKS: i64 = 180;
const MAX_DEATHS: usize = 12;

impl Aggregator {
    pub fn new(state: LiveState) -> Self {
        Self { state, ..Default::default() }
    }

    /// Server tickrate (measured: ~60 tick messages/s in console.log net stats).
    pub const TICKRATE: f64 = 60.0;

    /// Match clock. Preferred: last clock value + ticks since it was taken (valid once
    /// the game has been paused at least once). Otherwise: server time − game start
    /// − paused time, where server time = tick / tickrate.
    fn update_clock(&mut self) -> bool {
        let anchored = self
            .clock_anchor
            .filter(|(_, at)| *at > 0 && self.latest_tick >= *at)
            .map(|(clock, at)| clock + (self.latest_tick - at) as f64 / Self::TICKRATE);
        let from_start = self.game_start.filter(|(start, _)| *start > 0.0).map(|(start, paused)| {
            (self.latest_tick - paused) as f64 / Self::TICKRATE - start
        });
        let Some(t) = anchored.or(from_start) else { return false };
        if (t - self.state.game_time_s).abs() >= 1.0 {
            self.state.game_time_s = t.max(0.0);
            return true;
        }
        false
    }

    fn server_now(&self) -> f64 {
        self.latest_tick as f64 / Self::TICKRATE
    }

    /// Recomputes countdowns (respawns, mid boss) against the latest tick.
    fn update_timers(&mut self) -> bool {
        let now = self.server_now();
        let mut changed = false;
        for p in &mut self.state.players {
            let next = if p.dead {
                self.respawn_at.get(&p.account_id).map(|at| (at - now).max(0.0).round())
            } else {
                None
            };
            if next != p.respawn_in_s {
                p.respawn_in_s = next;
                changed = true;
            }
        }
        let mb = self.mid_boss_at.map(|at| (at - now).round()).filter(|s| *s > 0.0);
        if mb != self.state.mid_boss_in_s {
            self.state.mid_boss_in_s = mb;
            changed = true;
        }
        changed
    }

    /// Returns true if the state changed in a way worth emitting.
    pub fn apply(&mut self, row: &Value) -> bool {
        let changed = self.apply_row(row);
        self.update_timers() || changed
    }

    fn apply_row(&mut self, row: &Value) -> bool {
        if let Some(t) = num(row.get("tick")).map(|t| t as i64) {
            self.latest_tick = self.latest_tick.max(t);
        }
        if let (Some(a), Some(b)) = (num(row.get("obj_mask_0")), num(row.get("obj_mask_1"))) {
            self.state.objective_masks = Some([a as u64, b as u64]);
            return true;
        }
        if row.get("clock_s").is_some() || row.get("game_start_s").is_some() {
            if let Some(mb) = num(row.get("mid_boss_at")) {
                self.mid_boss_at = Some(mb).filter(|x| *x > 0.0);
            }
            if let (Some(c), Some(at)) = (num(row.get("clock_s")), num(row.get("clock_tick"))) {
                self.clock_anchor = Some((c, at as i64));
            }
            if let Some(start) = num(row.get("game_start_s")) {
                let paused = num(row.get("paused_ticks")).unwrap_or(0.0) as i64;
                self.game_start = Some((start, paused));
            }
            return self.update_clock();
        }
        let clock_moved = self.update_clock();
        if let Some(t) = num(row.get("winning_team")) {
            self.state.winning_team = Some(map_team(t as i64));
            return true;
        }

        if let (Some(team), Some(slot)) = (num(row.get("flex_team")), num(row.get("flexslot_unlocked"))) {
            let t = map_team(team as i64) as usize;
            if t < 2 {
                let set = self.flex_unlocked.entry(t).or_default();
                set.insert(slot as i64);
                let mut fs = self.state.flex_slots.unwrap_or([0, 0]);
                fs[t] = set.len().min(255) as u8;
                self.state.flex_slots = Some(fs);
            }
            return true;
        }
        if row.get("kill_victim").is_some() {
            return self.apply_kill(row);
        }
        if let Some(recap) = row.get("death_recap") {
            return self.apply_recap(row, recap);
        }

        if let Some(slot) = num(row.get("purchase_slot")).map(|x| x as i64) {
            let Some(item) = num(row.get("item_id")).map(|x| x as u32).filter(|x| *x > 0) else { return false };
            let sold = matches!(row.get("sold"), Some(Value::Bool(true))) || num(row.get("sold")) == Some(1.0);
            let tick = num(row.get("tick")).map(|t| t as i64).unwrap_or(self.latest_tick);
            let when = self.game_time_at(tick);
            let list = self.items.entry(slot).or_default();
            if sold {
                if let Some(i) = list.iter().position(|x| *x == item) {
                    list.remove(i);
                }
                self.bought_at.remove(&(slot, item));
            } else if !list.contains(&item) {
                list.push(item);
                self.bought_at.insert((slot, item), when);
            }
            let list = list.clone();
            if let Some(acc) = self.slots.get(&slot).copied() {
                let times = self.times_for(slot, &list);
                let p = self.state.player_mut(acc);
                p.item_ids = list;
                p.item_times = times;
            }
            return true;
        }

        let mut changed = clock_moved;
        if let Some(t) = num(row.get("game_time_s")) {
            if t > self.state.game_time_s {
                self.state.game_time_s = t;
                changed = true;
            }
        }

        let raw = match row.get("account_id") {
            Some(Value::Number(n)) => n.as_u64(),
            Some(Value::String(s)) => s.parse().ok(),
            _ => None,
        };
        let Some(raw) = raw.filter(|r| *r > 0) else { return changed };
        let account = if raw > u32::MAX as u64 { steam64_to_account(raw) } else { Some(raw as u32) };
        let Some(account) = account else { return changed };

        let slot = num(row.get("slot")).map(|x| x as i64);
        if let Some(slot) = slot {
            self.slots.insert(slot, account);
        }
        if let Some(pawn) = num(row.get("pawn")).map(|x| x as i64).filter(|x| *x > 0) {
            self.pawns.insert(pawn, account);
        }
        let buffered = slot.and_then(|s| self.items.get(&s).cloned());

        let p = self.state.player_mut(account);
        if let Some(v) = num(row.get("team")) {
            p.team = map_team(v as i64);
        }
        if let Some(v) = num(row.get("hero_id")) {
            p.hero_id = v as u32;
        }
        if let Some(v) = num(row.get("net_worth")) {
            p.net_worth = v as i64;
        }
        if let Some(v) = num(row.get("souls")) {
            p.souls = Some(v as i64);
        }
        if let Some(v) = num(row.get("kills")) {
            p.kills = v as i64;
        }
        if let Some(v) = num(row.get("deaths")) {
            p.deaths = v as i64;
        }
        if let Some(v) = num(row.get("assists")) {
            p.assists = v as i64;
        }
        if let Some(v) = num(row.get("level")) {
            p.level = v as i64;
        }
        if let Some(v) = num(row.get("alive")) {
            p.dead = v == 0.0;
        }
        if let Some(at) = num(row.get("respawn_at")) {
            self.respawn_at.insert(account, at);
        }
        let p = self.state.player_mut(account);
        if let Some(v) = num(row.get("lane")) {
            p.lane = Some(v as i64);
        }
        if let Some(v) = num(row.get("hero_damage")) {
            p.hero_damage = Some(v as i64);
        }
        if let Some(v) = num(row.get("hero_healing")) {
            p.hero_healing = Some(v as i64);
        }
        if let Some(v) = num(row.get("self_healing")) {
            p.self_healing = Some(v as i64);
        }
        let p = self.state.player_mut(account);
        if let Some(Value::Array(items)) = row.get("item_ids") {
            p.item_ids = items.iter().filter_map(|i| num(Some(i))).map(|x| x as u32).filter(|x| *x > 0).collect();
        } else if let Some(items) = buffered {
            p.item_ids = items;
        }
        if let Some(slot) = slot {
            let ids = self.state.player_mut(account).item_ids.clone();
            let times = self.times_for(slot, &ids);
            self.state.player_mut(account).item_times = times;
        }
        true
    }
}

impl Aggregator {
    /// Purchase game time per item (−1 when unknown, e.g. bought before we connected).
    fn times_for(&self, slot: i64, items: &[u32]) -> Vec<f64> {
        items.iter().map(|i| self.bought_at.get(&(slot, *i)).copied().unwrap_or(-1.0)).collect()
    }

    /// Entity index from an event → account. Hero pawns first, then controllers
    /// (controller entity index = slot + 1).
    fn ent_account(&self, ent: i64) -> Option<u32> {
        self.pawns.get(&ent).copied().or_else(|| self.slots.get(&(ent - 1)).copied())
    }

    fn game_time_at(&self, tick: i64) -> f64 {
        (self.state.game_time_s - (self.latest_tick - tick).max(0) as f64 / Self::TICKRATE).max(0.0)
    }

    /// Finds (or creates) my death record near `tick`.
    fn my_death_at(&mut self, tick: i64) -> &mut DeathRecord {
        let me = self.state.my_account_id;
        if let Some(i) = self.state.my_deaths.iter().rposition(|d| (d.tick - tick).abs() <= DEATH_MERGE_TICKS) {
            return &mut self.state.my_deaths[i];
        }
        let my_team = self.state.players.iter().find(|p| p.account_id == me).map(|p| p.team);
        let (mut allies, mut enemies) = (0, 0);
        for p in &self.state.players {
            if p.dead || p.account_id == me {
                continue;
            }
            if Some(p.team) == my_team {
                allies += 1;
            } else {
                enemies += 1;
            }
        }
        let (nw, items) = self.state.players.iter().find(|p| p.account_id == me).map(|p| (p.net_worth, p.item_ids.clone())).unwrap_or_default();
        let rec = DeathRecord {
            tick,
            game_time_s: self.game_time_at(tick),
            allies_alive: allies,
            enemies_alive: enemies,
            net_worth: nw,
            item_ids: items,
            ..Default::default()
        };
        self.state.my_deaths.push(rec);
        self.state.my_deaths.sort_by_key(|d| d.tick);
        if self.state.my_deaths.len() > MAX_DEATHS {
            self.state.my_deaths.remove(0);
        }
        let i = self.state.my_deaths.iter().position(|d| d.tick == tick).unwrap_or(self.state.my_deaths.len() - 1);
        &mut self.state.my_deaths[i]
    }

    fn apply_kill(&mut self, row: &Value) -> bool {
        let tick = num(row.get("tick")).unwrap_or(self.latest_tick as f64) as i64;
        let Some(victim) = num(row.get("kill_victim")).and_then(|e| self.ent_account(e as i64)) else { return false };
        if victim != self.state.my_account_id || victim == 0 {
            return false;
        }
        let killer = num(row.get("kill_attacker")).and_then(|e| self.ent_account(e as i64));
        let assisters: Vec<u32> = match row.get("kill_assisters") {
            Some(Value::Array(xs)) => xs.iter().filter_map(|x| num(Some(x))).filter_map(|e| self.ent_account(e as i64)).collect(),
            _ => vec![],
        };
        let ability = num(row.get("killer_ability_id")).map(|x| x as u32).filter(|x| *x > 0);
        let d = self.my_death_at(tick);
        d.killer_account = killer.or(d.killer_account);
        if !assisters.is_empty() {
            d.assister_accounts = assisters;
        }
        d.killer_ability_id = ability.or(d.killer_ability_id);
        true
    }

    fn apply_recap(&mut self, row: &Value, recap: &Value) -> bool {
        let tick = num(row.get("tick")).unwrap_or(self.latest_tick as f64) as i64;
        let victim = num(recap.get("player_slot")).and_then(|s| self.slots.get(&(s as i64)).copied());
        // recaps are sent to the victim; accept unknown slots only when they can only be mine
        if victim.is_some_and(|v| v != self.state.my_account_id) {
            return false;
        }
        let pawn_acc: HashMap<i64, u32> = self.pawns.clone();
        let slots = self.slots.clone();
        let acc = |e: i64| pawn_acc.get(&e).copied().or_else(|| slots.get(&(e - 1)).copied());
        let damage: Vec<DeathDamage> = match recap.get("damage_records") {
            Some(Value::Array(xs)) => xs
                .iter()
                .map(|r| DeathDamage {
                    attacker_hero_id: num(r.get("hero_id")).unwrap_or(0.0) as u32,
                    ability_id: num(r.get("ability_id")).unwrap_or(0.0) as u32,
                    damage: num(r.get("damage")).unwrap_or(0.0) as i64,
                    hits: num(r.get("hits")).unwrap_or(0.0) as i64,
                    damage_type: num(r.get("damage_type")).unwrap_or(0.0) as u32,
                    crit_damage: num(r.get("crit_damage")).unwrap_or(0.0),
                    absorbed: num(r.get("damage_absorbed")).unwrap_or(0.0),
                    killing_blow: matches!(r.get("is_killing_blow"), Some(Value::Bool(true))),
                })
                .filter(|d| d.damage > 0)
                .collect(),
            _ => vec![],
        };
        let modifiers: Vec<DeathModifier> = match recap.get("modifier_records") {
            Some(Value::Array(xs)) => xs
                .iter()
                .map(|m| DeathModifier {
                    ability_id: num(m.get("ability_id")).unwrap_or(0.0) as u32,
                    caster_account: num(m.get("entindex_caster")).and_then(|e| acc(e as i64)),
                    start_s: num(m.get("start_time")).unwrap_or(0.0),
                    end_s: num(m.get("end_time")).unwrap_or(0.0),
                    debuff: matches!(m.get("debuff"), Some(Value::Bool(true))),
                })
                .collect(),
            _ => vec![],
        };
        if damage.is_empty() && modifiers.is_empty() {
            return false;
        }
        let start = num(recap.get("start_time"));
        let end = num(recap.get("end_time"));
        let total = num(recap.get("total_damage")).map(|x| x as i64);
        let lost = num(recap.get("lost_gold")).map(|x| x as i64);
        let d = self.my_death_at(tick);
        d.damage = damage;
        d.modifiers = modifiers;
        d.duration_s = match (start, end) {
            (Some(a), Some(b)) if b >= a => Some(b - a),
            _ => d.duration_s,
        };
        d.total_damage = total.or(d.total_damage);
        d.lost_gold = lost.or(d.lost_gold);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn counts_flex_slot_unlocks_per_team() {
        let mut a = Aggregator::default();
        a.apply(&json!({"tick": 1, "flex_team": 2, "flexslot_unlocked": 1}));
        a.apply(&json!({"tick": 2, "flex_team": 2, "flexslot_unlocked": 1}));
        a.apply(&json!({"tick": 3, "flex_team": 2, "flexslot_unlocked": 2}));
        a.apply(&json!({"tick": 4, "flex_team": 3, "flexslot_unlocked": 1}));
        assert_eq!(a.state.flex_slots, Some([2, 1]));
    }

    #[test]
    fn records_purchase_game_time() {
        let mut a = Aggregator::default();
        a.apply(&json!({"tick": 6000, "game_start_s": 40.0, "paused_ticks": 0}));
        a.apply(&json!({"tick": 6000, "account_id": 7, "slot": 2, "team": 2, "hero_id": 6}));
        a.apply(&json!({"tick": 9000, "purchase_slot": 2, "item_id": 555, "sold": false}));
        let p = &a.state.players[0];
        assert_eq!(p.item_ids, vec![555]);
        // tick 9000 / 60 = 150 s server time − 40 s game start = 110 s game time
        assert!((p.item_times[0] - 110.0).abs() < 1.5, "{:?}", p.item_times);
    }

    #[test]
    fn records_my_death_from_killfeed_and_recap() {
        let mut a = Aggregator::default();
        a.state.my_account_id = 7;
        a.apply(&json!({"tick": 6000, "account_id": 7, "slot": 2, "team": 2, "hero_id": 6, "pawn": 40, "net_worth": 9000}));
        a.apply(&json!({"tick": 6000, "account_id": 8, "slot": 3, "team": 3, "hero_id": 13, "pawn": 41}));
        a.apply(&json!({"tick": 6000, "account_id": 9, "slot": 4, "team": 3, "hero_id": 1, "pawn": 42}));
        // someone else's death is ignored
        assert!(!a.apply(&json!({"tick": 6100, "kill_victim": 41, "kill_attacker": 40, "kill_assisters": []})));
        assert!(a.apply(&json!({"tick": 6200, "kill_victim": 40, "kill_attacker": 41, "kill_assisters": [42], "killer_ability_id": 555})));
        assert!(a.apply(&json!({"tick": 6230, "death_recap": {"player_slot": 2, "start_time": 100.0, "end_time": 103.5, "total_damage": 900, "lost_gold": 300,
            "damage_records": [{"damage": 600, "hits": 12, "damage_type": 1, "hero_id": 13, "ability_id": 99, "crit_damage": 120.0, "is_killing_blow": true}],
            "modifier_records": [{"ability_id": 777, "entindex_caster": 42, "start_time": 101.0, "end_time": 102.5, "debuff": true}]}})));
        let d = &a.state.my_deaths;
        assert_eq!(d.len(), 1);
        assert_eq!((d[0].killer_account, d[0].assister_accounts.clone(), d[0].killer_ability_id), (Some(8), vec![9], Some(555)));
        assert_eq!((d[0].duration_s, d[0].total_damage, d[0].damage.len()), (Some(3.5), Some(900), 1));
        assert_eq!(d[0].modifiers[0].caster_account, Some(9));
        assert_eq!((d[0].net_worth, d[0].enemies_alive), (9000, 2));
    }

    #[test]
    fn sse_parser_handles_split_chunks() {
        let mut p = SseParser::default();
        assert!(p.push(b"data: {\"a\":").is_empty());
        let ev = p.push(b"1}\r\n\r\nevent: end\ndata: x\n\n");
        assert_eq!(ev.len(), 2);
        assert_eq!(ev[0].data, "{\"a\":1}");
        assert_eq!(ev[1].event.as_deref(), Some("end"));
    }

    #[test]
    fn aggregates_players_clock_items_and_game_over() {
        let mut a = Aggregator::default();
        // purchase arrives before we know who slot 3 is → buffered
        assert!(a.apply(&json!({"tick": 10, "purchase_slot": 3, "item_id": 111, "sold": false})));
        let rows = flatten_rows(json!([
            {"tick": 11, "account_id": 76561198012345678u64, "slot": 3, "team": 2, "hero_id": 6, "net_worth": 12000, "souls": 900, "kills": 3, "deaths": 1, "assists": 4, "level": 12, "lane": 4, "hero_healing": 1200},
            {"tick": 11, "account_id": "1234", "slot": 4, "team": 3, "hero_id": 13, "net_worth": "9000"}
        ]));
        for r in &rows {
            assert!(a.apply(r));
        }
        assert!(a.apply(&json!({"tick": 12, "game_time_s": 610.5})));
        assert!(a.apply(&json!({"tick": 13, "purchase_slot": 3, "item_id": 222, "sold": false})));
        assert!(a.apply(&json!({"tick": 14, "purchase_slot": 3, "item_id": 111, "sold": true})));
        assert!(a.apply(&json!({"tick": 15, "purchase_slot": 4, "item_id": 333, "sold": false})));

        let s = &a.state;
        assert_eq!(s.players.len(), 2);
        let me = &s.players[0];
        assert_eq!((me.account_id, me.team, me.hero_id, me.net_worth, me.souls), (52_079_950, 0, 6, 12000, Some(900)));
        assert_eq!((me.lane, me.hero_healing, me.self_healing), (Some(4), Some(1200), None));
        assert_eq!(me.item_ids, vec![222]);
        assert_eq!(s.players[1].team, 1);
        assert_eq!(s.players[1].item_ids, vec![333]);
        assert_eq!(s.game_time_s, 610.5);

        // later row updates in place and keeps items
        a.apply(&json!({"account_id": 1234, "slot": 4, "net_worth": 9500}));
        assert_eq!(a.state.players.len(), 2);
        assert_eq!(a.state.players[1].net_worth, 9500);
        assert_eq!(a.state.players[1].item_ids, vec![333]);

        assert!(a.apply(&json!({"tick": 99, "winning_team": 3})));

        // clock: anchored at tick 600 with 10 s, now at tick 600 + 60*50 → 60 s
        let mut c = Aggregator::default();
        c.apply(&json!({"tick": 600, "clock_s": 10.0, "clock_tick": 600}));
        assert_eq!(c.state.game_time_s, 10.0);
        assert!(c.apply(&json!({"tick": 3600, "account_id": 1, "slot": 0, "net_worth": 1})));
        assert_eq!(c.state.game_time_s, 60.0);

        // timers: respawn + mid boss against server time (tick 3600 → 60 s)
        let mut t = Aggregator::default();
        t.apply(&json!({"tick": 3600, "account_id": 7, "slot": 0, "alive": false, "respawn_at": 85.0}));
        assert!(t.state.players[0].dead);
        assert_eq!(t.state.players[0].respawn_in_s, Some(25.0));
        t.apply(&json!({"tick": 3600, "clock_s": 0.0, "clock_tick": 0, "game_start_s": 0.0, "mid_boss_at": 180.0}));
        assert_eq!(t.state.mid_boss_in_s, Some(120.0));
        t.apply(&json!({"tick": 4800, "account_id": 7, "slot": 0, "alive": true}));
        assert!(!t.state.players[0].dead);
        assert_eq!(t.state.players[0].respawn_in_s, None);
        assert_eq!(t.state.mid_boss_in_s, Some(100.0));
        t.apply(&json!({"tick": 4801, "obj_mask_0": 65535, "obj_mask_1": 65533}));
        assert_eq!(t.state.objective_masks, Some([65535, 65533]));

        // never paused: anchor is 0 → use game start. Start at 100 s server time,
        // now tick 60*700 = 700 s server time, 60 paused ticks (1 s) → 599 s.
        let mut d = Aggregator::default();
        d.apply(&json!({"tick": 42000, "clock_s": 0.0, "clock_tick": 0, "game_start_s": 100.0, "paused_ticks": 60}));
        assert_eq!(d.state.game_time_s, 599.0);
        assert_eq!(a.state.winning_team, Some(1));
    }

    #[test]
    fn extracts_url_from_various_shapes() {
        assert_eq!(extract_url("\"https://a/b\"").as_deref(), Some("https://a/b"));
        assert_eq!(extract_url("{\"broadcast_url\":\"https://x\"}").as_deref(), Some("https://x"));
        assert_eq!(extract_url("https://plain").as_deref(), Some("https://plain"));
    }
}
