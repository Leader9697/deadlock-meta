import { describe, expect, it } from "vitest";
import { calculateDraftOdds, type HeroDraftStats } from "../src/draftodds";

describe("calculateDraftOdds", () => {
  const heroStats = new Map<number, HeroDraftStats>([
    [1, { heroId: 1, winrate: 0.55, matches: 1000 }], // Strong
    [2, { heroId: 2, winrate: 0.52, matches: 800 }],
    [3, { heroId: 3, winrate: 0.51, matches: 900 }],
    [10, { heroId: 10, winrate: 0.45, matches: 1000 }], // Weak
    [11, { heroId: 11, winrate: 0.48, matches: 700 }],
    [12, { heroId: 12, winrate: 0.49, matches: 800 }],
  ]);

  it("predicts higher win probability for team with higher baseline winrates", () => {
    const odds = calculateDraftOdds({
      allies: [1, 2, 3],
      enemies: [10, 11, 12],
      heroStats,
    });

    expect(odds.winProbability).toBeGreaterThan(0.50);
    expect(odds.components.heroBaseDelta).toBeGreaterThan(0);
  });

  it("predicts lower win probability when lineup is weaker", () => {
    const odds = calculateDraftOdds({
      allies: [10, 11, 12],
      enemies: [1, 2, 3],
      heroStats,
    });

    expect(odds.winProbability).toBeLessThan(0.50);
    expect(odds.components.heroBaseDelta).toBeLessThan(0);
  });

  it("takes counter matchups into account", () => {
    const counterMatrix = [
      {
        hero_id: 1,
        enemy_hero_id: 10,
        matches_played: 200,
        wins: 140, // 70% winrate vs hero 10
      },
    ];

    const odds = calculateDraftOdds({
      allies: [1],
      enemies: [10],
      heroStats,
      counterMatrix,
    });

    expect(odds.advantages.length).toBeGreaterThan(0);
    expect(odds.advantages[0].ourHeroId).toBe(1);
    expect(odds.advantages[0].enemyHeroId).toBe(10);
    expect(odds.components.matchupDelta).toBeGreaterThan(0);
  });

  it("weights direct lane matchups 2.5x higher", () => {
    const counterMatrix = [
      {
        hero_id: 1,
        enemy_hero_id: 10,
        matches_played: 200,
        wins: 140,
      },
    ];

    const laneAssignments = new Map([
      [1, 2], // Lane 2
      [10, 2], // Same lane 2!
    ]);

    const oddsWithSameLane = calculateDraftOdds({
      allies: [1],
      enemies: [10],
      heroStats,
      counterMatrix,
      laneAssignments,
    });

    const oddsDifferentLane = calculateDraftOdds({
      allies: [1],
      enemies: [10],
      heroStats,
      counterMatrix,
    });

    expect(oddsWithSameLane.components.matchupDelta).toBeGreaterThan(
      oddsDifferentLane.components.matchupDelta,
    );
  });
});
