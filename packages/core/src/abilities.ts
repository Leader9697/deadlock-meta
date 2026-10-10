import { wilsonLower, winrate } from "./stats";
import type { AbilityOrderStats, Hero, Item } from "./types";

/**
 * Ability upgrade order analysis from /v1/analytics/ability-order-stats.
 * Each row is one full upgrade sequence (ability ids, one entry per point spent).
 */

export interface HeroAbility {
  id: number;
  slot: number; // 1..4, 4 = ultimate
  name: string;
  image?: string | null;
}

/** The hero's four signature abilities in slot order, resolved via items class names. */
export function heroAbilities(hero: Hero, items: Item[]): HeroAbility[] {
  const byClass = new Map(items.map((i) => [i.class_name, i]));
  const out: HeroAbility[] = [];
  for (let slot = 1; slot <= 4; slot++) {
    const cls = hero.items?.[`signature${slot}`];
    const it = cls ? byClass.get(cls) : undefined;
    if (it) out.push({ id: it.id, slot, name: it.name, image: it.image_webp ?? it.image });
  }
  return out;
}

export interface OrderRow {
  sequence: number[];
  matches: number;
  winrate: number;
  wilson: number;
  kda: number;
}

export interface MaxPriority {
  /** ability ids in the order they reach their last upgrade */
  order: number[];
  matches: number;
  winrate: number;
  wilson: number;
}

export interface AbilityOrderAnalysis {
  totalMatches: number;
  /** best full sequences (Wilson-ranked) */
  topOrders: OrderRow[];
  /** best opening (first N points), aggregated over all sequences sharing it */
  openings: OrderRow[];
  /** which ability to max first, second, … */
  maxPriorities: MaxPriority[];
  /** at which point (1-based) the ultimate is first taken: WR per position bucket */
  ultTiming: { position: number; matches: number; winrate: number }[];
  bestUltPosition: number | null;
}

function aggregate<K>(rows: AbilityOrderStats[], key: (r: AbilityOrderStats) => K | null, toId: (k: K) => string) {
  const m = new Map<string, { key: K; wins: number; matches: number; k: number; d: number; a: number }>();
  for (const r of rows) {
    const k = key(r);
    if (k === null) continue;
    const id = toId(k);
    const e = m.get(id) ?? { key: k, wins: 0, matches: 0, k: 0, d: 0, a: 0 };
    e.wins += r.wins;
    e.matches += r.matches;
    e.k += r.total_kills;
    e.d += r.total_deaths;
    e.a += r.total_assists;
    m.set(id, e);
  }
  return [...m.values()];
}

/** Ability ids ordered by when each received its final point in the sequence. */
export function maxOrder(sequence: number[]): number[] {
  const last = new Map<number, number>();
  sequence.forEach((id, i) => last.set(id, i));
  return [...last.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
}

export function analyzeAbilityOrders(
  rows: AbilityOrderStats[],
  ultimateId: number | null,
  opts: { openingLength?: number; minMatches?: number } = {},
): AbilityOrderAnalysis {
  const n = opts.openingLength ?? 5;
  const minM = opts.minMatches ?? 50;
  const totalMatches = rows.reduce((s, r) => s + r.matches, 0);
  const toRow = (seq: number[], e: { wins: number; matches: number; k: number; d: number; a: number }): OrderRow => ({
    sequence: seq,
    matches: e.matches,
    winrate: winrate(e.wins, e.matches),
    wilson: wilsonLower(e.wins, e.matches),
    kda: (e.k + e.a) / Math.max(1, e.d),
  });

  const topOrders = rows
    .filter((r) => r.matches >= minM)
    .map((r) => toRow(r.abilities, { wins: r.wins, matches: r.matches, k: r.total_kills, d: r.total_deaths, a: r.total_assists }))
    .sort((a, b) => b.wilson - a.wilson)
    .slice(0, 5);

  const openings = aggregate(rows, (r) => (r.abilities.length >= n ? r.abilities.slice(0, n) : null), (k) => k.join(","))
    .filter((e) => e.matches >= minM)
    .map((e) => toRow(e.key, e))
    .sort((a, b) => b.wilson - a.wilson)
    .slice(0, 5);

  const maxPriorities = aggregate(rows, (r) => (r.abilities.length >= 8 ? maxOrder(r.abilities) : null), (k) => k.join(","))
    .filter((e) => e.matches >= minM)
    .map((e) => ({ order: e.key, matches: e.matches, winrate: winrate(e.wins, e.matches), wilson: wilsonLower(e.wins, e.matches) }))
    .sort((a, b) => b.wilson - a.wilson)
    .slice(0, 5);

  let ultTiming: AbilityOrderAnalysis["ultTiming"] = [];
  let bestUltPosition: number | null = null;
  if (ultimateId != null) {
    const agg = aggregate(
      rows,
      (r) => {
        const i = r.abilities.indexOf(ultimateId);
        return i >= 0 ? i + 1 : null;
      },
      (k) => String(k),
    );
    ultTiming = agg
      .filter((e) => e.matches >= minM)
      .map((e) => ({ position: e.key, matches: e.matches, winrate: winrate(e.wins, e.matches), wilson: wilsonLower(e.wins, e.matches) }))
      .sort((a, b) => a.position - b.position)
      .map(({ position, matches, winrate }) => ({ position, matches, winrate }));
    const best = agg
      .filter((e) => e.matches >= minM)
      .sort((a, b) => wilsonLower(b.wins, b.matches) - wilsonLower(a.wins, a.matches))[0];
    bestUltPosition = best?.key ?? null;
  }

  return { totalMatches, topOrders, openings, maxPriorities, ultTiming, bestUltPosition };
}
