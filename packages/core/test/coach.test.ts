import { describe, it, expect } from "vitest";
import { enemyMatchups, type CoachInput } from "../src/coach";

describe("enemyMatchups target priority and verdict consistency", () => {
  const me = {
    accountId: 1,
    team: 0,
    heroId: 1,
    netWorth: 10000,
    kills: 3,
    deaths: 1,
    assists: 2,
    itemIds: [],
    dead: false,
    respawnInS: null,
    heroDamage: 5000,
  };

  const createInput = (enemies: any[]): CoachInput => ({
    state: {
      gameTimeS: 700,
      players: [me, ...enemies],
      objectivesMask: 0,
    } as any,
    me: me as any,
    summary: {
      threats: enemies.map((e) => ({
        player: e,
        threat: e.netWorth,
      })),
      allies: [me],
      enemies,
      lead: 0,
      powerSpike: "even",
    } as any,
    winP: 0.5,
    trend: null,
    phases: new Map(),
    counter: { items: [] } as any,
    items: new Map(),
    heroName: (id: number) => `Hero_${id}`,
    topBuild: null,
    matchupDelta: () => 0,
    profiles: [
      { accountId: 2, archetypes: [] },
      { accountId: 3, archetypes: [] },
      { accountId: 4, archetypes: ["tank"] },
    ] as any,
  });

  it("marks highest threat enemy as isTargetPriority with verdict 'focus' instead of conflicting 'avoid'", () => {
    const enemyCarry = {
      accountId: 2,
      team: 1,
      heroId: 10,
      netWorth: 18000, // 8k lead over me => score = -4 < -2, would normally be 'avoid'
      kills: 8,
      deaths: 1,
      assists: 2,
      itemIds: [],
      dead: false,
      respawnInS: null,
    };
    const enemySecondary = {
      accountId: 3,
      team: 1,
      heroId: 11,
      netWorth: 15000, // 5k lead over me => score = -2.5 < -2 => 'avoid'
      kills: 5,
      deaths: 2,
      assists: 3,
      itemIds: [],
      dead: false,
      respawnInS: null,
    };

    const input = createInput([enemyCarry, enemySecondary]);
    const res = enemyMatchups(input, 60);

    const target = res.find((m) => m.accountId === 2)!;
    const secondary = res.find((m) => m.accountId === 3)!;

    // Target priority must have verdict 'focus', NOT conflicting 'avoid'
    expect(target.isTargetPriority).toBe(true);
    expect(target.verdict).toBe("focus");
    expect(target.advice).toContain("Target burst tim (jangan 1v1 sendirian)");
    expect(target.advice).not.toMatch(/^Hindari 1v1/);
    expect(target.priorityReason).toContain("carry kaya");

    // The other high-NW enemy remains 'avoid' with 'Hindari 1v1'
    expect(secondary.isTargetPriority).toBeUndefined();
    expect(secondary.verdict).toBe("avoid");
    expect(secondary.advice).toContain("Hindari 1v1");
  });

  it("skips dead enemies when selecting teamfight target priority", () => {
    const deadCarry = {
      accountId: 2,
      team: 1,
      heroId: 10,
      netWorth: 20000,
      kills: 10,
      deaths: 3,
      assists: 1,
      itemIds: [],
      dead: true,
      respawnInS: 40,
    };
    const aliveCarry = {
      accountId: 3,
      team: 1,
      heroId: 11,
      netWorth: 12000,
      kills: 4,
      deaths: 2,
      assists: 4,
      itemIds: [],
      dead: false,
      respawnInS: null,
    };

    const input = createInput([deadCarry, aliveCarry]);
    const res = enemyMatchups(input, 0);

    const dead = res.find((m) => m.accountId === 2)!;
    const alive = res.find((m) => m.accountId === 3)!;

    expect(dead.verdict).toBe("dead");
    expect(dead.isTargetPriority).toBeUndefined();

    expect(alive.isTargetPriority).toBe(true);
    expect(alive.verdict).toBe("focus");
  });
});
