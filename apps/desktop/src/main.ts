import "./style.css";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import type { BuildStep, DeathPattern, DeathReview, DraftOddsResult, HeroCombo, EnemyMatchup, ImbueAdvice, ItemPlay, GamePlan, LiveState, MacroPlan, MatchLog, PlayerScout, TeamPhaseCompare, Tip, WinSmoothState, MacroHoldState, TipHoldState } from "@deadlock/core";
import { formatClock, smoothWinProb, holdMacroPlan, stabilizeTips, computeLagSeconds, filterPendingBuys, computeSoulsPacing } from "@deadlock/core";

// ---------- engine events (Rust serde: tag "type", kebab-case) ----------
type EngineEvent =
  | { type: "game-started" }
  | { type: "game-stopped" }
  | { type: "match-detected"; match_id: number; source: string }
  | { type: "lobby-players"; account_ids: number[] }
  | { type: "live-connected"; match_id: number }
  | { type: "status"; message: string }
  | ({ type: "live-state" } & LiveState)
  | { type: "live-ended"; match_id: number }
  | { type: "error"; message: string }
  | ({ type: "diag" } & Diag);

interface Diag {
  game: boolean;
  found_by: string | null;
  force: boolean;
  procs_seen: number;
  steam_app: number | null;
  log_path: string | null;
  log_exists: boolean;
  log_age_s: number | null;
  account_id: number;
  match_id: number | null;
  live_connected: boolean;
}

/** shown in the header so it is obvious which build is running */
let APP_BUILD = "v0.3.5"; // replaced by the real app version at start

export interface SteamProfile {
  account_id: number;
  persona_name: string;
  avatar_hash: string | null;
  avatar_url: string | null;
}

interface Settings {
  siteBase: string;
  accountId: number | null;
  configPath: string;
  profile?: SteamProfile | null;
}

const HERO_ASSET_SLUGS: Record<number, string> = {
  1: "inferno",
  2: "gigawatt",
  3: "hornet",
  4: "spectre",
  6: "bull",
  7: "wraith",
  8: "engineer",
  10: "chrono",
  11: "sumo",
  12: "kelvin",
  13: "haze",
  14: "astro",
  15: "bebop",
  16: "nano",
  17: "archer",
  18: "digger",
  19: "shiv",
  20: "tengu",
  25: "warden",
  27: "yamato",
  31: "lash",
  35: "viscous",
  50: "synth",
  52: "mirage",
  58: "kali",
  60: "magician",
  63: "vampirebat",
  64: "drifter",
  65: "priest",
  66: "frank",
  67: "bookworm",
  69: "doorman",
  72: "punkgoat",
  76: "necro",
  77: "fencer",
  79: "familiar",
  80: "werewolf",
  81: "unicorn",
  84: "ratking",
  85: "chessmaster",
  88: "baba",
};

function getHeroAssetIcon(id: number): string | null {
  const slug = HERO_ASSET_SLUGS[id];
  return slug ? `https://assets-bucket.deadlock-api.com/assets-api-res/images/heroes/${slug}_sm.webp` : null;
}

const failedHeroIcons = new Set<string>();
(window as unknown as { __onHeroIconError: (el: HTMLImageElement, url: string) => void }).__onHeroIconError = (el, url) => {
  failedHeroIcons.add(url);
  el.style.display = "none";
};

// ---------- slim shapes of the website's /api responses ----------
interface MetaHero { heroId: number; name: string; icon?: string; winrate: number; tier: string }
interface HeroInfo {
  hero: { id: number; name: string };
  meta?: MetaHero | null;
  phases: { phases: Record<"early" | "mid" | "late", { winrate: number; matches: number }>; peak: string | null; scaling: number } | null;
  builds: { id: number; name: string; winrate: number; matches: number }[];
  itemsByTier?: Record<string, { id: number; name: string; slot: "weapon" | "vitality" | "spirit"; winrate: number; delta: number; avgBuyTimeS?: number }[]>;
}
interface Buy { id: number; name: string; tier: number; cost: number | null; slot: "weapon" | "vitality" | "spirit"; score: number; affordable: boolean; reason: string }
interface LiveResp {
  gameTimeS: number;
  teamNetWorth: [number, number];
  netWorthLead: number;
  winProbability: number | null;
  winModel: { matches: number; samples: number } | null;
  empirical: { from: number; to: number; leadMin: number; leadMax: number; winrate: number; n: number; leaderIsMe: boolean } | null;
  trend: { seconds: number; leadDelta: number } | null;
  tips: Tip[];
  teamPhases: TeamPhaseCompare | null;
  buildPath: BuildStep[];
  build: { id: number; name: string; winrate: number; matches: number } | null;
  matchups: EnemyMatchup[];
  threats: { accountId: number; heroId: number; netWorth: number; nwShare: number; weight: number }[];
  nextBuys: Record<"all" | "weapon" | "vitality" | "spirit", Buy[]>;
  phase?: Phase;
  adaptive?: { phase: Phase; flexUsed: number; flexMax: number; source: "core+flex" | "build" };
  needs?: { kind: string; urgency: number; reason: string; satisfied: boolean }[];
  damage?: { bullet: number; spirit: number };
  macro?: MacroPlan;
  gamePlan?: GamePlan | null;
  playbook?: { next: ItemPlay[]; owned: ItemPlay[] };
  imbue?: ImbueAdvice[];
  deaths?: { reviews: DeathReview[]; patterns: DeathPattern };
  abilityOrder?: { max: { slot: number; name: string }[]; maxWinrate: number | null; sequence: number[]; sequenceWinrate: number | null; ultAt: number | null } | null;
  laneStats?: { netWorthDiff: number; winrate: number; matches: number; sampleMatches: number; sampleS: number } | null;
  spikes?: {
    verdict: "fight" | "avoid" | "even";
    mine: number;
    enemy: number;
    windowLeft: number;
    /** in-game clock when the window closes */
    untilClock?: string;
    myItems: { heroId: number; name: string; age: number }[];
    enemyItems: { heroId: number; name: string; age: number }[];
  };
  combo?: HeroCombo;
  partner?: { heroId: number; name: string; delta: number; why: string } | null;
  sell?: { sellId: number; sellName: string; refund: number; forId: number; forName: string; reason: string; slotsUsed: number; capacity: number } | null;
  switched?: string | null;
  mode?: { gameMode: "normal" | "brawl"; matchMode: "unranked" | "ranked"; isBrawl: boolean; isRanked: boolean; label: string };
  draftOdds?: DraftOddsResult;
}
type PathStep = BuildStep & { locked?: boolean; upgradeFrom?: number; fullCost?: number };
type Phase = "early" | "mid" | "late" | "vlate";
const PHASE_NAME: Record<Phase, string> = { early: "Early", mid: "Mid", late: "Late", vlate: "Very Late" };
const NEED_NAME: Record<string, string> = {
  anti_heal: "Anti-heal",
  bullet_resist: "Resist peluru",
  spirit_resist: "Resist spirit",
  cc_resist: "Anti-CC",
  lockdown: "Slow/stun",
  shred: "Penembus armor",
};
const ARCH_NAME: Record<string, string> = { sustain: "SUSTAIN", tank: "TANK", slippery: "LINCAH", cc: "CC" };
interface ScoutResp { players: { accountId: number; heroId?: number; team?: number; scout: PlayerScout | null }[] }

type Tab = "now" | "enemies" | "items" | "deaths" | "hero";
type LauncherTab = "home" | "live" | "roster" | "meta" | "profile" | "settings";

// ---------- state ----------
const S = {
  launcherTab: "home" as LauncherTab,
  selectedRosterHero: null as number | null,
  rosterSearch: "",
  rosterRoleFilter: "all" as "all" | "s" | "a",
  isAlwaysOnTop: (() => {
    try {
      const saved = localStorage.getItem("dlm_pin");
      return saved === null ? true : saved === "1";
    } catch {
      return true;
    }
  })(),
  settings: null as Settings | null,
  steamProfile: null as SteamProfile | null,
  omniSearchQuery: "",
  game: false,
  matchId: null as number | null,
  matchSource: "",
  connected: false,
  ended: false,
  live: null as LiveState | null,
  liveResp: null as LiveResp | null,
  leadHistory: [] as [number, number][],
  heroes: new Map<number, MetaHero>(),
  heroInfo: null as HeroInfo | null,
  pregameHero: (() => {
    try {
      const v = localStorage.getItem("dlm_pregame_hero");
      return v ? Number(v) : null;
    } catch {
      return null;
    }
  })(),
  scout: null as ScoutResp | null,
  scoutKey: "",
  tab: "now" as Tab,
  slotTab: "all" as keyof LiveResp["nextBuys"],
  error: "",
  clickThrough: false,
  matchDraft: "",
  diag: null as Diag | null,
  /** HUD focus mode (Ctrl+Shift+H): only coach + next buy on screen */
  focus: (() => {
    try {
      return localStorage.getItem("dlm_focus") === "on";
    } catch {
      return false;
    }
  })(),
  /** short confirmation shown on the HUD after a hotkey */
  toast: "",
  /** Date.now() until which the HUD Lawan box shows the team (Ctrl+Shift+T) */
  teamUntil: 0,
  /** items I tapped "sudah beli" on, until the broadcast shows them (or 6 min pass) */
  pending: [] as { itemId: number; name: string; cost: number; atS: number; matchId: number | null }[],
  /** wall clock ↔ game clock at the first live data of this match, to measure the real delay */
  lagAnchor: null as { wall: number; game: number; matchId: number | null } | null,
  note: "",
  log: null as MatchLog | null,
  /** the #1 buy we committed to (sent back so the server keeps it until bought) */
  commit: null as { itemId: number; sinceS: number; matchId: number | null } | null,
  /** manual mode: treat Deadlock as running even when the exe is not detected */
  force: (() => {
    try {
      return localStorage.getItem("dlm_force") === "on";
    } catch {
      return false;
    }
  })(),
  voice: (() => {
    try {
      return localStorage.getItem("dlm_voice") !== "off";
    } catch {
      return true;
    }
  })(),
  layout: null as { widgets: Record<string, { enabled: boolean; w: number; h: number }> } | null,
  postMatchSummary: null as { matchId: number; won: boolean; durationS: number; netWorth: number; kda: string } | null,
};

const $ = (id: string) => document.getElementById(id)!;

// ---------- view prefs (shared with HUD widgets via localStorage) ----------
const ZOOMS = [1, 1.1, 1.25, 0.9];
// solid by default (transparency was distracting in game); the button still cycles if wanted
const ALPHAS = [1, 0.92, 0.8];
function pref(key: string, list: number[]): number {
  try {
    const v = Number(localStorage.getItem(key));
    return list.includes(v) ? v : list[0];
  } catch {
    return list[0];
  }
}
function applyPrefs() {
  document.documentElement.style.setProperty("--zoom", String(pref("dlm_zoom", ZOOMS)));
  document.documentElement.style.setProperty("--alpha", String(pref("dlm_alpha_v2", ALPHAS)));
}
function cyclePref(key: string, list: number[]) {
  const next = list[(list.indexOf(pref(key, list)) + 1) % list.length];
  try {
    localStorage.setItem(key, String(next));
  } catch {}
  applyPrefs();
}
applyPrefs();
window.addEventListener("storage", applyPrefs);
const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const pct = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`;
const delta = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}`;
const wrCls = (x: number) => (x >= 0.53 ? "win" : x <= 0.47 ? "loss" : "");
const k = (n: number) => `${(n / 1000).toFixed(1)}k`;
const SLOT_CLS = { weapon: "w", vitality: "v", spirit: "s" } as const;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const base = S.settings?.siteBase ?? "http://localhost:3000";
  const res = await fetch(`${base.replace(/\/$/, "")}${path}`, init);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    let msg = body;
    try {
      msg = (JSON.parse(body) as { error?: string }).error ?? body;
    } catch {}
    throw new Error(`${path} → ${res.status}${msg ? `: ${msg.slice(0, 160)}` : ""}`);
  }
  return (await res.json()) as T;
}

function heroIcon(id: number, cls = "ico") {
  const h = S.heroes.get(id);
  const src = h?.icon || getHeroAssetIcon(id);
  const name = h?.name ?? "";
  if (src && !failedHeroIcons.has(src)) {
    return `<img class="${cls}" src="${esc(src)}" alt="${esc(name)}" title="${esc(name)}" loading="lazy" onerror="window.__onHeroIconError(this,'${esc(src)}')">`;
  }
  return `<span class="${cls}"></span>`;
}
const me = () => {
  if (!S.live) return undefined;
  if (S.live.myAccountId) {
    const found = S.live.players.find((p) => p.accountId === S.live!.myAccountId);
    if (found) return found;
  }
  if (S.pregameHero) {
    const foundByHero = S.live.players.find((p) => p.heroId === S.pregameHero);
    if (foundByHero) return foundByHero;
  }
  // Fallback: pick the first player on team Amber (0) or team Sapphire (1)
  return S.live.players[0];
};
async function loadHero(id: number) {
  if (S.heroInfo?.hero.id === id) return;
  try {
    S.heroInfo = await api<HeroInfo>(`/api/hero/${id}`);
  } catch (e) {
    S.error = String(e);
  }
  render();
}

async function loadScout(entries: { accountId: number; heroId?: number; team?: number }[]) {
  const key = entries.map((e) => `${e.accountId}:${e.heroId ?? ""}:${e.team ?? ""}`).join(",");
  if (!entries.length || key === S.scoutKey) return;
  S.scoutKey = key;
  try {
    S.scout = await api<ScoutResp>(`/api/scout?ids=${encodeURIComponent(key)}`);
  } catch (e) {
    S.error = String(e);
  }
  render();
}

let lastLivePost = 0;
let liveInFlight = false;
/**
 * Win probability smoothing. The raw model reacts to every pick-off and wave, so it
 * jumped 15–20 points within a minute. An exponential average over ~2.5 min of game time
 * shows the trend; a team wipe still moves it within a couple of minutes.
 */
const WIN_TAU_S = 150;
let winSmooth: WinSmoothState | null = null;
const winHist: [number, number][] = [];
function smoothWin(raw: number | null, t: number): number | null {
  const mid = S.live?.matchId ?? null;
  const res = smoothWinProb(winSmooth, raw, t, mid, WIN_TAU_S);
  winSmooth = res.state;
  if (winSmooth) {
    winHist.push([t, winSmooth.p]);
    while (winHist.length && t - winHist[0][0] > 300) winHist.shift();
  }
  return res.p;
}

let macroHeld: MacroHoldState | null = null;
function holdMacro(mc: MacroPlan | undefined, t: number): MacroPlan | undefined {
  const mid = S.live?.matchId ?? null;
  const res = holdMacroPlan(macroHeld, mc, t, mid, lagSeconds(), 45);
  macroHeld = res.state;
  return res.plan;
}

/** change of the smoothed value over the last ~2 min (points) */
function winTrend(): number | null {
  if (winHist.length < 2) return null;
  const [t1, p1] = winHist[winHist.length - 1];
  const old = winHist.find(([t]) => t1 - t <= 120) ?? winHist[0];
  return t1 - old[0] >= 45 ? p1 - old[1] : null;
}
const winBand = (p: number) => (p >= 0.65 ? "Unggul jauh" : p >= 0.55 ? "Unggul" : p > 0.45 ? "Seimbang" : p > 0.35 ? "Tertinggal" : "Tertinggal jauh");

/** souls in hand minus what I marked as bought (the broadcast has not caught up yet) */
function soulsNow(m: { souls?: number; itemIds: number[] }): number {
  const spent = S.pending.filter((p) => !m.itemIds.includes(p.itemId)).reduce((t, p) => t + p.cost, 0);
  return Math.max(0, (m.souls ?? 0) - spent);
}
let HUD_SOULS: number | null = null;

let toastTimer = 0;
function toast(msg: string) {
  S.toast = msg;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    S.toast = "";
    render();
  }, 5000);
  render();
}

/** mark an item as bought now (the broadcast shows it 1+ minute later) */
function markBought(id: number) {
  if (!S.live) return;
  const st = S.liveResp?.buildPath.find((x) => x.itemId === id);
  if (!S.pending.some((p) => p.itemId === id))
    S.pending.push({ itemId: id, name: st?.name ?? `#${id}`, cost: st?.cost ?? 0, atS: S.live.gameTimeS, matchId: S.live.matchId ?? null });
  if (S.commit?.itemId === id) S.commit = null;
  toast(`✓ ${st?.name ?? "Item"} ditandai sudah dibeli`);
  void postLive(true);
}

function onHotkey(k: string) {
  if (k === "bought") {
    const first = S.liveResp?.buildPath.find((x) => !S.pending.some((p) => p.itemId === x.itemId));
    if (S.live && first) {
      markBought(first.itemId);
    } else {
      const earlyItems = S.heroInfo?.itemsByTier?.["1"] ?? [];
      const firstEarly = earlyItems.find((x) => !S.pending.some((p) => p.itemId === x.id));
      if (firstEarly) {
        if (!S.pending.some((p) => p.itemId === firstEarly.id)) {
          S.pending.push({ itemId: firstEarly.id, name: firstEarly.name, cost: 500, atS: S.live?.gameTimeS ?? 0, matchId: S.matchId });
        }
        toast(`✓ ${firstEarly.name} ditandai sudah dibeli`);
        render();
      } else {
        toast("Belum ada saran beli untuk ditandai");
      }
    }
  } else if (k === "team") {
    S.teamUntil = Date.now() + 10_000;
    render();
    window.setTimeout(render, 10_100);
  } else if (k === "focus") {
    S.focus = !S.focus;
    try {
      localStorage.setItem("dlm_focus", S.focus ? "on" : "off");
    } catch {}
    toast(S.focus ? "Mode fokus: hanya Coach + Beli" : "Mode lengkap: semua widget HUD");
  }
}

/** drop pending buys the broadcast already shows, or that are older than 6 min game time */
function livePending(owned: number[]) {
  const t = S.live?.gameTimeS ?? 0;
  S.pending = filterPendingBuys(S.pending, owned, t, S.live?.matchId ?? null);
  return S.pending;
}

let liveRerun = false;
let lastLiveSuccess = 0;
async function postLive(force = false) {
  if (!S.live) return;
  if (liveInFlight) {
    // a click / purchase while a request runs: send again right after it
    if (force) liveRerun = true;
    return;
  }
  const m = me();
  if (!m) {
    S.error = S.live.myAccountId
      ? `Akun kamu (#${S.live.myAccountId}) tidak ada di 12 pemain match ini. Kalau main pakai akun lain, isi account_id di ${S.settings?.configPath ?? "deadlock-live.toml"}.`
      : "Akun Steam belum terdeteksi. Isi account_id di deadlock-live.toml.";
    render();
    return;
  }
  const now = Date.now();
  if (!force && now - lastLivePost < 10000) return; // analytics are cached server-side; 10 s is plenty
  lastLivePost = now;
  liveInFlight = true;
  try {
    S.liveResp = await api<LiveResp>("/api/live", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...S.live,
        leadHistory: S.leadHistory,
        broadcastDelayS: lagSeconds(),
        winPSmooth: winSmooth && winSmooth.matchId === (S.live.matchId ?? null) ? winSmooth.p : null,
        pendingBuys: livePending(m.itemIds).map((p) => ({ itemId: p.itemId, cost: p.cost })),
        commit: S.commit && S.commit.matchId === S.live.matchId ? { itemId: S.commit.itemId, sinceS: S.commit.sinceS } : null,
      }),
    });
    lastLiveSuccess = Date.now();
    const t = S.liveResp.gameTimeS;
    S.liveResp.winProbability = smoothWin(S.liveResp.winProbability, t);
    S.liveResp.macro = holdMacro(S.liveResp.macro, t);
    const last = S.leadHistory[S.leadHistory.length - 1];
    if (!last || t - last[0] >= 15) S.leadHistory.push([t, S.liveResp.netWorthLead]);
    S.leadHistory = S.leadHistory.filter(([ht]) => t - ht <= 600);
    S.error = "";
    S.liveResp.tips = stabilize(S.liveResp.tips);
    // commit to the #1 buy until it is bought (or the server says its reason is gone)
    const first = S.liveResp.buildPath[0];
    const bought = S.commit && m.itemIds.includes(S.commit.itemId);
    if (first && (!S.commit || S.commit.matchId !== S.live.matchId || bought || S.liveResp.switched || S.commit.itemId !== first.itemId)) {
      if (!S.commit || S.commit.itemId !== first.itemId || S.commit.matchId !== S.live.matchId)
        S.commit = { itemId: first.itemId, sinceS: S.liveResp.gameTimeS, matchId: S.live.matchId };
    }
    recordSnapshot(S.liveResp, m);
    speakTop(S.liveResp);
  } catch (e) {
    S.error = String(e);
  } finally {
    liveInFlight = false;
  }
  render();
  if (liveRerun) {
    liveRerun = false;
    void postLive(true);
  }
}

// ---------- tip stability: don't let the top call flicker every 10 s ----------
let topTip: TipHoldState | null = null;
let freshTop = false;
function stabilize(tips: Tip[]): Tip[] {
  const prevTitle = topTip?.title;
  const res = stabilizeTips(topTip, tips, Date.now());
  topTip = res.state;
  freshTop = !prevTitle || prevTitle !== res.tips[0]?.title;
  return res.tips;
}

// ---------- staleness: the broadcast can stall; never show old advice as current ----------
let lastStateAt = 0;
const staleSeconds = () => (lastStateAt ? Math.round((Date.now() - lastStateAt) / 1000) : 0);
/** Broadcast delay assumed when the first data of a match arrives (Valve spectate delay). */
const BASE_DELAY = 75;
/**
 * Real delay: base delay + how much the game clock fell behind the wall clock since the
 * first data. Grows when the broadcast / live query falls behind. (A game pause also counts.)
 */
function lagSeconds(): number {
  return computeLagSeconds(S.lagAnchor, S.live?.gameTimeS ?? 0, S.live?.matchId ?? null, Date.now(), BASE_DELAY);
}
setInterval(() => {
  if (S.connected && staleSeconds() >= 30) renderStatus();
}, 5000);

// ---------- match log (for calibration + post-match review) ----------
let lastLogSave = 0;
function recordSnapshot(r: LiveResp, m: LiveState["players"][number]) {
  if (!S.live?.matchId) return;
  if (!S.log || S.log.matchId !== S.live.matchId) {
    S.log = { matchId: S.live.matchId, accountId: S.live.myAccountId, heroId: m.heroId, team: m.team, startedAt: Date.now(), updatedAt: Date.now(), snapshots: [] };
  }
  const log = S.log;
  const last = log.snapshots[log.snapshots.length - 1];
  if (!last || r.gameTimeS - last.t >= 20) {
    log.snapshots.push({
      t: r.gameTimeS,
      winP: r.winProbability,
      lead: r.netWorthLead,
      phase: r.phase,
      macro: r.macro?.action,
      tips: r.tips.map((x) => ({ kind: x.kind, title: x.title })),
      next: r.buildPath.slice(0, 3).map((b) => ({ itemId: b.itemId, kind: b.kind })),
      needs: (r.needs ?? []).map((n) => ({ kind: n.kind, satisfied: n.satisfied })),
      items: [...m.itemIds],
      deaths: m.deaths,
      nw: m.netWorth,
    });
  }
  log.updatedAt = Date.now();
  log.finalItems = [...m.itemIds];
  if (S.live.winningTeam !== undefined && log.winningTeam === undefined) {
    log.winningTeam = S.live.winningTeam;
    void saveLog(true);
  } else void saveLog(false);
}

async function saveLog(force: boolean) {
  if (!S.log || (!force && Date.now() - lastLogSave < 120_000)) return;
  lastLogSave = Date.now();
  try {
    await api("/api/me/log", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(S.log) });
  } catch {
    // best effort: the next save retries
  }
}

// ---------- voice cues ----------
// ---------- voice & audio cues ----------
let lastSpoken = { title: "", at: 0 };
let audioCtx: AudioContext | null = null;

/** Play crisp tactical chimes and synthesized audio cues (works offline, zero robotic distortion) */
function playTacticalChime(kind: "alert" | "info" | "boss" | "retreat" = "info") {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    if (!audioCtx) audioCtx = new Ctx();
    if (audioCtx.state === "suspended") void audioCtx.resume();

    const now = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();

    osc.type = "sine";
    if (kind === "boss") {
      // 3-tone ascending alert chime for Mid-Boss (C5 -> E5 -> G5)
      osc.frequency.setValueAtTime(523.25, now);
      osc.frequency.setValueAtTime(659.25, now + 0.1);
      osc.frequency.setValueAtTime(783.99, now + 0.2);
      gain.gain.setValueAtTime(0.001, now);
      gain.gain.exponentialRampToValueAtTime(0.14, now + 0.05);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.5);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(now);
      osc.stop(now + 0.51);
    } else if (kind === "retreat") {
      // 2-tone descending urgency chime (A5 -> D5)
      osc.frequency.setValueAtTime(880.0, now);
      osc.frequency.setValueAtTime(587.33, now + 0.12);
      gain.gain.setValueAtTime(0.001, now);
      gain.gain.exponentialRampToValueAtTime(0.15, now + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.42);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(now);
      osc.stop(now + 0.43);
    } else if (kind === "alert") {
      // 2-tone alert chime (F5 -> A5)
      osc.frequency.setValueAtTime(698.46, now);
      osc.frequency.setValueAtTime(880.0, now + 0.08);
      gain.gain.setValueAtTime(0.001, now);
      gain.gain.exponentialRampToValueAtTime(0.12, now + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(now);
      osc.stop(now + 0.36);
    } else {
      // Gentle confirmation chime (E5 -> B5)
      osc.frequency.setValueAtTime(659.25, now);
      osc.frequency.setValueAtTime(987.77, now + 0.07);
      gain.gain.setValueAtTime(0.001, now);
      gain.gain.exponentialRampToValueAtTime(0.08, now + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.3);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(now);
      osc.stop(now + 0.31);
    }
  } catch {
    // Audio context not allowed or failed, fallback gracefully
  }
}

/** Pick the most human, natural sounding voice (prioritizing Natural Neural engines) for offline fallback */
function pickVoice(): SpeechSynthesisVoice | null {
  const vs = window.speechSynthesis?.getVoices() ?? [];
  if (!vs.length) return null;

  // 1. Indonesian Natural / Neural (Edge / Windows 11)
  const idNatural = vs.find(
    (v) => (v.name.includes("Natural") || v.name.includes("Online")) && (v.lang.startsWith("id") || v.lang.startsWith("ms")),
  );
  if (idNatural) return idNatural;

  // 2. Standard Indonesian / Malay
  const idStd = vs.find((v) => v.lang.toLowerCase().startsWith("id")) ?? vs.find((v) => v.lang.toLowerCase().startsWith("ms"));
  if (idStd) return idStd;

  // 3. High-quality English Natural if Indonesian is unavailable
  const enNatural = vs.find((v) => v.name.includes("Natural") && v.lang.startsWith("en"));
  if (enNatural) return enNatural;

  return vs[0] ?? null;
}

/** Formats coaching titles into concise, natural spoken voice callouts */
function formatCalloutText(title: string): string {
  return title
    .replace(/[:·•]/g, ", ")
    .replace(/\bvs\b/gi, "lawan")
    .replace(/±/g, "sekitar ")
    .replace(/\bdtk\b/gi, "detik")
    .replace(/\bmnt\b/gi, "menit")
    .replace(/\bmid-boss\b/gi, "mid bos")
    .replace(/\bboss\b/gi, "bos")
    .replace(/\bretreat\b/gi, "mundur")
    .replace(/\bgank\b/gi, "genk")
    .replace(/\bt1\b/gi, "tower satu")
    .replace(/\bt2\b/gi, "tower dua")
    .replace(/\bwalker\b/gi, "walker")
    .replace(/\bguardian\b/gi, "guardian")
    .replace(/\bpatron\b/gi, "patron")
    .replace(/\burn\b/gi, "ern")
    .replace(/\brejuv(?:enator)?\b/gi, "rejuve")
    .replace(/[⚠⚡🎯⚔🛡💥🔥]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const ttsAudioCache = new Map<string, string>();
let activeTtsAudio: HTMLAudioElement | null = null;

function fallbackSpeechSynthesis(text: string) {
  if (!("speechSynthesis" in window)) return;
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const v = pickVoice();
    if (v) u.voice = v;
    u.lang = v?.lang ?? "id-ID";
    u.rate = 1.05;
    u.pitch = 1.0;
    window.speechSynthesis.speak(u);
  } catch {
    // Ignore speech error
  }
}

async function playNaturalVoice(rawText: string) {
  if (!rawText) return;
  const text = formatCalloutText(rawText);
  if (!text) return;

  // 1. If the OS has an Indonesian/Malay voice, use it directly (0ms latency, offline & proxy-safe)
  const voice = pickVoice();
  if (voice && (voice.lang.toLowerCase().startsWith("id") || voice.lang.toLowerCase().startsWith("ms"))) {
    fallbackSpeechSynthesis(text);
    return;
  }

  // 2. Otherwise try Google TTS with a 1.5s timeout guard and fallback to speechSynthesis
  try {
    if (activeTtsAudio) {
      activeTtsAudio.pause();
      activeTtsAudio.currentTime = 0;
      activeTtsAudio = null;
    }

    let url = ttsAudioCache.get(text);
    if (!url) {
      const q = encodeURIComponent(text.slice(0, 200));
      url = `https://translate.google.com/translate_tts?ie=UTF-8&tl=id&client=tw-ob&q=${q}`;
      ttsAudioCache.set(text, url);
    }

    const audio = new Audio(url);
    activeTtsAudio = audio;
    audio.volume = 1.0;

    let resolved = false;
    const cleanup = () => {
      resolved = true;
      clearTimeout(timer);
      audio.removeEventListener("canplay", onCanPlay);
      audio.removeEventListener("error", onError);
    };

    const onError = () => {
      if (resolved) return;
      cleanup();
      fallbackSpeechSynthesis(text);
    };

    const onCanPlay = () => {
      if (resolved) return;
      cleanup();
      audio.play().catch(() => fallbackSpeechSynthesis(text));
    };

    // 1500ms timeout guard against rate-limiting, proxy drops, or silent HTML responses
    const timer = setTimeout(() => {
      if (resolved) return;
      cleanup();
      try {
        audio.pause();
        audio.src = "";
      } catch {}
      fallbackSpeechSynthesis(text);
    }, 1500);

    audio.addEventListener("canplay", onCanPlay, { once: true });
    audio.addEventListener("error", onError, { once: true });
    audio.load();
  } catch {
    fallbackSpeechSynthesis(text);
  }
}

function speakTop(r: LiveResp) {
  if (!S.voice || S.live?.winningTeam !== undefined) return;
  const top = r.tips[0];
  if (!top || top.priority < 70) return;
  const now = Date.now();
  if (top.title === lastSpoken.title && now - lastSpoken.at < 90_000) return;
  if (now - lastSpoken.at < 14_000) return;
  lastSpoken = { title: top.title, at: now };

  const isBoss = top.title.toLowerCase().includes("boss") || top.detail.toLowerCase().includes("boss");
  const chimeKind = isBoss ? "boss" : top.kind === "retreat" ? "retreat" : (top.priority >= 80 || top.kind === "threat" || top.kind === "objective") ? "alert" : "info";
  playTacticalChime(chimeKind);

  void playNaturalVoice(top.title);
}

// ---------- engine events ----------
function onEngine(ev: EngineEvent) {
  switch (ev.type) {
    case "game-started":
      S.game = true;
      render();
      break;
    case "game-stopped":
      Object.assign(S, { game: false, matchId: null, connected: false, live: null, liveResp: null, scout: null, scoutKey: "", leadHistory: [] });
      render();
      break;
    case "match-detected":
      Object.assign(S, { matchId: ev.match_id, matchSource: ev.source, connected: false, ended: false, live: null, liveResp: null, error: "", note: "", leadHistory: [] });
      if (S.launcherTab === "home") S.launcherTab = "live";
      if (S.pregameHero) void loadHero(S.pregameHero);
      render();
      break;
    case "status":
      S.note = ev.message;
      break;
    case "lobby-players":
      void loadScout(ev.account_ids.map((a) => ({ accountId: a })));
      break;
    case "live-connected":
      S.connected = true;
      S.note = "";
      if (S.launcherTab === "home") S.launcherTab = "live";
      break;
    case "live-state": {
      lastStateAt = Date.now();
      if (!S.lagAnchor || S.lagAnchor.matchId !== ev.matchId) S.lagAnchor = { wall: Date.now(), game: ev.gameTimeS, matchId: ev.matchId ?? null };
      const { type: _t, ...state } = ev;
      if (S.matchId == null && state.matchId != null) S.matchId = state.matchId;
      const prevItems = S.live?.players.map((p) => p.itemIds.join(".")).join("|");
      const prevDead = S.live?.players.filter((p) => p.dead).length;
      S.live = state;
      S.connected = true;
      if (S.launcherTab === "home") S.launcherTab = "live";
      const m = me();
      if (m?.heroId) void loadHero(m.heroId);
      if (state.players.length >= 2) {
        void loadScout(state.players.map((p) => ({ accountId: p.accountId, heroId: p.heroId, team: p.team })));
      }
      const changed =
        prevItems !== state.players.map((p) => p.itemIds.join(".")).join("|") || prevDead !== state.players.filter((p) => p.dead).length;
      void postLive(changed);
      break;
    }
    case "live-ended": {
      S.ended = true;
      const m = me();
      if (m && S.live && S.matchId) {
        const won = S.live.winningTeam !== undefined ? S.live.winningTeam === m.team : false;
        S.postMatchSummary = {
          matchId: S.matchId,
          won,
          durationS: S.live.gameTimeS,
          netWorth: m.netWorth,
          kda: `${m.kills}/${m.deaths}/${m.assists}`,
        };
      }
      void postLive(true).then(() => saveLog(true));
      break;
    }
    case "error":
      S.error = ev.message;
      break;
    case "diag": {
      const { type: _t, ...d } = ev;
      const changed = JSON.stringify(d) !== JSON.stringify(S.diag);
      S.diag = d;
      if (!changed) return; // every 3 s; skip re-render when nothing changed
      break;
    }
  }
  render();
}

// ---------- rendering ----------
function renderStatus() {
  const dot = $("dot");
  if (dot) dot.className = "dot" + (S.connected ? " live" : S.game ? " on" : "");
  const tickerDot = document.querySelector<HTMLElement>(".ticker-dot");
  if (tickerDot) tickerDot.className = "ticker-dot" + (S.connected ? " live" : S.game ? " on" : "");

  document.querySelectorAll<HTMLElement>("#launcherNav .nav-tab").forEach((btn) => {
    btn.classList.toggle("on", btn.dataset.launcherTab === S.launcherTab);
  });
  const livePill = document.getElementById("livePill");
  if (livePill) {
    livePill.style.display = S.connected || (S.matchId != null && S.live != null) ? "inline-block" : "none";
  }
  const pinBtn = document.getElementById("pin");
  if (pinBtn) {
    pinBtn.classList.toggle("active", S.isAlwaysOnTop);
    pinBtn.title = S.isAlwaysOnTop ? "Sematkan aktif (Always on top)" : "Sematkan di atas layar (Always on top)";
  }

  const spPill = document.getElementById("steamProfilePill");
  if (spPill) {
    if (S.steamProfile) {
      spPill.style.display = "inline-flex";
      spPill.innerHTML = `
        ${S.steamProfile.avatar_url ? `<img class="steam-avatar-thumb" src="${esc(S.steamProfile.avatar_url)}" alt="">` : ""}
        <span class="steam-profile-online" title="Steam Terdeteksi"></span>
        <span class="steam-profile-name">${esc(S.steamProfile.persona_name || `Account #${S.steamProfile.account_id}`)}</span>
      `;
    } else if (S.settings?.accountId) {
      spPill.style.display = "inline-flex";
      spPill.innerHTML = `
        <span class="steam-profile-online" title="ID Manual"></span>
        <span class="steam-profile-name">#${S.settings.accountId}</span>
      `;
    } else {
      spPill.style.display = "none";
    }
  }

  let html: string;
  if (S.connected && S.live) {
    const stale = staleSeconds();
    const modeBadge = S.liveResp?.mode
      ? ` <span class="tag ${S.liveResp.mode.isBrawl ? "hot" : S.liveResp.mode.isRanked ? "main" : "ok"}">${esc(S.liveResp.mode.label)}</span>`
      : S.live.players.length > 0 && S.live.players.length <= 8
        ? ` <span class="tag hot">Brawl 4v4</span>`
        : "";
    html = `<b>LIVE</b> #${S.matchId ?? "?"}${modeBadge} · ${formatClock(S.live.gameTimeS)} <span class="small">· di game ±${formatClock(S.live.gameTimeS + lagSeconds())} · telat ${lagSeconds()} dtk</span>${lagSeconds() >= 150 ? ` <span class="stale">⚠ broadcast tertinggal ${Math.round(lagSeconds() / 60)} mnt: tekan ✓ Sudah beli setelah belanja</span>` : ""}${
      stale >= 30 ? ` <span class="stale">⚠ data berhenti ${stale} dtk, saran bisa basi</span>` : ""
    }`;
  } else if (S.matchId) {
    html = `Match <b>#${S.matchId}</b> (${esc(S.matchSource)}) · menyambung ke broadcast…`;
  } else if (S.game) {
    html = "Deadlock jalan · siap & memantau match";
  } else {
    html = S.force ? "Mode manual · menunggu match" : "Menunggu Deadlock… <span class=\"small\">(exe belum terdeteksi · lihat Status koneksi)</span>";
  }
  const m = me();
  if (S.live?.winningTeam !== undefined && m) {
    html += S.live.winningTeam === m.team ? ` · <b class="win">MENANG</b>` : ` · <b class="loss">KALAH</b>`;
  } else if (S.ended) {
    html += ` · <b>selesai</b>`;
  }
  if (S.note && !S.connected) html += `<br><span class="small">${esc(S.note)}</span>`;
  const st = $("status");
  if (st) st.innerHTML = html;
  const vb = document.getElementById("voice");
  if (vb) vb.textContent = S.voice ? "🔊" : "🔇";
  const mode = $("mode");
  if (mode) {
    mode.textContent = S.clickThrough ? "klik-tembus" : "interaktif";
    mode.className = "mode" + (S.clickThrough ? " through" : "");
  }
}

const TIP_ICON: Record<Tip["kind"], string> = {
  push: "⚔", retreat: "⛔", objective: "◎", buy: "$", tempo: "⏱", threat: "!", momentum: "↗", farm: "⛏", death: "✝",
};

/**
 * Coach banner. Compact: the main instruction in one bold line + one short line of why,
 * the other tips as single title chips (full text on hover). The HUD widget uses `hud`
 * (even tighter, no sub-tips) so it does not cover the fight.
 */
function coachCard(r: LiveResp, hud = false) {
  if (S.live?.winningTeam !== undefined) return "";
  const staleAge = hud ? HUD.staleAgeS : (lastLiveSuccess > 0 && Date.now() - lastLiveSuccess > 15_000 ? Math.round((Date.now() - lastLiveSuccess) / 1000) : null);
  const staleTag = staleAge != null ? ` <span class="tag muted" style="font-size:9px" title="Data terakhir dari server analitik">${staleAge}s lalu</span>` : "";

  if (!r.tips.length) {
    // never an empty box: a blank HUD Coach looks like the widget vanished mid-match
    return `<section class="coach calm compact${hud ? " hud" : ""}"><div class="coach-main"><span class="coach-ico">✓</span><div class="coach-txt"><b>Farm & ikuti build${staleTag}</b></div></div></section>`;
  }
  const [main, ...rest] = r.tips;
  const sub = hud
    ? ""
    : rest.length
      ? `<div class="coach-chips">${rest.map((t) => `<span class="chip ${t.kind}" title="${esc(t.detail)}">${TIP_ICON[t.kind]} ${esc(t.title)}</span>`).join("")}</div>`
      : "";
  return `<section class="coach compact ${main.kind}${freshTop ? " fresh" : ""}${hud ? " hud" : ""}">
    <div class="coach-main"><span class="coach-ico">${TIP_ICON[main.kind]}</span><div class="coach-txt"><b>${esc(main.title)}${staleTag}</b><p title="${esc(main.detail)}">${esc(main.detail)}</p></div></div>${sub}
  </section>`;
}

function winCard(r: LiveResp) {
  const m = me()!;
  const [a, b] = m.team === 0 ? r.teamNetWorth : [r.teamNetWorth[1], r.teamNetWorth[0]];
  const share = a + b > 0 ? (a / (a + b)) * 100 : 50;
  const p = r.winProbability;
  const trend = r.trend
    ? `<span class="small ${r.trend.leadDelta >= 0 ? "win" : "loss"}">${r.trend.leadDelta >= 0 ? "▲" : "▼"} ${k(Math.abs(r.trend.leadDelta))} / ${Math.round(r.trend.seconds / 60)}m</span>`
    : "";
  const emp = r.empirical
    ? `<p class="small muted" style="margin:6px 0 0">Tim yang unggul ${k(r.empirical.leadMin)}–${Number.isFinite(r.empirical.leadMax) ? k(r.empirical.leadMax) : "+"} di menit ${Math.round(r.empirical.from / 60)}–${Math.round(r.empirical.to / 60)} menang <b class="${r.empirical.winrate >= 0.5 ? "win" : ""}">${pct(r.empirical.winrate, 0)}</b> (n=${r.empirical.n}).</p>`
    : "";
  const tp = r.teamPhases;
  const phase = tp
    ? `<div class="phase-cmp">${(["early", "mid", "late"] as const)
        .map((ph) => {
          const d = tp.mine[ph] - tp.enemy[ph];
          return `<div><span class="small muted">${ph.toUpperCase()}</span><b class="${d > 0.005 ? "win" : d < -0.005 ? "loss" : ""}">${d >= 0 ? "+" : ""}${(d * 100).toFixed(1)}</b></div>`;
        })
        .join("")}</div><p class="small muted" style="margin:4px 0 0">Kekuatan lineup per fase vs lawan (poin WR). ${
        tp.scalingDiff > 0.01 ? "Tim kamu <b>lebih kuat di late</b>." : tp.scalingDiff < -0.01 ? "Lawan <b>lebih kuat di late</b>." : "Scaling seimbang."
      }</p>`
    : "";
  return `<section class="card">
    <h3>${
      p != null
        ? `Peluang menang <span class="big ${p >= 0.5 ? "win" : "loss"}">${pct(p, 0)}</span> <small>${winBand(p)}${(() => {
            const d = winTrend();
            return d == null || Math.abs(d) < 0.03 ? " · stabil" : ` · ${d > 0 ? "▲ naik" : "▼ turun"} ${Math.round(Math.abs(d) * 100)} poin/2m`;
          })()}</small>`
        : "Ekonomi"
    } ${trend}</h3>
    <div class="nw"><div class="a" style="width:${share}%"></div><div class="b" style="width:${100 - share}%"></div></div>
    <div class="row small muted" style="justify-content:space-between"><span>Tim kamu ${k(a)}</span><span class="${r.netWorthLead >= 0 ? "win" : "loss"}">${r.netWorthLead >= 0 ? "+" : "−"}${k(Math.abs(r.netWorthLead))}</span><span>Lawan ${k(b)}</span></div>
    ${(() => {
      const p = computeSoulsPacing(m.netWorth, r.gameTimeS);
      if (!p) return "";
      return `<div class="row small" style="margin-top:6px;padding:4px 8px;border-radius:6px;background:rgba(229,179,88,0.08);border:1px solid rgba(229,179,88,0.2);justify-content:space-between">
        <span>⚡ <b>Pacing Souls (${formatClock(r.gameTimeS)}):</b> kamu <b>${k(p.current)}</b></span>
        <span class="${p.isAhead ? "win" : "loss"}" style="font-weight:700">${p.label}</span>
      </div>`;
    })()}
    ${emp}
    ${
      r.draftOdds
        ? `<div class="draft-odds-box" style="margin-top:6px;padding:6px 8px;border-radius:6px;background:rgb(255 255 255 / .04);border:1px solid rgb(255 255 255 / .08)">
            <div class="row small" style="justify-content:space-between">
              <span>⚖️ <b>Prediksi Draft Lineup:</b> <span class="${r.draftOdds.winProbability >= 0.5 ? "win" : "loss"}"><b>${pct(r.draftOdds.winProbability, 0)}</b></span></span>
              <span class="muted">Peak: <b>${PHASE_NAME[r.draftOdds.peakPhase]}</b></span>
            </div>
            <div class="row small muted" style="gap:8px;margin-top:3px;font-size:11px">
              <span>Base Hero: <b class="${r.draftOdds.components.heroBaseDelta >= 0 ? "win" : "loss"}">${delta(r.draftOdds.components.heroBaseDelta)}%</b></span>
              <span>Matchup: <b class="${r.draftOdds.components.matchupDelta >= 0 ? "win" : "loss"}">${delta(r.draftOdds.components.matchupDelta)}%</b></span>
              <span>Sinergi: <b class="${r.draftOdds.components.synergyDelta >= 0 ? "win" : "loss"}">${delta(r.draftOdds.components.synergyDelta)}%</b></span>
            </div>
            ${
              r.draftOdds.advantages[0]
                ? `<div class="small win" style="margin-top:3px;font-size:11px">🛡️ Edge: <b>${esc(S.heroes.get(r.draftOdds.advantages[0].ourHeroId)?.name ?? `#${r.draftOdds.advantages[0].ourHeroId}`)}</b> vs <b>${esc(S.heroes.get(r.draftOdds.advantages[0].enemyHeroId)?.name ?? `#${r.draftOdds.advantages[0].enemyHeroId}`)}</b> (+${(r.draftOdds.advantages[0].delta * 100).toFixed(1)}%)</div>`
                : ""
            }
            ${
              r.draftOdds.threats[0]
                ? `<div class="small loss" style="margin-top:2px;font-size:11px">⚠️ Awas: <b>${esc(S.heroes.get(r.draftOdds.threats[0].enemyHeroId)?.name ?? `#${r.draftOdds.threats[0].enemyHeroId}`)}</b> vs <b>${esc(S.heroes.get(r.draftOdds.threats[0].ourHeroId)?.name ?? `#${r.draftOdds.threats[0].ourHeroId}`)}</b> (${(r.draftOdds.threats[0].delta * 100).toFixed(1)}%)</div>`
                : ""
            }
          </div>`
        : ""
    }
    ${p == null ? `<p class="small muted" style="margin:6px 0 0">Model peluang menang sedang dihitung dari match terbaru…</p>` : `<p class="small muted" style="margin:4px 0 0">Rata-rata ±2,5 menit terakhir (tidak loncat tiap pick-off) · dari ${r.winModel?.matches ?? "?"} match nyata 3 hari terakhir.</p>`}
    ${phase}
  </section>`;
}

function buildPathCard(r: LiveResp) {
  const m = me()!;
  const steps = r.buildPath;
  const ad = r.adaptive;
  const head =
    ad?.source === "core+flex"
      ? `<small>${PHASE_NAME[ad.phase]} · flex ${ad.flexUsed}/${ad.flexMax} · ${k(HUD_SOULS ?? soulsNow(m))} souls</small>`
      : r.build
        ? `<small>${esc(r.build.name)} · ${pct(r.build.winrate)} <button class="copy" data-copy="${r.build.id}">ID ${r.build.id}</button></small>`
        : `<small>${k(HUD_SOULS ?? soulsNow(m))} souls di tangan</small>`;
  const sell = r.sell
    ? `<div class="small" style="margin-bottom:6px;padding:5px 7px;border-radius:6px;background:rgb(226 103 92 / .12)">💱 <b>Jual ${esc(r.sell.sellName)}</b> (+${k(r.sell.refund)}) → <b>${esc(r.sell.forName)}</b><div class="muted">${esc(r.sell.reason)}</div></div>`
    : "";
  const sw = r.switched ? `<div class="small" style="margin-bottom:6px">↺ <b>Target diganti:</b> <span class="muted">${esc(r.switched)}</span></div>` : "";
  return `<section class="card">
    <h3>Beli berikutnya ${head}</h3>${sell}${sw}${
      S.pending.length
        ? `<div class="small muted" style="margin-bottom:6px">✓ Ditandai sudah beli: ${S.pending.map((p) => `${esc(p.name)} <button class="copy" data-unbought="${p.itemId}">batal</button>`).join(", ")} <span>(sampai broadcast menyusul)</span></div>`
        : ""
    }
    ${
      steps.length
        ? steps
            .map(
              (s0, i) => {
                const s = s0 as PathStep;
                return `<div class="step ${s.affordable ? "ok" : ""}">
          <span class="num-badge">${i + 1}</span>
          <div class="grow2"><div class="row"><span class="name ${s.slot ? SLOT_CLS[s.slot as keyof typeof SLOT_CLS] ?? "" : ""}">${esc(s.name)}</span>
            <span class="small">${k(s.cost)}</span>
            ${s.kind === "flex" ? `<span class="tag flex">FLEX</span>` : ""}
            ${r.sell && r.sell.forId === s.itemId ? `<span class="tag loss">JUAL DULU</span>` : s.affordable ? `<span class="tag ok">BISA BELI</span>` : `<span class="small muted">kurang ${k(s.missing)}</span>`}
            <button class="copy" data-bought="${s.itemId}" title="Tandai sudah dibeli (broadcast telat ±${lagSeconds()} dtk)">✓ Sudah beli</button></div>
          ${s.locked && S.commit ? `<div class="small" style="color:var(--brass)">🔒 target sejak ${formatClock(S.commit.sinceS)}: tidak diganti sampai terbeli</div>` : ""}
          ${s.upgradeFrom && s.fullCost ? `<div class="small win">⬆ bayar ${k(s.cost)} saja (harga ${k(s.fullCost)}, komponen dipotong)</div>` : ""}
          <div class="small muted">${esc(s.reason)}</div>${imbueLines(r.imbue?.find((x) => x.itemId === s.itemId), i === 0 ? 3 : 1)}${i === 0 || s.kind === "flex" ? playLines(r.playbook?.next.find((p) => p.itemId === s.itemId), 2) : ""}</div>
        </div>`;
              },
            )
            .join("")
        : `<div class="empty">Build selesai — lihat tab Item untuk counter tambahan.</div>`
    }
  </section>`;
}

const STAGE = ["Guardian", "Walker", "Base", "Inti"];
const ROLE_LABEL: Record<string, string> = { buka: "BUKA", item: "ITEM", shred: "SHRED", damage: "DMG", tutup: "TUTUP", kabur: "KABUR" };
function comboCard(r: LiveResp) {
  const c = r.combo;
  if (!c || !c.steps.length) return "";
  return `<section class="card"><h3>Combo kamu <small>dari angka ability & item</small></h3>
    ${c.steps
      .map((st, i) => `<div class="row small" style="align-items:flex-start;margin-top:3px"><span class="num-badge" style="background:var(--brass)">${i + 1}</span><span class="tag ${st.role === "kabur" ? "muted" : st.role === "tutup" ? "loss" : "hot"}">${ROLE_LABEL[st.role]}</span><div class="grow2"><b>${esc(st.name)}</b> <span class="muted">${esc(st.note)}</span></div></div>`)
      .join("")}
    ${c.notes.map((n) => `<div class="small muted" style="margin-top:4px">${esc(n)}</div>`).join("")}
  </section>`;
}

function abilityCard(r: LiveResp) {
  const a = r.abilityOrder;
  if (!a || (!a.max.length && !a.sequence.length)) return "";
  return `<section class="card"><h3>Urutan ability <small>${a.maxWinrate != null ? `WR ${pct(a.maxWinrate)}` : ""}</small></h3>
    ${a.max.length ? `<div class="small"><b>Max dulu:</b> ${a.max.map((x) => `${esc(x.name)} <span class="muted">(${x.slot})</span>`).join(" → ")}</div>` : ""}
    ${a.sequence.length ? `<div class="small muted" style="margin-top:3px">Urutan poin: ${a.sequence.join("-")}${a.ultAt ? ` · ult pertama di poin ke-${a.ultAt}` : ""}</div>` : ""}
  </section>`;
}

// ---------- pre-game: tilt check + your best heroes ----------
export interface SummaryMatch {
  match_id: number;
  hero_id: number;
  start_time: number;
  match_duration_s: number;
  player_team: number;
  match_result: number;
  player_kills: number;
  player_deaths: number;
  player_assists: number;
  net_worth: number;
  last_hits: number;
  denies: number;
}

interface Summary {
  tilt: { warning: string | null; last10: { wins: number; games: number }; streak: number; streakKind: string | null };
  best: { heroId: number; name?: string; matches: number; winrate: number; edge: number }[];
  /** cross-match habits from the overlay logs on this PC (pre-game only) */
  habits?: { matches: number; hudLines: string[]; notes: string[] } | null;
  matches?: SummaryMatch[];
}
let summary: Summary | null = null;
let summaryAt = 0;

function formatTimeAgo(timestampS: number): string {
  const diffSec = Math.max(0, Math.floor(Date.now() / 1000 - timestampS));
  if (diffSec < 60) return "Baru saja";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} mnt lalu`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} jam lalu`;
  return `${Math.floor(diffSec / 86400)} hari lalu`;
}

async function loadSummary() {
  const acc = S.steamProfile?.account_id ?? S.settings?.accountId;
  if (!acc || Date.now() - summaryAt < 30_000) return;
  summaryAt = Date.now();
  try {
    summary = await api<Summary>(`/api/me/summary?account=${acc}`);
    render();
  } catch {
    // optional
  }
}
function summaryCard() {
  void loadSummary();
  if (!summary || (!summary.best.length && !summary.habits?.hudLines.length)) return "";
  const hb = summary.habits;
  const habitsBlock = hb?.hudLines.length
    ? `<div class="small" style="margin-bottom:6px">${hb.hudLines.map((l) => `<div>${esc(l)}</div>`).join("")}${hb.notes
        .map((n) => `<div class="muted" style="margin-top:2px">${esc(n)}</div>`)
        .join("")}</div>`
    : "";
  return `<section class="card"><h3>Kebiasaan & hero terbaikmu <small>${hb ? `${hb.matches} match log` : ""}</small></h3>${habitsBlock}
    ${
      summary.best.length
        ? `<div class="small muted">Hero terbaikmu:</div>${summary.best
            .slice(0, 4)
            .map((h) => `<div class="row small">${heroIcon(h.heroId, "ico sm")}<span class="name">${esc(h.name ?? "")}</span><span class="${wrCls(h.winrate)}">${pct(h.winrate, 0)}</span><span class="muted">${h.matches}g</span><span class="win">${delta(h.edge)}</span></div>`)
            .join("")}`
        : ""
    }
  </section>`;
}

function profileCard() {
  const acc = S.live?.myAccountId ?? S.settings?.accountId;
  if (!acc) return "";
  const base = (S.settings?.siteBase ?? "http://localhost:3000").replace(/\/$/, "");
  const profile = `${base}/me?account=${acc}`;
  const review = S.live?.matchId ? `${base}/me/match/${S.live.matchId}?account=${acc}` : null;
  const over = S.live?.winningTeam !== undefined || S.ended;
  return `<section class="card"><h3>Profil & review <small>buka di browser</small></h3>
    <div class="row small"><span class="name">Profil (hero terbaikmu, kalibrasi)</span><button class="copy" data-copy="${esc(profile)}">copy link</button></div>
    ${review ? `<div class="row small"><span class="name">${over ? "Review match ini (data muncul beberapa menit setelah selesai)" : "Review match ini (setelah selesai)"}</span><button class="copy" data-copy="${esc(review)}">copy link</button></div>` : ""}
  </section>`;
}

const PH_LABEL: Record<string, string> = { early: "early (0–10)", mid: "mid (10–20)", late: "late (20+)" };
/**
 * Game plan card: stable strategy from lineup strength per phase, pinned to the in-game
 * clock. (The real-time farm / group / push-now calls were removed: the broadcast delay
 * made them arrive too late.) Lane objective status is slow data and stays.
 */
function planCard(r: LiveResp) {
  const g = r.gamePlan;
  const m = r.macro;
  if (!g && !m) return "";
  const lanes = m?.lanes.length
    ? `<div class="lanes">${m!.lanes
        .map(
          (l) => `<div class="lane ${l.status === "kita tekan" ? "up" : l.status === "kita ditekan" ? "down" : ""} ${m!.lane?.color === l.color ? "focus" : ""}">
        <b>${esc(l.name)}</b>
        <span class="small">kita: ${l.ourStage === 0 ? "utuh" : `${STAGE[l.ourStage - 1]} hancur`}</span>
        <span class="small">lawan: ${l.enemyStage === 0 ? "utuh" : `${STAGE[l.enemyStage - 1]} hancur`}</span>
        <span class="small muted">${l.enemyLaners.map((e) => `${esc(S.heroes.get(e.heroId)?.name ?? "#" + e.heroId)}${e.dead ? " ✝" : ""}`).join(", ")}</span>
      </div>`,
        )
        .join("")}</div>`
    : "";
  return `<section class="card"><h3>Game plan <small>${g ? (g.flat ? "lineup seimbang di semua fase" : `window kamu: ${PH_LABEL[g.ourWindow]}${g.theirWindow !== g.ourWindow ? ` · lawan: ${PH_LABEL[g.theirWindow]}` : ""}`) : ""}</small></h3>
    ${g ? `<b>${esc(g.title)}</b><p class="small" style="margin:3px 0 0">${esc(g.detail)}</p>` : ""}
    ${spikeLine(r)}
    ${r.partner ? `<p class="small" style="margin:4px 0 0">🤝 Main bareng <b>${esc(r.partner.name)}</b> <span class="win">${delta(r.partner.delta)}%</span> <span class="muted">${esc(r.partner.why)}</span></p>` : ""}
    ${lanes}
  </section>`;
}

function spikeLine(r: LiveResp) {
  const s = r.spikes;
  if (!s || (!s.myItems.length && !s.enemyItems.length)) return "";
  const total = s.mine + s.enemy || 1;
  const until = s.untilClock ? `sampai ${s.untilClock}` : `±${Math.round(s.windowLeft)} dtk`;
  const label = s.verdict === "fight" ? `<b class="win">Tim kamu lebih kuat ${until}</b>` : s.verdict === "avoid" ? `<b class="loss">Lawan lebih kuat ${until}</b>` : `<span class="muted">Power spike seimbang</span>`;
  return `<div style="margin-top:6px"><div class="row small" style="justify-content:space-between"><span>⚡ ${label}</span><span class="muted">item besar 3 menit terakhir</span></div>
    <div class="nw"><div class="a" style="width:${(s.mine / total) * 100}%"></div><div class="b" style="width:${(s.enemy / total) * 100}%"></div></div></div>`;
}

function playLines(p: ItemPlay | undefined, max = 3) {
  // plain stat items have nothing to explain
  if (!p || (!p.active && !p.target && !p.combo.length)) return "";
  return `<div class="play">
    ${p.target ? `<div class="small">🎯 <b>${esc(p.target.name)}</b> <span class="muted">${esc(p.target.why)}</span></div>` : ""}
    ${p.when && p.when !== "Pasif, tidak perlu diaktifkan." ? `<div class="small muted">${esc(p.when)}</div>` : ""}
    ${p.combo.slice(0, max).map((c) => `<div class="small">↳ ${esc(c)}</div>`).join("")}
  </div>`;
}

/** "Imbue → ability" with the stat + data argument (first `max` reasons). */
function imbueLines(a: ImbueAdvice | undefined, max = 3) {
  if (!a) return "";
  const src = a.source === "data+stat" ? (a.agree === false ? "data ≠ stat" : "stat + data") : "dari stat";
  return `<div class="play imbue">
    <div class="small">✨ <b>Imbue → ${esc(a.target.name)}</b> <span class="tag ${a.agree === false ? "muted" : "ok"}">${src}</span> <span class="muted">pilih saat beli</span></div>
    ${a.reasons.slice(0, max).map((x) => `<div class="small muted">↳ ${esc(x)}</div>`).join("")}
    ${max >= 3 && a.alternatives.length ? `<div class="small muted">Alternatif: ${a.alternatives.map((x) => `${esc(x.name)}${x.share != null ? ` (${pct(x.share, 0)})` : ""}`).join(", ")}</div>` : ""}
  </div>`;
}

function ownedPlaysCard(r: LiveResp) {
  const ps = r.playbook?.owned ?? [];
  if (!ps.length) return "";
  return `<section class="card"><h3>Cara pakai item kamu</h3>${ps
    .map((p) => `<div class="step"><div class="grow2"><b>${esc(p.name)}</b>${p.cooldownS ? ` <span class="small muted">CD ${Math.round(p.cooldownS)}s</span>` : ""}${imbueLines(r.imbue?.find((x) => x.itemId === p.itemId), 3)}${playLines(p)}</div></div>`)
    .join("")}</section>`;
}

function deathsCard(r: LiveResp) {
  const d = r.deaths;
  if (!d || !d.reviews.length) return `<section class="card"><h3>Kenapa mati</h3><div class="empty">Belum mati di match ini. Setiap kematian akan dianalisa di sini.</div></section>`;
  const pat = d.patterns.text.length
    ? `<section class="card"><h3>Pola kematian <small>${d.patterns.deaths}× mati</small></h3>${d.patterns.text.map((t) => `<div class="small">• ${esc(t)}</div>`).join("")}</section>`
    : "";
  return (
    pat +
    d.reviews
      .map(
        (rv, i) => `<section class="card death">
      <h3>${esc(rv.headline)} <small>${i === 0 ? "terbaru" : ""}</small></h3>
      ${rv.killer ? `<div class="small muted">Dibunuh ${esc(rv.killer)}</div>` : ""}
      ${
        rv.sources.length
          ? `<div class="dmg-rows">${rv.sources
              .map(
                (s) => `<div class="row small"><span class="name">${esc(s.heroName)} · ${esc(s.name)}${s.killingBlow ? " ✝" : ""}</span><span class="muted">${s.critPct >= 0.2 ? `${Math.round(s.critPct * 100)}% HS · ` : ""}</span><b>${Math.round(s.pct * 100)}%</b></div>
                 <div class="dbar"><div style="width:${Math.round(s.pct * 100)}%" class="${s.kind === "peluru" ? "b-w" : s.kind === "tower/creep" ? "b-t" : "b-s"}"></div></div>`,
              )
              .join("")}</div>`
          : `<div class="small muted">Rincian damage tidak dikirim broadcast untuk kematian ini (hanya killfeed).</div>`
      }
      ${rv.cc.length ? `<div class="small" style="margin-top:4px">CC: ${rv.cc.map((c) => `${esc(c.name)} (${esc(c.type)} ${c.seconds.toFixed(1)}s, ${esc(c.by)})`).join(", ")}</div>` : ""}
      ${rv.causes
        .slice(0, 3)
        .map((c, j) => `<div class="cause ${j === 0 ? "main" : ""}"><b>${esc(c.title)}</b><div class="small muted">${esc(c.detail)}</div></div>`)
        .join("")}
      <div class="fixes"><div class="small"><b>Lain kali:</b></div>${rv.fixes.map((f) => `<div class="small">→ ${esc(f)}</div>`).join("")}</div>
    </section>`,
      )
      .join("")
  );
}

function readCard(r: LiveResp) {
  const d = r.damage;
  const needs = (r.needs ?? []).filter((n) => n.urgency >= 0.35);
  if (!d && !needs.length) return "";
  const bar = d
    ? `<div class="row small" style="justify-content:space-between"><span class="w">Peluru ${pct(d.bullet, 0)}</span><span class="s">Spirit ${pct(d.spirit, 0)}</span></div>
       <div class="nw"><div class="dmg-b" style="width:${d.bullet * 100}%"></div><div class="dmg-s" style="width:${d.spirit * 100}%"></div></div>`
    : "";
  return `<section class="card"><h3>Baca lawan <small>damage yang kamu terima & yang perlu dijawab</small></h3>
    ${bar}
    ${needs
      .map(
        (n) => `<div class="row" style="margin-top:6px"><span class="tag ${n.satisfied ? "ok" : n.urgency >= 0.6 ? "loss" : "hot"}">${n.satisfied ? "✓" : n.urgency >= 0.6 ? "PENTING" : "SARAN"}</span>
        <div class="grow2"><b>${esc(NEED_NAME[n.kind] ?? n.kind)}</b> <span class="small muted">${esc(n.reason)}</span></div></div>`,
      )
      .join("")}
  </section>`;
}

const VERDICT: Record<EnemyMatchup["verdict"], { label: string; cls: string }> = {
  duel: { label: "DUEL", cls: "win" },
  avoid: { label: "HINDARI 1v1", cls: "loss" },
  even: { label: "SEIMBANG", cls: "" },
  dead: { label: "MATI", cls: "muted" },
  focus: { label: "BURST TIM", cls: "hot" },
};

function enemiesCard(r: LiveResp) {
  const scoutBy = new Map((S.scout?.players ?? []).map((p) => [p.accountId, p.scout]));
  return `<section class="card"><h3>Lawan <small>urut dari ancaman terbesar</small></h3>
    ${r.matchups
      .map((mu) => {
        const sc = scoutBy.get(mu.accountId);
        const v = VERDICT[mu.verdict];
        return `<div class="enemy ${mu.verdict}${mu.isTargetPriority ? " focus" : ""}">
        <div class="row">${heroIcon(mu.heroId)}
          <div class="grow2"><div class="row"><b class="name">${esc(mu.heroName)}</b>${mu.isTargetPriority ? `<span class="tag hot">TARGET UTAMA</span>` : ""}${mu.laneOpponent ? `<span class="tag hot">LANE</span>` : ""}${(mu.archetypes ?? []).map((a) => `<span class="tag">${ARCH_NAME[a] ?? a}</span>`).join("")}<span class="tag ${v.cls}">${v.label}${mu.verdict === "dead" && mu.respawnInS ? ` ${Math.round(mu.respawnInS)}s` : ""}</span></div>
          <div class="small muted">${esc(sc?.name ?? "")} · ${mu.kda} · ${k(mu.netWorth)} <span class="${mu.nwDiff > 0 ? "loss" : "win"}">(${mu.nwDiff >= 0 ? "+" : "−"}${k(Math.abs(mu.nwDiff))})</span>${
            mu.matchupDelta != null ? ` · matchup <span class="${mu.matchupDelta >= 0 ? "win" : "loss"}">${delta(mu.matchupDelta)}%</span>` : ""
          }</div></div>
        </div>
        <div class="small" style="margin-top:4px">${esc(mu.advice)}</div>
        ${mu.recentItems.length ? `<div class="small muted">Item terbaru: ${mu.recentItems.map(esc).join(", ")}${mu.bulletShare != null ? ` · damage ${pct(mu.bulletShare, 0)} peluru` : ""}</div>` : ""}
        ${(mu.notable ?? []).map((n) => `<div class="small">⚠ <b>${esc(n.name)}</b> <span class="muted">${esc(n.note)}</span></div>`).join("")}
        ${mu.bestCounter ? `<div class="small">Counter: <b>${esc(mu.bestCounter.name)}</b> <span class="win">+${(mu.bestCounter.delta * 100).toFixed(1)}%</span></div>` : ""}
        ${
          sc
            ? `<div class="small muted">Pemain: WR ${pct(sc.overallWinrate, 0)} · 20 terakhir ${pct(sc.recent.winrate, 0)}${sc.currentHero ? ` · ${sc.currentHero.matches} game di hero ini` : ""}${sc.flags.length ? ` · ${sc.flags.map((f) => f.toUpperCase()).join(", ")}` : ""}</div>`
            : ""
        }
      </div>`;
      })
      .join("")}
  </section>`;
}

function itemsCard(r: LiveResp) {
  const buys = r.nextBuys[S.slotTab] ?? [];
  return `<section class="card">
    <h3>Counter item <small>dibobot net worth musuh</small></h3>
    <div class="tabs small-tabs">${(["all", "weapon", "vitality", "spirit"] as const)
      .map((t) => `<button data-slot="${t}" class="${S.slotTab === t ? "on" : ""}">${t === "all" ? "Semua" : t}</button>`)
      .join("")}</div>
    ${
      buys.length
        ? buys
            .map(
              (x) => `<div class="row">
          <span class="small ${SLOT_CLS[x.slot]}">T${x.tier}</span>
          <div class="grow2"><span class="name ${x.affordable ? "" : "muted"}">${esc(x.name)}</span>${x.reason ? `<div class="small muted">${esc(x.reason)}</div>` : ""}</div>
          <span class="small win">${delta(x.score)}</span>
          <button class="copy" data-copy="${esc(x.name)}">copy</button></div>`,
            )
            .join("")
        : `<div class="empty">Tidak ada counter yang menonjol untuk tier ini.</div>`
    }
  </section>`;
}

function heroCard() {
  const h = S.heroInfo;
  if (!h) return `<div class="empty">Pilih hero di bawah untuk melihat build.</div>`;
  return renderHeroDossierBody(h);
}

const DEADLOCK_APP = 1422450;
/** Checklist & hub before the match: clean and friendly dashboard */
function connectionCard() {
  const d = S.diag;
  const isReady = !!(d?.game || S.game);
  const isLive = !!(d?.live_connected || S.connected);
  const siteBase = (S.settings?.siteBase ?? "http://localhost:3000").replace(/\/$/, "");

  // Hero status banner
  const banner = `
    <div class="home-banner ${isLive ? "live" : isReady ? "ready" : ""}">
      <div class="banner-badge">${isLive ? "🔴" : isReady ? "🟢" : "⏳"}</div>
      <div class="banner-content">
        <div class="banner-title">${isLive ? "Match Live Terhubung" : isReady ? "Deadlock Siap & Terhubung" : "Menunggu Game Deadlock"}</div>
        <div class="banner-desc">${isLive ? `Live #${S.matchId ?? "?"} · Asisten & HUD aktif real-time` : isReady ? "Proses game terdeteksi. Asisten akan aktif otomatis saat match dimulai." : "Buka Deadlock di Steam (Borderless Windowed + launch option <code>-condebug</code>)."}</div>
      </div>
    </div>
  `;

  // Status pills
  const pills = `
    <div class="home-stat-grid">
      <div class="stat-pill">
        <span class="stat-pill-label">STATUS GAME</span>
        <span class="stat-pill-val ${isReady ? "win" : "muted"}">${isReady ? "✓ Terhubung" : "Belum Jalan"}</span>
      </div>
      <div class="stat-pill">
        <span class="stat-pill-label">AKUN STEAM</span>
        <span class="stat-pill-val">${d && d.account_id > 0 ? "#" + d.account_id : "Auto"}</span>
      </div>
      <div class="stat-pill">
        <span class="stat-pill-label">SERVER LOCAL</span>
        <span class="stat-pill-val ${S.heroes.size > 0 ? "win" : "muted"}">${S.heroes.size > 0 ? "✓ Siap" : webNote ? esc(webNote) : "Menyala…"}</span>
      </div>
    </div>
  `;

  // Quick Match launcher
  const launcher = `
    <div class="match-launcher">
      <div class="match-input-wrap">
        <span class="match-input-icon">🎮</span>
        <input id="matchInput" placeholder="Ketik Match ID untuk live manual…" inputmode="numeric" value="${esc(S.matchDraft)}">
      </div>
      <button class="btn" id="matchGo">Mulai Live</button>
      ${S.matchId ? `<button class="btn" id="matchStop" style="background:#443f33">Stop</button>` : ""}
    </div>
  `;

  // Quick Action cards
  const quickActions = `
    <div class="quick-actions-grid">
      <button class="quick-action-card" id="hudEdit">
        <span class="quick-action-ico">🎯</span>
        <div class="quick-action-text">
          <strong>Atur Posisi HUD</strong>
          <span>Geser widget di layar</span>
        </div>
      </button>
      <button class="quick-action-card" data-copy="${esc(siteBase)}">
        <span class="quick-action-ico">📊</span>
        <div class="quick-action-text">
          <strong>Tier List & Meta</strong>
          <span>Buka link web meta</span>
        </div>
      </button>
      <button class="quick-action-card" data-copy="${esc(siteBase + "/counter")}">
        <span class="quick-action-ico">🛡️</span>
        <div class="quick-action-text">
          <strong>Counter Builder</strong>
          <span>Analisis lawan & item</span>
        </div>
      </button>
      <button class="quick-action-card" data-copy="${esc(siteBase + "/draft")}">
        <span class="quick-action-ico">⚖️</span>
        <div class="quick-action-text">
          <strong>Draft Analyzer</strong>
          <span>Prediksi komposisi tim</span>
        </div>
      </button>
    </div>
  `;

  // Advanced diagnostics inside collapsible accordion
  const ok = (b: boolean | null, label: string, detail: string) =>
    `<div class="row small" style="gap:6px;align-items:flex-start"><span style="width:16px;color:${b == null ? "var(--muted)" : b ? "#7bd88f" : "#ff6b6b"}">${b == null ? "…" : b ? "✓" : "✗"}</span><span><b>${label}</b> <span class="muted">${detail}</span></span></div>`;

  const age = d?.log_age_s;
  const ageTxt = age == null ? "" : age < 60 ? `ditulis ${age} dtk lalu` : `terakhir ditulis ${Math.round(age / 60)} mnt lalu`;
  const gameDetail = d?.game
    ? `terhubung (lewat ${esc(d.found_by ?? "?")})`
    : `belum · ${d?.procs_seen ?? 0} proses terbaca${(d?.procs_seen ?? 0) === 0 ? " (app tidak bisa membaca daftar proses)" : ""}, Steam: ${d?.steam_app ? (d.steam_app === DEADLOCK_APP ? "Deadlock jalan" : `app ${d.steam_app}`) : "tidak ada game"}`;

  const rows = d
    ? [
        ok(d.game, "Deadlock", gameDetail),
        ok(d.log_exists, "console.log", d.log_exists ? `ada · ${ageTxt}` : `tidak ada${d.log_path ? ` di ${esc(d.log_path)}` : ""} → tambahkan -condebug di Launch Options`),
        ok(d.account_id > 0, "Akun Steam", d.account_id > 0 ? `#${d.account_id}` : "tidak ketemu (isi account_id di config)"),
        ok(S.heroes.size > 0, "Server data", S.heroes.size > 0 ? "siap" : webNote ? esc(webNote) : "menyala…"),
        ok(d.match_id != null ? (d.live_connected || S.connected) : null, "Match", d.match_id != null ? `#${d.match_id} · ${d.live_connected || S.connected ? "live tersambung" : "menunggu broadcast"}` : "belum ada (otomatis saat match mulai)"),
      ]
    : [ok(null, "Engine", "Menunggu status engine…")];

  const diag = `
    <details class="diag-details">
      <summary><span>⚙ Detail Diagnostik & Pengaturan Lanjut</span><span style="font-size:10px">▼</span></summary>
      <div class="diag-content">
        ${rows.join("")}
        <label class="row small" style="gap:6px;cursor:pointer;margin-top:6px">
          <input type="checkbox" id="forceGame" ${S.force ? "checked" : ""}>
          <span><b>Mode manual: anggap Deadlock jalan</b> <span class="muted">(pakai jika game sudah terbuka tapi belum terdeteksi)</span></span>
        </label>
        <div style="margin-top:8px;padding-top:6px;border-top:1px solid var(--line)">
          <div class="small" style="font-weight:bold;margin-bottom:4px;color:var(--brass)">Tampilkan Widget HUD di Layar:</div>
          <div class="row small" style="flex-wrap:wrap;gap:10px">
            <label style="cursor:pointer;display:flex;align-items:center;gap:4px">
              <input type="checkbox" data-widget-toggle="coach" ${S.layout?.widgets?.coach?.enabled ?? true ? "checked" : ""}> Coach (Tengah Atas)
            </label>
            <label style="cursor:pointer;display:flex;align-items:center;gap:4px">
              <input type="checkbox" data-widget-toggle="win" ${S.layout?.widgets?.win?.enabled ?? true ? "checked" : ""}> Situasi / Win% (Kiri Atas)
            </label>
            <label style="cursor:pointer;display:flex;align-items:center;gap:4px">
              <input type="checkbox" data-widget-toggle="enemies" ${S.layout?.widgets?.enemies?.enabled ?? true ? "checked" : ""}> Lawan (Kiri Tengah)
            </label>
            <label style="cursor:pointer;display:flex;align-items:center;gap:4px">
              <input type="checkbox" data-widget-toggle="buy" ${S.layout?.widgets?.buy?.enabled ?? true ? "checked" : ""}> Next Buy (Kanan)
            </label>
          </div>
        </div>
      </div>
    </details>
  `;

  return `<section class="card" style="padding:10px">${banner}${pills}${launcher}${quickActions}${diag}</section>`;
}

function heroPickCard() {
  const heroes = [...S.heroes.values()].sort((a, b) => a.name.localeCompare(b.name));
  const selected = S.heroes.get(S.pregameHero ?? 0);
  return `<section class="card">
    <h3>Pilih hero sebelum main <small>klik avatar atau pilih dropdown</small></h3>
    <div class="hero-avatar-strip" id="heroAvatarStrip">
      ${heroes
        .map(
          (h) => `
        <button class="hero-avatar-btn ${h.heroId === S.pregameHero ? "selected" : ""}" data-hero-pick="${h.heroId}" title="${esc(h.name)} · WR ${pct(h.winrate, 0)} (Tier ${h.tier})">
          ${heroIcon(h.heroId, "ico")}
          <span class="hero-avatar-label">${esc(h.name)}</span>
        </button>`,
        )
        .join("")}
    </div>
    <div class="row" style="margin-top:8px">
      ${selected ? heroIcon(selected.heroId, "ico") : `<span class="ico" style="display:grid;place-items:center;color:var(--muted)">🎮</span>`}
      <select id="heroSel" style="flex:1"><option value="">Pilih / cari hero dari daftar…</option>
        ${heroes.map((h) => `<option value="${h.heroId}" ${h.heroId === S.pregameHero ? "selected" : ""}>${esc(h.name)} (WR ${pct(h.winrate, 0)} · Tier ${h.tier})</option>`).join("")}</select>
    </div>
    <div class="row small muted" style="margin-top:8px;gap:6px;align-items:center;flex-wrap:wrap">
      <span>💡 <b>Rekomendasi Draft Meta (Tier S):</b></span>
      ${heroes
        .filter((h) => h.tier === "S")
        .slice(0, 4)
        .map(
          (h) => `
        <button class="copy ${h.heroId === S.pregameHero ? "ok" : ""}" data-hero-pick="${h.heroId}" style="padding:3px 8px;display:inline-flex;align-items:center;gap:4px">
          ${heroIcon(h.heroId, "ico sm")} <span>${esc(h.name)}</span> <span class="win" style="font-weight:700">${pct(h.winrate, 0)}</span>
        </button>`,
        )
        .join("")}
    </div>
  </section>`;
}

function scoutLobbyCard() {
  const players = S.scout?.players.filter((p) => p.scout) ?? [];
  if (!players.length) return "";
  return `<section class="card"><h3>Scout lobby</h3>${players
    .map(({ scout: s, heroId }) => {
      const p = s!;
      return `<div class="row">${heroId ? heroIcon(heroId) : `<span class="ico"></span>`}<span class="name">${esc(p.name ?? "#" + p.accountId)}</span>
        ${p.flags.map((f) => `<span class="tag ${esc(f)}">${esc(f.toUpperCase())}</span>`).join("")}
        <span class="small ${wrCls(p.overallWinrate)}">${pct(p.overallWinrate, 0)}</span><span class="small ${wrCls(p.recent.winrate)}">${pct(p.recent.winrate, 0)}</span></div>`;
    })
    .join("")}</section>`;
}

// ---------- HUD widget broadcast ----------
interface HudExtra {
  focus: boolean;
  toast: string;
  pending: string[];
  lag: number;
  winTrend: number | null;
  souls: number | null;
  team: boolean;
  /** 1–2 pre-game habit lines (HUD Situasi before the match starts) */
  habits: string[];
  /** stale data age in seconds if live response is old, e.g. server blip */
  staleAgeS?: number | null;
}
interface OverlayData {
  hud: HudExtra;
  r: LiveResp | null;
  live: LiveState | null;
  connected: boolean;
  matchId: number | null;
  heroes: [number, MetaHero][];
  scout: ScoutResp | null;
  pregameHero?: number | null;
  heroInfo?: HeroInfo | null;
}
/** why the bundled site is not reachable (from the Rust side), shown in Status koneksi */
let webNote = "";
/** form controls that must not be re-rendered while they have focus */
const GUARDED = new Set(["matchInput", "heroSel", "rosterSearchInput", "omniSearchInput"]);
let lastBroadcast = "";
function broadcast(force = false) {
  const now = Date.now();
  const staleLiveS = lastLiveSuccess > 0 && now - lastLiveSuccess > 15_000 ? Math.round((now - lastLiveSuccess) / 1000) : null;
  const hud: HudExtra = { focus: S.focus, toast: S.toast, pending: S.pending.map((p) => p.name), lag: S.live ? lagSeconds() : BASE_DELAY, winTrend: winTrend(), team: Date.now() < S.teamUntil, habits: summary?.habits?.hudLines ?? [], souls: (() => {
    const m = me();
    return m ? soulsNow(m) : null;
  })(), staleAgeS: staleLiveS };
  const data: OverlayData = {
    hud,
    r: S.liveResp,
    live: S.live,
    connected: S.connected,
    matchId: S.matchId,
    heroes: [...S.heroes],
    scout: S.scout,
    pregameHero: S.pregameHero,
    heroInfo: S.heroInfo,
  };
  const key = JSON.stringify([data.r, data.matchId, data.live?.gameTimeS, data.connected, data.heroes.length, S.scoutKey, hud, S.pregameHero, S.heroInfo?.hero.id]);
  if (!force && key === lastBroadcast) return;
  lastBroadcast = key;
  void emit("overlay-data", data);
}

function renderHeroDossierBody(h: HeroInfo) {
  const ph = h.phases;
  const phaseHtml = ph
    ? `<div class="phases">${(["early", "mid", "late"] as const)
        .map((p) => `<div class="${ph.peak === p ? "peak" : ""}"><span class="small muted">${p.toUpperCase()}</span><b class="${wrCls(ph.phases[p].winrate)}">${pct(ph.phases[p].winrate)}</b></div>`)
        .join("")}</div>
       <p class="small muted" style="margin:6px 0 0">${
         ph.scaling > 0.02 ? "📈 Scaling kuat: peluang menang meningkat di late game." : ph.scaling < -0.02 ? "⚡ Early pressure: kuat di awal, tekan objektif sebelum ±28 menit." : "⚖ Stabil seimbang di semua fase durasi match."
       }</p>`
    : "";
  const builds = h.builds.length
    ? `<div class="row small muted" style="justify-content:space-between;margin-bottom:6px;padding:0 4px;font-size:11px">
        <span style="flex:1">NAMA BUILD</span>
        <span style="width:70px;text-align:right">WIN RATE</span>
        <span style="width:65px;text-align:right">SAMPEL</span>
        <span style="width:75px;text-align:right">KODE BUILD</span>
      </div>` +
      h.builds
        .map(
          (b) => `<div class="row" style="align-items:center;padding:4px 0">
            <span class="name" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(b.name)}">${esc(b.name)}</span>
            <span class="small ${wrCls(b.winrate)}" style="width:70px;text-align:right;font-weight:bold" title="Win Rate build">${pct(b.winrate)}</span>
            <span class="small muted" style="width:65px;text-align:right" title="Jumlah match yang memakai build ini">${b.matches.toLocaleString()} match</span>
            <span style="width:75px;text-align:right"><button class="copy" data-copy="${b.id}" title="Klik untuk copy ID build ke game Deadlock">ID ${b.id}</button></span>
          </div>`,
        )
        .join("")
    : `<div class="empty">Belum ada build dengan sampel cukup.</div>`;

  let itemsTierHtml = "";
  if (h.itemsByTier && Object.keys(h.itemsByTier).length) {
    itemsTierHtml = `<section class="card">
      <h3>Item Unggulan Per Tier <small>Berdasarkan Winrate Delta</small></h3>
      ${Object.entries(h.itemsByTier)
        .map(([tierNum, items]) => `
          <div style="margin-top:6px">
            <span class="small muted" style="font-weight:700">TIER ${tierNum}</span>
            <div class="items-tier-grid">
              ${items
                .slice(0, 4)
                .map((it) => `
                <div class="item-badge-pill" title="${esc(it.name)} · Winrate ${pct(it.winrate, 1)} (${delta(it.delta)})">
                  <span class="ico sm ${SLOT_CLS[it.slot] ?? ""}" style="background:currentColor;opacity:.2"></span>
                  <span class="item-name ${SLOT_CLS[it.slot] ?? ""}">${esc(it.name)}</span>
                  <span class="small ${it.delta >= 0 ? "win" : "loss"}" style="font-size:10px">${delta(it.delta)}</span>
                </div>
              `)
                .join("")}
            </div>
          </div>
        `)
        .join("")}
    </section>`;
  }

  return `<section class="card"><h3>Kurva Scaling Match <small>Winrate per fase</small></h3>${phaseHtml}</section>
  <section class="card"><h3>Build Komunitas <small>Pilih & Copy ID ke Deadlock</small></h3>${builds}</section>
  ${itemsTierHtml}`;
}

function renderRosterView() {
  const heroesList = [...S.heroes.values()].sort((a, b) => b.winrate - a.winrate);
  if (!S.selectedRosterHero && heroesList.length) {
    S.selectedRosterHero = S.pregameHero ?? heroesList[0].heroId;
    void loadHero(S.selectedRosterHero);
  }
  const q = S.rosterSearch.toLowerCase().trim();
  const filtered = heroesList.filter((h) => {
    if (q && !h.name.toLowerCase().includes(q)) return false;
    if (S.rosterRoleFilter === "s" && h.tier !== "S") return false;
    if (S.rosterRoleFilter === "a" && h.tier !== "A" && h.tier !== "S") return false;
    return true;
  });
  const selHero = S.heroes.get(S.selectedRosterHero ?? 0);
  const hInfo = S.heroInfo && S.heroInfo.hero.id === S.selectedRosterHero ? S.heroInfo : null;

  return `<div class="roster-view">
    <div class="roster-toolbar">
      <div class="roster-search">
        <span class="muted">🔍</span>
        <input id="rosterSearchInput" placeholder="Cari nama hero..." value="${esc(S.rosterSearch)}">
      </div>
      <div class="role-filters">
        <button class="role-filter-btn ${S.rosterRoleFilter === "all" ? "on" : ""}" data-roster-filter="all">SEMUA (${heroesList.length})</button>
        <button class="role-filter-btn ${S.rosterRoleFilter === "s" ? "on" : ""}" data-roster-filter="s">TIER S</button>
        <button class="role-filter-btn ${S.rosterRoleFilter === "a" ? "on" : ""}" data-roster-filter="a">TIER S & A</button>
      </div>
    </div>
    <div class="roster-split">
      <div class="hero-roster-grid">
        ${filtered
          .map((h) => {
            const isSel = h.heroId === S.selectedRosterHero;
            const tierCls = `tier-badge-${h.tier.toLowerCase()}`;
            return `<div class="agent-card ${isSel ? "selected" : ""}" data-select-roster="${h.heroId}">
              <span class="agent-tier-badge ${tierCls}">${esc(h.tier)}</span>
              ${heroIcon(h.heroId, "ico")}
              <div class="agent-name">${esc(h.name)}</div>
              <div class="agent-stats">
                <b class="${wrCls(h.winrate)}">${pct(h.winrate, 1)}</b>
              </div>
            </div>`;
          })
          .join("")}
      </div>
      <div class="hero-dossier-panel">
        ${
          selHero
            ? `
          <div class="hero-dossier-header">
            ${heroIcon(selHero.heroId, "ico")}
            <div class="hero-dossier-info">
              <div class="row" style="align-items:center;gap:8px">
                <h2>${esc(selHero.name)}</h2>
                <span class="agent-tier-badge tier-badge-${selHero.tier.toLowerCase()}" style="position:static;font-size:11px;padding:2px 6px">${esc(selHero.tier)}-TIER</span>
              </div>
              <div class="hero-dossier-meta">
                <span>Winrate Meta: <b class="${wrCls(selHero.winrate)}">${pct(selHero.winrate, 1)}</b></span>
              </div>
              <button class="hero-pregame-btn ${S.pregameHero === selHero.heroId ? "active" : ""}" data-hero-pick="${selHero.heroId}">
                ${S.pregameHero === selHero.heroId ? "✓ Hero Pre-Game Terpilih" : "🎯 Kunci Sebagai Hero Pre-Game"}
              </button>
            </div>
          </div>
          ${hInfo ? renderHeroDossierBody(hInfo) : `<div class="card"><div class="empty">Memuat detail & build hero…</div></div>`}
        `
            : `<div class="card"><div class="empty">Pilih hero dari daftar di sebelah kiri</div></div>`
        }
      </div>
    </div>
  </div>`;
}

function renderMetaView() {
  const heroesList = [...S.heroes.values()];
  const tiers = [
    { tier: "S", title: "S-TIER &bull; Overperforming Meta", cls: "tier-badge-s", filter: (h: MetaHero) => h.tier === "S" },
    { tier: "A", title: "A-TIER &bull; Pilihan Solid & Konsisten", cls: "tier-badge-a", filter: (h: MetaHero) => h.tier === "A" },
    { tier: "B", title: "B-TIER &bull; Seimbang / Situasional", cls: "tier-badge-b", filter: (h: MetaHero) => h.tier === "B" },
    { tier: "C", title: "C-TIER &bull; Butuh Eksekusi Spesifik", cls: "tier-badge-c", filter: (h: MetaHero) => h.tier === "C" },
    { tier: "D", title: "D-TIER &bull; Underperforming", cls: "tier-badge-d", filter: (h: MetaHero) => h.tier === "D" },
  ];
  return `<div class="meta-tier-list">
    <div class="card" style="padding:10px 14px">
      <h3 style="margin:0">Tier List Meta Deadlock <small>Diperbarui dari deadlock-api & agregat match publik</small></h3>
      <p class="muted small" style="margin:4px 0 0">Klik kartu hero untuk langsung melihat analisis build, fase scaling, dan item kunci di Hero Roster.</p>
    </div>
    ${tiers
      .map(({ tier, title, cls, filter }) => {
        const group = heroesList.filter(filter).sort((a, b) => b.winrate - a.winrate);
        if (!group.length) return "";
        return `<div class="meta-tier-group">
          <div class="meta-tier-head">
            <div class="row" style="align-items:center;gap:8px">
              <span class="meta-tier-tag ${cls}">${tier}</span>
              <span style="font-weight:700;font-size:13px">${title}</span>
            </div>
            <span class="small muted">${group.length} Hero</span>
          </div>
          <div class="meta-tier-strip">
            ${group
              .map(
                (h) => `
              <div class="meta-hero-pill" data-select-roster="${h.heroId}" title="Klik untuk inspect ${esc(h.name)}">
                ${heroIcon(h.heroId, "ico sm")}
                <span class="name">${esc(h.name)}</span>
                <span class="small ${wrCls(h.winrate)}" style="font-weight:700">${pct(h.winrate, 1)}</span>
              </div>
            `,
              )
              .join("")}
          </div>
        </div>`;
      })
      .join("")}
  </div>`;
}

function renderLastMatchCard(pm: { matchId: number; won: boolean; durationS: number; netWorth: number; kda: string }) {
  return `<section class="card" style="border:1px solid ${pm.won ? "var(--win)" : "var(--loss)"};background:rgba(${pm.won ? "74,222,128" : "248,113,113"},0.08)">
    <h3>Ringkasan Match Terakhir <small>Match #${pm.matchId}</small></h3>
    <div class="row" style="justify-content:space-between;margin-top:4px">
      <span style="font-size:16px;font-weight:bold;color:${pm.won ? "var(--win)" : "var(--loss)"}">${pm.won ? "VICTORY (MENANG) 🎉" : "DEFEAT (KALAH)"}</span>
      <span class="small muted">Durasi: ${formatClock(pm.durationS)}</span>
    </div>
    <div class="row small" style="margin-top:6px;gap:12px">
      <span>Souls Akhir: <b>${k(pm.netWorth)}</b></span>
      <span>K/D/A: <b>${esc(pm.kda)}</b></span>
    </div>
  </section>`;
}

function renderProfileBanner() {
  const acc = S.steamProfile?.account_id ?? S.settings?.accountId;
  const persona = S.steamProfile?.persona_name || (acc ? `Player #${acc}` : "Pemain Deadlock");
  const avatar = S.steamProfile?.avatar_url;
  return `
    <div class="player-banner">
      <div style="display:flex;align-items:center;gap:16px">
        ${avatar ? `<img class="player-banner-avatar" src="${esc(avatar)}" alt="">` : `<div class="player-banner-avatar" style="display:flex;align-items:center;justify-content:center;background:rgba(229,179,88,0.15);font-size:24px">👤</div>`}
        <div class="player-banner-info">
          <div style="display:flex;align-items:center;gap:8px">
            <span class="player-banner-name">${esc(persona)}</span>
            ${S.steamProfile ? `<span class="tag ok" style="font-size:10px">✓ Steam Terdeteksi</span>` : ""}
          </div>
          <span class="player-banner-id">${acc ? `Steam Account ID: <b>${acc}</b>` : "ID Steam belum terpasang (atur di tab Pengaturan)"}</span>
        </div>
      </div>
      <div style="display:flex;gap:8px">
        <button class="copy" data-launcher-tab="settings">⚙ Pengaturan</button>
      </div>
    </div>
  `;
}

function renderMatchHistoryCard() {
  void loadSummary();
  if (!summary?.matches?.length) return "";
  return `<section class="card">
    <div class="row" style="justify-content:space-between;margin-bottom:8px">
      <h3>Riwayat Match Terakhir <small>${summary.matches.length} match publik terakhir</small></h3>
      <span class="small muted">Data via Valve & Deadlock API</span>
    </div>
    <div style="display:flex;flex-direction:column;gap:8px">
      ${summary.matches.map((m) => {
        const isWin = m.match_result === m.player_team;
        const hero = S.heroes.get(m.hero_id);
        const heroName = hero?.name ?? `Hero #${m.hero_id}`;
        const timeAgo = formatTimeAgo(m.start_time);
        return `
          <div class="match-card ${isWin ? "win" : "loss"}">
            <div class="match-card-main">
              ${heroIcon(m.hero_id, "ico")}
              <div>
                <div style="display:flex;align-items:center;gap:8px">
                  <span style="font-weight:700;font-size:14px;color:var(--fg)">${esc(heroName)}</span>
                  <span class="match-badge-outcome ${isWin ? "win" : "loss"}">${isWin ? "VICTORY" : "DEFEAT"}</span>
                </div>
                <div class="small muted">Match #${m.match_id} &bull; ${formatClock(m.match_duration_s)}</div>
              </div>
            </div>
            <div class="match-card-stats">
              <div style="text-align:center">
                <div class="match-kda">${m.player_kills} / <span style="color:var(--loss)">${m.player_deaths}</span> / ${m.player_assists}</div>
                <div class="small muted" style="font-size:10px">K / D / A</div>
              </div>
              <div style="text-align:right">
                <div style="font-weight:700;font-size:13px;color:var(--brass)">${k(m.net_worth)}</div>
                <div class="small muted" style="font-size:10px">${m.last_hits} CS &bull; ${m.denies} deny</div>
              </div>
              <div class="match-card-meta">
                <span class="small" style="font-size:11px">${timeAgo}</span>
              </div>
            </div>
          </div>
        `;
      }).join("")}
    </div>
  </section>`;
}

function renderProfileView() {
  return `<div class="home-dashboard">
    ${renderProfileBanner()}
    ${S.postMatchSummary ? renderLastMatchCard(S.postMatchSummary) : ""}
    ${renderMatchHistoryCard()}
    ${summaryCard()}
    ${profileCard()}
  </div>`;
}

function renderSettingsView() {
  return `<div class="home-dashboard">
    <section class="card">
      <h3>Pengaturan In-Game HUD Widget <small>Widget transparan di monitor game</small></h3>
      <div class="small muted" style="margin-bottom:8px">Aktifkan atau sembunyikan 4 widget HUD yang melayang di atas layar game Deadlock:</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <label class="row small"><input type="checkbox" data-widget-toggle="coach" ${S.layout?.widgets?.coach?.enabled ?? true ? "checked" : ""}> <b>Coach Taktis</b> (Tengah Atas)</label>
        <label class="row small"><input type="checkbox" data-widget-toggle="win" ${S.layout?.widgets?.win?.enabled ?? true ? "checked" : ""}> <b>Situasi / Win%</b> (Kiri Atas)</label>
        <label class="row small"><input type="checkbox" data-widget-toggle="enemies" ${S.layout?.widgets?.enemies?.enabled ?? true ? "checked" : ""}> <b>Target Lawan</b> (Kiri Tengah)</label>
        <label class="row small"><input type="checkbox" data-widget-toggle="buy" ${S.layout?.widgets?.buy?.enabled ?? true ? "checked" : ""}> <b>Saran Beli Item</b> (Kanan)</label>
      </div>
      <div class="row" style="margin-top:12px;gap:8px">
        <button class="btn" id="hudEdit">📐 Atur Posisi HUD (Ctrl+Shift+E)</button>
        <button class="copy" id="hudReset">Reset ke Posisi Standar</button>
      </div>
    </section>
    <section class="card">
      <h3>Suara & Audio Coach <small>Natural Voice & tactical cues</small></h3>
      <div class="row" style="align-items:center;gap:12px;margin-bottom:8px">
        <button class="copy ${S.voice ? "ok" : ""}" id="voiceToggle">Suara Coach: ${S.voice ? "🔊 AKTIF" : "🔇 MATI"}</button>
        <span class="small muted">Callout audio bahasa Indonesia natural saat Mid-Boss spawn, gank, dan instruksi push/retreat.</span>
      </div>
      <div class="row" style="gap:6px;align-items:center;flex-wrap:wrap">
        <span class="small muted">Uji Coba Nada Chime:</span>
        <button class="copy" data-test-chime="info">Tes Normal</button>
        <button class="copy" data-test-chime="alert">Tes Alert</button>
        <button class="copy" data-test-chime="boss">Tes Mid-Boss</button>
        <button class="copy" data-test-chime="retreat">Tes Retreat</button>
      </div>
      <div class="row" style="gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px">
        <span class="small muted">Uji Coba Suara Coach:</span>
        <button class="btn" id="testVoiceBtn">🗣 Tes Suara Coach Natural</button>
      </div>
    </section>
    ${connectionCard()}
  </div>`;
}

function renderLiveStandby() {
  const heroPick = S.pregameHero ? S.heroes.get(S.pregameHero) : null;
  return `<div class="war-room-view">
    <section class="card" style="text-align:center;padding:24px 16px;background:linear-gradient(180deg, rgba(20,24,36,0.95) 0%, rgba(13,15,21,0.95) 100%)">
      <div style="font-size:36px;margin-bottom:8px">⚔️</div>
      <h2 style="margin:0;font:800 22px 'Barlow Condensed', sans-serif;letter-spacing:.05em;color:var(--brass)">RUANG TAKTIS LIVE COACH</h2>
      <p class="muted" style="max-width:540px;margin:8px auto 14px">
        ${S.matchId ? `Match <b>#${S.matchId}</b> terdeteksi (${esc(S.matchSource)}) &bull; Menghubungkan ke broadcast spectate Valve…` : S.game ? "Deadlock sedang berjalan. Masuk ke match untuk mengaktifkan analisis live war-room otomatis." : "Deadlock belum terdeteksi. Buka game Deadlock atau gunakan tombol di bawah."}
      </p>
      <div class="row" style="justify-content:center;gap:10px">
        <button class="btn" data-launcher-tab="roster">Jelajahi Hero Roster & Build ↗</button>
        <button class="copy" id="hudEdit">📐 Atur Posisi Widget HUD</button>
      </div>
    </section>
    ${S.scout?.players.length ? scoutLobbyCard() : ""}
    ${heroPick ? `<section class="card"><h3>Hero Pilihan Pre-Game: ${heroIcon(heroPick.heroId, "ico sm")} ${esc(heroPick.name)}</h3>${heroCard()}</section>` : heroPickCard()}
    <details class="diag-details">
      <summary><span style="font-size:11px">Ganti / Sambung Match ID Manual</span><span style="font-size:9px">▼</span></summary>
      <div class="diag-content" style="padding-top:6px">
        <div class="row" style="gap:6px">
          <input id="matchInput" class="small" placeholder="Masukkan Match ID angka" inputmode="numeric" style="flex:1" value="${esc(S.matchDraft)}">
          <button class="copy" id="matchGo">Terapkan Match ID</button>
        </div>
      </div>
    </details>
  </div>`;
}

function renderLiveWarRoomView(r: LiveResp | null) {
  if (!r || !me()) {
    return renderLiveStandby();
  }
  return `<div class="war-room-view">
    <div class="war-room-top">
      ${coachCard(r)}
    </div>
    <div class="war-room-grid">
      <!-- Col 1: Macro & Win% -->
      <div class="war-col">
        ${winCard(r)}
        ${planCard(r)}
        ${abilityCard(r)}
        ${comboCard(r)}
      </div>
      <!-- Col 2: Threat Matrix & 6v6 Intel -->
      <div class="war-col">
        ${enemiesCard(r)}
        ${teamHtml(false)}
        ${deathsCard(r)}
      </div>
      <!-- Col 3: Adaptive Build Path & Shop -->
      <div class="war-col">
        ${buildPathCard(r)}
        ${itemsCard(r)}
        ${ownedPlaysCard(r)}
        ${readCard(r)}
      </div>
    </div>
    <div class="card" style="margin-top:4px">
      <div class="row" style="gap:8px;align-items:center;flex-wrap:wrap">
        <button class="copy" id="hudEdit">📐 Atur Posisi HUD (Ctrl+Shift+E)</button>
        <button class="copy" id="hudReset">Reset Posisi HUD</button>
        <span style="flex:1"></span>
        <button class="copy" id="matchStop" style="color:var(--loss)">Stop Match</button>
      </div>
      <details class="diag-details" style="margin-top:6px">
        <summary><span style="font-size:11px">Ganti Match ID Manual (Hanya jika perlu)</span><span style="font-size:9px">▼</span></summary>
        <div class="diag-content" style="padding-top:4px">
          <div class="row" style="gap:6px">
            <input id="matchInput" class="small" placeholder="Masukkan Match ID" inputmode="numeric" style="flex:1" value="${esc(S.matchDraft)}">
            <button class="copy" id="matchGo">Terapkan Match ID</button>
          </div>
        </div>
      </details>
    </div>
  </div>`;
}

function renderHomeView() {
  const preHero = S.pregameHero ? S.heroes.get(S.pregameHero) : [...S.heroes.values()][0];
  return `<div class="home-dashboard">
    <div class="home-spotlight">
      <div class="home-spotlight-hero">
        ${preHero ? heroIcon(preHero.heroId, "ico") : `<span class="ico">🎮</span>`}
        <div>
          <div class="row" style="align-items:center;gap:6px">
            <span class="tag ${preHero ? `tier-badge-${preHero.tier.toLowerCase()}` : ""}">HERO PILIHAN PRE-GAME</span>
            <span class="small muted">${S.game ? "🎮 Deadlock Aktif" : "Menunggu Game"}</span>
          </div>
          <h2>${esc(preHero?.name ?? "Pilih Hero")}</h2>
          <div class="small muted">
            Winrate Meta: <b class="${wrCls(preHero?.winrate ?? 0.5)}">${pct(preHero?.winrate ?? 0.5, 1)}</b> &bull; Tier ${esc(preHero?.tier ?? "-")}
          </div>
        </div>
      </div>
      <div class="row" style="gap:8px">
        <button class="btn" data-launcher-tab="roster">Ganti Hero / Lihat Build ↗</button>
        ${S.connected || (S.matchId && S.live) ? `<button class="btn" data-launcher-tab="live" style="background:var(--riot-red);color:#fff">Masuk Live Coach ⚔</button>` : ""}
      </div>
    </div>
    <div class="home-grid">
      <div>
        ${S.postMatchSummary ? renderLastMatchCard(S.postMatchSummary) : ""}
        ${summaryCard()}
      </div>
      <div>
        ${S.scout?.players.length ? scoutLobbyCard() : ""}
        <section class="card">
          <h3>Pintasan Keyboard Dalam Game <small>Akses instan saat main</small></h3>
          <div style="display:flex;flex-direction:column;gap:6px;margin-top:6px">
            <div class="row small"><kbd>Ctrl+Shift+D</kbd> <span class="name">Buka / Tutup Launcher</span></div>
            <div class="row small"><kbd>Ctrl+Shift+E</kbd> <span class="name">Mode Geser Posisi HUD Transparan</span></div>
            <div class="row small"><kbd>Ctrl+Shift+B</kbd> <span class="name">Tandai Item #1 Sudah Dibeli</span></div>
            <div class="row small"><kbd>Ctrl+Shift+H</kbd> <span class="name">Mode Fokus HUD (Hanya Coach + Beli)</span></div>
            <div class="row small"><kbd>Ctrl+Shift+T</kbd> <span class="name">Intip Roster Tim Lawan (10 detik)</span></div>
            <div class="row small"><kbd>Ctrl+Shift+F</kbd> <span class="name">Mode Klik-Tembus Interaktif</span></div>
          </div>
        </section>
        ${connectionCard()}
      </div>
    </div>
  </div>`;
}

function handleOmniSearch(query: string) {
  S.omniSearchQuery = query.trim();
  const dropdown = document.getElementById("omniDropdown");
  if (!dropdown) return;

  if (!S.omniSearchQuery) {
    dropdown.style.display = "none";
    dropdown.innerHTML = "";
    return;
  }

  const q = S.omniSearchQuery.toLowerCase();
  const isNumeric = /^\d+$/.test(q);

  // Match heroes
  const matchedHeroes = [...S.heroes.values()]
    .filter((h) => h.name.toLowerCase().includes(q))
    .slice(0, 6);

  let itemsHtml = "";

  if (matchedHeroes.length > 0) {
    itemsHtml += `<div class="omni-group-label" style="padding:4px 8px;font-size:10px;text-transform:uppercase;color:var(--fg-muted);font-weight:700">Hero (${matchedHeroes.length})</div>`;
    for (const h of matchedHeroes) {
      itemsHtml += `
        <div class="omni-item" data-omni-hero="${h.heroId}">
          ${heroIcon(h.heroId, "ico")}
          <div class="omni-item-info">
            <span class="omni-item-title">${esc(h.name)}</span>
            <span class="omni-item-sub">Tier ${h.tier} &bull; Winrate ${pct(h.winrate, 1)}</span>
          </div>
          <span class="small muted" style="font-size:10px">Pilih Hero ↵</span>
        </div>
      `;
    }
  }

  // If numeric or scout syntax
  if (isNumeric || q.startsWith("scout:") || q.startsWith("@")) {
    const targetId = isNumeric ? q : q.replace(/^(scout:|@)/, "").trim();
    if (targetId && /^\d+$/.test(targetId)) {
      itemsHtml += `<div class="omni-group-label" style="padding:4px 8px;font-size:10px;text-transform:uppercase;color:var(--fg-muted);font-weight:700">Player Scout</div>`;
      itemsHtml += `
        <div class="omni-item" data-omni-player="${esc(targetId)}">
          <span class="ico" style="display:flex;align-items:center;justify-content:center;background:var(--brass);color:#10141d;font-weight:800;border-radius:4px">🔍</span>
          <div class="omni-item-info">
            <span class="omni-item-title">Scout Akun Steam #${esc(targetId)}</span>
            <span class="omni-item-sub">Lihat hero pool, riwayat winrate, dan tilt check</span>
          </div>
          <span class="small muted" style="font-size:10px">Scout ↵</span>
        </div>
      `;
    }
  }

  if (!itemsHtml) {
    dropdown.innerHTML = `<div style="padding:10px;text-align:center;font-size:11px;color:var(--fg-muted)">Tidak ada hero atau player cocok dengan "${esc(query)}"</div>`;
  } else {
    dropdown.innerHTML = itemsHtml;
  }
  dropdown.style.display = "block";
}

function closeOmniSearch() {
  const dropdown = document.getElementById("omniDropdown");
  if (dropdown) dropdown.style.display = "none";
}

function render() {
  if (WIDGET) return renderWidget();
  broadcast();
  renderStatus();
  const r = S.liveResp;
  let viewContent = "";
  if (S.launcherTab === "home") {
    viewContent = renderHomeView();
  } else if (S.launcherTab === "live") {
    viewContent = renderLiveWarRoomView(r);
  } else if (S.launcherTab === "roster") {
    viewContent = renderRosterView();
  } else if (S.launcherTab === "meta") {
    viewContent = renderMetaView();
  } else if (S.launcherTab === "profile") {
    viewContent = renderProfileView();
  } else if (S.launcherTab === "settings") {
    viewContent = renderSettingsView();
  }

  // don't wipe form controls while focused
  if (GUARDED.has((document.activeElement as HTMLElement | null)?.id ?? "")) {
    pendingRender = true;
    return;
  }
  const viewEl = $("view");
  const prevViewScroll = viewEl.scrollTop;
  const errBanner = S.error ? `<div class="err" style="margin-bottom:8px" title="${esc(S.error)}">${esc(S.error.length > 240 ? S.error.slice(0, 240) + "…" : S.error)}</div>` : "";

  viewEl.innerHTML = fatalHtml() + updateCard() + errBanner + viewContent;

  if (prevViewScroll > 0) {
    viewEl.scrollTop = prevViewScroll;
  }
}

// ---------- UI events (delegated) ----------
document.addEventListener("click", async (e) => {
  const t = e.target as HTMLElement;

  const omniHero = t.closest<HTMLElement>("[data-omni-hero]");
  if (omniHero) {
    const id = Number(omniHero.dataset.omniHero);
    if (id) {
      S.selectedRosterHero = id;
      void loadHero(id);
      S.launcherTab = "roster";
      closeOmniSearch();
      const input = document.getElementById("omniSearchInput") as HTMLInputElement | null;
      if (input) input.value = "";
      render();
    }
    return;
  }
  const omniPlayer = t.closest<HTMLElement>("[data-omni-player]");
  if (omniPlayer) {
    const accountId = Number(omniPlayer.dataset.omniPlayer);
    if (accountId) {
      closeOmniSearch();
      const input = document.getElementById("omniSearchInput") as HTMLInputElement | null;
      if (input) input.value = "";
      const base = (S.settings?.siteBase ?? "http://localhost:3000").replace(/\/$/, "");
      window.open(`${base}/me?account=${accountId}`, "_blank");
    }
    return;
  }
  const spPill = t.closest<HTMLElement>("#steamProfilePill");
  if (spPill) {
    S.launcherTab = "profile";
    render();
    return;
  }
  if (!t.closest(".omnisearch-wrap")) {
    closeOmniSearch();
  }

  const launcherTab = t.closest<HTMLElement>("[data-launcher-tab]");
  if (launcherTab) {
    S.launcherTab = launcherTab.dataset.launcherTab as LauncherTab;
    render();
    return;
  }
  const selectRoster = t.closest<HTMLElement>("[data-select-roster]");
  if (selectRoster) {
    const id = Number(selectRoster.dataset.selectRoster);
    if (id) {
      S.selectedRosterHero = id;
      void loadHero(id);
      S.launcherTab = "roster";
      render();
    }
    return;
  }
  const rosterFilter = t.closest<HTMLElement>("[data-roster-filter]");
  if (rosterFilter) {
    S.rosterRoleFilter = rosterFilter.dataset.rosterFilter as typeof S.rosterRoleFilter;
    render();
    return;
  }
  const testChime = t.closest<HTMLElement>("[data-test-chime]");
  if (testChime) {
    playTacticalChime(testChime.dataset.testChime as "alert" | "info" | "boss" | "retreat");
    return;
  }
  if (t.id === "voiceToggle") {
    S.voice = !S.voice;
    try {
      localStorage.setItem("dlm_voice", S.voice ? "on" : "off");
    } catch {}
    if (S.voice) void playNaturalVoice("Suara coach aktif");
    render();
    return;
  }
  if (t.id === "testVoiceBtn") {
    void playNaturalVoice("Perhatian tim, bersiap kontes Mid-Boss di pit sekarang. Hati-hati gank dari lane samping.");
    return;
  }
  if (t.id === "pin") {
    S.isAlwaysOnTop = !S.isAlwaysOnTop;
    try {
      localStorage.setItem("dlm_pin", S.isAlwaysOnTop ? "1" : "0");
    } catch {}
    void getCurrentWindow().setAlwaysOnTop(S.isAlwaysOnTop);
    renderStatus();
    return;
  }
  if (t.id === "max") {
    void getCurrentWindow().toggleMaximize();
    return;
  }
  const copy = t.closest<HTMLElement>("[data-copy]");
  if (copy) {
    await writeText(copy.dataset.copy!);
    copy.classList.add("ok");
    const prev = copy.textContent;
    copy.textContent = "✓";
    setTimeout(() => {
      copy.classList.remove("ok");
      copy.textContent = prev;
    }, 1200);
    return;
  }
  const heroPick = t.closest<HTMLElement>("[data-hero-pick]");
  if (heroPick) {
    const id = Number(heroPick.dataset.heroPick);
    if (id) {
      S.pregameHero = id;
      try {
        localStorage.setItem("dlm_pregame_hero", String(id));
      } catch {}
      void loadHero(id);
      render();
    }
    return;
  }
  const tab = t.closest<HTMLElement>("[data-tab]");
  if (tab) {
    S.tab = tab.dataset.tab as Tab;
    render();
    return;
  }
  const slot = t.closest<HTMLElement>("[data-slot]");
  if (slot) {
    S.slotTab = slot.dataset.slot as typeof S.slotTab;
    render();
    return;
  }
  const bought = t.closest<HTMLElement>("[data-bought]");
  if (bought && S.live) {
    markBought(Number(bought.dataset.bought));
    return;
  }
  const unb = t.closest<HTMLElement>("[data-unbought]");
  if (unb) {
    S.pending = S.pending.filter((p) => p.itemId !== Number(unb.dataset.unbought));
    void postLive(true);
    return;
  }
  if (t.id === "doUpdate") {
    void installUpdate();
    return;
  }
  if (t.id === "matchStop") {
    await invoke("stop_live");
    Object.assign(S, { matchId: null, connected: false, live: null, liveResp: null, note: "" });
    render();
    return;
  }
  if (t.id === "matchGo") {
    const v = Number((document.getElementById("matchInput") as HTMLInputElement).value.trim());
    if (Number.isInteger(v) && v > 0) await invoke("set_match", { matchId: v });
    return;
  }
  if (t.id === "zoom") return cyclePref("dlm_zoom", ZOOMS);
  if (t.id === "alpha") return cyclePref("dlm_alpha_v2", ALPHAS);
  if (t.id === "voice") {
    S.voice = !S.voice;
    try {
      localStorage.setItem("dlm_voice", S.voice ? "on" : "off");
    } catch {}
    if (S.voice) void playNaturalVoice("Suara coach aktif");
    renderStatus();
    return;
  }
  if (t.id === "min") await getCurrentWindow().minimize();
  if (t.id === "hide") await getCurrentWindow().hide();
  if (t.id === "hudEdit") await invoke("toggle_edit_mode");
  if (t.id === "hudReset") await invoke("reset_layout");
});

let pendingRender = false;
document.addEventListener("focusout", (e) => {
  if (GUARDED.has((e.target as HTMLElement).id) && pendingRender) {
    pendingRender = false;
    setTimeout(render, 0);
  }
});
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) {
    e.preventDefault();
    const omniInput = document.getElementById("omniSearchInput") as HTMLInputElement | null;
    if (omniInput) {
      omniInput.focus();
      omniInput.select();
      if (omniInput.value) handleOmniSearch(omniInput.value);
    }
    return;
  }
  if (e.key === "Escape") {
    closeOmniSearch();
    const omniInput = document.getElementById("omniSearchInput") as HTMLInputElement | null;
    if (omniInput && document.activeElement === omniInput) omniInput.blur();
  }
  if (e.ctrlKey && e.shiftKey && (e.key === "D" || e.key === "d")) {
    e.preventDefault();
    void getCurrentWindow().hide();
    return;
  }
  if ((e.target as HTMLElement).id === "matchInput" && e.key === "Enter") document.getElementById("matchGo")?.click();
});

document.addEventListener("input", (e) => {
  const t = e.target as HTMLInputElement;
  if (t.id === "omniSearchInput") {
    handleOmniSearch(t.value);
    return;
  }
  if (t.id === "matchInput") S.matchDraft = t.value;
  if (t.id === "rosterSearchInput") {
    S.rosterSearch = t.value;
    render();
  }
});

document.addEventListener("change", (e) => {
  const t = e.target as HTMLSelectElement;
  if (t.id === "forceGame") {
    S.force = (t as unknown as HTMLInputElement).checked;
    try {
      localStorage.setItem("dlm_force", S.force ? "on" : "off");
    } catch {}
    void invoke("force_game", { on: S.force });
    render();
    return;
  }
  if (t.id === "heroSel" && t.value) {
    S.pregameHero = Number(t.value);
    try {
      localStorage.setItem("dlm_pregame_hero", String(S.pregameHero));
    } catch {}
    t.blur(); // lets the deferred render (and the hero's build) through
    void loadHero(S.pregameHero);
    return;
  }
  const widgetToggle = t.closest<HTMLInputElement>("[data-widget-toggle]");
  if (widgetToggle) {
    const name = widgetToggle.dataset.widgetToggle!;
    const enabled = widgetToggle.checked;
    void invoke("toggle_widget", { name, enabled }).then((layout) => {
      S.layout = layout as typeof S.layout;
      render();
    });
    return;
  }
});

// ---------- HUD widget mode (?widget=coach|win|buy|enemies) ----------
const WIDGET = new URLSearchParams(location.search).get("widget");
let editing = false;

let HUD: HudExtra = { focus: false, toast: "", pending: [], lag: BASE_DELAY, winTrend: null, souls: null, team: false, habits: [], staleAgeS: null };
const LANE_ARROW: Record<string, string> = { "kita tekan": "▲", "kita ditekan": "▼" };

/**
 * HUD "Situasi" before the match: the cross-match habits (deaths before 10:00, souls at
 * 10:00 vs the hero average, items always bought late) in 1–2 lines. Replaced by the live
 * situation as soon as the match data arrives.
 */
function habitsHud(lines: string[]) {
  if (!lines.length) return "";
  return `<section class="card hud situasi"><h3>Kebiasaan <small>sebelum match</small></h3>${lines
    .map((l) => `<div class="hud-line">${esc(l)}</div>`)
    .join("")}</section>`;
}

/** HUD "Situasi": win chance (smoothed) + economy + power spike + the macro plan, in ~6 lines. */
function situasiHud(r: LiveResp) {
  const m = me()!;
  const [a, b] = m.team === 0 ? r.teamNetWorth : [r.teamNetWorth[1], r.teamNetWorth[0]];
  const share = a + b > 0 ? (a / (a + b)) * 100 : 50;
  const p = r.winProbability;
  const d = HUD.winTrend;
  const trend = d == null || Math.abs(d) < 0.03 ? "" : ` <span class="${d > 0 ? "win" : "loss"}">${d > 0 ? "▲" : "▼"}${Math.round(Math.abs(d) * 100)}</span>`;
  const sp = r.spikes;
  const spike =
    sp && sp.verdict !== "even"
      ? `<div class="hud-line ${sp.verdict === "fight" ? "win" : "loss"}">⚡ ${sp.verdict === "fight" ? "Spike tim kamu" : "Spike lawan"}: <b>${sp.verdict === "fight" ? "cari fight" : "tahan fight"}</b> sampai ${sp.untilClock ?? `±${Math.round(sp.windowLeft)}s`}</div>`
      : "";
  const mc = r.macro;
  const isBrawl = !!(r.mode?.isBrawl || (S.live && S.live.players.length <= 8));
  // Clean HUD: Show 1 focused lane note if critical (e.g. pushed/threatened) instead of 4 cryptic arrow symbols
  const lanes = isBrawl
    ? `<div class="hud-line win">🥊 <b>Street Brawl 4v4</b> · Draft 3 item acak di awal ronde</div>`
    : mc?.lane
      ? `<div class="hud-line small" style="opacity:.9">🚩 Fokus Lane: <b class="${mc.lane.status === "kita tekan" ? "win" : mc.lane.status === "kita ditekan" ? "loss" : "brass"}">${esc(mc.lane.name)}</b> (${esc(mc.lane.status)})</div>`
      : "";
  const modeTag = r.mode ? ` <span class="tag ${r.mode.isBrawl ? "hot" : r.mode.isRanked ? "main" : "ok"}">${esc(r.mode.label)}</span>` : "";
  return `<section class="card hud situasi">
    <div class="row" style="justify-content:space-between"><span>${p != null ? `Menang <b class="hud-big ${p >= 0.5 ? "win" : "loss"}">${pct(p, 0)}</b> <span class="small">${winBand(p)}${trend}</span>` : `<b>Ekonomi</b>`}${modeTag}</span><span class="small ${r.netWorthLead >= 0 ? "win" : "loss"}">${r.netWorthLead >= 0 ? "+" : "−"}${k(Math.abs(r.netWorthLead))}</span></div>
    <div class="nw" style="margin:4px 0"><div class="a" style="width:${share}%"></div><div class="b" style="width:${100 - share}%"></div></div>
    ${spike}
    ${
      r.draftOdds && (r.gameTimeS < 600 || Math.abs(r.netWorthLead) < 1500)
        ? `<div class="hud-line small" style="opacity:.9">⚖️ Draft: <b class="${r.draftOdds.winProbability >= 0.5 ? "win" : "loss"}">${pct(r.draftOdds.winProbability, 0)}</b> · Peak ${PHASE_NAME[r.draftOdds.peakPhase]}${
            r.draftOdds.advantages[0]
              ? ` · Edge: ${esc(S.heroes.get(r.draftOdds.advantages[0].ourHeroId)?.name ?? `#${r.draftOdds.advantages[0].ourHeroId}`)}`
              : ""
          }</div>`
        : ""
    }
    ${r.gamePlan ? `<div class="hud-line">🎯 <b>${esc(r.gamePlan.title)}</b></div>` : ""}
    ${lanes}
    ${
      !isBrawl && r.gameTimeS >= 120 && r.gameTimeS <= 720
        ? (() => {
            const p = computeSoulsPacing(m.netWorth, r.gameTimeS);
            if (!p) return "";
            return `<div class="hud-line small" style="opacity:.9">⚡ Laning Souls: target <b>${k(p.target)}</b> · kamu <b class="${p.isAhead ? "win" : "loss"}">${k(p.current)}</b> <span class="${p.isAhead ? "win" : "loss"}">(${p.delta >= 0 ? "+" : "−"}${k(Math.abs(p.delta))})</span></div>`;
          })()
        : ""
    }
    ${teamLine()}
  </section>`;
}

/** Team numbers from the broadcast: damage to heroes, share, net worth, KDA, who is dead. */
function teamStats() {
  const m = me();
  const live = S.live;
  if (!m || !live) return null;
  const allies = live.players.filter((p) => p.team === m.team);
  const total = allies.reduce((s, p) => s + (p.heroDamage ?? 0), 0);
  const avgNw = allies.reduce((s, p) => s + p.netWorth, 0) / Math.max(1, allies.length);
  const mins = Math.max(1, live.gameTimeS / 60);
  const rows = allies
    .map((p) => ({ p, dmg: p.heroDamage ?? 0, share: total > 0 ? (p.heroDamage ?? 0) / total : 0, dpm: (p.heroDamage ?? 0) / mins, nwRel: avgNw > 0 ? p.netWorth / avgNw : 1, isMe: p.accountId === m.accountId }))
    .sort((a, b) => b.dmg - a.dmg);
  const rank = rows.findIndex((r) => r.isMe) + 1;
  const carry = rows[0] && rows[0].share >= 0.27 && !rows[0].isMe ? rows[0] : null;
  const poor = rows.filter((r) => !r.isMe && r.nwRel < 0.72).sort((a, b) => a.nwRel - b.nwRel)[0] ?? null;
  const name = (id: number) => S.heroes.get(id)?.name ?? `#${id}`;
  const notes: string[] = [];
  if (total <= 0) notes.push("Data damage belum masuk dari broadcast.");
  else {
    if (carry) notes.push(`${name(carry.p.heroId)} carry damage (${Math.round(carry.share * 100)}%): main di sekitar dia, lindungi di fight.`);
    else if (rows[0]?.isMe) notes.push(`Kamu damage #1 tim (${Math.round(rows[0].share * 100)}%): kamu target utama lawan, jaga posisi.`);
    if (poor) notes.push(`${name(poor.p.heroId)} tertinggal ${k(avgNw - poor.p.netWorth)} dari rata-rata: jangan ambil wave/camp-nya.`);
  }
  return { rows, rank, total, carry, notes, name, count: allies.length };
}

function teamHtml(hud: boolean) {
  const ts = teamStats();
  if (!ts) return "";
  const rows = ts.rows
    .map(
      (r) => `<div class="team-line${r.isMe ? " me" : ""}">
        ${heroIcon(r.p.heroId, "ico sm")}
        <span class="name">${r.isMe ? "Kamu" : esc(ts.name(r.p.heroId))}</span>
        <span class="small team-dmg">${k(r.dmg)}</span>
        <span class="small muted team-share">${Math.round(r.share * 100)}%</span>
        <span class="small ${r.nwRel >= 1 ? "win" : r.nwRel < 0.8 ? "loss" : ""} team-nw">${k(r.p.netWorth)}</span>
        ${
          r.p.dead
            ? `<span class="tag loss team-status">💀${r.p.respawnInS ? Math.max(0, Math.round(r.p.respawnInS - (hud ? HUD.lag : lagSeconds()))) + "s" : ""}</span>`
            : `<span class="small muted team-kda">${r.p.kills}/${r.p.deaths}/${r.p.assists}</span>`
        }
      </div>`,
    )
    .join("");
  return `<section class="card hud team">
    <div class="hud-title-bar">
      <h3>Tim</h3>
      <span class="small muted" style="font-size:10px">${hud ? "Ctrl+Shift+T = Lawan" : "damage · % · NW · K/D/A"}</span>
    </div>
    <div class="hud-table-header team-header">
      <span style="grid-column: 1 / 3;">PEMAIN</span>
      <span style="text-align:right">DMG</span>
      <span style="text-align:right">%</span>
      <span style="text-align:right">NW</span>
      <span style="text-align:center">K/D/A</span>
    </div>
    <div class="team-table">
      ${rows}
    </div>
    ${ts.notes.map((n) => `<div class="small" style="margin-top:4px;padding:0 2px">💡 ${esc(n)}</div>`).join("")}
  </section>`;
}

/** one line for HUD Situasi */
function teamLine() {
  const ts = teamStats();
  if (!ts || ts.total <= 0) return "";
  return `<div class="hud-line small">👥 Damage kamu #${ts.rank}/${ts.count}${ts.carry ? ` · carry: <b>${esc(ts.name(ts.carry.p.heroId))}</b> ${Math.round(ts.carry.share * 100)}%` : ""} <span class="muted">(Ctrl+Shift+T)</span></div>`;
}

/** HUD "Beli": sell first if needed, top items, imbue for #1, hotkey hint. */
function beliHud(r: LiveResp) {
  const m = me()!;
  const steps = r.buildPath.slice(0, HUD.focus ? 2 : 3);
  const sell = r.sell ? `<div class="hud-line loss">💱 Jual <b>${esc(r.sell.sellName)}</b> (+${k(r.sell.refund)}) → ${esc(r.sell.forName)}</div>` : "";
  const im = steps[0] ? r.imbue?.find((x) => x.itemId === steps[0].itemId) : undefined;
  return `<section class="card hud beli"><h3>Beli <small>${r.adaptive ? `${PHASE_NAME[r.adaptive.phase]} · ` : ""}${k(HUD_SOULS ?? soulsNow(m))} souls</small></h3>${sell}${steps
    .map(
      (s2, i) => `<div class="step ${s2.affordable ? (i === 0 ? "ready-buy ok" : "ok") : ""}"><span class="num-badge">${i + 1}</span><div class="grow2"><div class="row"><span class="name ${SLOT_CLS[s2.slot as keyof typeof SLOT_CLS] ?? ""}">${esc(s2.name)}</span><span class="small">${k(s2.cost)}</span>${s2.kind === "flex" ? `<span class="tag flex">FLEX</span>` : ""}${
        r.sell && r.sell.forId === s2.itemId ? `<span class="tag loss">JUAL DULU</span>` : s2.affordable ? `<span class="tag ok" style="font-weight:bold">BISA BELI</span>` : `<span class="small muted">−${k(s2.missing)}</span>`
      }</div>${i === 0 ? `<div class="small muted clamp1">${esc(s2.reason)}</div>${im ? `<div class="small" style="color:var(--spirit)">✨ Imbue → <b>${esc(im.target.name)}</b></div>` : ""}` : ""}</div></div>`,
    )
    .join("")}
    ${HUD.pending.length ? `<div class="small muted">✓ ditandai: ${HUD.pending.map(esc).join(", ")}</div>` : ""}
    <div class="hud-hint">Ctrl+Shift+B = sudah beli #1 · Ctrl+Shift+H = fokus</div></section>`;
}

/** HUD "Beli" for 0:00 starting items before live broadcast is ready */
function startingItemsHud(heroId: number | null) {
  const heroName = heroId ? S.heroes.get(heroId)?.name ?? S.heroInfo?.hero.name ?? "Hero" : "Hero";
  const items = (S.heroInfo && (!heroId || S.heroInfo.hero.id === heroId))
    ? S.heroInfo.itemsByTier?.["1"] ?? []
    : [];
  const displayItems = items.length > 0
    ? items.slice(0, HUD.focus ? 2 : 3)
    : [
        { id: 1, name: "Basic Magazine", slot: "weapon" as const, delta: 0.02 },
        { id: 2, name: "Extra Health", slot: "vitality" as const, delta: 0.03 },
        { id: 3, name: "Extra Spirit", slot: "spirit" as const, delta: 0.02 },
      ].slice(0, HUD.focus ? 2 : 3);

  return `<section class="card hud beli">
    <div class="hud-title-bar">
      <h3>Beli <small>0:00 · 500 souls</small></h3>
      <span class="tag hot" style="font-size:10px">AWAL GAME</span>
    </div>
    <div class="small muted" style="margin-bottom:6px">🚀 Beli 1 item Tier 1 di base (500 souls) sebelum zipline · <b>${esc(heroName)}</b>:</div>
    ${displayItems
      .map(
        (it, i) => `<div class="step ready-buy ok">
          <span class="num-badge">${i + 1}</span>
          <div class="grow2">
            <div class="row">
              <span class="name ${SLOT_CLS[it.slot] ?? ""}">${esc(it.name)}</span>
              <span class="small">500</span>
              <span class="tag ok" style="font-weight:bold">BISA BELI</span>
            </div>
            <div class="small muted clamp1">${it.delta !== undefined ? `Tier 1 rekomendasi (${delta(it.delta)})` : "Pilihan awal"}</div>
          </div>
        </div>`,
      )
      .join("")}
    ${HUD.pending.length ? `<div class="small muted" style="margin-top:4px">✓ ditandai: ${HUD.pending.map(esc).join(", ")}</div>` : ""}
    <div class="hud-hint">Ctrl+Shift+B = sudah beli #1 · Live sync otomatis saat broadcast masuk</div>
  </section>`;
}

function renderWidget() {
  const r = S.liveResp;
  const m = me();
  let html = "";
  if (WIDGET === "coach") {
    if (HUD.toast) {
      html = `<div class="hud-toast">${esc(HUD.toast)}</div>`;
    } else if (r) {
      html = coachCard(r, true);
    } else if (S.matchId || S.live || S.connected || S.game || S.force) {
      const isBrawl = S.live?.gameMode === "brawl" || (S.live && S.live.players.length > 0 && S.live.players.length <= 8);
      const selHeroId = m?.heroId ?? S.pregameHero ?? (S.live?.players[0]?.heroId ?? null);
      const heroName = selHeroId ? (S.heroes.get(selHeroId)?.name ?? S.heroInfo?.hero.name ?? "") : "";
      const title = isBrawl ? "Street Brawl 4v4" : heroName ? `Fase Awal · ${heroName}` : (S.matchId ? `Match #${S.matchId}` : "Menyiapkan Coach");
      const desc = isBrawl
        ? "Draft 3 item acak per ronde · Menunggu live data…"
        : heroName
          ? "Beli 1 item Tier 1 di base (500 souls) sebelum zipline. Broadcast sinkron ~1-2 menit."
          : (S.matchId ? `Match terdeteksi (#${S.matchId}) · Menghubungkan ke broadcast live…` : "Menghubungkan ke broadcast live…");
      html = `<section class="coach calm compact hud"><div class="coach-main"><span class="coach-ico">⏱</span><div class="coach-txt"><b>${esc(title)}</b><p>${esc(desc)}</p></div></div></section>`;
    } else {
      const selHeroId = S.pregameHero;
      const heroName = selHeroId ? (S.heroes.get(selHeroId)?.name ?? S.heroInfo?.hero.name ?? "") : "";
      const desc = heroName ? `Hero siap: ${heroName}. Asisten aktif saat match dimulai.` : "Asisten akan aktif saat kamu masuk match";
      html = `<section class="coach calm compact hud"><div class="coach-main"><span class="coach-ico">⏱</span><div class="coach-txt"><b>Menunggu Match…</b><p>${esc(desc)}</p></div></div></section>`;
    }
  } else if (r && m) {
    if (WIDGET === "win" && !HUD.focus) html = situasiHud(r);
    if (WIDGET === "buy") {
      html = r.buildPath && r.buildPath.length > 0 ? beliHud(r) : startingItemsHud(m.heroId || S.pregameHero);
    }
    if (WIDGET === "enemies" && HUD.team) html = teamHtml(true);
    else if (WIDGET === "enemies" && !HUD.focus) {
      const priorityEnemy = r.matchups.find((m) => m.isTargetPriority);
      const priorityBadge = priorityEnemy
        ? `<div class="hud-line small" style="background:rgba(232,146,58,0.15);border:1px solid var(--weapon);border-radius:4px;padding:3px 6px;margin-bottom:6px">
            🎯 <b>TARGET UTAMA:</b> ${esc(priorityEnemy.heroName)}
            <div class="muted" style="font-size:10px">${esc(priorityEnemy.priorityReason ?? "")}</div>
          </div>`
        : "";
      html = `<section class="card hud hud-enemies">
        <div class="hud-title-bar">
          <h3>Lawan</h3>
          <span class="small muted" style="font-size:10px">Ctrl+Shift+T = Tim</span>
        </div>
        ${priorityBadge}
        <div class="hud-table-header enemy-header">
          <span style="grid-column: 1 / 3;">HERO</span>
          <span style="text-align:right">DIFF NW</span>
          <span style="text-align:center">STATUS</span>
        </div>
        <div class="enemy-table">
          ${r.matchups
            .map((mu) => {
              const v = VERDICT[mu.verdict];
              const isDead = mu.verdict === "dead";
              const avatar = `<div class="avatar-wrapper ${isDead ? "dead" : ""} ${mu.isTargetPriority ? "target-priority" : ""}">
                ${heroIcon(mu.heroId, "ico sm")}
                ${isDead && mu.respawnInS ? `<div class="avatar-respawn-overlay">${Math.round(mu.respawnInS)}s</div>` : ""}
              </div>`;
              return `<div class="enemy-line ${mu.verdict}${mu.isTargetPriority ? " focus" : ""}">
                ${avatar}
                <div class="enemy-name-cell">
                  <span class="name">${esc(mu.heroName)}</span>
                  ${mu.laneOpponent ? `<span class="tag hot lane-badge" title="Lawan 1 Lane">LANE</span>` : ""}
                </div>
                <span class="small ${mu.nwDiff > 0 ? "loss" : "win"} enemy-nw">${mu.nwDiff >= 0 ? "+" : "−"}${k(Math.abs(mu.nwDiff))}</span>
                <span class="tag ${v.cls} enemy-status">${v.label}${mu.verdict === "dead" && mu.respawnInS ? ` ${Math.round(mu.respawnInS)}s` : ""}</span>
              </div>${
                mu.bestCounter && mu.verdict !== "dead" ? `<div class="small muted counter-line">↳ ${esc(mu.bestCounter.name)} <span class="win">+${(mu.bestCounter.delta * 100).toFixed(1)}%</span></div>` : ""
              }`;
            })
            .join("")}
        </div>
      </section>`;
    }
  } else if (WIDGET === "buy") {
    if (S.matchId || S.live || S.connected || S.game || S.force || editing) {
      const heroId = m?.heroId ?? S.live?.players[0]?.heroId ?? S.pregameHero ?? S.selectedRosterHero ?? null;
      if (heroId && (!S.heroInfo || S.heroInfo.hero.id !== heroId)) void loadHero(heroId);
      html = startingItemsHud(heroId);
    } else {
      html = "";
    }
  } else if (WIDGET === "win" && !HUD.focus) {
    if (S.matchId || S.live) {
      const isBrawl = S.live?.gameMode === "brawl" || (S.live && S.live.players.length > 0 && S.live.players.length <= 8);
      html = `<section class="card hud situasi"><h3>Situasi ${isBrawl ? '<span class="tag hot">Brawl 4v4</span>' : ""}</h3><div class="empty">Menghubungkan ke data match…</div></section>`;
    } else {
      html = ""; // Keep screen clean before match starts
    }
  }
  if (editing) {
    const NAME: Record<string, string> = { coach: "HUD Coach", win: "HUD Situasi", buy: "HUD Beli", enemies: "HUD Lawan" };
    html = `<div class="edit-frame" data-tauri-drag-region><span data-tauri-drag-region>${esc(NAME[WIDGET ?? ""] ?? WIDGET ?? "")} · seret untuk pindah · Ctrl+Shift+E simpan</span></div>${html}`;
  }
  $("app").innerHTML = html;
}

async function widgetBoot() {
  document.documentElement.classList.add("widget");
  await listen<OverlayData>("overlay-data", (e) => {
    const d = e.payload;
    if (d.hud) {
      HUD = d.hud;
      HUD_SOULS = d.hud.souls;
    }
    S.liveResp = d.r;
    S.live = d.live;
    S.connected = d.connected;
    S.matchId = d.matchId;
    S.heroes = new Map(d.heroes);
    S.scout = d.scout;
    if (d.pregameHero !== undefined) {
      S.pregameHero = d.pregameHero;
      try {
        if (d.pregameHero) localStorage.setItem("dlm_pregame_hero", String(d.pregameHero));
      } catch {}
    }
    if (d.heroInfo !== undefined) S.heroInfo = d.heroInfo;
    renderWidget();
  });
  await listen<boolean>("edit-mode", (e) => {
    editing = e.payload;
    renderWidget();
  });
  if (S.pregameHero && !S.heroInfo) {
    void loadHero(S.pregameHero);
  }
  renderWidget();
  await emit("widget-ready", WIDGET);
}

// ---------- boot ----------
// ---------- auto update (GitHub Releases, signed) ----------
let pendingUpdate: Update | null = null;
let updateState: "" | "downloading" | "error" = "";
async function checkUpdate() {
  try {
    const u = await check();
    if (u) {
      pendingUpdate = u;
      toast(`Update ${u.version} tersedia (buka panel: Ctrl+Shift+D)`);
      render();
    }
  } catch {
    // dev mode / offline / no release yet: nothing to show
  }
  // check again every 30 min while the app runs
  window.setTimeout(checkUpdate, 30 * 60_000);
}
async function installUpdate() {
  if (!pendingUpdate || updateState === "downloading") return;
  updateState = "downloading";
  render();
  try {
    await pendingUpdate.downloadAndInstall();
    await relaunch();
  } catch (e) {
    updateState = "error";
    showFatal("update", e);
  }
}
function updateCard() {
  if (!pendingUpdate) return "";
  const busy = updateState === "downloading";
  return `<section class="card" style="border-color:var(--win)"><div class="row" style="justify-content:space-between"><span><b>Update ${esc(pendingUpdate.version)}</b> <span class="small muted">(sekarang ${esc(APP_BUILD)})</span></span><button class="btn" id="doUpdate" ${busy ? "disabled" : ""}>${busy ? "Mengunduh…" : "Update sekarang"}</button></div>${
    pendingUpdate.body ? `<div class="small muted" style="margin-top:4px;white-space:pre-wrap">${esc(pendingUpdate.body.slice(0, 400))}</div>` : ""
  }<div class="small muted" style="margin-top:4px">Aplikasi akan restart sendiri. Jangan update di tengah match.</div></section>`;
}

/** Show a startup / runtime error inside the panel so it can be screenshotted. */
function showFatal(where: string, e: unknown) {
  const msg = e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e);
  const line = `${where}: ${msg.slice(0, 600)}`;
  if (!FATAL.includes(line)) FATAL.push(line);
  if (FATAL.length > 5) FATAL.shift();
  const v = document.getElementById("view");
  if (v) v.insertAdjacentHTML("afterbegin", fatalHtml());
}
const FATAL: string[] = [];
const fatalHtml = () =>
  FATAL.length ? `<div class="err" style="white-space:pre-wrap;font-size:11px">${FATAL.map((f) => `⚠ ${esc(f)}`).join("\n")}</div>` : "";
window.addEventListener("error", (e) => showFatal("JS error", e.error ?? e.message));
window.addEventListener("unhandledrejection", (e) => showFatal("Promise", e.reason));

async function step<T>(name: string, f: () => Promise<T>, tries = 1): Promise<T | undefined> {
  for (let i = 0; i < tries; i++) {
    try {
      return await f();
    } catch (e) {
      if (i === tries - 1) showFatal(`start: ${name}`, e);
      else await new Promise((r) => setTimeout(r, 500));
    }
  }
  return undefined;
}

async function boot() {
  if (WIDGET) return widgetBoot();
  try {
    APP_BUILD = `v${await getVersion()}`;
  } catch {}
  const b = document.getElementById("build");
  if (b) b.textContent = APP_BUILD;
  // render first: whatever fails below, the panel (connection status, manual controls) is there
  try {
    render();
  } catch (e) {
    showFatal("render awal", e);
  }
  await step("widget-ready", () => listen<string>("widget-ready", () => broadcast(true)));
  S.settings = (await step("settings", () => invoke<Settings>("settings"), 10)) ?? S.settings;
  try {
    S.steamProfile = S.settings?.profile ?? (await invoke<SteamProfile | null>("get_steam_profile").catch(() => null));
    if (S.steamProfile && !S.settings?.accountId && S.settings) {
      S.settings.accountId = S.steamProfile.account_id;
    }
  } catch {}
  S.layout = (await step("get_layout", () => invoke<typeof S.layout>("get_layout"), 5)) ?? S.layout;
  await step("listen engine", () =>
    listen<EngineEvent>("engine", (e) => {
      try {
        onEngine(e.payload);
      } catch (err) {
        showFatal(`event ${e.payload?.type}`, err);
      }
    }),
  );
  const snap = (await step("engine_snapshot", () => invoke<EngineEvent[]>("engine_snapshot"), 5)) ?? [];
  for (const ev of snap) {
    try {
      onEngine(ev);
    } catch (err) {
      showFatal(`snapshot ${ev.type}`, err);
    }
  }
  if (S.force) void step("force_game", () => invoke("force_game", { on: true }));
  await step("listen hotkey", () => listen<string>("hotkey", (e) => onHotkey(e.payload)));
  await step("listen click-through", () =>
    listen<boolean>("click-through", (e) => {
      S.clickThrough = e.payload;
      renderStatus();
    }),
  );
  if (S.isAlwaysOnTop) {
    void getCurrentWindow().setAlwaysOnTop(true);
  }
  render();
  void checkUpdate();
  // the installed app starts its bundled server at launch: give it time to come up
  // Never give up: a slow first start (antivirus scanning the bundled server) must still recover.
  for (let attempt = 0; ; attempt++) {
    try {
      const meta = await api<{ heroes: MetaHero[] }>("/api/meta");
      S.heroes = new Map(meta.heroes.map((h) => [h.heroId, h]));
      if (S.pregameHero) {
        S.selectedRosterHero = S.pregameHero;
        void loadHero(S.pregameHero);
      } else if (!S.selectedRosterHero && meta.heroes.length) {
        S.selectedRosterHero = meta.heroes[0].heroId;
        void loadHero(S.selectedRosterHero);
      }
      S.error = "";
      webNote = "";
      break;
    } catch {
      webNote = await invoke<string>("web_status").catch(() => "");
      S.error =
        attempt < 6
          ? "Menyalakan server lokal…"
          : `Website tidak bisa dihubungi (${S.settings?.siteBase}).${webNote ? ` ${webNote}.` : ""} Cek koneksi internet / proxy (web_env di ${S.settings?.configPath}); log server: folder log app, web-server.log.`;
      render();
      await new Promise((r) => setTimeout(r, attempt < 6 ? 1000 : 5000));
    }
  }
  render();
}

void boot();
