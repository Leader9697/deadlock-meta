import { describe, it, expect } from "vitest";
import { calibrate, type MatchLog } from "../src/matchlog";
import { habits, type HabitsInput } from "../src/habits";

describe("matchlog and habits", () => {
  const makeLog = (id: number, wonGame: boolean, winP: number, boughtRec: boolean): MatchLog => ({
    matchId: id,
    accountId: 1001,
    heroId: 1,
    team: 0,
    startedAt: 1700000000 + id * 1000,
    updatedAt: 1700000000 + id * 1000 + 1800,
    winningTeam: wonGame ? 0 : 1,
    snapshots: [
      {
        t: 120,
        winP: 0.5,
        lead: 0,
        tips: [{ kind: "macro", title: "Hold lane" }],
        next: [{ itemId: 101, kind: "core" }],
        needs: [],
        items: [],
        deaths: 0,
        nw: 1200,
      },
      {
        t: 300,
        winP,
        lead: wonGame ? 2000 : -2000,
        tips: [{ kind: "farm", title: "Push wave" }],
        next: [{ itemId: 101, kind: "core" }],
        needs: [{ kind: "anti_heal", satisfied: false }],
        items: boughtRec ? [101] : [],
        deaths: 1,
        nw: 4000,
      },
      {
        t: 600, // 10 minutes mark
        winP,
        lead: wonGame ? 4000 : -4000,
        tips: [{ kind: "macro", title: "Group up" }],
        next: [{ itemId: 102, kind: "situational" }],
        needs: [{ kind: "anti_heal", satisfied: true }],
        items: boughtRec ? [101, 102] : [],
        deaths: 2,
        nw: 8500,
      },
      {
        t: 1200,
        winP,
        lead: wonGame ? 8000 : -8000,
        tips: [],
        next: [],
        needs: [],
        items: boughtRec ? [101, 102] : [],
        deaths: 3,
        nw: 17000,
      },
    ],
  });

  it("calibrates win probabilities and computes Brier score", () => {
    // 4 matches: 3 wins where winP was 0.75, 1 loss where winP was 0.3
    const logs: MatchLog[] = [
      makeLog(1, true, 0.75, true),
      makeLog(2, true, 0.75, false),
      makeLog(3, true, 0.75, true),
      makeLog(4, false, 0.3, false),
    ];

    const cal = calibrate(logs);
    expect(cal.matches).toBe(4);
    expect(cal.finished).toBe(4);
    expect(cal.wins).toBe(3);
    expect(cal.brier).not.toBeNull();
    // Brier should be low because predictions aligned with outcomes
    expect(cal.brier!).toBeLessThan(0.25);
    expect(cal.reliability.length).toBeGreaterThan(0);
    expect(cal.follow.n).toBeGreaterThan(0);
  });

  it("analyzes cross-match player habits at 10 minutes", () => {
    const logs: MatchLog[] = [
      makeLog(1, true, 0.7, true),
      makeLog(2, true, 0.65, true),
      makeLog(3, false, 0.4, false),
    ];

    const input: HabitsInput = {
      soulsBench: new Map([[1, 8000]]), // bench for hero 1 is 8k, player had 8.5k
      avgBuyTime: new Map([[101, 360]]),
      itemName: (id: number) => (id === 101 ? "Basic Magazine" : `Item-${id}`),
      itemTier: () => 2,
      minMatches: 3,
    };

    const res = habits(logs, input);
    expect(res.matches).toBe(3);
    expect(res.deaths10.avg).toBe(2);
    expect(res.souls10.avg).toBe(8500);
    expect(res.souls10.bench).toBe(8000);
    expect(res.souls10.deltaPct).toBeGreaterThan(0); // ahead of bench (+6%)
    expect(res.perHero.length).toBe(1);
    expect(res.perHero[0].heroId).toBe(1);
  });
});
