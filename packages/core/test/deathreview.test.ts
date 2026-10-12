import { describe, it, expect } from "vitest";
import { reviewDeath, deathPatterns, type DeathRecord, type ReviewInput } from "../src/deathreview";
import type { LabItem } from "../src/buildlab";
import type { LivePlayer } from "../src/live";

describe("deathreview", () => {
  const dummyLab = new Map<number, LabItem>([
    [
      101,
      {
        id: 101,
        name: "Spirit Strike",
        class_name: "citadel_item_spirit_strike",
        type: "ability",
        shopable: false,
        disabled: false,
      } as LabItem,
    ],
    [
      201,
      {
        id: 201,
        name: "Spirit Armor",
        class_name: "citadel_item_spirit_armor",
        type: "upgrade",
        item_tier: 2,
        cost: 1250,
        shopable: true,
        disabled: false,
        properties: {
          MODIFIER_VALUE_TECH_RESIST: {
            provided_property_type: "MODIFIER_VALUE_TECH_RESIST",
            tooltip_section: "innate",
            value: "15",
          },
        },
      } as unknown as LabItem,
    ],
    [
      301,
      {
        id: 301,
        name: "Debuff Remover",
        class_name: "citadel_item_debuff_remover",
        type: "upgrade",
        item_tier: 3,
        cost: 3000,
        shopable: true,
        disabled: false,
        is_active_item: true,
        shop_filters: ["anti_cc", "debuff_resist"],
      } as unknown as LabItem,
    ],
  ]);

  const me: LivePlayer = {
    accountId: 1001,
    team: 0,
    heroId: 1,
    lane: 1,
    netWorth: 5000,
    kills: 1,
    deaths: 2,
    assists: 0,
    lastHits: 30,
    denies: 5,
    itemIds: [],
    dead: true,
  };

  const players: LivePlayer[] = [
    me,
    { accountId: 2001, team: 1, heroId: 2, lane: 1, netWorth: 7500, kills: 3, deaths: 0, assists: 1, lastHits: 40, denies: 10, itemIds: [], dead: false },
    { accountId: 2002, team: 1, heroId: 3, lane: 1, netWorth: 6000, kills: 1, deaths: 1, assists: 2, lastHits: 35, denies: 4, itemIds: [], dead: false },
  ];

  const defaultInput: ReviewInput = {
    me,
    players,
    lab: dummyLab,
    heroName: (id: number) => (id === 1 ? "Infernus" : id === 2 ? "Seven" : "Haze"),
    myKit: [],
    kitOf: () => [],
    matchupDelta: () => -0.05,
  };

  it("identifies outnumbered deaths", () => {
    const record: DeathRecord = {
      tick: 1000,
      gameTimeS: 450,
      killerAccount: 2001,
      assisterAccounts: [2002],
      damage: [
        { attackerHeroId: 2, abilityId: 101, damage: 400, hits: 2, damageType: 1, critDamage: 0, absorbed: 0, killingBlow: true },
        { attackerHeroId: 3, abilityId: 0, damage: 300, hits: 5, damageType: 0, critDamage: 0, absorbed: 0, killingBlow: false },
      ],
      modifiers: [],
      alliesAlive: 1,
      enemiesAlive: 4, // 4 - 1 = 3 gap
      netWorth: 5000,
      itemIds: [],
    };

    const review = reviewDeath(record, defaultInput);
    expect(review.hasRecap).toBe(true);
    expect(review.causes.some((c) => c.key === "outnumbered")).toBe(true);
    expect(review.killer).toBe("Seven");
    expect(review.fixes.length).toBeGreaterThan(0);
  });

  it("identifies burst damage and suggests resist items", () => {
    const record: DeathRecord = {
      tick: 1200,
      gameTimeS: 600,
      killerAccount: 2001,
      assisterAccounts: [],
      durationS: 2.5,
      totalDamage: 1000,
      damage: [
        { attackerHeroId: 2, abilityId: 101, damage: 800, hits: 1, damageType: 1, critDamage: 0, absorbed: 0, killingBlow: true },
      ],
      modifiers: [],
      alliesAlive: 5,
      enemiesAlive: 5,
      netWorth: 6000,
      itemIds: [],
    };

    const review = reviewDeath(record, defaultInput);
    expect(review.causes[0].key).toBe("burst");
    expect(review.fixes.some((f) => f.includes("Spirit Armor") || f.includes("Resist spirit"))).toBe(true);
  });

  it("identifies heavy CC chain and suggests anti-CC", () => {
    const record: DeathRecord = {
      tick: 1500,
      gameTimeS: 750,
      killerAccount: 2001,
      assisterAccounts: [],
      durationS: 4,
      damage: [
        { attackerHeroId: 2, abilityId: 101, damage: 500, hits: 1, damageType: 1, critDamage: 0, absorbed: 0, killingBlow: true },
      ],
      modifiers: [
        {
          abilityId: 101,
          casterAccount: 2001,
          startS: 746,
          endS: 748, // 2 seconds
          debuff: true,
        },
      ],
      alliesAlive: 5,
      enemiesAlive: 5,
      netWorth: 6000,
      itemIds: [],
    };

    // Make 101 have a stun feature
    dummyLab.set(101, {
      ...dummyLab.get(101)!,
      properties: {
        StunDuration: { value: "2.0" },
      },
    } as unknown as LabItem);

    const review = reviewDeath(record, defaultInput);
    expect(review.cc.length).toBeGreaterThanOrEqual(1);
    expect(review.causes.some((c) => c.key === "cc")).toBe(true);
    expect(review.fixes.some((f) => f.includes("Debuff Remover") || f.includes("anti-CC"))).toBe(true);
  });

  it("identifies tower damage deaths", () => {
    const record: DeathRecord = {
      tick: 800,
      gameTimeS: 300,
      killerAccount: undefined,
      assisterAccounts: [],
      damage: [
        { attackerHeroId: 0, abilityId: 0, damage: 600, hits: 4, damageType: 0, critDamage: 0, absorbed: 0, killingBlow: true },
      ],
      modifiers: [],
      alliesAlive: 5,
      enemiesAlive: 5,
      netWorth: 3000,
      itemIds: [],
    };

    const review = reviewDeath(record, defaultInput);
    expect(review.causes.some((c) => c.key === "tower")).toBe(true);
  });

  it("tracks recurring death patterns across multiple deaths", () => {
    const d1: DeathRecord = {
      tick: 500,
      gameTimeS: 200,
      killerAccount: 2001,
      assisterAccounts: [],
      damage: [{ attackerHeroId: 2, abilityId: 101, damage: 500, hits: 1, damageType: 1, critDamage: 0, absorbed: 0, killingBlow: true }],
      modifiers: [],
      alliesAlive: 5,
      enemiesAlive: 5,
      netWorth: 2000,
      itemIds: [],
    };
    const d2: DeathRecord = {
      tick: 900,
      gameTimeS: 400,
      killerAccount: 2001,
      assisterAccounts: [],
      damage: [{ attackerHeroId: 2, abilityId: 101, damage: 600, hits: 1, damageType: 1, critDamage: 0, absorbed: 0, killingBlow: true }],
      modifiers: [],
      alliesAlive: 5,
      enemiesAlive: 5,
      netWorth: 3500,
      itemIds: [],
    };
    const d3: DeathRecord = {
      tick: 1300,
      gameTimeS: 550,
      killerAccount: 2001,
      assisterAccounts: [],
      damage: [{ attackerHeroId: 2, abilityId: 101, damage: 700, hits: 1, damageType: 1, critDamage: 0, absorbed: 0, killingBlow: true }],
      modifiers: [],
      alliesAlive: 5,
      enemiesAlive: 5,
      netWorth: 4500,
      itemIds: [],
    };

    const r1 = reviewDeath(d1, defaultInput);
    const r2 = reviewDeath(d2, defaultInput);
    const r3 = reviewDeath(d3, defaultInput);

    const patterns = deathPatterns([r1, r2, r3], [d1, d2, d3], defaultInput.heroName, players);
    expect(patterns.deaths).toBe(3);
    // Seven killed 3 times
    expect(patterns.text.some((t) => t.includes("Seven sudah membunuhmu 3×"))).toBe(true);
    // 3 deaths under 10 minutes (gameTimeS < 600)
    expect(patterns.text.some((t) => t.includes("10 menit pertama"))).toBe(true);
  });
});
