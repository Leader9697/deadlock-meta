import { describe, it, expect } from "vitest";
import { countDestroyedStages, laneStates, macroPlan, type MacroInput } from "../src/macro";
import type { LiveState, LivePlayer } from "../src/live";

describe("macro", () => {
  it("computes countDestroyedStages correctly", () => {
    expect(countDestroyedStages(undefined)).toBe(0);
    expect(countDestroyedStages(NaN)).toBe(0);
    // All standing: all bits 1..4, 5..8, 12..15 set
    // Mask with all bits 1 to 15 set: (1 << 16) - 1 = 65535
    expect(countDestroyedStages(0xffff)).toBe(0);
    // All destroyed: mask = 0 (all bits 0)
    // 4 lanes * 3 stages = 12 destroyed
    expect(countDestroyedStages(0)).toBe(12);
  });

  const me: LivePlayer = {
    accountId: 1001,
    team: 0,
    heroId: 1,
    lane: 1, // Lane 1 (Kuning)
    netWorth: 8000,
    kills: 2,
    deaths: 0,
    assists: 3,
    lastHits: 80,
    denies: 10,
    itemIds: [],
    dead: false,
  };

  const allies: LivePlayer[] = [
    me,
    { accountId: 1002, team: 0, heroId: 2, lane: 3, netWorth: 7500, kills: 1, deaths: 0, assists: 2, lastHits: 70, denies: 5, itemIds: [], dead: false },
    { accountId: 1003, team: 0, heroId: 3, lane: 4, netWorth: 7000, kills: 0, deaths: 0, assists: 1, lastHits: 60, denies: 3, itemIds: [], dead: false },
    { accountId: 1004, team: 0, heroId: 4, lane: 6, netWorth: 6500, kills: 1, deaths: 1, assists: 1, lastHits: 55, denies: 2, itemIds: [], dead: false },
  ];

  const enemies: LivePlayer[] = [
    { accountId: 2001, team: 1, heroId: 5, lane: 1, netWorth: 7000, kills: 0, deaths: 1, assists: 0, lastHits: 60, denies: 4, itemIds: [], dead: false },
    { accountId: 2002, team: 1, heroId: 6, lane: 3, netWorth: 6500, kills: 1, deaths: 0, assists: 0, lastHits: 50, denies: 2, itemIds: [], dead: false },
    { accountId: 2003, team: 1, heroId: 7, lane: 4, netWorth: 6000, kills: 0, deaths: 1, assists: 1, lastHits: 45, denies: 1, itemIds: [], dead: false },
    { accountId: 2004, team: 1, heroId: 8, lane: 6, netWorth: 5500, kills: 0, deaths: 2, assists: 0, lastHits: 40, denies: 0, itemIds: [], dead: false },
  ];

  const baseState: LiveState = {
    matchId: 9999,
    gameTimeS: 700,
    players: [...allies, ...enemies],
    objectiveMasks: [0xffff, 0xffff],
  };

  const defaultInput: MacroInput = {
    state: baseState,
    me,
    netWorthLead: 4000,
    winP: 0.58,
    scalingDiff: 0.02,
    delayS: 75,
    heroName: (id: number) => `Hero-${id}`,
  };

  it("calculates lane states from objective masks", () => {
    const lanes = laneStates(defaultInput);
    expect(lanes.length).toBe(4);
    expect(lanes.find((l) => l.color === 1)?.name).toBe("Kuning");
    expect(lanes.every((l) => l.status === "seimbang")).toBe(true);
  });

  it("triggers urgent push recommendation when enemies are dead (numbers window)", () => {
    const deadEnemies = enemies.map((e, idx) => {
      if (idx === 0 || idx === 1) {
        return { ...e, dead: true, respawnInS: 120 }; // 120 - 75 = 45s real left
      }
      return e;
    });

    const state: LiveState = {
      ...baseState,
      players: [...allies, ...deadEnemies],
    };

    const plan = macroPlan({
      ...defaultInput,
      state,
    });

    expect(plan.action).toBe("push");
    expect(plan.urgent).toBe(true);
    expect(plan.until).toBeDefined();
    expect(plan.why.some((w) => w.includes("musuh mati"))).toBe(true);
  });

  it("triggers urgent defend recommendation when allies are dead (numbers deficit)", () => {
    const deadAllies = allies.map((a, idx) => {
      if (idx === 1 || idx === 2) {
        return { ...a, dead: true, respawnInS: 125 };
      }
      return a;
    });

    const state: LiveState = {
      ...baseState,
      players: [...deadAllies, ...enemies],
    };

    const plan = macroPlan({
      ...defaultInput,
      state,
    });

    expect(plan.action).toBe("defend");
    expect(plan.urgent).toBe(true);
    expect(plan.why.some((w) => w.includes("teman mati"))).toBe(true);
  });

  it("recommends lane push in laning phase when lane opponent is dead", () => {
    const laneDeadEnemy: LivePlayer = {
      ...enemies[0],
      dead: true,
      respawnInS: 90,
    };

    const state: LiveState = {
      ...baseState,
      gameTimeS: 300, // early laning phase
      players: [...allies, laneDeadEnemy, ...enemies.slice(1)],
    };

    const plan = macroPlan({
      ...defaultInput,
      state,
    });

    expect(plan.action).toBe("push");
    expect(plan.title).toContain("Guardian lawan");
  });
});
