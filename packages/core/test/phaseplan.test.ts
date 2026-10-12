import { describe, expect, it } from "vitest";
import {
  GAME_PHASES,
  phaseRange,
  planPhases,
  planToText,
  type GamePhase,
  type PhaseCandidate,
} from "../src/phaseplan";

describe("GAME_PHASES & phaseRange", () => {
  it("defines standard game phases in chronological order", () => {
    expect(GAME_PHASES).toHaveLength(4);
    expect(GAME_PHASES[0].key).toBe("early");
    expect(GAME_PHASES[1].key).toBe("mid");
    expect(GAME_PHASES[2].key).toBe("late");
    expect(GAME_PHASES[3].key).toBe("vlate");
  });

  it("formats phase ranges into readable strings", () => {
    expect(phaseRange(GAME_PHASES[0])).toBe("0–10m");
    expect(phaseRange(GAME_PHASES[3])).toBe("30m+");
  });
});

describe("planPhases", () => {
  it("generates structured phase plans respecting caps and budgets", () => {
    const candidates = new Map<GamePhase, PhaseCandidate[]>([
      [
        "early",
        [
          { itemId: 101, score: 95, cost: 500, tier: 1, slot: "weapon", matches: 100 },
          { itemId: 102, score: 90, cost: 500, tier: 1, slot: "vitality", matches: 100 },
          { itemId: 103, score: 85, cost: 800, tier: 1, slot: "spirit", matches: 100 },
        ],
      ],
      [
        "mid",
        [
          { itemId: 201, score: 88, cost: 1250, tier: 2, slot: "weapon", matches: 100 },
          { itemId: 202, score: 82, cost: 1250, tier: 2, slot: "vitality", matches: 100 },
        ],
      ],
      [
        "late",
        [
          { itemId: 301, score: 92, cost: 3000, tier: 3, slot: "weapon", matches: 100 },
          { itemId: 302, score: 70, cost: 3000, tier: 3, slot: "spirit", matches: 100 },
        ],
      ],
    ]);

    const plan = planPhases(candidates);
    expect(plan).toHaveLength(4);

    const earlyPlan = plan.find((p) => p.phase.key === "early")!;
    expect(earlyPlan.steps).toHaveLength(3);
    expect(earlyPlan.steps[0].order).toBe(1);
    expect(earlyPlan.steps[0].itemId).toBe(101);

    const midPlan = plan.find((p) => p.phase.key === "mid")!;
    expect(midPlan.steps).toHaveLength(2);
    expect(midPlan.steps[0].order).toBe(4); // sequential global order

    const latePlan = plan.find((p) => p.phase.key === "late")!;
    expect(latePlan.steps).toHaveLength(2);
    expect(latePlan.steps[0].order).toBe(6);
  });

  it("produces readable text summary of the plan", () => {
    const candidates = new Map<GamePhase, PhaseCandidate[]>([
      [
        "early",
        [{ itemId: 101, score: 95, cost: 500, tier: 1, slot: "weapon", matches: 100 }],
      ],
    ]);

    const plan = planPhases(candidates);
    const text = planToText(plan, (id) => (id === 101 ? "Basic Magazine" : `#${id}`));

    expect(text).toContain("Early (0–10m):");
    expect(text).toContain("Basic Magazine");
  });
});
