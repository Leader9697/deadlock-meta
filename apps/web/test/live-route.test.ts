import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { CounterItem, Item } from "@deadlock/core";

// Data layer stubbed: the route's own decisions (tier floor, mode, errors) are under test.
const item = (id: number, tier: number): Item =>
  ({ id, name: `Item ${id}`, class_name: `upgrade_${id}`, type: "upgrade", item_slot_type: "weapon", item_tier: tier, cost: [0, 800, 1600, 3200, 6400][tier] }) as Item;
const ITEMS = [item(11, 1), item(12, 2), item(13, 3), item(14, 4)];
const ci = (itemId: number): CounterItem => ({ itemId, score: 0.03, baselineWinrate: 0.5, baselineMatches: 500, avgBuyTimeS: 900, perEnemy: [] });

vi.mock("@/lib/data", () => ({
  ITEM_PHASE_S: 300,
  getItemMap: async () => new Map(ITEMS.map((i) => [i.id, i])),
  getItems: async () => ITEMS,
  getHeroMap: async () => new Map(),
  getPhaseCounter: async () => {
    const list = ITEMS.map((i) => ci(i.id));
    return { items: list, bySlot: { weapon: list, vitality: [], spirit: [] }, byPhase: new Map(), coveredEnemies: [] };
  },
  getPhases: async () => new Map(),
  getBuilds: async () => [],
  getCounterMatrix: async () => [],
  getSynergy: async () => [],
  getHeroMeta: async () => [],
  getItemFlow: async () => null,
  getHeroItemStats: async () => [],
  getLaneMatchup: async () => null,
  getAbilityOrders: async () => [],
  getImbueData: async () => null,
}));
vi.mock("@/lib/lab", () => ({
  getLabData: async () => ({ items: [], heroes: [] }),
  getLabItemMap: async () => new Map(),
}));
vi.mock("@/lib/winmodel", () => ({ getWinModel: async () => null }));

const { POST } = await import("../app/api/live/route");

const players = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    accountId: i + 1,
    heroId: i + 1,
    team: i < n / 2 ? 0 : 1,
    netWorth: 30000,
    souls: 9000,
    kills: 0,
    deaths: 0,
    assists: 0,
    itemIds: [],
  }));

const post = (body: unknown) =>
  POST(new NextRequest("http://localhost/api/live", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));

describe("POST /api/live", () => {
  it("late game lists no item below the T3 floor, in the build path or the counter list", async () => {
    const res = await post({ myAccountId: 1, gameTimeS: 1800, players: players(12) });
    expect(res.status).toBe(200);
    const j = await res.json();
    for (const k of ["all", "weapon"] as const) for (const b of j.nextBuys[k]) expect(b.tier).toBeGreaterThanOrEqual(3);
    expect(j.nextBuys.all.length).toBeGreaterThan(0);
    for (const st of j.buildPath) expect(st.tier ?? 0).toBeGreaterThanOrEqual(3);
    expect(j.mode.isBrawl).toBe(false);
  });

  it("a short player list at the start is not called Street Brawl", async () => {
    const j = await (await post({ myAccountId: 1, gameTimeS: 20, players: players(4) })).json();
    expect(j.mode.isBrawl).toBe(false);
    expect(j.tips.some((t: { title: string }) => /Brawl/.test(t.title))).toBe(false);
  });

  it("rejects a match without my account instead of guessing", async () => {
    expect((await post({ myAccountId: 999, gameTimeS: 600, players: players(12) })).status).toBe(409);
    expect((await post({ gameTimeS: 600, players: players(12) })).status).toBe(400);
  });
});
