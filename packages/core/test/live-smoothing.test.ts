import { describe, expect, it } from "vitest";
import {
  smoothWinProb,
  holdMacroPlan,
  stabilizeTips,
  computeLagSeconds,
  filterPendingBuys,
  computeSoulsPacing,
} from "../src/live-smoothing";
import type { MacroPlan } from "../src/macro";
import type { Tip } from "../src/coach";

describe("smoothWinProb", () => {
  it("initializes state on first sample", () => {
    const res = smoothWinProb(null, 0.6, 100, 12345);
    expect(res.p).toBe(0.6);
    expect(res.state).toEqual({ p: 0.6, t: 100, matchId: 12345 });
  });

  it("resets when matchId changes", () => {
    const prev = { p: 0.8, t: 500, matchId: 11111 };
    const res = smoothWinProb(prev, 0.4, 20, 22222);
    expect(res.p).toBe(0.4);
    expect(res.state?.matchId).toBe(22222);
  });

  it("smooths value gradually toward raw over time", () => {
    const prev = { p: 0.5, t: 100, matchId: 12345 };
    // After 150 seconds (tau = 150s), it should move by ~63.2% of the delta (0.5 -> 0.8: delta 0.3 * 0.632 = ~0.19)
    const res = smoothWinProb(prev, 0.8, 250, 12345, 150);
    expect(res.p).toBeGreaterThan(0.65);
    expect(res.p).toBeLessThan(0.72);
  });

  it("returns previous value when raw is null", () => {
    const prev = { p: 0.55, t: 100, matchId: 12345 };
    const res = smoothWinProb(prev, null, 120, 12345);
    expect(res.p).toBe(0.55);
  });
});

describe("holdMacroPlan", () => {
  const planA: MacroPlan = {
    action: "farm",
    title: "Farming Lane",
    detail: "Jaga lane dan ambil camp",
    lanes: [],
  };

  const planB: MacroPlan = {
    action: "group",
    title: "Group Mid",
    detail: "Kumpul mid untuk fight",
    lanes: [],
  };

  it("holds non-urgent plan for at least 45 seconds", () => {
    const first = holdMacroPlan(null, planA, 100, 12345);
    expect(first.plan?.action).toBe("farm");

    // After 20 seconds, incoming plan is group, but farm should be held!
    const held = holdMacroPlan(first.state, planB, 120, 12345);
    expect(held.plan?.action).toBe("farm");

    // After 50 seconds (t = 155), group plan should now be accepted!
    const updated = holdMacroPlan(first.state, planB, 155, 12345);
    expect(updated.plan?.action).toBe("group");
  });

  it("switches immediately if incoming plan is urgent", () => {
    const first = holdMacroPlan(null, planA, 100, 12345);
    const urgentB: MacroPlan = { ...planB, urgent: true };
    const res = holdMacroPlan(first.state, urgentB, 110, 12345);
    expect(res.plan?.action).toBe("group");
  });
});

describe("stabilizeTips", () => {
  const tip1: Tip = { kind: "push", title: "Push T1", body: "Dorong lane", priority: 50 };
  const tip2: Tip = { kind: "farm", title: "Farm Jungle", body: "Ambil creep", priority: 55 };
  const urgentTip: Tip = { kind: "retreat", title: "Gank Lawan!", body: "Mundur segera", priority: 80 };

  it("holds top tip for at least minHoldMs unless priority delta is high", () => {
    const now = 100_000;
    const first = stabilizeTips(null, [tip1, tip2], now);
    expect(first.tips[0].title).toBe("Push T1");

    // 5 seconds later, tip2 is first, but tip1 was held
    const held = stabilizeTips(first.state, [tip2, tip1], now + 5000);
    expect(held.tips[0].title).toBe("Push T1");

    // Urgent tip (+30 priority) breaks through hold immediately
    const broken = stabilizeTips(first.state, [urgentTip, tip1], now + 5000);
    expect(broken.tips[0].title).toBe("Gank Lawan!");
  });
});

describe("computeLagSeconds", () => {
  it("returns base delay when no anchor is set", () => {
    expect(computeLagSeconds(null, 100, 12345, 200_000)).toBe(75);
  });

  it("calculates drift when wall clock advances faster than game clock", () => {
    // 60 seconds of wall clock elapsed, but only 40 seconds of game clock elapsed (drift = +20s)
    const anchor = { wall: 100_000, game: 100, matchId: 12345 };
    const lag = computeLagSeconds(anchor, 140, 12345, 160_000, 75);
    expect(lag).toBe(95); // 75 + 20
  });

  it("clamps to minimum delay", () => {
    const anchor = { wall: 100_000, game: 100, matchId: 12345 };
    // game caught up significantly
    const lag = computeLagSeconds(anchor, 200, 12345, 110_000, 75, 30);
    expect(lag).toBe(30);
  });
});

describe("filterPendingBuys", () => {
  it("retains pending items that are not owned and within max age", () => {
    const pending = [
      { itemId: 1, name: "Item 1", cost: 500, atS: 100, matchId: 99 },
      { itemId: 2, name: "Item 2", cost: 1250, atS: 100, matchId: 99 },
      { itemId: 3, name: "Item 3", cost: 3000, atS: 50, matchId: 99 }, // expired
      { itemId: 4, name: "Item 4", cost: 500, atS: 100, matchId: 88 }, // diff match
    ];
    const filtered = filterPendingBuys(pending, [1], 450, 99, 360);
    // Item 1 is owned -> excluded
    // Item 2 is not owned, age 350 < 360, same match -> kept
    // Item 3 age 400 >= 360 -> excluded
    // Item 4 match 88 != 99 -> excluded
    expect(filtered).toHaveLength(1);
    expect(filtered[0].itemId).toBe(2);
  });
});

describe("computeSoulsPacing", () => {
  it("returns null in first 60 seconds of game", () => {
    expect(computeSoulsPacing(500, 30)).toBeNull();
  });

  it("calculates 10-minute laning target (~9.2k) and delta", () => {
    // Exactly at 10m (600s), target should be ~9200
    const pacingAhead = computeSoulsPacing(10_000, 600);
    expect(pacingAhead).not.toBeNull();
    expect(pacingAhead?.target).toBe(9200);
    expect(pacingAhead?.delta).toBe(800);
    expect(pacingAhead?.isAhead).toBe(true);
    expect(pacingAhead?.label).toContain("+0.8k");

    const pacingBehind = computeSoulsPacing(8_100, 600);
    expect(pacingBehind).not.toBeNull();
    expect(pacingBehind?.target).toBe(9200);
    expect(pacingBehind?.delta).toBe(-1100);
    expect(pacingBehind?.isAhead).toBe(false);
    expect(pacingBehind?.label).toContain("-1.1k");
  });

  it("calculates 5-minute laning benchmark (~3.8k)", () => {
    const pacing = computeSoulsPacing(4_000, 300);
    expect(pacing).not.toBeNull();
    expect(pacing?.target).toBeGreaterThan(3500);
    expect(pacing?.target).toBeLessThan(4200);
  });
});
