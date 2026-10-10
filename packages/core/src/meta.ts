import { shrink, winrate } from "./stats";
import type { AnalyticsHeroStats, HeroBanStats, HeroCounterStats, HeroSynergyStats } from "./types";

// ---------------------------------------------------------------------------
// Meta Detector
// ---------------------------------------------------------------------------

export type MetaStatus = "confirmed" | "rising" | "sleeper" | "overrated" | "falling" | "stable";

export interface MetaRow {
  heroId: number;
  matches: number;
  winrate: number;
  /** WR shrunk toward 50% (k = 500 matches) */
  adjWr: number;
  prevWr: number | null;
  wrTrend: number | null;
  pickRate: number;
  prevPickRate: number | null;
  /** relative change in pick rate: 0.2 = +20% */
  pickTrend: number | null;
  banShare: number;
  score: number;
  status: MetaStatus;
  reasons: string[];
}

const z = (xs: number[]) => {
  const m = xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);
  const sd = Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, xs.length)) || 1;
  return (x: number) => (x - m) / sd;
};

/**
 * Composite meta score:
 *   0.45·z(WR uplift) + 0.20·z(WR trend) + 0.20·z(pick trend) + 0.15·z(ban share)
 * WR uplift uses Bayesian shrinkage so low-sample heroes cannot top the list.
 */
export function detectMeta(now: AnalyticsHeroStats[], prev: AnalyticsHeroStats[], bans: HeroBanStats[]): MetaRow[] {
  const total = (rows: AnalyticsHeroStats[]) => rows.reduce((s, r) => s + r.matches, 0) / 12;
  const tNow = total(now);
  const tPrev = total(prev);
  const prevBy = new Map(prev.map((r) => [r.hero_id, r]));
  const banTotal = bans.reduce((s, b) => s + b.bans, 0);
  const banBy = new Map<number, number>();
  for (const b of bans) banBy.set(b.hero_id, (banBy.get(b.hero_id) ?? 0) + b.bans);

  const base = now
    .filter((r) => r.matches > 0)
    .map((r) => {
      const p = prevBy.get(r.hero_id);
      const adjWr = shrink(r.wins, r.matches, 0.5, 500);
      const prevAdj = p && p.matches > 0 ? shrink(p.wins, p.matches, 0.5, 500) : null;
      const pickRate = tNow > 0 ? r.matches / tNow : 0;
      const prevPickRate = p && tPrev > 0 ? p.matches / tPrev : null;
      return {
        heroId: r.hero_id,
        matches: r.matches,
        winrate: winrate(r.wins, r.matches),
        adjWr,
        prevWr: prevAdj,
        wrTrend: prevAdj != null ? adjWr - prevAdj : null,
        pickRate,
        prevPickRate,
        pickTrend: prevPickRate ? pickRate / prevPickRate - 1 : null,
        banShare: banTotal > 0 ? (banBy.get(r.hero_id) ?? 0) / banTotal : 0,
      };
    });

  const zU = z(base.map((b) => b.adjWr - 0.5));
  const zT = z(base.map((b) => b.wrTrend ?? 0));
  const zP = z(base.map((b) => b.pickTrend ?? 0));
  const zB = z(base.map((b) => b.banShare));
  const picks = [...base.map((b) => b.pickRate)].sort((a, b) => a - b);
  const pickPct = (x: number) => picks.findIndex((p) => p >= x) / Math.max(1, picks.length - 1);

  return base
    .map((b) => {
      const score = 0.45 * zU(b.adjWr - 0.5) + 0.2 * zT(b.wrTrend ?? 0) + 0.2 * zP(b.pickTrend ?? 0) + 0.15 * zB(b.banShare);
      const uplift = b.adjWr - 0.5;
      const pp = pickPct(b.pickRate);
      const reasons: string[] = [];
      let status: MetaStatus = "stable";
      if (uplift >= 0.015 && pp >= 0.6) {
        status = "confirmed";
        reasons.push("WR tinggi dan sudah banyak dipick");
      } else if (uplift >= 0.015 && pp <= 0.4) {
        status = "sleeper";
        reasons.push("WR tinggi tapi jarang dipick");
      } else if ((b.wrTrend ?? 0) >= 0.01 || (b.pickTrend ?? 0) >= 0.2) {
        status = "rising";
        reasons.push("naik dibanding minggu lalu");
      } else if (pp >= 0.7 && uplift < 0) {
        status = "overrated";
        reasons.push("populer tapi WR di bawah 50%");
      } else if ((b.wrTrend ?? 0) <= -0.015) {
        status = "falling";
        reasons.push("WR turun dibanding minggu lalu");
      }
      if (b.banShare >= 0.06) reasons.push(`sering diban (${(b.banShare * 100).toFixed(1)}% dari semua ban)`);
      return { ...b, score, status, reasons };
    })
    .sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// Draft analyzer
// ---------------------------------------------------------------------------

/**
 * Additive draft model in win-rate points (not a trained classifier):
 *   strength(T) = mean_i (WR_i − 50%)
 *   synergy(T)  = mean over ally pairs (WR_pair − mean(WR_i, WR_j))
 *   counter(A,B)= mean over i∈A, j∈B (WR(i vs j) − WR_i)
 *   edge(A)     = Δstrength + Δsynergy + (counter(A,B) − counter(B,A))
 *   P(A wins)  ≈ 50% + edge, clamped to 5–95%
 * All pair rates are shrunk toward the expectation (k = 150).
 */
export interface DraftContext {
  heroWr: Map<number, number>;
  pairWr: (a: number, b: number) => number | null; // same team
  vsWr: (a: number, b: number) => number | null; // a vs b
}

export function buildDraftContext(heroStats: AnalyticsHeroStats[], synergy: HeroSynergyStats[], counters: HeroCounterStats[]): DraftContext {
  const heroWr = new Map(heroStats.filter((r) => r.matches > 0).map((r) => [r.hero_id, shrink(r.wins, r.matches, 0.5, 500)]));
  const wr = (id: number) => heroWr.get(id) ?? 0.5;
  const pairs = new Map<string, number>();
  for (const s of synergy) {
    const exp = (wr(s.hero_id1) + wr(s.hero_id2)) / 2;
    const v = shrink(s.wins, s.matches_played, exp, 150);
    pairs.set(`${s.hero_id1}:${s.hero_id2}`, v);
    pairs.set(`${s.hero_id2}:${s.hero_id1}`, v);
  }
  const vs = new Map<string, number>();
  for (const c of counters) {
    const exp = wr(c.hero_id);
    vs.set(`${c.hero_id}:${c.enemy_hero_id}`, shrink(c.wins, c.matches_played, exp, 150));
  }
  for (const c of counters) {
    const rev = `${c.enemy_hero_id}:${c.hero_id}`;
    if (!vs.has(rev)) vs.set(rev, shrink(c.matches_played - c.wins, c.matches_played, wr(c.enemy_hero_id), 150));
  }
  return { heroWr, pairWr: (a, b) => pairs.get(`${a}:${b}`) ?? null, vsWr: (a, b) => vs.get(`${a}:${b}`) ?? null };
}

export interface DraftBreakdown {
  strength: number;
  synergy: number;
  counter: number;
  edge: number;
  winProbability: number;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

function teamStrength(ctx: DraftContext, t: number[]) {
  return mean(t.map((h) => (ctx.heroWr.get(h) ?? 0.5) - 0.5));
}

function teamSynergy(ctx: DraftContext, t: number[]) {
  const ds: number[] = [];
  for (let i = 0; i < t.length; i++)
    for (let j = i + 1; j < t.length; j++) {
      const p = ctx.pairWr(t[i], t[j]);
      if (p != null) ds.push(p - ((ctx.heroWr.get(t[i]) ?? 0.5) + (ctx.heroWr.get(t[j]) ?? 0.5)) / 2);
    }
  return mean(ds);
}

function teamCounter(ctx: DraftContext, a: number[], b: number[]) {
  const ds: number[] = [];
  for (const i of a)
    for (const j of b) {
      const v = ctx.vsWr(i, j);
      if (v != null) ds.push(v - (ctx.heroWr.get(i) ?? 0.5));
    }
  return mean(ds);
}

export function evaluateDraft(ctx: DraftContext, a: number[], b: number[]): DraftBreakdown {
  const strength = teamStrength(ctx, a) - teamStrength(ctx, b);
  const synergy = teamSynergy(ctx, a) - teamSynergy(ctx, b);
  const counter = b.length && a.length ? teamCounter(ctx, a, b) - teamCounter(ctx, b, a) : 0;
  const edge = strength + synergy + counter;
  return { strength, synergy, counter, edge, winProbability: Math.min(0.95, Math.max(0.05, 0.5 + edge)) };
}

export interface PickSuggestion {
  heroId: number;
  after: DraftBreakdown;
  gain: number;
  synergyWithAllies: number;
  vsEnemies: number;
}

export function suggestPicks(ctx: DraftContext, a: number[], b: number[], pool: number[], limit = 6): PickSuggestion[] {
  const before = evaluateDraft(ctx, a, b).edge;
  const taken = new Set([...a, ...b]);
  return pool
    .filter((h) => !taken.has(h))
    .map((h) => {
      const after = evaluateDraft(ctx, [...a, h], b);
      const syn = mean(a.map((x) => ctx.pairWr(h, x)).filter((v): v is number => v != null).map((v) => v - (ctx.heroWr.get(h) ?? 0.5)));
      const vsE = mean(b.map((x) => ctx.vsWr(h, x)).filter((v): v is number => v != null).map((v) => v - (ctx.heroWr.get(h) ?? 0.5)));
      return { heroId: h, after, gain: after.edge - before, synergyWithAllies: syn, vsEnemies: vsE };
    })
    .sort((x, y) => y.gain - x.gain)
    .slice(0, limit);
}

/** Heroes the enemy would gain most from (= best bans for team A). */
export function suggestBans(ctx: DraftContext, a: number[], b: number[], pool: number[], limit = 5) {
  return suggestPicks(ctx, b, a, pool, limit).map((s) => ({ heroId: s.heroId, enemyGain: s.gain, vsUs: s.vsEnemies }));
}
