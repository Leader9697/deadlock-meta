import { describe, expect, it } from "vitest";
import {
  isImbueItem,
  imbueEffect,
  abilityTraits,
  recommendImbue,
} from "../src/imbue";
import type { LabItem } from "../src/buildlab";
import type { Feat } from "../src/playbook";

describe("imbue module", () => {
  const dummyItem: LabItem = {
    id: 101,
    name: "Cooldown Extender",
    tier: 2,
    cost: 1250,
    slot: "spirit",
    type: "upgrade",
    properties: {
      ImbuedCooldownReduction: { value: 15 },
    },
    imbue: "imbue_modifier_value",
  };

  const nonImbueItem: LabItem = {
    id: 102,
    name: "Basic Magazine",
    tier: 1,
    cost: 500,
    slot: "weapon",
    type: "upgrade",
    properties: {},
  };

  const testKit: Feat[] = [
    {
      id: 1,
      name: "Soul Shards",
      slot: 1,
      isUlt: false,
      cooldown: 12,
      damage: 150,
      damageType: "spirit",
      properties: {},
    },
    {
      id: 2,
      name: "Shadow Escape",
      slot: 2,
      isUlt: false,
      cooldown: 28,
      duration: 3,
      properties: {},
    },
    {
      id: 3,
      name: "Grand Finale",
      slot: 4,
      isUlt: true,
      cooldown: 90,
      damage: 600,
      damageType: "spirit",
      properties: {},
    },
  ];

  it("identifies imbue items correctly", () => {
    expect(isImbueItem(dummyItem)).toBe(true);
    expect(isImbueItem(nonImbueItem)).toBe(false);
    expect(isImbueItem(null)).toBe(false);
  });

  it("extracts imbue effect details properly", () => {
    const effect = imbueEffect(dummyItem);
    expect(effect).not.toBeNull();
    expect(effect?.kind).toBe("cooldown");
    expect(effect?.pct).toBe(15);
    expect(effect?.noUlt).toBe(false);

    const chargeItem: LabItem = {
      id: 103,
      name: "Extra Charge",
      tier: 2,
      cost: 1250,
      slot: "spirit",
      type: "upgrade",
      properties: {
        BonusAbilityCharges: { value: 1 },
      },
      imbue: "imbue_modifier_value",
    };
    const chargeEffect = imbueEffect(chargeItem);
    expect(chargeEffect?.kind).toBe("charges");
    expect(chargeEffect?.extra).toBe(1);
  });

  it("extracts ability traits correctly", () => {
    const traits = abilityTraits(testKit[0]);
    expect(traits).toContain("damage 150");
  });

  it("recommends imbue target based on stat alignment", () => {
    const rec = recommendImbue(dummyItem, testKit);
    expect(rec).not.toBeNull();
    expect(rec?.target.id).toBe(1); // Soul Shards provides active damage and high frequency casts
    expect(rec?.target.name).toBe("Soul Shards");
    expect(rec?.source).toBe("stat");
  });
});
