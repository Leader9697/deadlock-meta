// Run: npx tsx --test packages/core/test/build.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { adaptivePath, buildAudit, type Need } from "../src/adaptive";
import type { LabItem } from "../src/buildlab";
import type { CounterItem } from "../src/counter";
import type { LivePlayer } from "../src/live";
import type { FlowPhasePlan } from "../src/phaseplan";
import { coreSensitivity, coreStability, stabilityVerdict } from "../src/robustness";
import type { Item, ItemFlowNode, ItemFlowStats } from "../src/types";

// ---------- fixtures ----------
const mkItem = (id: number, slot: "weapon" | "vitality" | "spirit", tier: number, extra: Partial<LabItem> = {}): LabItem => ({
  id,
  name: `Item${id}`,
  class_name: `item_${id}`,
  type: "upgrade",
  item_slot_type: slot,
  item_tier: tier,
  cost: [0, 500, 1250, 3000, 6300][tier],
  shopable: true,
  ...extra,
});
const lab = new Map<number, LabItem>();
for (let i = 1; i <= 4; i++) lab.set(i, mkItem(i, "weapon", 4)); // 1-4: owned T4 weapon
lab.set(5, mkItem(5, "weapon", 3)); // owned weak T3 weapon
lab.set(6, mkItem(6, "weapon", 4)); // strong T4 weapon candidate
lab.set(7, mkItem(7, "weapon", 2)); // cheap candidate (down-tier)
lab.set(8, mkItem(8, "weapon", 4, { component_items: ["item_5"] })); // upgrade OF item 5
for (let i = 10; i <= 13; i++) lab.set(i, mkItem(i, "vitality", 4));
for (let i = 20; i <= 23; i++) lab.set(i, mkItem(i, "spirit", 4));
lab.set(30, mkItem(30, "vitality", 4)); // not owned, vitality
lab.set(31, mkItem(31, "spirit", 3)); // not owned, spirit T3

const counter = (itemId: number, score: number): CounterItem => ({ itemId, score, baselineWinrate: 0.5, baselineMatches: 500, avgBuyTimeS: 2400, perEnemy: [] });
const me = (itemIds: number[], souls = 0): LivePlayer => ({ accountId: 1, heroId: 1, team: 0, netWorth: 60000, souls, kills: 0, deaths: 0, assists: 0, level: 30, itemIds });
const noNeeds: Need[] = [];

// full 12/12 build: weapon 1,5 + 4? -> weapon slots: 1,2,3,5 ; vitality 10-13 ; spirit 20-23
const fullItems = [1, 2, 3, 5, 10, 11, 12, 13, 20, 21, 22, 23];
const baseAudit = {
  lab,
  gameTimeS: 2400,
  needs: noNeeds,
  flexUnlocked: 0,
};

// ---------- buildAudit ----------
test("audit: full build swaps a weak owned item for a clearly better same-category one", () => {
  const a = buildAudit({
    ...baseAudit,
    me: me(fullItems, 8000),
    counter: [counter(5, -0.03), counter(6, 0.03)],
    heroItemDelta: () => null,
  });
  assert.equal(a.full, true);
  assert.equal(a.swaps.length, 1);
  assert.equal(a.swaps[0].sellId, 5);
  assert.equal(a.swaps[0].buyId, 6);
  assert.ok(a.swaps[0].affordable);
});

test("audit: no data on the owned item => never suggested to be sold", () => {
  const a = buildAudit({ ...baseAudit, me: me(fullItems, 8000), counter: [counter(6, 0.05)], heroItemDelta: () => null });
  assert.equal(a.swaps.length, 0);
});

test("audit: gain below margin => no swap", () => {
  const a = buildAudit({ ...baseAudit, me: me(fullItems, 8000), counter: [counter(5, -0.005), counter(6, 0.01)], heroItemDelta: () => null });
  assert.equal(a.swaps.length, 0);
});

test("audit: never swaps down a tier, and ignores the owned item's own upgrade", () => {
  const a = buildAudit({
    ...baseAudit,
    me: me(fullItems, 8000),
    counter: [counter(5, -0.04), counter(7, 0.06), counter(8, 0.06)],
    heroItemDelta: () => null,
  });
  assert.equal(a.swaps.length, 0, "T2 is below the phase floor/owned tier; item 8 is an upgrade of 5 (normal buy)");
});

test("audit: core item needs twice the margin", () => {
  const input = { ...baseAudit, me: me(fullItems, 8000), counter: [counter(5, -0.015), counter(6, 0.012)], heroItemDelta: () => null };
  assert.equal(buildAudit(input).swaps.length, 1); // gain 0.027 ≥ 0.02
  assert.equal(buildAudit({ ...input, coreIds: new Set([5]) }).swaps.length, 0); // 0.027 < 0.04
});

test("audit: items in the buy list or combo are protected; unaffordable swap is flagged", () => {
  const input = { ...baseAudit, me: me(fullItems, 0), counter: [counter(5, -0.03), counter(6, 0.03)], heroItemDelta: () => null };
  const a = buildAudit(input);
  assert.equal(a.swaps[0].affordable, false);
  assert.ok(a.swaps[0].missing > 0);
  assert.equal(buildAudit({ ...input, keepIds: new Set([5]) }).swaps.length, 0);
});

test("audit: not full when a slot is open", () => {
  const a = buildAudit({ ...baseAudit, me: me(fullItems.slice(0, 11)), counter: [], heroItemDelta: () => null });
  assert.equal(a.full, false);
});

// ---------- adaptivePath: very late with nothing left ----------
const emptyCore: FlowPhasePlan = { baselineWr: 0.5, matches: 1000, plan: [], items: {}, netWorthByPhase: { early: 5000, mid: 20000, late: 40000, vlate: 70000 } };
test("adaptivePath: very late, core + counters exhausted => falls back to hero data instead of an empty list", () => {
  const owned = [1, 2, 3, 5, 10, 11, 12, 13, 20, 21, 22];
  const r = adaptivePath({
    me: me(owned, 20000),
    gameTimeS: 2400,
    lab,
    items: new Map<number, Item>(),
    core: emptyCore,
    phaseCounter: [],
    heroItemDelta: (id) => (id === 31 ? 0.03 : id === 30 ? 0.02 : null),
    needs: noNeeds,
    heroName: (id) => `H${id}`,
  });
  assert.deepEqual(r.steps.map((s) => s.itemId), [31, 30]);
  assert.ok(r.steps[0].reason.includes("hero kamu"));
});

test("adaptivePath: hero-data fallback respects the tier floor", () => {
  lab.set(40, mkItem(40, "vitality", 1));
  const r = adaptivePath({
    me: me([], 20000),
    gameTimeS: 2400,
    lab,
    items: new Map<number, Item>(),
    core: null,
    phaseCounter: [],
    heroItemDelta: (id) => (id === 40 ? 0.09 : null),
    needs: noNeeds,
    heroName: (id) => `H${id}`,
  });
  assert.ok(!r.steps.some((s) => s.itemId === 40));
  lab.delete(40);
});

// ---------- robustness ----------
// deterministic PRNG so the test is stable
const rng = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const N_ITEMS = 40;
const items = new Map<number, Item>();
for (let i = 1; i <= N_ITEMS; i++) items.set(i, { id: i, name: `I${i}`, class_name: `i${i}`, type: "upgrade", item_slot_type: "weapon", item_tier: 1 + (i % 4), cost: 1000, shopable: true });

/** `noise` = how much of each item's win-rate edge is random sampling noise */
function synthFlow(seed: number, matches: number): ItemFlowStats {
  const r = rng(seed);
  const nodes: ItemFlowNode[] = [];
  for (let id = 1; id <= N_ITEMS; id++) {
    const col = Math.floor(((id - 1) / N_ITEMS) * 8); // modal column per item
    const pick = 0.5 / (1 + (id % 10)); // true popularity
    const trueEdge = ((id % 7) - 3) * 0.008; // true WR edge
    const m = Math.round(matches * pick * (0.9 + r() * 0.2));
    const noise = (r() - 0.5) * 2 * Math.sqrt(0.25 / Math.max(m, 1));
    const wr = 0.5 + trueEdge + noise;
    nodes.push({ column: col, item_id: id, wins: Math.round(m * wr), losses: m - Math.round(m * wr), matches: m, players: m, adjusted_win_rate: wr, avg_net_worth_at_buy: 3000 + col * 4500 });
  }
  return {
    nodes,
    edges: [],
    summary: { wins: matches / 2, losses: matches / 2, matches, players: matches, avg_net_worth: 30000, avg_duration_s: 2100 },
    baseline: { wins: matches / 2, losses: matches / 2, matches, players: matches, avg_net_worth: 30000, avg_duration_s: 2100 },
    reached_per_column: Array(8).fill(matches),
  };
}

test("robustness: halves of the same signal produce a similar core; pure noise does not", () => {
  const stable = coreStability(synthFlow(1, 20000), synthFlow(2, 20000), 300, items);
  assert.ok(stable.overall! >= 0.6, `overlap ${stable.overall}`);
  assert.equal(stabilityVerdict(stable), "stabil");

  // a hero with almost no data per item: the plan should be flagged as unstable, not trusted
  const thin = coreStability(synthFlow(3, 700), synthFlow(4, 700), 300, items);
  assert.ok(thin.overall == null || thin.overall <= stable.overall!, "less data must not look more stable");
});

test("robustness: sensitivity table reports how many items flip when the weights move", () => {
  const rows = coreSensitivity(synthFlow(1, 20000), 300, items);
  assert.equal(rows.length, 8);
  const base = rows.find((x) => x.value === 0.06 * 0.75)!;
  assert.ok(base.vsBase.overall! > 0.5);
  assert.ok(rows.every((x) => x.vsBase.overall != null));
});
