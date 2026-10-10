import { wilsonLower, winrate } from "./stats";
import type { ItemFlowStats } from "./types";

/**
 * Item timing from /v1/analytics/item-flow-stats.
 *
 * Items are bucketed by the phase (column) they were bought in. `adjusted_win_rate` is
 * deadlock-api's WR standardised to the net-worth-at-buy distribution of that phase,
 * so "rich players buy it and rich players win" is already removed.
 */

export interface TimingCell {
  column: number;
  matches: number;
  adjustedWr: number;
  rawWr: number;
  /** share of players reaching this phase who bought the item here */
  pickShare: number;
  avgNetWorthAtBuy: number;
}

export interface ItemTiming {
  itemId: number;
  totalMatches: number;
  cells: TimingCell[];
  /** column with the best adjusted WR (sample-weighted) */
  bestColumn: number | null;
  /** last column whose adjusted WR is still ≥ the hero's baseline WR; buy before this ends */
  lastGoodColumn: number | null;
  /** most common next items and how that path performs */
  next: { itemId: number; matches: number; winrate: number }[];
}

export interface ItemTimingAnalysis {
  phaseSeconds: number;
  columns: number;
  baselineWr: number;
  matches: number;
  avgDurationS: number;
  items: ItemTiming[];
}

export function analyzeItemFlow(flow: ItemFlowStats, phaseSeconds: number, opts: { minCellMatches?: number; maxItems?: number } = {}): ItemTimingAnalysis {
  const minCell = opts.minCellMatches ?? 30;
  const baselineWr = winrate(flow.summary.wins, flow.summary.matches);
  const columns = Math.max(0, ...flow.nodes.map((n) => n.column + 1), flow.reached_per_column.length);

  const byItem = new Map<number, TimingCell[]>();
  for (const n of flow.nodes) {
    const reached = flow.reached_per_column[n.column] ?? 0;
    const list = byItem.get(n.item_id) ?? [];
    list.push({
      column: n.column,
      matches: n.matches,
      adjustedWr: n.adjusted_win_rate,
      rawWr: winrate(n.wins, n.matches),
      pickShare: reached > 0 ? n.matches / reached : 0,
      avgNetWorthAtBuy: n.avg_net_worth_at_buy,
    });
    byItem.set(n.item_id, list);
  }

  const edgesFrom = new Map<number, { itemId: number; wins: number; matches: number }[]>();
  for (const e of flow.edges) {
    const list = edgesFrom.get(e.from_item_id) ?? [];
    const ex = list.find((x) => x.itemId === e.to_item_id);
    if (ex) {
      ex.wins += e.wins;
      ex.matches += e.matches;
    } else list.push({ itemId: e.to_item_id, wins: e.wins, matches: e.matches });
    edgesFrom.set(e.from_item_id, list);
  }

  const items: ItemTiming[] = [...byItem.entries()].map(([itemId, cells]) => {
    cells.sort((a, b) => a.column - b.column);
    const solid = cells.filter((c) => c.matches >= minCell);
    // sample-aware "best": Wilson on adjusted WR (treat as rate over matches)
    const best = solid
      .map((c) => ({ c, score: wilsonLower(c.adjustedWr * c.matches, c.matches) }))
      .sort((a, b) => b.score - a.score)[0];
    const good = solid.filter((c) => c.adjustedWr >= baselineWr);
    return {
      itemId,
      totalMatches: cells.reduce((s, c) => s + c.matches, 0),
      cells,
      bestColumn: best?.c.column ?? null,
      lastGoodColumn: good.length ? good[good.length - 1].column : null,
      next: (edgesFrom.get(itemId) ?? [])
        .filter((x) => x.matches >= minCell)
        .sort((a, b) => b.matches - a.matches)
        .slice(0, 3)
        .map((x) => ({ itemId: x.itemId, matches: x.matches, winrate: winrate(x.wins, x.matches) })),
    };
  });

  items.sort((a, b) => b.totalMatches - a.totalMatches);
  return {
    phaseSeconds,
    columns,
    baselineWr,
    matches: flow.summary.matches,
    avgDurationS: flow.summary.avg_duration_s,
    items: items.slice(0, opts.maxItems ?? 30),
  };
}

export const phaseLabel = (column: number, phaseSeconds: number, columns: number) => {
  const a = Math.round((column * phaseSeconds) / 60);
  const b = Math.round(((column + 1) * phaseSeconds) / 60);
  return column === columns - 1 ? `${a}m+` : `${a}–${b}m`;
};
