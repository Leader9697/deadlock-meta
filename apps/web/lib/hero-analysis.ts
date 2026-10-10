import { shrink, winrate, type HeroCounterStats, type HeroSynergyStats, type Item, type ItemStats } from "@deadlock/core";

export interface Matchup {
  heroId: number;
  matches: number;
  winrate: number;
  /** shrunk WR minus this hero's overall WR */
  delta: number;
}

/** Matchups of `heroId` vs every enemy. Uses rows from either direction of the pair. */
export function matchupsFor(heroId: number, rows: HeroCounterStats[], heroWr: number, k = 150): Matchup[] {
  const pairs = new Map<number, { wins: number; matches: number }>();
  for (const r of rows) {
    if (r.hero_id === heroId) pairs.set(r.enemy_hero_id, { wins: r.wins, matches: r.matches_played });
  }
  for (const r of rows) {
    if (r.enemy_hero_id === heroId && !pairs.has(r.hero_id)) {
      pairs.set(r.hero_id, { wins: r.matches_played - r.wins, matches: r.matches_played });
    }
  }
  return [...pairs]
    .filter(([id]) => id !== heroId)
    .map(([id, p]) => ({
      heroId: id,
      matches: p.matches,
      winrate: winrate(p.wins, p.matches),
      delta: shrink(p.wins, p.matches, heroWr, k) - heroWr,
    }));
}

export function synergiesFor(heroId: number, rows: HeroSynergyStats[], heroWr: number, k = 150): Matchup[] {
  return rows
    .filter((r) => r.hero_id1 === heroId || r.hero_id2 === heroId)
    .map((r) => ({
      heroId: r.hero_id1 === heroId ? r.hero_id2 : r.hero_id1,
      matches: r.matches_played,
      winrate: winrate(r.wins, r.matches_played),
      delta: shrink(r.wins, r.matches_played, heroWr, k) - heroWr,
    }));
}

export interface HeroItemRow {
  item: Item;
  matches: number;
  pickRate: number;
  winrate: number;
  delta: number;
  avgBuyTimeS: number;
}

/**
 * Per-tier item table for one hero. Delta is compared against the matches-weighted
 * average WR of items *in the same tier*, which removes most of the "late items
 * always look good" bias.
 */
export function heroItemsByTier(rows: ItemStats[], items: Map<number, Item>, heroMatches: number, k = 200) {
  const shop = rows
    .map((r) => ({ r, item: items.get(r.item_id) }))
    .filter((x): x is { r: ItemStats; item: Item } => !!x.item && x.item.type === "upgrade" && !!x.item.shopable && !x.item.disabled);

  const tiers = new Map<number, HeroItemRow[]>();
  for (const t of [1, 2, 3, 4]) {
    const inTier = shop.filter((x) => x.item.item_tier === t);
    const n = inTier.reduce((s, x) => s + x.r.matches, 0);
    const tierWr = n > 0 ? inTier.reduce((s, x) => s + x.r.wins, 0) / n : 0.5;
    tiers.set(
      t,
      inTier.map(({ r, item }) => ({
        item,
        matches: r.matches,
        pickRate: heroMatches > 0 ? r.matches / heroMatches : 0,
        winrate: winrate(r.wins, r.matches),
        delta: shrink(r.wins, r.matches, tierWr, k) - tierWr,
        avgBuyTimeS: r.avg_buy_time_s,
      })),
    );
  }
  return tiers;
}

export const TIER_COST: Record<number, string> = { 1: "800", 2: "1.6k", 3: "3.2k", 4: "6.4k" };
