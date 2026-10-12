import "server-only";
import { cache } from "react";
import {
  buildDraftContext,
  buildHeroMeta,
  createClient,
  daysAgo,
  getCounterItems,
  fetchPhaseCounterRows,
  fetchImbueData,
  scorePhaseCounter,
  getHeroPhases,
  getTopBuilds,
  isLiveHero,
  parsePatch,
  type ParsedPatch,
  scoutPlayers,
  type FetchInit,
  type Hero,
  type Item,
  type Rank,
  type ScoutTarget,
} from "@deadlock/core";
import { diskFallback } from "./disk-cache";
import { AUTO, SINCE_PATCH, type Filters } from "./filters";

export const api = createClient({
  baseUrl: process.env.DEADLOCK_API_BASE || undefined,
  apiKey: process.env.DEADLOCK_API_KEY || undefined,
  // offline: last good answer from disk instead of an empty overlay
  fallback: diskFallback,
});

// Cache windows. Analytics on deadlock-api itself are cached 6h per query,
// so refreshing more often than ~10 min gains nothing.
// Assets are 2–8 MB (over Next's 2 MB data-cache limit) and memoised in-process for an
// hour below, so new heroes/items show up within an hour of a patch.
const ASSETS: FetchInit = { cache: "no-store" };
const META: FetchInit = { next: { revalidate: 600 } };
const PLAYER: FetchInit = { next: { revalidate: 120 } };

/**
 * Process-wide memo with TTL. The asset endpoints are 2–8 MB, above Next's 2 MB data
 * cache limit, so without this every page view and every live-coach POST (each ~10 s)
 * re-downloaded them. Failed loads are not kept. Lives on globalThis so dev reloads
 * don't drop it.
 */
type MemoEntry = { at: number; ttl: number; p: Promise<unknown>; lastGood?: unknown };
const MAX_MEMO_ENTRIES = 200;
const MEMO: Map<string, MemoEntry> = ((globalThis as Record<string, unknown>).__dlMemo ??= new Map()) as Map<string, MemoEntry>;

function sweepMemo() {
  const now = Date.now();
  for (const [k, e] of MEMO.entries()) {
    if (now - e.at >= e.ttl) {
      MEMO.delete(k);
    }
  }
  while (MEMO.size >= MAX_MEMO_ENTRIES) {
    const oldest = MEMO.keys().next().value;
    if (!oldest) break;
    MEMO.delete(oldest);
  }
}

export function memo<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = MEMO.get(key);
  if (hit && Date.now() - hit.at < ttlMs) {
    // Refresh LRU position
    MEMO.delete(key);
    MEMO.set(key, hit);
    return hit.p as Promise<T>;
  }
  const rawP = load();
  const p = rawP
    .then((val) => {
      const entry = MEMO.get(key);
      if (entry && entry.p === p) {
        entry.lastGood = val;
      }
      return val;
    })
    .catch((err) => {
      const entry = MEMO.get(key);
      if (entry && entry.p === p) {
        if (entry.lastGood !== undefined) {
          // Stale-while-error: serve last good result, retry in 60s
          console.warn(`[memo:${key}] refresh failed, serving stale cache:`, err);
          entry.at = Date.now() - ttlMs + 60_000;
          entry.p = Promise.resolve(entry.lastGood);
          return entry.lastGood as T;
        }
        MEMO.delete(key);
      }
      throw err;
    });

  if (MEMO.size >= MAX_MEMO_ENTRIES) {
    sweepMemo();
  }
  MEMO.delete(key);
  MEMO.set(key, { at: Date.now(), ttl: ttlMs, p, lastGood: hit?.lastGood });
  return p;
}
const ASSET_TTL = 3600_000;

/** Heroes per hero-stats over the last 7 days, to detect newly released heroes. */
const playedHeroes = () =>
  memo("played-heroes", 3600_000, async () => {
    const rows = await api.heroStats({ min_unix_timestamp: daysAgo(7) }, META);
    return new Map(rows.map((r) => [r.hero_id, r.matches]));
  });

/**
 * Selectable heroes. New heroes often keep Valve's `in_development` flag for a while
 * after release; they are included as soon as they show up in real matches, so a new
 * hero appears without any code change.
 */
export const getHeroes = cache(async (): Promise<Hero[]> =>
  memo("heroes", ASSET_TTL, async () => {
    const [hs, played] = await Promise.all([api.heroes(ASSETS), playedHeroes().catch(() => new Map<number, number>())]);
    return hs.filter((h) => isLiveHero(h, played.get(h.id) ?? 0)).sort((a, b) => a.name.localeCompare(b.name));
  }),
);

/** Ids of heroes that are live (see getHeroes), for other loaders (Build Lab). */
export const getLiveHeroIds = cache(async () => new Set((await getHeroes()).map((h) => h.id)));

// ---------- patches ----------

export const getPatches = cache(() => memo("patches", 15 * 60_000, () => api.patches({ next: { revalidate: 900 } })).catch(() => []));

/** Patch feed parsed into hero/item lines, newest first. */
export const getParsedPatches = cache(async (): Promise<ParsedPatch[]> => {
  const [feed, heroes, items] = await Promise.all([getPatches(), getHeroes(), getItems()]);
  const shop = items.filter((i) => i.type === "upgrade" && i.shopable);
  return feed
    .map((p) => parsePatch(p, heroes, shop))
    .filter((p) => p.lines.length)
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
});

/** Unix time of the latest big patch day (≤ now), or null. */
export const getLatestPatchTs = cache(async (): Promise<number | null> => {
  const days = await memo("big-days", 15 * 60_000, () => api.patchBigDays({ next: { revalidate: 900 } })).catch(() => [] as string[]);
  const now = Date.now();
  const ts = days.map((d) => Date.parse(d)).filter((t) => Number.isFinite(t) && t <= now);
  return ts.length ? Math.floor(Math.max(...ts) / 1000) : null;
});

export const getHeroMap = cache(async () => new Map((await getHeroes()).map((h) => [h.id, h])));

export const getItems = cache(async (): Promise<Item[]> => memo("items", ASSET_TTL, () => api.items(ASSETS)));

export const getItemMap = cache(async () => new Map((await getItems()).map((i) => [i.id, i])));

export const getRanks = cache(async (): Promise<Rank[]> =>
  memo("ranks", ASSET_TTL, async () => (await api.ranks(ASSETS)).sort((a, b) => a.tier - b.tier)),
);

/** A patch needs this long before "since patch" has enough matches to trust. */
const AUTO_MIN_PATCH_AGE_S = 2 * 86400;

/**
 * Start of the analytics window:
 *  - AUTO (default): since the last big patch once it is ≥ 2 days old (current balance,
 *    enough matches); right after a patch, the last 7 days instead.
 *  - SINCE_PATCH: since the last big patch.
 *  - N: the last N days.
 */
export async function windowStart(days: number): Promise<number> {
  if (days === AUTO) {
    const ts = await getLatestPatchTs();
    const now = Math.floor(Date.now() / 1000);
    if (ts && now - ts >= AUTO_MIN_PATCH_AGE_S) return ts - (ts % 3600);
    return daysAgo(7);
  }
  if (days === SINCE_PATCH) {
    const ts = await getLatestPatchTs();
    // round down to the hour so the query string (and caches) stay stable
    if (ts) return ts - (ts % 3600);
    return daysAgo(7);
  }
  return daysAgo(days);
}

async function analyticsQuery(f: Filters) {
  return {
    min_unix_timestamp: await windowStart(f.days),
    min_average_badge: f.badge || undefined,
  };
}

export const getHeroMeta = cache(async (days: number, badge: number) => {
  const rows = await api.heroStats((await analyticsQuery({ days, badge })), META);
  return buildHeroMeta(rows);
});

export const getHeroItemStats = cache(async (heroId: number, days: number, badge: number) =>
  api.itemStats({ ...(await analyticsQuery({ days, badge })), hero_id: heroId, min_matches: 50 }, META),
);

export const getCounterMatrix = cache(async (days: number, badge: number) =>
  api.heroCounterStats({ ...(await analyticsQuery({ days, badge })), same_lane_filter: false, min_matches: 50 }, META),
);

export const getSynergy = cache(async (days: number, badge: number) =>
  api.heroSynergyStats({ ...(await analyticsQuery({ days, badge })), min_matches: 50 }, META),
);

export async function getCounter(heroId: number | undefined, enemies: number[], f: Filters, enemyWeights?: Map<number, number>) {
  const items = await getItems();
  return getCounterItems(
    api,
    items,
    {
      heroId,
      enemyHeroIds: enemies,
      minAverageBadge: f.badge || undefined,
      minUnixTimestamp: await windowStart(f.days),
      enemyWeights,
    },
    META,
  );
}

/**
 * Counter items scored per game phase + an ordered buy plan. The 4 × (1 + enemies)
 * fetches are memoised per lineup for 10 min (the live coach re-asks every ~10 s);
 * scoring with fresh enemy weights runs every call.
 */
export async function getPhaseCounter(heroId: number | undefined, enemies: number[], f: Filters, enemyWeights?: Map<number, number>) {
  const ids = [...new Set(enemies)].sort((a, b) => a - b);
  const key = `pc:${heroId ?? 0}:${ids.join(",")}:${f.days}:${f.badge}`;
  const [items, rows] = await Promise.all([
    getItems(),
    memo(key, 600_000, async () =>
      fetchPhaseCounterRows(api, { heroId, enemyHeroIds: ids, minAverageBadge: f.badge || undefined, minUnixTimestamp: await windowStart(f.days) }, META),
    ),
  ]);
  return scorePhaseCounter(rows, items, enemyWeights);
}

export async function getScout(targets: ScoutTarget[]) {
  return scoutPlayers(api, targets, { init: PLAYER });
}

export const getPhases = cache(async (days: number, badge: number) =>
  getHeroPhases(api, (await analyticsQuery({ days, badge })), META),
);

export const getBuilds = cache(async (heroId: number, days: number, badge: number) =>
  getTopBuilds(api, heroId, (await analyticsQuery({ days, badge })), { limit: 5, init: META }),
);

// ---------- advanced analytics ----------

/** Imbue targets of the most-played builds (6 h memo: ~30 build lookups per hero). */
export const getImbueData = cache(async (heroId: number, days: number, badge: number) => {
  const q = await analyticsQuery({ days, badge });
  return memo(`imbue:${heroId}:${q.min_unix_timestamp}:${badge}`, 6 * 3600_000, () => fetchImbueData(api, heroId, q, META));
});

export const getAbilityOrders = cache(async (heroId: number, days: number, badge: number) =>
  api.abilityOrderStats(heroId, { ...(await analyticsQuery({ days, badge })), min_matches: 20 }, META),
);

/** 5-minute purchase phases, 8 columns (0–35 min+). */
export const ITEM_PHASE_S = 300;
export const getItemFlow = cache(async (heroId: number, days: number, badge: number) =>
  api.itemFlowStats(
    { ...(await analyticsQuery({ days, badge })), hero_ids: String(heroId), phase_interval_s: ITEM_PHASE_S, phase_count: 8, min_matches: 20 },
    META,
  ),
);

/** Current window vs the window before it, plus bans, for the Meta Detector. */
export const getMetaWindows = cache(async (days: number, badge: number) => {
  // previous window of equal length (for "since patch": the same span before the patch)
  const start = await windowStart(days);
  const span = Math.floor(Date.now() / 1000) - start;
  const prevQ = { min_unix_timestamp: start - span, max_unix_timestamp: start, min_average_badge: badge || undefined };
  const [now, prev, bans] = await Promise.all([
    api.heroStats((await analyticsQuery({ days, badge })), META),
    api.heroStats(prevQ, META),
    api.heroBanStats((await analyticsQuery({ days, badge })), META).catch(() => []),
  ]);
  return { now, prev, bans };
});

export const getDraftContext = cache(async (days: number, badge: number) => {
  const [{ now }, synergy, counters] = await Promise.all([getMetaWindows(days, badge), getSynergy(days, badge), getCounterMatrix(days, badge)]);
  return buildDraftContext(now, synergy, counters);
});

/** Human description of the window, shown under the filter. */
export async function describeWindow(days: number): Promise<string> {
  const start = await windowStart(days);
  const ts = await getLatestPatchTs();
  const date = (t: number) => new Date(t * 1000).toLocaleDateString("id-ID", { day: "numeric", month: "short", timeZone: "Asia/Jakarta" });
  const span = Math.max(1, Math.round((Date.now() / 1000 - start) / 86400));
  if (ts && start === ts - (ts % 3600)) return `Data sejak patch ${date(ts)} (${span} hari)`;
  if (days === AUTO && ts) {
    const h = Math.round((Date.now() / 1000 - ts) / 3600);
    return `Patch baru ${h} jam lalu, data belum cukup → pakai 7 hari terakhir (masih campur sebelum patch)`;
  }
  return `Data ${span} hari terakhir${ts && start < ts ? ` (termasuk sebelum patch ${date(ts)})` : ""}`;
}

// ---------- personal ----------

/** Valve match metadata for one match (finished matches don't change: keep a day). */
export const getMatchMeta = cache((matchId: number) =>
  memo(`meta:${matchId}`, 86400_000, () => api.matchMetadata(matchId, { cache: "no-store" })),
);

export const getMatchHistory = cache((accountId: number) =>
  // errors are not memoised (memo drops rejected promises), so a blip doesn't stick for minutes
  memo(`hist:${accountId}`, 120_000, () => api.matchHistory(accountId, PLAYER)).catch(() => []),
);

export const getPlayerHeroes = cache((accountId: number) =>
  memo(`ph:${accountId}`, 600_000, () => api.playerHeroStats([accountId], {}, PLAYER)).catch(() => []),
);

/**
 * My hero (with any partner) vs the enemy lane duo at `sampleS` seconds: mean souls
 * lead of the duo, win rate. Upstream endpoint is marked unstable, so failures → null.
 */
export async function getLaneMatchup(heroId: number, enemyHeroIds: number[], f: Filters, sampleS = 600) {
  if (!enemyHeroIds.length) return null;
  const enemies = [...new Set(enemyHeroIds)].sort((a, b) => a - b).slice(0, 2);
  const key = `lane:${heroId}:${enemies.join(",")}:${f.badge}:${sampleS}`;
  return memo(key, 600_000, async () => {
    const rows = await api
      .laneMatchupStats(
        {
          hero_ids: String(heroId),
          enemy_hero_ids: enemies.join(","),
          group_by: "enemy_hero_ids",
          sample_time_s: sampleS,
          min_unix_timestamp: await windowStart(f.days),
          min_average_badge: f.badge || undefined,
          min_matches: 10,
        },
        META,
      );
    // prefer the exact enemy duo, else any duo containing them
    const exact = rows.find((r) => r.enemy_hero_ids.length === enemies.length && enemies.every((e) => r.enemy_hero_ids.includes(e)));
    const pick = exact ?? rows.sort((a, b) => b.matches_played - a.matches_played)[0];
    return pick ? { netWorthDiff: pick.net_worth_diff, winrate: pick.matches_played ? pick.wins / pick.matches_played : 0.5, matches: pick.matches_played, sampleMatches: pick.sample_matches, sampleS } : null;
  }).catch(() => null);
}
