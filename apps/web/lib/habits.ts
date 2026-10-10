import "server-only";
import { flowPhasePlan, habitMatches, habits, type HabitMatch, type Habits, type MatchLog } from "@deadlock/core";
import { getHeroItemStats, getItemFlow, getItemMap, ITEM_PHASE_S } from "./data";
import { AUTO } from "./filters";
import { listMatchLogs } from "./store";

/** heroes to fetch benchmarks for: the ones actually played in the logs, most played first */
const HERO_LIMIT = 4;

export interface HabitsResult {
  habits: Habits;
  matches: HabitMatch[];
  /** overlay logs found for this account */
  logs: number;
}

/**
 * Cross-match habits for an account: overlay logs from this PC plus the community
 * benchmarks (souls at 10:00 per hero from item-flow, average item buy times from
 * item-stats); pass `preloaded` to reuse logs the caller already read. Benchmarks are best
 * effort — without them the habits still show my own numbers, just without the comparison.
 */
export async function loadHabits(account: number, preloaded?: MatchLog[]): Promise<HabitsResult> {
  const logs = preloaded ?? (await listMatchLogs(account));
  const rows = habitMatches(logs);
  if (!logs.length) return { habits: habits([]), matches: rows, logs: 0 };

  const played = new Map<number, number>();
  for (const r of rows) played.set(r.heroId, (played.get(r.heroId) ?? 0) + 1);
  const heroIds = [...played.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, HERO_LIMIT)
    .map(([id]) => id);

  const [items, flows, itemStats] = await Promise.all([
    getItemMap(),
    Promise.all(heroIds.map((id) => getItemFlow(id, AUTO, 0).catch(() => null))),
    Promise.all(heroIds.map((id) => getHeroItemStats(id, AUTO, 0).catch(() => []))),
  ]);

  const soulsBench = new Map<number, number>();
  heroIds.forEach((id, i) => {
    const flow = flows[i];
    if (!flow) return;
    const nw = flowPhasePlan(flow, ITEM_PHASE_S, items).netWorthByPhase.early;
    if (nw > 0) soulsBench.set(id, nw);
  });

  // average buy time per item across my heroes (same item, several heroes → mean)
  const buy = new Map<number, { sum: number; n: number }>();
  for (const rowsForHero of itemStats) {
    for (const r of rowsForHero) {
      if (!Number.isFinite(r.avg_buy_time_s) || r.avg_buy_time_s <= 0) continue;
      const e = buy.get(r.item_id) ?? { sum: 0, n: 0 };
      e.sum += r.avg_buy_time_s;
      e.n++;
      buy.set(r.item_id, e);
    }
  }
  const avgBuyTime = new Map([...buy.entries()].map(([id, e]) => [id, e.sum / e.n]));

  return {
    habits: habits(logs, {
      soulsBench,
      avgBuyTime,
      itemName: (id) => items.get(id)?.name ?? `#${id}`,
      itemTier: (id) => {
        const it = items.get(id);
        return it?.type === "upgrade" ? (it.item_tier ?? undefined) : undefined;
      },
    }),
    matches: rows,
    logs: logs.length,
  };
}
