import type { DeadlockClient, FetchInit, Query } from "./api";
import { winrate } from "./stats";
import type { Item, ItemSlotType, ItemStats } from "./types";

/**
 * Counter-item scoring.
 *
 * Raw item win rates are biased by *when* an item is bought (late items look great
 * because only winning players reach them). Comparing the same item against itself
 * cancels that bias:
 *
 *   rawDelta(i, e)  = WR(i | enemy e on other team) − WR(i | baseline)
 *   drift(e)        = matches-weighted mean of rawDelta over all items vs e
 *                     (how much harder/easier the match is overall vs e)
 *   adjDelta(i, e)  = (rawDelta − drift) · n / (n + K)      ← shrink small samples
 *   score(i)        = Σ_e adjDelta(i, e) · w(i, e) / Σ_e w(i, e),  w = sqrt(n)
 *
 * So score is "how much better this item performs vs this lineup than it normally
 * does", in win-rate points.
 */

export interface CounterOptions {
  /** Hero you are playing. Omit for "what beats these heroes on any hero". */
  heroId?: number;
  enemyHeroIds: number[];
  minAverageBadge?: number;
  minUnixTimestamp?: number;
  /** Pseudo-count for shrinkage. Higher = more conservative. */
  shrinkK?: number;
  minMatches?: number;
  enemyWeights?: Map<number, number>;
}

export interface EnemyContribution {
  enemyHeroId: number;
  matches: number;
  winrate: number;
  delta: number; // adjusted delta in WR points (0.03 = +3%)
}

export interface CounterItem {
  itemId: number;
  score: number;
  baselineWinrate: number;
  baselineMatches: number;
  avgBuyTimeS: number;
  perEnemy: EnemyContribution[];
}

export function scoreCounterItems(
  baseline: ItemStats[],
  perEnemy: Map<number, ItemStats[]>,
  shrinkK = 150,
  /** Optional per-enemy importance, e.g. live net-worth share. Default 1. */
  enemyWeights?: Map<number, number>,
): CounterItem[] {
  const base = new Map(baseline.map((r) => [r.item_id, r]));

  const contributions = new Map<number, EnemyContribution[]>();
  for (const [enemyId, rows] of perEnemy) {
    const paired = rows
      .map((r) => ({ r, b: base.get(r.item_id) }))
      .filter((x): x is { r: ItemStats; b: ItemStats } => !!x.b && x.b.matches > 0 && x.r.matches > 0);

    const totalN = paired.reduce((s, x) => s + x.r.matches, 0);
    const drift =
      totalN > 0
        ? paired.reduce((s, x) => s + (winrate(x.r.wins, x.r.matches) - winrate(x.b.wins, x.b.matches)) * x.r.matches, 0) /
          totalN
        : 0;

    for (const { r, b } of paired) {
      const raw = winrate(r.wins, r.matches) - winrate(b.wins, b.matches);
      const adj = (raw - drift) * (r.matches / (r.matches + shrinkK));
      const list = contributions.get(r.item_id) ?? [];
      list.push({ enemyHeroId: enemyId, matches: r.matches, winrate: winrate(r.wins, r.matches), delta: adj });
      contributions.set(r.item_id, list);
    }
  }

  const out: CounterItem[] = [];
  for (const [itemId, list] of contributions) {
    const b = base.get(itemId)!;
    let num = 0;
    let den = 0;
    for (const c of list) {
      const w = Math.sqrt(c.matches) * (enemyWeights?.get(c.enemyHeroId) ?? 1);
      num += c.delta * w;
      den += w;
    }
    // Items with no data vs some enemies are treated as neutral (0) for those enemies,
    // weighted by the average weight, so partial coverage does not inflate the score.
    const missing = perEnemy.size - list.length;
    if (missing > 0 && list.length > 0) den += missing * (den / list.length);

    out.push({
      itemId,
      score: den > 0 ? num / den : 0,
      baselineWinrate: winrate(b.wins, b.matches),
      baselineMatches: b.matches,
      avgBuyTimeS: b.avg_buy_time_s,
      perEnemy: list.sort((a, c) => c.delta - a.delta),
    });
  }
  return out.sort((a, c) => c.score - a.score);
}

export interface CounterResult {
  items: CounterItem[];
  bySlot: Record<ItemSlotType, CounterItem[]>;
  coveredEnemies: number[];
}

/** Fetch the data and score it. Uses 1 + N analytics calls (N = enemies). */
export async function getCounterItems(
  client: DeadlockClient,
  allItems: Item[],
  opts: CounterOptions,
  init?: FetchInit,
): Promise<CounterResult> {
  const enemies = [...new Set(opts.enemyHeroIds)].filter((id) => id !== opts.heroId).slice(0, 6);
  const common: Query = {
    hero_id: opts.heroId,
    min_average_badge: opts.minAverageBadge,
    min_unix_timestamp: opts.minUnixTimestamp,
    min_matches: opts.minMatches ?? 30,
  };

  const [baseline, ...perEnemyRows] = await Promise.all([
    client.itemStats(common, init),
    ...enemies.map((e) => client.itemStats({ ...common, enemy_hero_ids: String(e) }, init)),
  ]);

  const perEnemy = new Map<number, ItemStats[]>();
  enemies.forEach((e, i) => perEnemy.set(e, perEnemyRows[i]));

  const shop = new Map(
    allItems
      .filter((it) => it.type === "upgrade" && it.shopable && !it.disabled && it.item_slot_type)
      .map((it) => [it.id, it]),
  );

  const items = scoreCounterItems(baseline, perEnemy, opts.shrinkK, opts.enemyWeights).filter((c) => shop.has(c.itemId));
  const bySlot: Record<ItemSlotType, CounterItem[]> = { weapon: [], spirit: [], vitality: [] };
  for (const c of items) bySlot[shop.get(c.itemId)!.item_slot_type!].push(c);

  return { items, bySlot, coveredEnemies: enemies };
}
