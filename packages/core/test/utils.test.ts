import { describe, expect, it } from "vitest";
import { maxOrder } from "../src/abilities";
import { heroCombo } from "../src/combo";
import { scoreCounterItems } from "../src/counter";
import { classify, htmlToLines, parsePatch, summarizeKinds } from "../src/patchnotes";
import type { Feat } from "../src/playbook";
import { isWin } from "../src/scout";
import { buildHeroMeta, formatClock, formatDelta, formatPct, shrink, wilsonLower, winrate } from "../src/stats";
import { toAccountId, toSteam64 } from "../src/steam";
import type { AnalyticsHeroStats, ItemStats, MatchHistoryEntry, PatchNote } from "../src/types";

describe("stats", () => {
  it("winrate and Wilson lower bound", () => {
    expect(winrate(0, 0)).toBe(0);
    expect(winrate(6, 10)).toBeCloseTo(0.6);
    expect(wilsonLower(0, 0)).toBe(0);
    // a small sample is punished more than a large one with the same rate
    expect(wilsonLower(6, 10)).toBeLessThan(wilsonLower(600, 1000));
    expect(wilsonLower(600, 1000)).toBeLessThan(0.6);
  });
  it("shrink pulls toward the prior", () => {
    expect(shrink(10, 10, 0.5, 10)).toBeCloseTo(0.75);
    expect(shrink(0, 0, 0.5, 10)).toBeCloseTo(0.5);
  });
  it("formats", () => {
    expect(formatPct(0.5234)).toBe("52.3%");
    expect(formatDelta(0.012)).toBe("+1.2");
    expect(formatDelta(-0.012)).toBe("-1.2");
    expect(formatClock(-5)).toBe("0:00");
    expect(formatClock(825)).toBe("13:45");
  });
  it("buildHeroMeta ranks a strong hero above a weak one and skips empty rows", () => {
    const row = (hero_id: number, wins: number, matches: number): AnalyticsHeroStats => ({
      hero_id,
      bucket: 0,
      wins,
      losses: matches - wins,
      matches,
      matches_per_bucket: matches,
      total_kills: matches * 5,
      total_deaths: matches * 5,
      total_assists: matches * 5,
      total_net_worth: matches * 30000,
      total_player_damage: matches * 20000,
      total_last_hits: matches * 100,
    });
    const meta = buildHeroMeta([row(1, 5600, 10000), row(2, 4400, 10000), row(3, 0, 0), row(4, 5000, 10000)]);
    expect(meta.map((m) => m.heroId)).not.toContain(3);
    expect(meta[0].heroId).toBe(1);
    expect(meta[meta.length - 1].heroId).toBe(2);
  });
});

describe("steam ids", () => {
  it("accepts SteamID64, SteamID3, profile URLs and account ids", () => {
    expect(toAccountId("76561197960265738")).toBe(10);
    expect(toAccountId("[U:1:12345]")).toBe(12345);
    expect(toAccountId("https://steamcommunity.com/profiles/76561197960265738/")).toBe(10);
    expect(toAccountId(" 42 ")).toBe(42);
    expect(toAccountId("https://steamcommunity.com/id/vanity")).toBeNull();
    expect(toAccountId("0")).toBeNull();
    expect(toSteam64(10)).toBe("76561197960265738");
  });
});

describe("patch notes", () => {
  it("splits html into clean lines", () => {
    expect(htmlToLines("<p>- Haze: Bullet damage from 5 to 6</p><br>ok<li>&amp; Fixed a bug</li>")).toEqual(["Haze: Bullet damage from 5 to 6", "& Fixed a bug"]);
  });
  it("classifies buffs and nerfs, with lower-is-better stats inverted", () => {
    expect(classify("Bullet damage increased from 5 to 6")).toBe("buff");
    expect(classify("Bullet damage from 6 to 5")).toBe("nerf");
    expect(classify("Cooldown reduced from 30s to 25s")).toBe("buff");
    expect(classify("Cooldown increased")).toBe("nerf");
    expect(classify("Updated the icon")).toBe("change");
  });
  it("attributes lines under a hero header to that hero", () => {
    const p = {
      title: "Update",
      link: "l",
      pub_date: "2026-01-01",
      content_encoded: "<p>Haze</p><p>Bullet damage from 5 to 6</p><p>Mystic Burst cooldown from 10 to 8</p>",
    } as unknown as PatchNote;
    const parsed = parsePatch(p, [{ id: 13, name: "Haze" }], [{ id: 77, name: "Mystic Burst" }]);
    expect(parsed.heroes.get(13)?.map((l) => l.kind)).toEqual(["buff"]);
    expect(parsed.items.get(77)?.[0].kind).toBe("buff");
    expect(summarizeKinds(parsed.lines)).toEqual({ buff: 2, nerf: 0, change: 0 });
  });
});

describe("ability order", () => {
  it("orders abilities by when they got their last point", () => {
    expect(maxOrder([1, 2, 1, 3, 2, 1, 3, 3])).toEqual([2, 1, 3]);
    expect(maxOrder([])).toEqual([]);
  });
});

describe("counter scoring", () => {
  const st = (item_id: number, wins: number, matches: number): ItemStats => ({
    item_id,
    bucket: 0,
    wins,
    losses: matches - wins,
    matches,
    players: matches,
    avg_buy_time_s: 600,
    avg_buy_time_relative: 0,
    avg_sell_time_s: 0,
  });
  it("ranks the item that over-performs against the enemy, net of the lineup drift", () => {
    const baseline = [st(1, 500, 1000), st(2, 500, 1000)];
    const vsEnemy = new Map([[13, [st(1, 600, 1000), st(2, 500, 1000)]]]);
    const out = scoreCounterItems(baseline, vsEnemy);
    expect(out[0].itemId).toBe(1);
    expect(out[0].score).toBeGreaterThan(0);
    expect(out[1].score).toBeLessThan(0);
    expect(out[0].perEnemy[0].enemyHeroId).toBe(13);
  });
  it("partial coverage does not inflate the score", () => {
    const baseline = [st(1, 500, 1000), st(2, 500, 1000)];
    const one = scoreCounterItems(baseline, new Map([[13, [st(1, 600, 1000), st(2, 500, 1000)]]]));
    const two = scoreCounterItems(baseline, new Map([[13, [st(1, 600, 1000), st(2, 500, 1000)]], [25, [st(2, 500, 1000)]]]));
    expect(two.find((c) => c.itemId === 1)!.score).toBeLessThan(one.find((c) => c.itemId === 1)!.score);
  });
});

describe("hero combo", () => {
  const f = (p: Partial<Feat> & { id: number; name: string }): Feat =>
    ({ isItem: false, ult: false, active: true, dot: false, burst: false, aoe: false, skillshot: false, mobility: false, stealth: false, barrier: false, ...p }) as Feat;
  it("opens with the strongest non-ult lock and ends with the ult", () => {
    const combo = heroCombo([
      f({ id: 1, name: "Slow", slow: { pct: 30, dur: 2 } }),
      f({ id: 2, name: "Stun", stun: 1.5 }),
      f({ id: 3, name: "Nuke", burst: true }),
      f({ id: 4, name: "Ult", ult: true, burst: true, execute: 0.2 }),
    ]);
    expect(combo.steps[0]).toMatchObject({ id: 2, role: "buka" });
    expect(combo.steps.some((s) => s.id === 4 && s.role === "tutup")).toBe(true);
  });
  it("handles an empty kit", () => {
    expect(heroCombo([]).steps).toEqual([]);
  });
});

describe("scout", () => {
  it("win = match_result equals player_team (player_match_outcome is unreliable)", () => {
    expect(isWin({ match_result: 1, player_team: 1, player_match_outcome: 1 } as MatchHistoryEntry)).toBe(true);
    expect(isWin({ match_result: 0, player_team: 1, player_match_outcome: 0 } as MatchHistoryEntry)).toBe(false);
  });
});
