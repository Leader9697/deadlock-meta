import { describe, it, expect } from "vitest";
import { parseMatchMetadata, reviewMatch, type PostMatchInput } from "../src/postmatch";
import type { Item } from "../src/types";

describe("postmatch", () => {
  const dummyItems = new Map<number, Item>([
    [
      101,
      {
        id: 101,
        name: "Warp Stone",
        type: "upgrade",
        item_tier: 3,
        cost: 3000,
      } as Item,
    ],
  ]);

  const rawMatchData = {
    match_info: {
      match_id: 1234567,
      duration_s: 1500,
      winning_team: "Team0",
      average_badge_team0: 45,
      average_badge_team1: 43,
      players: [
        {
          account_id: 1001,
          player_slot: 0,
          team: "Team0",
          hero_id: 1,
          assigned_lane: 1,
          kills: 8,
          deaths: 2,
          assists: 10,
          net_worth: 24000,
          last_hits: 150,
          denies: 15,
          items: [
            { game_time_s: 900, item_id: 101, sold_time_s: 0 },
          ],
          stats: [
            { time_stamp_s: 600, net_worth: 8500, gold_lane_creep: 4000, gold_neutral_creep: 2000, gold_player: 1500 },
            { time_stamp_s: 1200, net_worth: 18000, gold_lane_creep: 8000, gold_neutral_creep: 5000, gold_player: 3500 },
            { time_stamp_s: 1500, net_worth: 24000, gold_lane_creep: 10000, gold_neutral_creep: 7000, gold_player: 5000 },
          ],
          death_details: [
            { game_time_s: 400, killer_player_slot: 6, death_duration_s: 15 },
            { game_time_s: 1100, killer_player_slot: 6, death_duration_s: 35 },
          ],
        },
        {
          account_id: 1002,
          player_slot: 1,
          team: "Team0",
          hero_id: 2,
          assigned_lane: 3,
          kills: 4,
          deaths: 5,
          assists: 8,
          net_worth: 16000,
          last_hits: 100,
          denies: 5,
          items: [],
          stats: [
            { time_stamp_s: 1500, gold_lane_creep: 6000, gold_neutral_creep: 3000, gold_player: 2500 },
          ],
          death_details: [],
        },
        {
          account_id: 2001,
          player_slot: 6,
          team: "Team1",
          hero_id: 5,
          assigned_lane: 1,
          kills: 5,
          deaths: 6,
          assists: 4,
          net_worth: 17000,
          last_hits: 110,
          denies: 8,
          items: [],
          stats: [
            { time_stamp_s: 600, net_worth: 7200 },
          ],
          death_details: [],
        },
      ],
    },
  };

  it("parses raw match metadata accurately", () => {
    const parsed = parseMatchMetadata(rawMatchData);
    expect(parsed).not.toBeNull();
    expect(parsed?.matchId).toBe(1234567);
    expect(parsed?.durationS).toBe(1500);
    expect(parsed?.winningTeam).toBe(0);
    expect(parsed?.averageBadge).toBe(44);
    expect(parsed?.players.length).toBe(3);
    expect(parsed?.players[0].accountId).toBe(1001);
  });

  it("generates detailed post-match review and detects late items", () => {
    const parsed = parseMatchMetadata(rawMatchData)!;
    const input: PostMatchInput = {
      accountId: 1001,
      items: dummyItems,
      heroName: (id: number) => (id === 1 ? "Infernus" : id === 5 ? "Seven" : `Hero-${id}`),
      avgBuyTime: new Map([[101, 600]]), // average is 600s (10m), player bought at 900s (+300s -> late!)
      netWorthBench: { 600: 8000, 1200: 17000, 1800: 25000 },
    };

    const review = reviewMatch(parsed, input);
    expect(review).not.toBeNull();
    expect(review?.won).toBe(true);
    expect(review?.kda).toBe("8/2/10");
    expect(review?.soulsPerMin).toBeCloseTo((24000 / 1500) * 60, 1);
    expect(review?.checkpoints.length).toBe(2); // 600 and 1200 (< 1500)
    expect(review?.checkpoints[0].laneOpp).toBe(7200);

    // Late items check
    expect(review?.lateItems.length).toBe(1);
    expect(review?.lateItems[0].name).toBe("Warp Stone");
    expect(review?.lateItems[0].deltaS).toBe(300);

    // Deaths check
    expect(review?.deaths.length).toBe(2);
    expect(review?.deaths[0].killer).toBe("Seven");
    expect(review?.deadSeconds).toBe(50);

    // Farm breakdown
    expect(review?.farm.some((f) => f.source === "Creep lane")).toBe(true);
  });

  it("returns null when player is not in match", () => {
    const parsed = parseMatchMetadata(rawMatchData)!;
    const input: PostMatchInput = {
      accountId: 999999,
      items: dummyItems,
      heroName: () => "Unknown",
      avgBuyTime: new Map(),
      netWorthBench: null,
    };
    expect(reviewMatch(parsed, input)).toBeNull();
  });
});
