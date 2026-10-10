import type { DeadlockClient, FetchInit } from "./api";
import { winrate } from "./stats";
import type { MatchHistoryEntry, PlayerHeroStats } from "./types";

export const isWin = (m: MatchHistoryEntry) => m.match_result === m.player_team;

export interface HeroPoolEntry {
  heroId: number;
  matches: number;
  winrate: number;
  kda: number;
  lastPlayed: number;
}

export interface PlayerScout {
  accountId: number;
  name: string | null;
  avatar: string | null;
  profileUrl: string | null;
  badge: number; // tier*10 + subrank, 0 = unknown
  totalMatches: number;
  overallWinrate: number;
  recent: {
    matches: number;
    winrate: number;
    kda: number;
    /** +3 = won last 3, -2 = lost last 2 */
    streak: number;
    lastMatchAt: number | null;
  };
  heroPool: HeroPoolEntry[];
  /** Stats on the hero they are playing right now, if heroId was provided. */
  currentHero: HeroPoolEntry | null;
  /** Rough threat flags, used for highlighting in the UI. */
  flags: string[];
  error?: string;
}

export interface ScoutTarget {
  accountId: number;
  heroId?: number | null;
}

async function mapLimit<T, R>(xs: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, xs.length) }, async () => {
    while (next < xs.length) {
      const i = next++;
      out[i] = await fn(xs[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

function poolEntry(h: PlayerHeroStats): HeroPoolEntry {
  return {
    heroId: h.hero_id,
    matches: h.matches_played,
    winrate: winrate(h.wins, h.matches_played),
    kda: (h.kills + h.assists) / Math.max(1, h.deaths),
    lastPlayed: h.last_played,
  };
}

/**
 * Builds a scouting card per player. Cost: 3 batched calls + 1 match-history call per player.
 * Designed for a 12-player lobby (the desktop overlay calls this through /api/scout).
 */
export async function scoutPlayers(
  client: DeadlockClient,
  targets: ScoutTarget[],
  opts: { recentN?: number; init?: FetchInit } = {},
): Promise<PlayerScout[]> {
  const recentN = opts.recentN ?? 20;
  const ids = [...new Set(targets.map((t) => t.accountId))].slice(0, 12);
  if (ids.length === 0) return [];

  const [profiles, ranks, heroStats] = await Promise.all([
    client.steamProfiles(ids, opts.init).catch(() => []),
    client.playerRanks(ids, opts.init).catch(() => []),
    client.playerHeroStats(ids, {}, opts.init).catch(() => []),
  ]);

  const histories = await mapLimit(ids, 4, (id) =>
    client.matchHistory(id, opts.init).then(
      (h) => ({ id, h, err: undefined as string | undefined }),
      (e: unknown) => ({ id, h: [] as MatchHistoryEntry[], err: e instanceof Error ? e.message : String(e) }),
    ),
  );

  return ids.map((accountId) => {
    const target = targets.find((t) => t.accountId === accountId);
    const profile = profiles.find((p) => p.account_id === accountId);
    const rank = ranks.find((r) => r.account_id === accountId);
    const pool = heroStats
      .filter((h) => h.account_id === accountId && h.matches_played > 0)
      .map(poolEntry)
      .sort((a, b) => b.matches - a.matches);
    const hist = histories.find((x) => x.id === accountId)!;

    const recent = [...hist.h].sort((a, b) => b.start_time - a.start_time).slice(0, recentN);
    const recentWins = recent.filter(isWin).length;
    let streak = 0;
    for (const m of recent) {
      const w = isWin(m);
      if (streak === 0) streak = w ? 1 : -1;
      else if (w && streak > 0) streak++;
      else if (!w && streak < 0) streak--;
      else break;
    }
    const k = recent.reduce((s, m) => s + m.player_kills, 0);
    const d = recent.reduce((s, m) => s + m.player_deaths, 0);
    const a = recent.reduce((s, m) => s + m.player_assists, 0);

    const totalMatches = pool.reduce((s, h) => s + h.matches, 0);
    const totalWins = heroStats
      .filter((h) => h.account_id === accountId)
      .reduce((s, h) => s + h.wins, 0);
    const currentHero = target?.heroId != null ? pool.find((p) => p.heroId === target.heroId) ?? null : null;

    const flags: string[] = [];
    if (currentHero && currentHero.matches >= 100) flags.push("main");
    if (currentHero && currentHero.matches < 5) flags.push("new-on-hero");
    if (recent.length >= 10 && recentWins / recent.length >= 0.65) flags.push("hot");
    if (streak <= -4) flags.push("tilted");
    if (totalMatches > 0 && totalMatches < 30) flags.push("low-sample");

    return {
      accountId,
      name: profile?.personaname ?? null,
      avatar: profile?.avatarmedium ?? null,
      profileUrl: profile?.profileurl ?? null,
      badge: rank?.badge ?? 0,
      totalMatches,
      overallWinrate: winrate(totalWins, totalMatches),
      recent: {
        matches: recent.length,
        winrate: winrate(recentWins, recent.length),
        kda: (k + a) / Math.max(1, d),
        streak,
        lastMatchAt: recent[0]?.start_time ?? null,
      },
      heroPool: pool.slice(0, 5),
      currentHero,
      flags,
      error: hist.err,
    };
  });
}
