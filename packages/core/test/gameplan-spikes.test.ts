import { describe, it, expect } from "vitest";
import { powerSpikes, SPIKE_WINDOW_S } from "../src/spikes";
import { gamePlan, type PlanPhase } from "../src/gameplan";
import type { LivePlayer } from "../src/live";
import type { Item } from "../src/types";

describe("gameplan and power spikes", () => {
  const dummyItems = new Map<number, Item>([
    [
      301,
      {
        id: 301,
        name: "Tier 3 Item",
        type: "upgrade",
        item_tier: 3,
        cost: 3000,
      } as Item,
    ],
    [
      401,
      {
        id: 401,
        name: "Tier 4 Item",
        type: "upgrade",
        item_tier: 4,
        cost: 6200,
      } as Item,
    ],
  ]);

  const me: LivePlayer = {
    accountId: 1001,
    team: 0,
    heroId: 1,
    lane: 1,
    netWorth: 12000,
    kills: 3,
    deaths: 1,
    assists: 4,
    lastHits: 100,
    denies: 10,
    itemIds: [401],
    itemTimes: [800], // bought at 800s
    dead: false,
  };

  const ally: LivePlayer = {
    accountId: 1002,
    team: 0,
    heroId: 2,
    lane: 2,
    netWorth: 10000,
    kills: 2,
    deaths: 1,
    assists: 3,
    lastHits: 90,
    denies: 5,
    itemIds: [301],
    itemTimes: [820], // bought at 820s
    dead: false,
  };

  const enemy: LivePlayer = {
    accountId: 2001,
    team: 1,
    heroId: 5,
    lane: 1,
    netWorth: 9000,
    kills: 1,
    deaths: 2,
    assists: 1,
    lastHits: 80,
    denies: 6,
    itemIds: [],
    itemTimes: [],
    dead: false,
  };

  it("calculates power spikes and gives fight verdict during spike window", () => {
    // gameTimeS = 800, delayS = 75 => now = 875.
    // me bought 401 at 800 -> age = 75s (< 180s).
    // ally bought 301 at 820 -> age = 55s (< 180s).
    // enemy has no fresh big items.
    const res = powerSpikes([me, ally, enemy], me, 800, dummyItems, 75);
    expect(res.mine).toBeGreaterThan(res.enemy);
    expect(res.verdict).toBe("fight");
    expect(res.self?.itemId).toBe(401);
    expect(res.myItems.length).toBe(2);
    expect(res.enemyItems.length).toBe(0);
    expect(res.windowLeft).toBeGreaterThan(0);
  });

  it("discards expired power spikes outside window", () => {
    // gameTimeS = 1200, delayS = 75 => now = 1275.
    // bought at 800 / 820 -> age > 400s (> SPIKE_WINDOW_S).
    const res = powerSpikes([me, ally, enemy], me, 1200, dummyItems, 75);
    expect(res.myItems.length).toBe(0);
    expect(res.verdict).toBe("even");
  });

  it("determines gamePlan stance when our lineup scales into late game", () => {
    const plan = gamePlan({
      mine: { early: 0.48, mid: 0.50, late: 0.56 },
      enemy: { early: 0.52, mid: 0.50, late: 0.44 },
      clockS: 400, // early game
      winP: 0.50,
    });

    expect(plan.ourWindow).toBe("late");
    expect(plan.theirWindow).toBe("early");
    expect(plan.stance).toBe("scale");
    expect(plan.title).toContain("Main sabar");
    expect(plan.flat).toBe(false);
  });

  it("determines gamePlan stance when currently in power window", () => {
    const plan = gamePlan({
      mine: { early: 0.54, mid: 0.50, late: 0.46 },
      enemy: { early: 0.46, mid: 0.50, late: 0.54 },
      clockS: 300, // early game (our best window)
      winP: 0.55,
    });

    expect(plan.ourWindow).toBe("early");
    expect(plan.stance).toBe("tekan");
    expect(plan.title).toContain("Window kamu: tekan");
  });

  it("identifies flat matchups where lineups are evenly matched", () => {
    const plan = gamePlan({
      mine: { early: 0.501, mid: 0.502, late: 0.501 },
      enemy: { early: 0.500, mid: 0.500, late: 0.500 },
      clockS: 600,
      winP: 0.50,
    });

    expect(plan.flat).toBe(true);
    expect(plan.stance).toBe("seimbang");
  });
});
