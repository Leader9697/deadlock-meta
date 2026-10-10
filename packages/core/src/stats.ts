import type { AnalyticsHeroStats } from "./types";

export const winrate = (wins: number, matches: number) => (matches > 0 ? wins / matches : 0);

/** Lower bound of the Wilson score interval (z=1.96 → 95%). Penalises small samples. */
export function wilsonLower(wins: number, n: number, z = 1.96): number {
  if (n === 0) return 0;
  const p = wins / n;
  const z2 = z * z;
  return (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / (1 + z2 / n);
}

/** Pull a rate toward a prior with the weight of `k` pseudo-matches. */
export function shrink(wins: number, n: number, prior: number, k: number): number {
  return (wins + prior * k) / (n + k);
}

export type Tier = "S" | "A" | "B" | "C" | "D";

export interface HeroMetaRow {
  heroId: number;
  matches: number;
  wins: number;
  winrate: number;
  wilson: number;
  pickRate: number;
  kda: number;
  avgKills: number;
  avgDeaths: number;
  avgAssists: number;
  avgNetWorth: number;
  avgDamage: number;
  zScore: number;
  tier: Tier;
}

/**
 * Tiering = z-score of the Wilson lower bound across heroes, with a small pick-rate
 * nudge so a 0.4%-pick hero on a lucky week does not top the list.
 */
export function buildHeroMeta(rows: AnalyticsHeroStats[]): HeroMetaRow[] {
  const valid = rows.filter((r) => r.matches > 0);
  // Each match has 12 heroes, so total matches = sum / 12.
  const totalMatches = valid.reduce((s, r) => s + r.matches, 0) / 12;

  const base = valid.map((r) => {
    const n = r.matches;
    const deaths = r.total_deaths / n;
    return {
      heroId: r.hero_id,
      matches: n,
      wins: r.wins,
      winrate: winrate(r.wins, n),
      wilson: wilsonLower(r.wins, n),
      pickRate: totalMatches > 0 ? n / totalMatches : 0,
      avgKills: r.total_kills / n,
      avgDeaths: deaths,
      avgAssists: r.total_assists / n,
      kda: (r.total_kills + r.total_assists) / Math.max(1, r.total_deaths),
      avgNetWorth: r.total_net_worth / n,
      avgDamage: r.total_player_damage / n,
    };
  });

  const score = (b: (typeof base)[number]) => b.wilson + 0.02 * Math.log10(Math.max(b.pickRate, 0.001) * 100);
  const scores = base.map(score);
  const mean = scores.reduce((s, x) => s + x, 0) / Math.max(1, scores.length);
  const sd = Math.sqrt(scores.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, scores.length)) || 1;

  return base
    .map((b, i) => {
      const z = (scores[i] - mean) / sd;
      const tier: Tier = z >= 1.1 ? "S" : z >= 0.4 ? "A" : z >= -0.4 ? "B" : z >= -1.1 ? "C" : "D";
      return { ...b, zScore: z, tier };
    })
    .sort((a, b) => b.zScore - a.zScore);
}

export function formatPct(x: number, digits = 1): string {
  return `${(x * 100).toFixed(digits)}%`;
}

export function formatDelta(x: number, digits = 1): string {
  const v = x * 100;
  return `${v >= 0 ? "+" : ""}${v.toFixed(digits)}`;
}

export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
