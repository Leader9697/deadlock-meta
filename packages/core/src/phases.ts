import type { DeadlockClient, FetchInit, Query } from "./api";
import { wilsonLower, winrate } from "./stats";
import type { HeroBuild } from "./types";

/**
 * Game phases by *match length*. A hero with high WR in short matches closes games
 * early; high WR in long matches means it scales. Boundaries are seconds.
 */
export const PHASES = [
  { key: "early", label: "Early (<28m)", min: 0, max: 1680 },
  { key: "mid", label: "Mid (28–36m)", min: 1680, max: 2160 },
  { key: "late", label: "Late (>36m)", min: 2160, max: 7000 },
] as const;

export type PhaseKey = (typeof PHASES)[number]["key"];

export interface PhaseStat {
  matches: number;
  winrate: number;
}

export interface HeroPhases {
  heroId: number;
  phases: Record<PhaseKey, PhaseStat>;
  /** Phase with the highest WR, if the spread is meaningful (>2 pts). */
  peak: PhaseKey | null;
  /** late WR − early WR. Positive = scales, negative = falls off. */
  scaling: number;
}

/** 3 analytics calls → phase win rates for every hero. */
export async function getHeroPhases(client: DeadlockClient, base: Query, init?: FetchInit): Promise<Map<number, HeroPhases>> {
  const rows = await Promise.all(
    PHASES.map((p) => client.heroStats({ ...base, min_duration_s: p.min, max_duration_s: p.max }, init)),
  );
  const out = new Map<number, HeroPhases>();
  PHASES.forEach((p, i) => {
    for (const r of rows[i]) {
      const h =
        out.get(r.hero_id) ??
        ({
          heroId: r.hero_id,
          phases: { early: { matches: 0, winrate: 0 }, mid: { matches: 0, winrate: 0 }, late: { matches: 0, winrate: 0 } },
          peak: null,
          scaling: 0,
        } satisfies HeroPhases);
      h.phases[p.key] = { matches: r.matches, winrate: winrate(r.wins, r.matches) };
      out.set(r.hero_id, h);
    }
  });
  for (const h of out.values()) {
    const entries = PHASES.map((p) => [p.key, h.phases[p.key].winrate] as const);
    const best = entries.reduce((a, b) => (b[1] > a[1] ? b : a));
    const worst = entries.reduce((a, b) => (b[1] < a[1] ? b : a));
    h.peak = best[1] - worst[1] > 0.02 ? best[0] : null;
    h.scaling = h.phases.late.winrate - h.phases.early.winrate;
  }
  return out;
}

export interface RankedBuild {
  build: HeroBuild;
  matches: number;
  winrate: number;
  wilson: number;
  players: number;
}

/**
 * Best in-game builds for a hero by real match results (demo analysis), ranked by
 * the Wilson lower bound so a 12-match build cannot outrank a 2,000-match one.
 */
export async function getTopBuilds(
  client: DeadlockClient,
  heroId: number,
  base: Query,
  opts: { limit?: number; minMatches?: number; init?: FetchInit } = {},
): Promise<RankedBuild[]> {
  const stats = await client.heroBuildStats(heroId, { ...base, min_matches: opts.minMatches ?? 30 }, opts.init);
  const top = stats
    .map((s) => ({ s, wilson: wilsonLower(s.wins, s.matches) }))
    .sort((a, b) => b.wilson - a.wilson)
    .slice(0, opts.limit ?? 5);

  const details = await Promise.all(
    top.map(({ s }) =>
      client
        .builds({ build_id: s.hero_build_id, only_latest: true, limit: 1 }, opts.init)
        .then((b) => b[0]?.hero_build ?? null)
        .catch(() => null),
    ),
  );

  return top.flatMap(({ s, wilson }, i) =>
    details[i]
      ? [{ build: details[i]!, matches: s.matches, winrate: winrate(s.wins, s.matches), wilson, players: s.players }]
      : [],
  );
}
