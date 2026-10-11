import type { CounterItem, CounterResult } from "./counter";
import type { DeathRecord } from "./deathreview";
import type { Item, ItemSlotType } from "./types";

/** Snapshot pushed by the desktop app's live engine (Rust) every few seconds. */
export interface LivePlayer {
  accountId: number;
  heroId: number;
  team: number;
  netWorth: number;
  /** unspent souls, if known */
  souls?: number;
  kills: number;
  deaths: number;
  assists: number;
  level: number;
  itemIds: number[];
  /** game time each item was bought (−1 = unknown), aligned with itemIds */
  itemTimes?: number[];
  dead?: boolean;
  /** seconds to respawn, broadcast time */
  respawnInS?: number;
  /** m_nAssignedLane; lane opponents share the same value */
  lane?: number;
  heroDamage?: number;
  heroHealing?: number;
  selfHealing?: number;
}

export interface LiveState {
  matchId: number | null;
  gameTimeS: number;
  myAccountId: number;
  players: LivePlayer[];
  /** 0 = Amber, 1 = Sapphire; set once the match is over */
  winningTeam?: number;
  /** seconds to next mid boss spawn, broadcast time */
  midBossInS?: number;
  /** [Amber, Sapphire] objective bitmasks, bit i = ECitadelTeamObjective i */
  objectiveMasks?: [number, number];
  /** my deaths this match (killfeed + game death recap), newest last */
  myDeaths?: DeathRecord[];
  /** unlocked flex item slots per team [Amber, Sapphire] */
  flexSlots?: [number, number];
  /** detected mode: "normal" (6v6) | "brawl" (4v4) */
  gameMode?: "normal" | "brawl";
  /** "unranked" | "ranked" */
  matchMode?: "unranked" | "ranked";
}

export type GameMode = "normal" | "brawl";
export type MatchMode = "unranked" | "ranked";

export interface ModeInfo {
  gameMode: GameMode;
  matchMode: MatchMode;
  isBrawl: boolean;
  isRanked: boolean;
  label: string;
}

export function detectMode(state: LiveState): ModeInfo {
  const isBrawl =
    state.gameMode === "brawl" ||
    (state.players.length >= 2 && state.players.length <= 8);
  const isRanked = state.matchMode === "ranked";
  const gameMode: GameMode = isBrawl ? "brawl" : "normal";
  const matchMode: MatchMode = isRanked ? "ranked" : "unranked";
  const label = isBrawl ? "Street Brawl (4v4)" : isRanked ? "Ranked (6v6)" : "Unranked (6v6)";
  return { gameMode, matchMode, isBrawl, isRanked, label };
}

export interface LiveSummary {
  myTeam: number;
  teamNetWorth: [number, number];
  /** my team − enemy team */
  netWorthLead: number;
  /** enemies sorted by threat (net worth share × KDA) */
  threats: { player: LivePlayer; nwShare: number; weight: number }[];
  /** enemy weights to feed back into getCounterItems */
  enemyWeights: Map<number, number>;
}

export function summarize(state: LiveState): LiveSummary | null {
  const me = state.players.find((p) => p.accountId === state.myAccountId);
  if (!me) return null;
  const nw: [number, number] = [0, 0];
  for (const p of state.players) if (p.team === 0 || p.team === 1) nw[p.team] += p.netWorth;
  const enemies = state.players.filter((p) => p.team !== me.team);
  const avg = enemies.reduce((s, p) => s + p.netWorth, 0) / Math.max(1, enemies.length);

  const threats = enemies
    .map((p) => {
      const nwShare = avg > 0 ? p.netWorth / avg : 1;
      const kda = (p.kills + p.assists) / Math.max(1, p.deaths);
      // Fed enemies dominate; KDA nudges it. Clamp so one hero never fully drowns the rest.
      const weight = Math.min(3, Math.max(0.4, nwShare ** 1.5 * (0.85 + 0.05 * Math.min(kda, 6))));
      return { player: p, nwShare, weight };
    })
    .sort((a, b) => b.weight - a.weight);

  return {
    myTeam: me.team,
    teamNetWorth: nw,
    netWorthLead: nw[me.team] - nw[1 - me.team],
    threats,
    enemyWeights: new Map(threats.map((t) => [t.player.heroId, t.weight])),
  };
}

export interface NextBuy {
  item: Item;
  counter: CounterItem;
  affordable: boolean;
}

/**
 * Turns counter scores into a "buy next" list for the current moment:
 * drops items already owned, prefers tiers that fit the current economy.
 */
export function nextBuys(result: CounterResult, items: Map<number, Item>, me: LivePlayer, limit = 6): Record<ItemSlotType | "all", NextBuy[]> {
  const owned = new Set(me.itemIds);
  // Rough tier you should be shopping in for your net worth.
  const tierCap = me.netWorth < 6000 ? 2 : me.netWorth < 16000 ? 3 : 4;
  const budget = me.souls ?? Infinity;

  const pick = (list: CounterItem[]) =>
    list
      .filter((c) => c.score > 0 && !owned.has(c.itemId))
      .map((c) => ({ c, it: items.get(c.itemId) }))
      .filter((x): x is { c: CounterItem; it: Item } => !!x.it && (x.it.item_tier ?? 1) <= tierCap)
      .slice(0, limit)
      .map(({ c, it }) => ({ item: it, counter: c, affordable: (it.cost ?? 0) <= budget }));

  return {
    all: pick(result.items),
    weapon: pick(result.bySlot.weapon),
    vitality: pick(result.bySlot.vitality),
    spirit: pick(result.bySlot.spirit),
  };
}
