import { describe, it, expect } from "vitest";
import { winProbability, type WinModel } from "../src/winprob";
import { calculateDraftOdds } from "../src/draftodds";
import { countDestroyedStages } from "../src/macro";

describe("winProbability with objectives and flex slots", () => {
  const dummyModel: WinModel = {
    windows: [
      { from: 0, to: 480, center: 240, k: 3.5, n: 100 },
      { from: 480, to: 900, center: 690, k: 5.2, n: 100 },
      { from: 900, to: 1500, center: 1200, k: 6.8, n: 100 },
    ],
    matches: 100,
    samples: 1000,
    table: [],
    fittedAt: Date.now(),
  };

  it("calculates 50% probability when souls, objectives, and flex slots are equal", () => {
    const p = winProbability(dummyModel, 600, 0, 50000, {
      objectiveDelta: 0,
      flexSlotDelta: 0,
    });
    expect(p).not.toBeNull();
    expect(p!).toBeCloseTo(0.5, 2);
  });

  it("boosts win probability when team has objective lead despite even souls", () => {
    const evenP = winProbability(dummyModel, 600, 0, 50000);
    const objLeadP = winProbability(dummyModel, 600, 0, 50000, {
      objectiveDelta: 2,
    });
    expect(objLeadP).not.toBeNull();
    expect(objLeadP!).toBeGreaterThan(evenP!);
    // 2 objectives lead provides ~57% winrate
    expect(objLeadP!).toBeGreaterThan(0.55);
  });

  it("boosts win probability when team has unlocked flex item slots", () => {
    const evenP = winProbability(dummyModel, 600, 0, 50000);
    const flexLeadP = winProbability(dummyModel, 600, 0, 50000, {
      flexSlotDelta: 1,
    });
    expect(flexLeadP).not.toBeNull();
    expect(flexLeadP!).toBeGreaterThan(evenP!);
  });
});

describe("calculateDraftOdds with lane matchup weighting", () => {
  it("weighs direct lane opponents higher than cross-map opponents", () => {
    const heroStats = new Map([
      [1, { heroId: 1, winrate: 0.5, matches: 500 }],
      [2, { heroId: 2, winrate: 0.5, matches: 500 }],
      [3, { heroId: 3, winrate: 0.5, matches: 500 }],
      [4, { heroId: 4, winrate: 0.5, matches: 500 }],
    ]);

    // Hero 1 beats Hero 3 heavily (+10% winrate advantage)
    const counterMatrix = [
      { hero_id: 1, enemy_hero_id: 3, wins: 60, matches_played: 100 },
    ];

    // Case A: Hero 1 and Hero 3 are in the same lane (e.g. Lane 1)
    const sameLane = calculateDraftOdds({
      allies: [1, 2],
      enemies: [3, 4],
      heroStats,
      counterMatrix,
      laneAssignments: new Map([
        [1, 1],
        [2, 2],
        [3, 1], // same lane as 1
        [4, 2],
      ]),
    });

    // Case B: Hero 1 and Hero 3 are in different lanes
    const diffLane = calculateDraftOdds({
      allies: [1, 2],
      enemies: [3, 4],
      heroStats,
      counterMatrix,
      laneAssignments: new Map([
        [1, 1],
        [2, 2],
        [3, 2], // different lane
        [4, 1],
      ]),
    });

    expect(sameLane.winProbability).toBeGreaterThan(diffLane.winProbability);
    expect(sameLane.advantages[0].reason).toContain("Lawan lane langsung");
  });
});

describe("countDestroyedStages", () => {
  it("correctly counts destroyed objective stages from bitmasks", () => {
    // 0 = all bits clear (all objectives destroyed)
    expect(countDestroyedStages(0)).toBe(12);

    // Initial state: bit 1..4 (guardians), 5..8 (walkers), 12..15 (base guardians) set
    // In binary with bits 1..4, 5..8, 12..15 all set:
    let fullMask = 0;
    for (let i = 1; i <= 4; i++) fullMask |= 1 << i;
    for (let i = 5; i <= 8; i++) fullMask |= 1 << i;
    for (let i = 12; i <= 15; i++) fullMask |= 1 << i;

    expect(countDestroyedStages(fullMask)).toBe(0);

    // If lane 1 guardian is destroyed (bit 1 cleared):
    const guardian1Destroyed = fullMask & ~(1 << 1);
    expect(countDestroyedStages(guardian1Destroyed)).toBe(1);
  });
});
