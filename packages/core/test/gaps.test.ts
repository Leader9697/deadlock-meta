import { describe, expect, it, vi } from "vitest";
import { createClient, fallbackKey, type ResponseFallback } from "../src/api";
import type { CounterResult } from "../src/counter";
import { BRAWL_COUNT_AFTER_S, detectMode, nextBuys, type LivePlayer, type LiveState } from "../src/live";
import { activeLaneIndexes, countDestroyedStages } from "../src/macro";
import { backfillOutcomes, calibrate, won, type LogSnapshot, type MatchLog } from "../src/matchlog";
import type { Item } from "../src/types";

const snap = (t: number, winP: number | null, winRaw?: number | null): LogSnapshot => ({
  t,
  winP,
  ...(winRaw !== undefined ? { winRaw } : {}),
  lead: 0,
  tips: [],
  next: [],
  needs: [],
  items: [],
  deaths: 0,
});

const log = (matchId: number, team: number, winningTeam: number | undefined, snaps: LogSnapshot[]): MatchLog => ({
  matchId,
  accountId: 1,
  heroId: 6,
  team,
  startedAt: matchId,
  updatedAt: matchId,
  snapshots: snaps,
  ...(winningTeam !== undefined ? { winningTeam } : {}),
});

describe("calibration uses the raw model value", () => {
  it("buckets by winRaw (what calibrateProb is applied to), Brier by the shown winP", () => {
    // shown value already pushed to 0.9 by an earlier calibration, raw was 0.6; the game was lost
    const l = log(1, 0, 1, [snap(200, 0.9, 0.6), snap(300, 0.9, 0.6), snap(400, 0.9, 0.6)]);
    const cal = calibrate([l]);
    expect(cal.reliability).toHaveLength(1);
    expect(cal.reliability[0].from).toBe(0.5);
    expect(cal.reliability[0].predicted).toBeCloseTo(0.6);
    expect(cal.brier).toBeCloseTo(0.81);
  });

  it("falls back to winP for logs written before winRaw existed", () => {
    const l = log(1, 0, 0, [snap(200, 0.7), snap(300, 0.7), snap(400, 0.7)]);
    expect(calibrate([l]).reliability[0].predicted).toBeCloseTo(0.7);
  });

  it("skips snapshots whose raw value is null", () => {
    const l = log(1, 0, 0, [snap(200, 0.7, null), snap(300, 0.7, null), snap(400, 0.7, null)]);
    expect(calibrate([l]).reliability).toHaveLength(0);
  });
});

describe("backfillOutcomes", () => {
  it("fills the result of matches whose broadcast ended early, from the match history", () => {
    const open = log(10, 1, undefined, []);
    const done = log(11, 0, 0, []);
    const unknown = log(12, 0, undefined, []);
    const changed = backfillOutcomes([open, done, unknown], [
      { match_id: 10, match_result: 1 },
      { match_id: 11, match_result: 1 },
    ]);
    expect(changed).toEqual([open]);
    expect(won(open)).toBe(true);
    // a result already known from the broadcast is never overwritten
    expect(done.winningTeam).toBe(0);
    expect(unknown.winningTeam).toBeUndefined();
  });

  it("ignores impossible results", () => {
    const l = log(10, 0, undefined, []);
    expect(backfillOutcomes([l], [{ match_id: 10, match_result: 2 }])).toEqual([]);
  });
});

describe("nextBuys respects the phase tier floor", () => {
  const item = (id: number, tier: number): Item => ({ id, name: `I${id}`, class_name: `i${id}`, type: "upgrade", item_slot_type: "weapon", item_tier: tier, cost: tier * 800 }) as Item;
  const items = new Map([1, 2, 3, 4].map((t) => [t, item(t, t)]));
  const ci = (itemId: number) => ({ itemId, score: 0.02, baselineWinrate: 0.5, baselineMatches: 100, avgBuyTimeS: 0, perEnemy: [] });
  const counter: CounterResult = { items: [1, 2, 3, 4].map(ci), bySlot: { weapon: [1, 2, 3, 4].map(ci), vitality: [], spirit: [] }, coveredEnemies: [] };
  const me = { accountId: 1, team: 0, heroId: 6, netWorth: 30000, souls: 9000, itemIds: [] } as unknown as LivePlayer;

  it("late game (floor T3) lists no T1/T2", () => {
    expect(nextBuys(counter, items, me, 6, 3).all.map((b) => b.item.item_tier)).toEqual([3, 4]);
  });
  it("a low net worth never pushes the cap below the floor", () => {
    const poor = { ...me, netWorth: 3000 } as LivePlayer;
    expect(nextBuys(counter, items, poor, 6, 3).all.map((b) => b.item.item_tier)).toEqual([3]);
  });
  it("defaults to no floor", () => {
    expect(nextBuys(counter, items, me).all).toHaveLength(4);
  });
});

describe("detectMode", () => {
  const st = (n: number, gameTimeS: number, gameMode?: "normal" | "brawl"): LiveState =>
    ({ myAccountId: 1, gameTimeS, players: Array.from({ length: n }, (_, i) => ({ accountId: i + 1 })), ...(gameMode ? { gameMode } : {}) }) as unknown as LiveState;

  it("a short player list early in a broadcast is not Street Brawl", () => {
    expect(detectMode(st(4, 30)).isBrawl).toBe(false);
  });
  it("a short list after the warm-up is Street Brawl", () => {
    expect(detectMode(st(8, BRAWL_COUNT_AFTER_S + 10)).isBrawl).toBe(true);
  });
  it("the game rules row decides when present", () => {
    expect(detectMode(st(4, 600, "normal")).isBrawl).toBe(false);
    expect(detectMode(st(12, 10, "brawl")).isBrawl).toBe(true);
  });
});

describe("objective stages only on lanes in play", () => {
  it("maps lane colours to objective lanes", () => {
    expect(activeLaneIndexes([{ lane: 1 }, { lane: 4 }, { lane: 6 }, { lane: 6 }, {}])).toEqual([1, 3, 4]);
  });
  it("an unused lane with clear bits is not counted as destroyed", () => {
    // everything standing except lane 2, which is not on this map
    const mask = 0xffff & ~(1 << 2) & ~(1 << 6) & ~(1 << 13);
    expect(countDestroyedStages(mask)).toBe(3);
    expect(countDestroyedStages(mask, [1, 3, 4])).toBe(0);
  });
});

describe("API client offline fallback", () => {
  it("drops the rolling time window from the key", () => {
    expect(fallbackKey("/v1/analytics/hero-stats?min_unix_timestamp=1&min_average_badge=61")).toBe("/v1/analytics/hero-stats?min_average_badge=61");
    expect(fallbackKey("/v1/assets/items")).toBe("/v1/assets/items");
  });

  const store = () => {
    const m = new Map<string, unknown>();
    const fb: ResponseFallback = { load: async (k) => m.get(k), save: (k, d) => void m.set(k, d) };
    return { m, fb };
  };

  it("saves good answers and serves them when the API is down", async () => {
    const { m, fb } = store();
    let up = true;
    const fetchImpl = vi.fn(async () => {
      if (!up) throw new Error("ECONNREFUSED");
      return new Response(JSON.stringify([{ id: 1 }]), { status: 200 });
    }) as unknown as typeof fetch;
    const api = createClient({ baseUrl: "http://x", fetchImpl, fallback: fb });
    expect(await api.items({ retries: 0 })).toEqual([{ id: 1 }]);
    expect(m.has("/v1/assets/items")).toBe(true);
    up = false;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await api.items({ retries: 0 })).toEqual([{ id: 1 }]);
    warn.mockRestore();
  });

  it("does not fall back on a 4xx or for live endpoints", async () => {
    const { m, fb } = store();
    m.set("/v1/assets/items", [{ id: 9 }]);
    m.set("/v1/matches/active", [{ match_id: 1 }]);
    const notFound = (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch;
    await expect(createClient({ baseUrl: "http://x", fetchImpl: notFound, fallback: fb }).items({ retries: 0 })).rejects.toThrow(/404/);
    const down = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    await expect(createClient({ baseUrl: "http://x", fetchImpl: down, fallback: fb }).activeMatches(undefined, { retries: 0 })).rejects.toThrow("down");
  });
});
