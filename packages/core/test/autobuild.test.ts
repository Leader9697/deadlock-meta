import { describe, expect, it } from "vitest";
import { autoBuild, autoBuilds, autoBuildText, itemEvidence, SLOTS_BASE, type AutoBuildInput } from "../src/autobuild";
import type { LabHero, LabItem } from "../src/buildlab";
import type { ItemStats } from "../src/types";

type Slot = "weapon" | "vitality" | "spirit";
let nextId = 100;
const items: LabItem[] = [];
const prop = (t: string, v: number) => ({ value: v, provided_property_type: t, tooltip_section: "innate", conditional: null });
function mk(name: string, slot: Slot, tier: number, props: Record<string, ReturnType<typeof prop> | { value: number }> = {}, extra: Partial<LabItem> = {}): LabItem {
  const it = { id: nextId++, name, class_name: `upgrade_${name.replace(/\s/g, "_").toLowerCase()}`, type: "upgrade", item_slot_type: slot, item_tier: tier, cost: 500, shopable: true, disabled: false, properties: props, ...extra } as LabItem;
  items.push(it);
  return it;
}

// a small but complete shop: 6 items per category per tier, with stats
const STAT: Record<Slot, string> = { weapon: "MODIFIER_VALUE_WEAPON_DAMAGE_INCREASE", vitality: "MODIFIER_VALUE_HEALTH_MAX", spirit: "MODIFIER_VALUE_TECH_POWER" };
const SIZE: Record<Slot, number> = { weapon: 8, vitality: 100, spirit: 6 };
for (const slot of ["weapon", "vitality", "spirit"] as Slot[])
  for (const tier of [1, 2, 3, 4]) for (let i = 0; i < 6; i++) mk(`${slot} t${tier} #${i}`, slot, tier, { s: prop(STAT[slot], SIZE[slot] * tier) });
const antiHeal = mk("Healbane", "spirit", 2, { HealAmpReceivePenaltyPercent: { value: -40 } });
const bulletRes = mk("Bullet Armor", "vitality", 2, { r: prop("MODIFIER_VALUE_BULLET_ARMOR_DAMAGE_RESIST", 20) });
const comp = mk("Basic Mag", "weapon", 1, { s: prop(STAT.weapon, 10) });
const upgrade = mk("Big Mag", "weapon", 3, { s: prop(STAT.weapon, 40) }, { component_items: [comp.class_name] });
const weapon = { id: 1, name: "gun", class_name: "gun", type: "weapon", properties: {}, weapon_info: { bullet_damage: 10, bullets: 1, clip_size: 20, reload_duration: 2, shots_per_second: 5 } } as LabItem;
const ability = { id: 2, name: "zap", class_name: "zap", type: "ability", properties: { Damage: { value: 100, scale_function: { specific_stat_scale_type: "ETechPower", stat_scale: 2 } } } } as LabItem;
items.push(weapon, ability);
const hero: LabHero = {
  id: 7,
  name: "Tester",
  items: { weapon_primary: "gun", signature1: "zap" },
  starting_stats: { max_health: { value: 600 } },
  level_info: { "1": { required_gold: 0 } },
  cost_bonuses: null,
};

const row = (it: LabItem, wins: number, matches: number, buy: number): ItemStats => ({ item_id: it.id, bucket: 0, wins, losses: matches - wins, matches, players: matches, avg_buy_time_s: buy, avg_buy_time_relative: 0, avg_sell_time_s: 0 });
const buyAt: Record<number, number> = { 1: 300, 2: 700, 3: 1400, 4: 2100 };
const rows: ItemStats[] = items
  .filter((i) => i.type === "upgrade")
  .map((i, k) => row(i, Math.round(1000 * (0.48 + (k % 5) * 0.01)), 1000, buyAt[i.item_tier ?? 1]));
// one standout item per tier-2 weapon slot
const star = items.find((i) => i.name === "weapon t2 #3")!;
rows.find((r) => r.item_id === star.id)!.wins = 600;

const input: AutoBuildInput = { hero, items, itemRows: rows, heroMatches: 5000, heroWr: 0.5, flow: null, kitPct: 0.5, publicBuilds: [{ id: 99, name: "pub", winrate: 0.55, matches: 900, items: [star.id] }] };

describe("autoBuild", () => {
  const std = autoBuild(input);
  const byId = new Map(items.map((i) => [i.id, i]));

  it("fills every phase with tiers that fit it (late game never buys T1/T2)", () => {
    expect(std.steps.length).toBeGreaterThanOrEqual(12);
    for (const s of std.steps) {
      if (s.phase === "early") expect(s.tier).toBeLessThanOrEqual(2);
      if (s.phase === "late" || s.phase === "vlate") expect(s.tier).toBeGreaterThanOrEqual(3);
    }
  });

  it("prices from the tier table, never the asset dump's 500", () => {
    for (const s of std.steps) expect(s.fullCost).toBe({ 1: 800, 2: 1600, 3: 3200, 4: 6400 }[s.tier]);
  });

  it("picks the item that wins more on this hero", () => {
    expect(std.steps.some((s) => s.itemId === star.id)).toBe(true);
    expect(std.steps.find((s) => s.itemId === star.id)!.reasons.join(" ")).toMatch(/poin vs item T2/);
  });

  it("keeps the slot rules: max 12 + flex, only sells a lower tier", () => {
    const owned = new Set<number>();
    for (const s of std.steps) {
      if (s.sell != null) {
        expect(byId.get(s.sell)!.item_tier!).toBeLessThan(s.tier);
        owned.delete(s.sell);
      }
      if (s.upgradeFrom != null) owned.delete(s.upgradeFrom);
      owned.add(s.itemId);
      expect(owned.size).toBeLessThanOrEqual(SLOTS_BASE + 4);
    }
  });

  it("anti-heal shows up when the enemy heals, with the reason", () => {
    const b = autoBuild(input, "lawan_heal", std);
    const s = b.steps.find((x) => x.itemId === antiHeal.id);
    expect(s).toBeDefined();
    expect(["early", "mid"]).toContain(s!.phase);
    expect(s!.reasons[0]).toMatch(/anti-heal/);
    expect(b.swaps.in).toContain(antiHeal.id);
  });

  it("vs guns buys bullet resist", () => {
    expect(autoBuild(input, "lawan_peluru").steps.some((s) => s.itemId === bulletRes.id)).toBe(true);
  });

  it("an upgrade replaces its component and is charged the difference", () => {
    const withUp = { ...input, itemRows: rows.map((r) => (r.item_id === upgrade.id || r.item_id === comp.id ? { ...r, wins: 650 } : r)) };
    const b = autoBuild(withUp);
    const up = b.steps.find((s) => s.itemId === upgrade.id);
    expect(up).toBeDefined();
    expect(up!.upgradeFrom).toBe(comp.id);
    expect(up!.cost).toBe(3200 - 800);
    expect(b.steps.findIndex((s) => s.itemId === comp.id)).toBeLessThan(b.steps.findIndex((s) => s.itemId === upgrade.id));
  });

  it("estimates WR modestly and points to the closest public build", () => {
    expect(std.estWr!.value).toBeGreaterThanOrEqual(0.46);
    expect(std.estWr!.value).toBeLessThanOrEqual(0.56);
    expect(std.closest?.id).toBe(99);
    expect(std.summary.length).toBeGreaterThan(2);
  });

  it("builds every scenario and a copyable text", () => {
    const all = autoBuilds(input);
    expect(all.map((b) => b.scenario)).toEqual(["standar", "unggul", "tertinggal", "lawan_peluru", "lawan_spirit", "lawan_heal", "lawan_cc", "lawan_tank"]);
    expect(autoBuildText(std)).toMatch(/^Early \(sampai 10:00\): /);
  });

  it("evidence shrinks small samples toward the tier average", () => {
    const ev = itemEvidence({ ...input, itemRows: [row(star, 9, 10, 600), row(items[0], 500, 1000, 300)] });
    expect(Math.abs(ev.get(star.id)!.tierDelta!)).toBeLessThan(0.05);
  });
});
