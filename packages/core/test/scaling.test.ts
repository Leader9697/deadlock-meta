import { describe, it, expect } from "vitest";
import { KIT_FIT_MAX, itemScalesWithSpirit, kitFit, kitLean, kitSpiritScale, spiritPercentiles } from "../src/scaling";
import { buildStale } from "../src/phases";
import type { LabItem } from "../src/buildlab";
import type { Feat } from "../src/playbook";

const feat = (spiritScale?: number) => ({ spiritScale }) as Feat;
const item = (over: Partial<LabItem>) => ({ id: 1, name: "x", class_name: "x", type: "upgrade", item_slot_type: "vitality", properties: {}, ...over }) as LabItem;

describe("kit spirit scaling", () => {
  it("sums ability scaling", () => {
    expect(kitSpiritScale([feat(1), feat(0.5), feat()])).toBe(1.5);
  });

  it("ranks heroes by percentile, ties share a rank", () => {
    const p = spiritPercentiles(new Map([[1, [feat(0)]], [2, [feat(1)]], [3, [feat(3)]], [4, [feat(1)]]]));
    expect(p.get(1)).toBe(0);
    expect(p.get(3)).toBe(1);
    expect(p.get(2)).toBe(p.get(4));
  });

  it("labels the lean", () => {
    expect(kitLean(0.9)).toBe("spirit");
    expect(kitLean(0.1)).toBe("weapon");
    expect(kitLean(0.5)).toBe("mixed");
  });
});

describe("kitFit", () => {
  const spirit = item({ item_slot_type: "spirit" });
  const weapon = item({ item_slot_type: "weapon" });
  const vit = item({ item_slot_type: "vitality" });

  it("favours spirit items for a spirit kit and weapon items for a gun kit", () => {
    expect(kitFit(spirit, 1).score).toBeCloseTo(KIT_FIT_MAX);
    expect(kitFit(weapon, 1).score).toBeCloseTo(-KIT_FIT_MAX);
    expect(kitFit(weapon, 0).score).toBeCloseTo(KIT_FIT_MAX);
    expect(kitFit(spirit, 0).score).toBeCloseTo(-KIT_FIT_MAX);
  });

  it("is neutral for vitality, mixed kits and unknown heroes", () => {
    expect(kitFit(vit, 1).score).toBe(0);
    expect(kitFit(spirit, 0.5).score).toBe(0);
    expect(kitFit(spirit, null).score).toBe(0);
  });

  it("treats a spirit-scaling vitality item as a spirit item", () => {
    const scaling = item({ item_slot_type: "vitality", properties: { Heal: { value: 50, scale_function: { specific_stat_scale_type: "ETechPower", stat_scale: 0.5 } } } });
    expect(itemScalesWithSpirit(scaling)).toBe(true);
    expect(kitFit(scaling, 1).score).toBeGreaterThan(0);
  });

  it("stays small next to real item data (≤ 1.2 WR points)", () => {
    expect(Math.abs(kitFit(spirit, 1).score)).toBeLessThanOrEqual(0.012);
  });

  it("only explains a nudge worth mentioning", () => {
    expect(kitFit(spirit, 1).why).toMatch(/spirit/);
    expect(kitFit(spirit, 0.6).why).toBe("");
  });
});

describe("buildStale", () => {
  it("flags a build last edited before the patch", () => {
    expect(buildStale(100, 200)).toBe(true);
    expect(buildStale(300, 200)).toBe(false);
  });
  it("never guesses without both dates", () => {
    expect(buildStale(null, 200)).toBe(false);
    expect(buildStale(100, null)).toBe(false);
    expect(buildStale(0, 200)).toBe(false);
  });
});
