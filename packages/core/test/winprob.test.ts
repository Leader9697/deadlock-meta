import { describe, expect, it } from "vitest";
import {
  parseTeam,
  parseStats,
  winProbability,
  empiricalFor,
  calibrateProb,
  type WinModel,
} from "../src/winprob";

describe("parseTeam", () => {
  it("parses numeric team indices 0 and 1", () => {
    expect(parseTeam(0)).toBe(0);
    expect(parseTeam(1)).toBe(1);
  });

  it("handles Source 2 team numbers (2 -> 0, 3 -> 1)", () => {
    expect(parseTeam(2)).toBe(0);
    expect(parseTeam(3)).toBe(1);
  });

  it("parses team strings like 'Team0' and 'Team1'", () => {
    expect(parseTeam("Team0")).toBe(0);
    expect(parseTeam("Team1")).toBe(1);
    expect(parseTeam("k_ECitadelLobbyTeam_Team0")).toBe(0);
  });

  it("returns null for invalid inputs", () => {
    expect(parseTeam(null)).toBeNull();
    expect(parseTeam(99)).toBeNull();
    expect(parseTeam("invalid")).toBeNull();
  });
});

describe("parseStats", () => {
  it("parses array of stats objects", () => {
    const player = {
      stats: [
        { time_stamp_s: 60, net_worth: 1000 },
        { time_stamp_s: 120, net_worth: 2200 },
      ],
    };
    const parsed = parseStats(player);
    expect(parsed).toEqual([
      [60, 1000],
      [120, 2200],
    ]);
  });

  it("parses parallel arrays in stats object", () => {
    const player = {
      stats: {
        time_stamp_s: [0, 60],
        net_worth: [500, 1100],
      },
    };
    const parsed = parseStats(player);
    expect(parsed).toEqual([
      [0, 500],
      [60, 1100],
    ]);
  });
});

describe("winProbability", () => {
  const mockModel: WinModel = {
    windows: [
      { from: 0, to: 480, center: 240, k: 3.0, n: 500 },
      { from: 480, to: 900, center: 690, k: 4.5, n: 500 },
      { from: 900, to: 1500, center: 1200, k: 6.0, n: 500 },
    ],
    matches: 100,
    samples: 1000,
    table: [
      { from: 0, to: 600, leadMin: 1000, leadMax: 3000, winrate: 0.58, n: 200 },
      { from: 600, to: 1200, leadMin: 5000, leadMax: 10000, winrate: 0.75, n: 300 },
    ],
    fittedAt: Date.now(),
  };

  it("returns 50% win probability when net worth lead is 0 (symmetry)", () => {
    const prob = winProbability(mockModel, 300, 0, 20_000);
    expect(prob).toBeCloseTo(0.5, 3);
  });

  it("is monotonically increasing with net worth lead", () => {
    const probEqual = winProbability(mockModel, 600, 0, 50_000)!;
    const probAhead = winProbability(mockModel, 600, 5_000, 50_000)!;
    const probBehind = winProbability(mockModel, 600, -5_000, 50_000)!;

    expect(probAhead).toBeGreaterThan(probEqual);
    expect(probBehind).toBeLessThan(probEqual);
    expect(probAhead + probBehind).toBeCloseTo(1.0, 3);
  });

  it("boosts win probability when objective delta is in our favor", () => {
    const baseProb = winProbability(mockModel, 600, 0, 50_000)!;
    const withObjectives = winProbability(mockModel, 600, 0, 50_000, { objectiveDelta: 2 })!;

    expect(withObjectives).toBeGreaterThan(baseProb);
  });

  it("boosts win probability when flex slot delta is in our favor", () => {
    const baseProb = winProbability(mockModel, 600, 0, 50_000)!;
    const withFlex = winProbability(mockModel, 600, 0, 50_000, { flexSlotDelta: 1 })!;

    expect(withFlex).toBeGreaterThan(baseProb);
  });

  it("returns null for missing model or non-positive total souls", () => {
    expect(winProbability(null, 600, 1000, 50_000)).toBeNull();
    expect(winProbability(mockModel, 600, 1000, 0)).toBeNull();
  });
});

describe("empiricalFor", () => {
  const mockModel: WinModel = {
    windows: [],
    matches: 100,
    samples: 1000,
    table: [
      { from: 0, to: 600, leadMin: 1000, leadMax: 3000, winrate: 0.58, n: 200 },
      { from: 600, to: 1200, leadMin: 5000, leadMax: 10000, winrate: 0.75, n: 300 },
    ],
    fittedAt: Date.now(),
  };

  it("finds matching empirical row and determines leader", () => {
    const rowPositive = empiricalFor(mockModel, 800, 6000);
    expect(rowPositive).not.toBeNull();
    expect(rowPositive?.winrate).toBe(0.75);
    expect(rowPositive?.leaderIsMe).toBe(true);

    const rowNegative = empiricalFor(mockModel, 800, -6000);
    expect(rowNegative).not.toBeNull();
    expect(rowNegative?.winrate).toBe(0.75);
    expect(rowNegative?.leaderIsMe).toBe(false);
  });

  it("returns null when no matching bin exists", () => {
    expect(empiricalFor(mockModel, 5000, 20_000)).toBeNull();
  });
});

describe("calibrateProb", () => {
  it("returns raw prob when calibration data is absent or insufficient", () => {
    expect(calibrateProb(null, null)).toBeNull();
    expect(calibrateProb(0.65, null)).toBe(0.65);
    expect(calibrateProb(0.65, [])).toBe(0.65);
    expect(calibrateProb(0.65, [{ from: 0.5, to: 0.8, predicted: 0.65, actual: 0.55, n: 1 }])).toBe(0.65);
  });

  it("adjusts predicted prob towards actual personal win rate based on sample size", () => {
    const buckets = [
      { from: 0.0, to: 0.35, predicted: 0.25, actual: 0.3, n: 10 },
      { from: 0.35, to: 0.65, predicted: 0.5, actual: 0.52, n: 15 },
      { from: 0.65, to: 1.0, predicted: 0.75, actual: 0.6, n: 20 },
    ];

    // Player with 75% model predicted probability actually only won 60% across 20 samples
    const calibrated = calibrateProb(0.75, buckets);
    expect(calibrated).not.toBeNull();
    expect(calibrated!).toBeLessThan(0.75);
    expect(calibrated!).toBeGreaterThan(0.6);
  });
});
