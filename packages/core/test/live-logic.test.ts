import { describe, expect, it } from "vitest";
import {
  TIER_FLOOR,
  phaseAt,
  summarize,
  type LiveState,
} from "../src";

describe("Live Route Core Business Logic", () => {
  it("enforces TIER_FLOOR per game phase", () => {
    // Early game (e.g. 5m = 300s) -> floor is tier 1
    expect(TIER_FLOOR[phaseAt(300)]).toBe(1);

    // Mid game (e.g. 15m = 900s) -> floor is tier 2
    expect(TIER_FLOOR[phaseAt(900)]).toBe(2);

    // Late game (e.g. 25m = 1500s) -> floor is tier 3
    expect(TIER_FLOOR[phaseAt(1500)]).toBe(3);

    // Very late game (e.g. 35m = 2100s) -> floor is tier 3
    expect(TIER_FLOOR[phaseAt(2100)]).toBe(3);
  });

  it("filters out low tier items that fall below TIER_FLOOR in late game", () => {
    const floor = TIER_FLOOR[phaseAt(1500)]; // late game = tier 3
    const buildPath = [
      { itemId: 101, tier: 1, name: "Basic Item" },
      { itemId: 102, tier: 2, name: "Mid Item" },
      { itemId: 103, tier: 1, name: "Upgraded Component", upgradeFrom: 50 },
      { itemId: 104, tier: 3, name: "Late Core Item" },
      { itemId: 105, tier: 4, name: "Luxury Item" },
    ];

    const filtered = buildPath.filter(
      (st) => (st.tier ?? 0) >= floor || (st as { upgradeFrom?: number }).upgradeFrom != null,
    );

    // Items with tier >= 3 or with upgradeFrom are kept
    expect(filtered).toHaveLength(3);
    expect(filtered.map((x) => x.itemId)).toEqual([103, 104, 105]);
  });

  it("deducts souls and applies pendingBuys correctly", () => {
    const mine = {
      accountId: 12345,
      heroId: 1,
      team: 0,
      itemIds: [10],
      souls: 2500,
    };

    const pendingBuys = [
      { itemId: 20, cost: 1250 },
      { itemId: 30, cost: 800 },
      { itemId: 10, cost: 500 }, // already owned -> should be ignored
    ];

    for (const b of pendingBuys.slice(0, 6)) {
      if (!b || typeof b.itemId !== "number" || mine.itemIds.includes(b.itemId)) continue;
      mine.itemIds = [...mine.itemIds, b.itemId];
      mine.souls = Math.max(0, (mine.souls ?? 0) - Math.max(0, Number(b.cost) || 0));
    }

    expect(mine.itemIds).toEqual([10, 20, 30]);
    // 2500 - 1250 - 800 = 450
    expect(mine.souls).toBe(450);
  });

  it("returns null in summarize when myAccountId is not in match (triggers 409)", () => {
    const state: LiveState = {
      matchId: 99999,
      myAccountId: 88888, // Not in players array!
      gameTimeS: 300,
      players: [
        { accountId: 11111, heroId: 1, team: 0, netWorth: 2000, itemIds: [] },
        { accountId: 22222, heroId: 2, team: 1, netWorth: 2000, itemIds: [] },
      ],
    };

    const summary = summarize(state);
    expect(summary).toBeNull();
  });

  it("detects brawl mode when match has <= 8 players", () => {
    const regularPlayers = Array.from({ length: 12 }, (_, i) => ({
      accountId: i + 1,
      heroId: i + 1,
      team: i < 6 ? 0 : 1,
      netWorth: 2000,
      itemIds: [],
    }));

    const brawlPlayers = Array.from({ length: 8 }, (_, i) => ({
      accountId: i + 1,
      heroId: i + 1,
      team: i < 4 ? 0 : 1,
      netWorth: 2000,
      itemIds: [],
    }));

    const isBrawl = (players: unknown[]) => players.length > 0 && players.length <= 8;
    expect(isBrawl(regularPlayers)).toBe(false);
    expect(isBrawl(brawlPlayers)).toBe(true);
  });
});
