import { describe, it, expect } from "vitest";
import {
  phaseAt,
  TIER_FLOOR,
  slotUsage,
  sellAdvice,
  findNeeds,
  type Need,
  type AdaptiveStep,
  type EnemyProfile,
  type DamageProfile,
} from "../src/adaptive";
import type { LabItem } from "../src/buildlab";
import type { LivePlayer } from "../src/live";

describe("adaptive phase and tier floors", () => {
  it("determines correct game phase from match time", () => {
    expect(phaseAt(300)).toBe("early"); // 5 mins
    expect(phaseAt(600)).toBe("mid"); // 10 mins
    expect(phaseAt(900)).toBe("mid"); // 15 mins
    expect(phaseAt(1300)).toBe("late"); // ~21 mins
    expect(phaseAt(2000)).toBe("vlate"); // ~33 mins
  });

  it("enforces increasing tier floors as game progresses", () => {
    expect(TIER_FLOOR.early).toBe(1);
    expect(TIER_FLOOR.mid).toBe(2);
    expect(TIER_FLOOR.late).toBe(3);
    expect(TIER_FLOOR.vlate).toBe(3);
  });
});

describe("slotUsage accounting", () => {
  const createItem = (id: number, slot: "weapon" | "vitality" | "spirit"): LabItem =>
    ({
      id,
      name: `Item_${id}`,
      item_slot_type: slot,
      type: "upgrade",
      cost: 500,
    }) as any;

  it("calculates category counts and zero flex usage within base 4 slots", () => {
    const owned: LabItem[] = [
      createItem(1, "weapon"),
      createItem(2, "weapon"),
      createItem(3, "vitality"),
      createItem(4, "spirit"),
    ];

    const res = slotUsage(owned, 0);
    expect(res.count.weapon).toBe(2);
    expect(res.count.vitality).toBe(1);
    expect(res.count.spirit).toBe(1);
    expect(res.flexUsed).toBe(0);
    expect(res.flexFree).toBe(0);
  });

  it("overflows into flex slots when a category exceeds 4 items", () => {
    // 5 weapons, 2 vitality, 1 spirit -> 1 flex needed
    const owned: LabItem[] = [
      createItem(1, "weapon"),
      createItem(2, "weapon"),
      createItem(3, "weapon"),
      createItem(4, "weapon"),
      createItem(5, "weapon"), // 5th weapon
      createItem(6, "vitality"),
      createItem(7, "vitality"),
      createItem(8, "spirit"),
    ];

    const with2Flex = slotUsage(owned, 2);
    expect(with2Flex.count.weapon).toBe(5);
    expect(with2Flex.flexUsed).toBe(1);
    expect(with2Flex.flexFree).toBe(1); // 2 - 1 = 1 free

    const with0Flex = slotUsage(owned, 0);
    expect(with0Flex.flexUsed).toBe(1);
    expect(with0Flex.flexFree).toBe(0);
  });

  it("handles maximum capacity across categories and 4 flex slots", () => {
    // 6 weapon (2 flex), 5 vitality (1 flex), 5 spirit (1 flex) = 4 flex used
    const owned: LabItem[] = [
      createItem(1, "weapon"),
      createItem(2, "weapon"),
      createItem(3, "weapon"),
      createItem(4, "weapon"),
      createItem(5, "weapon"),
      createItem(6, "weapon"),
      createItem(7, "vitality"),
      createItem(8, "vitality"),
      createItem(9, "vitality"),
      createItem(10, "vitality"),
      createItem(11, "vitality"),
      createItem(12, "spirit"),
      createItem(13, "spirit"),
      createItem(14, "spirit"),
      createItem(15, "spirit"),
      createItem(16, "spirit"),
    ];

    const res = slotUsage(owned, 4);
    expect(res.count.weapon).toBe(6);
    expect(res.count.vitality).toBe(5);
    expect(res.count.spirit).toBe(5);
    expect(res.flexUsed).toBe(4);
    expect(res.flexFree).toBe(0);
  });
});

describe("sellAdvice logic", () => {
  const lab = new Map<number, LabItem>([
    [101, { id: 101, class_name: "upgrade_t1_w", name: "Basic Magazine", item_slot_type: "weapon", item_tier: 1, cost: 500, type: "upgrade" } as any],
    [102, { id: 102, class_name: "upgrade_t2_w", name: "Fleetfoot", item_slot_type: "weapon", item_tier: 2, cost: 1250, type: "upgrade" } as any],
    [103, { id: 103, class_name: "upgrade_t2_w_core", name: "Active Reload", item_slot_type: "weapon", item_tier: 2, cost: 1250, type: "upgrade" } as any],
    [104, { id: 104, class_name: "upgrade_t3_w", name: "Pristine Emblem", item_slot_type: "weapon", item_tier: 3, cost: 3000, type: "upgrade" } as any],
    [105, { id: 105, class_name: "upgrade_t4_w", name: "Spiritual Overflow", item_slot_type: "weapon", item_tier: 4, cost: 6200, type: "upgrade" } as any],
  ]);

  const me: LivePlayer = {
    accountId: 1,
    team: 0,
    heroId: 1,
    netWorth: 10000,
    kills: 2,
    deaths: 1,
    assists: 3,
    itemIds: [101, 102, 103, 104], // 4 weapon items (slots full)
  } as any;

  it("does not advise selling if category slots and flex slots are not full", () => {
    const meNotFull = { ...me, itemIds: [101, 102] }; // only 2 items
    const next: AdaptiveStep[] = [
      { itemId: 105, name: "Spiritual Overflow", cost: 6200, tier: 4, slot: "weapon", kind: "core", missing: 2000, affordable: false, reason: "Core late" },
    ];

    const advice = sellAdvice({
      me: meNotFull,
      lab,
      next,
      needs: [],
      flexUnlocked: 0,
      heroItemDelta: () => 0,
    });

    expect(advice).toBeNull();
  });

  it("recommends selling the lowest tier non-core item when category slots are full", () => {
    const next: AdaptiveStep[] = [
      { itemId: 105, name: "Spiritual Overflow", cost: 6200, tier: 4, slot: "weapon", kind: "core", missing: 1000, affordable: false, reason: "Core late" },
    ];

    const advice = sellAdvice({
      me,
      lab,
      next,
      needs: [],
      flexUnlocked: 0,
      heroItemDelta: () => 0,
      coreIds: new Set([103]), // Active reload is core
    });

    expect(advice).not.toBeNull();
    // 101 is Tier 1 (500 cost), should be sold first
    expect(advice!.sellId).toBe(101);
    expect(advice!.sellName).toBe("Basic Magazine");
    // 50% refund of 500 = 250
    expect(advice!.refund).toBe(250);
    expect(advice!.forId).toBe(105);
  });

  it("protects combo items from being sold", () => {
    const next: AdaptiveStep[] = [
      { itemId: 105, name: "Spiritual Overflow", cost: 6200, tier: 4, slot: "weapon", kind: "core", missing: 1000, affordable: false, reason: "Core late" },
    ];

    const advice = sellAdvice({
      me,
      lab,
      next,
      needs: [],
      flexUnlocked: 0,
      heroItemDelta: () => 0,
      keepIds: new Set([101]), // 101 is part of hero combo
    });

    expect(advice).not.toBeNull();
    // 101 must be protected even though it's Tier 1; 102 should be picked instead
    expect(advice!.sellId).toBe(102);
    expect(advice!.sellName).toBe("Fleetfoot");
  });
});

describe("findNeeds enemy counter detection", () => {
  it("generates anti_heal need when enemy has strong sustain and healing", () => {
    const profiles: EnemyProfile[] = [
      {
        accountId: 2,
        heroId: 10,
        weight: 1.5,
        souls: { weapon: 3000, vitality: 5000, spirit: 2000 },
        bulletShare: 0.5,
        tagSouls: { lifesteal: 2500 },
        healPerMin: 1200,
        archetypes: ["sustain"],
        notable: [],
      },
    ];

    const damage: DamageProfile = { bullet: 0.5, spirit: 0.5 };
    const needs = findNeeds(profiles, damage, [], (id) => `Hero_${id}`, []);

    const antiHeal = needs.find((n) => n.kind === "anti_heal");
    expect(antiHeal).toBeDefined();
    expect(antiHeal!.urgency).toBeGreaterThan(0.4);
    expect(antiHeal!.satisfied).toBe(false);
  });

  it("marks need as satisfied when player already has matching item tag", () => {
    const profiles: EnemyProfile[] = [
      {
        accountId: 2,
        heroId: 10,
        weight: 1.5,
        souls: { weapon: 3000, vitality: 5000, spirit: 2000 },
        bulletShare: 0.5,
        tagSouls: { lifesteal: 2500 },
        healPerMin: 1200,
        archetypes: ["sustain"],
        notable: [],
      },
    ];

    const damage: DamageProfile = { bullet: 0.5, spirit: 0.5 };
    // Player already owns an anti-heal item (Toxic Bullets / Decay)
    const myOwnedLabItem: LabItem = {
      id: 999,
      class_name: "upgrade_toxic_bullets",
      name: "Toxic Bullets",
      item_slot_type: "weapon",
      type: "upgrade",
      item_tier: 3,
      properties: { HealAmpReceivePenalty: { value: -0.65 } },
    } as any;

    const needs = findNeeds(profiles, damage, [myOwnedLabItem], (id) => `Hero_${id}`, []);

    const antiHeal = needs.find((n) => n.kind === "anti_heal");
    expect(antiHeal).toBeDefined();
    expect(antiHeal!.satisfied).toBe(true);
  });
});
