import type {
  AbilityOrderStats,
  AccountRank,
  HeroBanStats,
  HeroCombStats,
  ItemFlowStats,
  ItemPermutationStats,
  ActiveMatch,
  AnalyticsHeroStats,
  Build,
  Hero,
  HeroBuildStats,
  HeroCounterStats,
  HeroSynergyStats,
  Item,
  ItemStats,
  MatchHistoryEntry,
  PlayerHeroStats,
  Rank,
  SteamProfile,
} from "./types";

export interface LaneMatchupRow {
  assigned_lane: number;
  hero_ids: number[];
  enemy_hero_ids: number[];
  wins: number;
  matches_played: number;
  sample_time_s: number;
  net_worth_diff: number;
  sample_matches: number;
}

export interface PatchNote {
  source: "forum" | "steam";
  title: string;
  pub_date: string;
  link: string;
  content?: string;
  content_encoded?: string;
  guid?: { text: string };
}

/** A hero is shown if Valve marks it released, or if it is actually being played. */
export const isLiveHero = (h: Hero, playedMatches = 0) => h.player_selectable && !h.disabled && (!h.in_development || playedMatches >= 50);

export const DEFAULT_API_BASE = "https://api.deadlock-api.com";

type QueryValue = string | number | boolean | null | undefined | Array<string | number>;
export type Query = Record<string, QueryValue>;

/**
 * Extra fetch options. In Next.js pass `{ next: { revalidate: 600 } }` to cache;
 * the core package stays framework-agnostic so the Tauri app can reuse it.
 */
export type FetchInit = RequestInit & { timeoutMs?: number; retries?: number } & Record<string, unknown>;

export class DeadlockApiError extends Error {
  constructor(
    public status: number,
    public url: string,
    body: string,
  ) {
    super(`deadlock-api ${status} on ${url}: ${body.slice(0, 200)}`);
  }
}

export interface ClientOptions {
  baseUrl?: string;
  apiKey?: string;
  /** Default init merged into every request (e.g. Next.js cache settings). */
  init?: FetchInit;
  fetchImpl?: typeof fetch;
  /**
   * Last-good copy of responses (e.g. on disk), used when deadlock-api cannot be reached
   * after all retries. Keys are the request URL without its time window, so a copy from an
   * hour ago still matches. Live endpoints (active matches) never fall back.
   */
  fallback?: ResponseFallback;
}

export interface ResponseFallback {
  load(key: string): Promise<unknown | undefined>;
  save(key: string, data: unknown): Promise<void> | void;
}

/** URL without the rolling time window, so last-good copies survive the hourly rounding. */
export function fallbackKey(url: string): string {
  const [path, qs = ""] = url.split("?");
  const params = new URLSearchParams(qs);
  params.delete("min_unix_timestamp");
  params.delete("max_unix_timestamp");
  params.sort();
  const rest = params.toString();
  return rest ? `${path}?${rest}` : path;
}

/** Paths whose old answer would be wrong rather than just stale. */
const NO_FALLBACK = ["/v1/matches/active"];

export function buildQuery(q: Query = {}): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) {
      if (v.length === 0) continue;
      params.set(k, v.join(","));
    } else {
      params.set(k, String(v));
    }
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

/**
 * Timestamp N days ago, rounded down to the hour. Rounding keeps the query string
 * stable for an hour so both our cache and deadlock-api's 6h cache get hits.
 */
export function daysAgo(days: number, now = Date.now()): number {
  const t = Math.floor(now / 1000) - days * 86400;
  return t - (t % 3600);
}

export function createClient(opts: ClientOptions = {}) {
  const base = (opts.baseUrl ?? DEFAULT_API_BASE).replace(/\/$/, "");
  const doFetch = opts.fetchImpl ?? fetch;

  async function get<T>(path: string, query?: Query, init?: FetchInit): Promise<T> {
    const url = `${base}${path}${buildQuery(query)}`;
    const fb = opts.fallback && !NO_FALLBACK.some((p) => path.startsWith(p)) ? opts.fallback : null;
    if (!fb) return fetchJson<T>(url, init);
    const key = fallbackKey(`${path}${buildQuery(query)}`);
    try {
      const data = await fetchJson<T>(url, init);
      try {
        await fb.save(key, data);
      } catch {
        // a read-only disk must not break a good answer
      }
      return data;
    } catch (err) {
      // a 4xx is a real answer (bad request, unknown id), not an outage
      if (err instanceof DeadlockApiError && err.status >= 400 && err.status < 500 && err.status !== 429) throw err;
      const old = await fb.load(key).catch(() => undefined);
      if (old !== undefined) {
        console.warn(`[deadlock-api] ${path} unreachable, using the last saved copy:`, err instanceof Error ? err.message : err);
        return old as T;
      }
      throw err;
    }
  }

  async function fetchJson<T>(url: string, init?: FetchInit): Promise<T> {
    const headers = new Headers(opts.init?.headers as HeadersInit | undefined);
    headers.set("accept", "application/json");
    if (opts.apiKey) headers.set("X-API-KEY", opts.apiKey);

    const maxRetries = typeof init?.retries === "number" ? init.retries : 2;
    const timeoutMs = typeof init?.timeoutMs === "number" ? init.timeoutMs : 10_000;
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const controller = new AbortController();
        timer = setTimeout(() => controller.abort(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs);

        if (init?.signal) {
          init.signal.addEventListener("abort", () => controller.abort(init.signal?.reason));
        }

        const res = await doFetch(url, { ...opts.init, ...init, headers, signal: controller.signal });
        clearTimeout(timer);

        // Respect rate limits (429)
        if (res.status === 429) {
          const retryHeader = res.headers.get("retry-after");
          const retrySec = retryHeader ? parseInt(retryHeader, 10) : (attempt + 1) * 2;
          const waitMs = Math.min(Math.max(1000, (Number.isNaN(retrySec) ? 2 : retrySec) * 1000), 10_000);
          if (attempt < maxRetries) {
            await new Promise((r) => setTimeout(r, waitMs));
            continue;
          }
          throw new DeadlockApiError(res.status, url, await res.text().catch(() => "Rate limit exceeded (429)"));
        }

        // 5xx errors: transient server problems, retry with backoff
        if (res.status >= 500) {
          if (attempt < maxRetries) {
            await new Promise((r) => setTimeout(r, (attempt + 1) * 1000));
            continue;
          }
          throw new DeadlockApiError(res.status, url, await res.text().catch(() => ""));
        }

        if (!res.ok) {
          throw new DeadlockApiError(res.status, url, await res.text().catch(() => ""));
        }

        return (await res.json()) as T;
      } catch (err) {
        if (timer) clearTimeout(timer);
        lastError = err;

        // If it's a DeadlockApiError with non-retryable 4xx (except 429), throw immediately
        if (err instanceof DeadlockApiError && err.status >= 400 && err.status < 500 && err.status !== 429) {
          throw err;
        }

        // Retry transient network errors or timeouts
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, (attempt + 1) * 1000));
          continue;
        }
        throw err;
      }
    }

    throw lastError;
  }

  return {
    get,

    // ---------- assets ----------
    /** Every selectable hero, including ones Valve still flags `in_development`
     *  (new heroes often keep that flag after release); filter with `isLiveHero`. */
    heroes: (init?: FetchInit) =>
      get<Hero[]>("/v1/assets/heroes", { only_active: true }, init).then((hs) => hs.filter((h) => h.player_selectable && !h.disabled)),
    /** Forum changelog + Steam news, newest first. */
    patches: (init?: FetchInit) => get<PatchNote[]>("/v2/patches", undefined, init),
    /** Dates (ISO) of the big, usually bi-weekly, patch days. */
    patchBigDays: (init?: FetchInit) => get<string[]>("/v1/patches/big-days", undefined, init),
    items: (init?: FetchInit) => get<Item[]>("/v1/assets/items", undefined, init),
    ranks: (init?: FetchInit) => get<Rank[]>("/v1/assets/ranks", undefined, init),

    // ---------- analytics ----------
    heroStats: (q: Query, init?: FetchInit) =>
      get<AnalyticsHeroStats[]>("/v1/analytics/hero-stats", q, init),
    itemStats: (q: Query, init?: FetchInit) => get<ItemStats[]>("/v1/analytics/item-stats", q, init),
    heroCounterStats: (q: Query, init?: FetchInit) =>
      get<HeroCounterStats[]>("/v1/analytics/hero-counter-stats", q, init),
    heroSynergyStats: (q: Query, init?: FetchInit) =>
      get<HeroSynergyStats[]>("/v1/analytics/hero-synergy-stats", q, init),

    heroBuildStats: (heroId: number, q: Query, init?: FetchInit) =>
      get<HeroBuildStats[]>(`/v1/analytics/hero-build-stats/${heroId}`, q, init),
    builds: (q: Query, init?: FetchInit) => get<Build[]>("/v1/builds", q, init),
    abilityOrderStats: (heroId: number, q: Query, init?: FetchInit) =>
      get<AbilityOrderStats[]>("/v1/analytics/ability-order-stats", { ...q, hero_id: heroId }, init),
    itemFlowStats: (q: Query, init?: FetchInit) => get<ItemFlowStats>("/v1/analytics/item-flow-stats", q, init),
    heroBanStats: (q: Query, init?: FetchInit) => get<HeroBanStats[]>("/v1/analytics/hero-ban-stats", q, init),
    heroCombStats: (q: Query, init?: FetchInit) => get<HeroCombStats[]>("/v1/analytics/hero-comb-stats", q, init),
    itemPermutationStats: (q: Query, init?: FetchInit) =>
      get<ItemPermutationStats[]>("/v1/analytics/item-permutation-stats", q, init),

    // ---------- players ----------
    playerRanks: (accountIds: number[], init?: FetchInit) =>
      get<AccountRank[]>("/v1/players/rank", { account_ids: accountIds }, init),
    steamProfiles: (accountIds: number[], init?: FetchInit) =>
      get<SteamProfile[]>("/v1/players/steam", { account_ids: accountIds }, init),
    steamSearch: (query: string, init?: FetchInit) =>
      get<SteamProfile[]>("/v1/players/steam-search", { search_query: query, limit: 20 }, init),
    playerHeroStats: (accountIds: number[], q: Query = {}, init?: FetchInit) =>
      get<PlayerHeroStats[]>("/v1/players/hero-stats", { ...q, account_ids: accountIds }, init),
    /** Valve match metadata (players, items with times, stats over time, deaths). */
    matchMetadata: (matchId: number, init?: FetchInit) => get<unknown>(`/v1/matches/${matchId}/metadata`, undefined, init),
    /** Duo-vs-duo lane stats (unstable endpoint upstream). */
    laneMatchupStats: (q: Query, init?: FetchInit) => get<LaneMatchupRow[]>("/v1/analytics/lane-matchup-stats", q, init),
    matchHistory: (accountId: number, init?: FetchInit) =>
      get<MatchHistoryEntry[]>(`/v1/players/${accountId}/match-history`, undefined, init),

    // ---------- live ----------
    /** Only covers the in-game Watch tab (top ~200 matches). */
    activeMatches: (accountIds?: number[], init?: FetchInit) =>
      get<ActiveMatch[]>("/v1/matches/active", { account_ids: accountIds }, init),
  };
}

export type DeadlockClient = ReturnType<typeof createClient>;
