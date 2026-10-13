import { describe, it, expect, afterEach } from "vitest";
import {
  COST_SENTINEL,
  DEFAULT_TIER_PRICES,
  configureTierPrices,
  isPriced,
  itemCost,
  souls,
  tierPrices,
  tierPricesFromEnv,
  withItemCost,
} from "../src/prices";

afterEach(() => configureTierPrices(null));

describe("itemCost", () => {
  it("prefers the tier price over a stale asset cost", () => {
    // the bug Faris hit: the asset dump still said 500 while the shop charged 800
    expect(itemCost({ item_tier: 1, cost: 500 })).toBe(800);
    expect(itemCost({ item_tier: 2, cost: 1250 })).toBe(1600);
    expect(itemCost({ item_tier: 3, cost: 3000 })).toBe(3200);
    expect(itemCost({ item_tier: 4, cost: 6200 })).toBe(6400);
  });

  it("treats the 9999 placeholder as not a shop item", () => {
    expect(itemCost({ cost: COST_SENTINEL })).toBe(0);
    expect(itemCost({ cost: 12000 })).toBe(0);
    expect(isPriced({ cost: COST_SENTINEL })).toBe(false);
  });

  it("falls back to the asset cost when there is no tier", () => {
    expect(itemCost({ cost: 1234 })).toBe(1234);
    expect(itemCost({ item_tier: 0, cost: 1234 })).toBe(1234);
  });

  it("returns 0 for missing, zero and negative costs", () => {
    expect(itemCost(null)).toBe(0);
    expect(itemCost({})).toBe(0);
    expect(itemCost({ cost: 0 })).toBe(0);
    expect(itemCost({ cost: -5 })).toBe(0);
  });

  it("withItemCost rewrites cost in place for downstream consumers", () => {
    const fixed = withItemCost({ id: 7, item_tier: 1, cost: 500 });
    expect(fixed.cost).toBe(800);
    expect(fixed.id).toBe(7); // other fields survive
  });
});

describe("tier price overrides", () => {
  it("parses a positional list", () => {
    expect(tierPricesFromEnv("800,1600,3200,6400")).toEqual(DEFAULT_TIER_PRICES);
  });

  it("parses explicit tier=price pairs", () => {
    expect(tierPricesFromEnv("1=900, 2=1800")).toEqual({ 1: 900, 2: 1800 });
  });

  it("rejects junk instead of guessing", () => {
    expect(tierPricesFromEnv("")).toBeNull();
    expect(tierPricesFromEnv(undefined)).toBeNull();
    expect(tierPricesFromEnv("abc")).toBeNull();
    expect(tierPricesFromEnv("1=0")).toBeNull();
    expect(tierPricesFromEnv(`1=${COST_SENTINEL}`)).toBeNull();
  });

  it("applies an override and restores the defaults", () => {
    configureTierPrices({ 1: 900 });
    expect(itemCost({ item_tier: 1, cost: 500 })).toBe(900);
    configureTierPrices(null);
    expect(tierPrices()).toEqual(DEFAULT_TIER_PRICES);
  });
});

describe("souls formatting", () => {
  it("writes prices exactly, the way the shop does", () => {
    // k() showed 1250 as "1.3k", which is what made the HUD disagree with the shop
    expect(souls(800)).toBe("800");
    expect(souls(1250)).toBe("1.250");
    expect(souls(6400)).toBe("6.400");
    expect(souls(1250.4)).toBe("1.250");
  });
});
