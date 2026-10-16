/**
 * Auto build: a complete, ordered build per hero and per situation, computed from data —
 * nothing to type, nothing to click item by item.
 *
 * Every candidate item is scored at the point of the build where it would be bought:
 *
 *   score = data            net-worth-adjusted WR edge on this hero (item-flow, the
 *                           "rich players win" bias removed) + WR vs other items of
 *                           the same tier, both shrunk by sample size, + popularity
 *         + stats           what the item really adds to THIS build at THIS net worth
 *                           (Build Lab formulas: DPS, EHP, ability damage via spirit
 *                           power), capped so data still decides
 *         + kit fit         spirit kit → spirit items, gun kit → weapon items
 *         + situation       e.g. enemy heals → the first anti-heal gets a big bonus
 *         − phase misfit    an item usually bought much later/earlier than this phase
 *         − unproven        < 30 matches on this hero
 *         − active fatigue  a 3rd/4th active item
 *
 * Constraints follow the in-game shop and the overlay's rules: tier floor/cap per phase
 * (late game never buys T1), 4 slots per category plus flex slots that open later, an
 * upgrade replaces its component (and is charged the difference, same as `adaptivePath`),
 * and a slot is only freed by selling a lower-tier item.
 *
 * The WR estimate is deliberately modest: hero WR + half the mean item edge, clamped. The
 * measured number is the closest public build's WR, shown next to it.
 */

import { computeStats, itemInnate, itemTags, scaledValues, type ItemTag, type LabHero, type LabItem, type LabStats } from "./buildlab";
import { GAME_PHASES, type FlowPhasePlan, type GamePhase } from "./phaseplan";
import { itemCost, souls } from "./prices";
import { kitFit, kitLean } from "./scaling";
import { shrink } from "./stats";
import type { ItemStats } from "./types";

type Slot = "weapon" | "vitality" | "spirit";

export type Scenario = "standar" | "unggul" | "tertinggal" | "lawan_peluru" | "lawan_spirit" | "lawan_heal" | "lawan_cc" | "lawan_tank";

export interface ScenarioDef {
  key: Scenario;
  label: string;
  /** when to pick this build */
  when: string;
  /** share of incoming damage that is bullet */
  bulletShare: number;
  offense: number;
  defence: number;
}

export const SCENARIOS: ScenarioDef[] = [
  { key: "standar", label: "Standar", when: "Default. Lawan campuran, game seimbang.", bulletShare: 0.5, offense: 1, defence: 1 },
  { key: "unggul", label: "Unggul", when: "Lane menang / tim unggul souls: percepat damage, tutup game.", bulletShare: 0.5, offense: 1.5, defence: 0.6 },
  { key: "tertinggal", label: "Tertinggal", when: "Lane kalah / tim tertinggal: item murah yang efisien, bertahan dulu.", bulletShare: 0.5, offense: 0.7, defence: 1.5 },
  { key: "lawan_peluru", label: "Lawan senjata", when: "Damage lawan mayoritas peluru (marksman, gun carry).", bulletShare: 0.85, offense: 0.9, defence: 1.3 },
  { key: "lawan_spirit", label: "Lawan spirit", when: "Damage lawan mayoritas ability / burst spirit.", bulletShare: 0.15, offense: 0.9, defence: 1.3 },
  { key: "lawan_heal", label: "Lawan heal", when: "Lawan punya healer / lifesteal tinggi.", bulletShare: 0.5, offense: 1, defence: 1 },
  { key: "lawan_cc", label: "Lawan CC", when: "Lawan banyak stun / silence / tarik.", bulletShare: 0.5, offense: 0.9, defence: 1.2 },
  { key: "lawan_tank", label: "Lawan tank", when: "Lawan HP / resist tinggi, susah dibunuh.", bulletShare: 0.5, offense: 1.3, defence: 0.8 },
];

export interface AutoBuildInput {
  hero: LabHero;
  /** lab items: shop items + the hero's weapon and abilities */
  items: LabItem[];
  /** this hero's item stats over the data window (`/v1/analytics/item-stats?hero_id=`) */
  itemRows: ItemStats[];
  heroMatches: number;
  heroWr: number | null;
  flow: FlowPhasePlan | null;
  /** kit spirit-scaling percentile (scaling.ts) */
  kitPct: number | null;
  publicBuilds?: { id: number; name: string; winrate: number; matches: number; items: number[] }[];
}

export interface ItemEvidence {
  matches: number;
  pickRate: number;
  /** shrunk WR minus the WR of all items of the same tier on this hero */
  tierDelta: number | null;
  /** net-worth-adjusted WR minus the hero's baseline, in the item's usual phase (item-flow) */
  adjDelta: number | null;
  modalPhase: GamePhase | null;
  avgBuyS: number | null;
}

export interface AutoStep {
  order: number;
  itemId: number;
  name: string;
  slot: Slot | null;
  tier: number;
  /** souls paid (component already owned is deducted) */
  cost: number;
  fullCost: number;
  phase: GamePhase;
  cumulativeCost: number;
  upgradeFrom: number | null;
  /** item sold to free the slot */
  sell: number | null;
  /** answers the scenario (anti-heal, resist, …) rather than core value */
  situational: boolean;
  score: number;
  /** strongest argument first */
  reasons: string[];
}

export interface PhaseSnapshot {
  phase: GamePhase;
  /** in-game clock the phase ends at */
  until: string;
  netWorth: number;
  dps: number;
  ehpBullet: number;
  ehpSpirit: number;
  spiritPower: number;
  health: number;
}

export interface AutoBuild {
  scenario: Scenario;
  steps: AutoStep[];
  phases: PhaseSnapshot[];
  totalCost: number;
  estWr: { value: number; confidence: "tinggi" | "sedang" | "rendah"; basis: string } | null;
  closest: { id: number; name: string; winrate: number; matches: number; overlap: number; size: number } | null;
  /** build-level argument: why this build, what it is weak against */
  summary: string[];
  /** differences vs the standard build */
  swaps: { out: number[]; in: number[] };
}

const PHASE_IDX: Record<GamePhase, number> = { early: 0, mid: 1, late: 2, vlate: 3 };
const PHASE_UNTIL: Record<GamePhase, string> = { early: "10:00", mid: "20:00", late: "30:00", vlate: "akhir game" };
const TIER_MIN: Record<GamePhase, number> = { early: 1, mid: 2, late: 3, vlate: 3 };
const TIER_MAX: Record<GamePhase, number> = { early: 2, mid: 3, late: 4, vlate: 4 };
const MAX_PER_PHASE: Record<GamePhase, number> = { early: 6, mid: 5, late: 4, vlate: 4 };
/** flex slots assumed open by the end of each phase (they unlock with objectives) */
const FLEX_BY_PHASE: Record<GamePhase, number> = { early: 0, mid: 1, late: 2, vlate: 4 };
export const SLOTS_BASE = 12;
const DEFAULT_NW: Record<GamePhase, number> = { early: 11_000, mid: 25_000, late: 40_000, vlate: 60_000 };
const MIN_PROVEN = 30;

const pts = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}`;
const pctTxt = (x: number) => `${x >= 0 ? "+" : ""}${Math.round(x * 100)}%`;
const SLOT_ID: Record<Slot, string> = { weapon: "weapon", vitality: "vitality", spirit: "spirit" };

const phaseOfSecond = (s: number): GamePhase => GAME_PHASES.find((p) => p.toS == null || s < p.toS)!.key;

/** Evidence per item on this hero: tier-relative WR, net-worth-adjusted WR, popularity. */
export function itemEvidence(input: Pick<AutoBuildInput, "itemRows" | "heroMatches" | "flow" | "items">): Map<number, ItemEvidence> {
  const byId = new Map(input.items.map((i) => [i.id, i]));
  const rows = input.itemRows.filter((r) => byId.get(r.item_id)?.type === "upgrade");
  const tierWr = new Map<number, number>();
  for (const t of [1, 2, 3, 4]) {
    const inTier = rows.filter((r) => byId.get(r.item_id)?.item_tier === t);
    const n = inTier.reduce((s, r) => s + r.matches, 0);
    tierWr.set(t, n > 0 ? inTier.reduce((s, r) => s + r.wins, 0) / n : 0.5);
  }
  const heroN = Math.max(1, input.heroMatches || Math.max(0, ...rows.map((r) => r.matches)));
  const out = new Map<number, ItemEvidence>();
  for (const r of rows) {
    const tier = byId.get(r.item_id)?.item_tier ?? 0;
    const tw = tierWr.get(tier) ?? 0.5;
    out.set(r.item_id, {
      matches: r.matches,
      pickRate: Math.min(1, r.matches / heroN),
      tierDelta: r.matches > 0 ? shrink(r.wins, r.matches, tw, 200) - tw : null,
      adjDelta: null,
      modalPhase: r.avg_buy_time_s > 0 ? phaseOfSecond(r.avg_buy_time_s) : null,
      avgBuyS: r.avg_buy_time_s > 0 ? r.avg_buy_time_s : null,
    });
  }
  const flow = input.flow;
  if (flow) {
    for (const [idStr, fi] of Object.entries(flow.items)) {
      const id = Number(idStr);
      const e = out.get(id) ?? { matches: fi.matches, pickRate: fi.pickShare, tierDelta: null, adjDelta: null, modalPhase: fi.phase, avgBuyS: null };
      // shrink the adjusted edge toward 0 like the phase plan does
      e.adjDelta = (fi.adjustedWr - flow.baselineWr) * (fi.matches / (fi.matches + 200));
      e.modalPhase = fi.phase;
      e.pickRate = Math.max(e.pickRate, Math.min(1, fi.pickShare));
      out.set(id, e);
    }
  }
  return out;
}

/** Data part of the score (WR units). */
function dataScore(e: ItemEvidence | undefined): number {
  if (!e) return -0.012;
  const parts: [number, number][] = [];
  if (e.adjDelta != null) parts.push([e.adjDelta, 0.6]);
  if (e.tierDelta != null) parts.push([e.tierDelta, 0.4]);
  const w = parts.reduce((s, p) => s + p[1], 0);
  const edge = w > 0 ? parts.reduce((s, p) => s + p[0] * p[1], 0) / w : 0;
  const pop = 0.03 * Math.sqrt(Math.max(0, e.pickRate));
  const unproven = e.matches < MIN_PROVEN ? -0.008 : 0;
  return edge + pop + unproven;
}

/** Combined data edge (no popularity), for the WR estimate and the reasons. */
export function edgeOf(e: ItemEvidence | undefined): number | null {
  if (!e) return null;
  if (e.adjDelta != null && e.tierDelta != null) return 0.6 * e.adjDelta + 0.4 * e.tierDelta;
  return e.adjDelta ?? e.tierDelta;
}

interface Owned {
  item: LabItem;
  score: number;
}

interface Placement {
  ok: boolean;
  upgradeFrom: LabItem | null;
  sell: LabItem | null;
  paid: number;
}

/** Can `c` go into the inventory at this phase? Upgrade replaces its component, else a free slot or a lower-tier sell. */
function place(owned: Owned[], c: LabItem, phase: GamePhase, byClass: Map<string, LabItem>): Placement {
  const cost = itemCost(c);
  const comps = (c.component_items ?? []).map((cls) => byClass.get(cls)?.id).filter((x): x is number => x != null);
  const comp = owned.find((o) => comps.includes(o.item.id));
  if (comp) return { ok: true, upgradeFrom: comp.item, sell: null, paid: Math.max(1, cost - itemCost(comp.item)) };
  const flex = FLEX_BY_PHASE[phase];
  const cat = c.item_slot_type;
  const inCat = owned.filter((o) => o.item.item_slot_type === cat).length;
  const flexUsed = (["weapon", "vitality", "spirit"] as Slot[]).reduce((s, k) => s + Math.max(0, owned.filter((o) => o.item.item_slot_type === k).length - 4), 0);
  const catFull = inCat >= 4 && flexUsed >= flex;
  const totalFull = owned.length >= SLOTS_BASE + flex;
  if (!catFull && !totalFull) return { ok: true, upgradeFrom: null, sell: null, paid: cost };
  // free a slot: lowest tier (strictly below this item), lowest score; same category if the category is the bottleneck
  const tier = c.item_tier ?? 0;
  const pool = owned
    .filter((o) => (o.item.item_tier ?? 0) < tier)
    .filter((o) => !catFull || o.item.item_slot_type === cat || flexUsed > 0)
    .sort((a, b) => (a.item.item_tier ?? 0) - (b.item.item_tier ?? 0) || a.score - b.score);
  const sell = pool[0];
  if (!sell) return { ok: false, upgradeFrom: null, sell: null, paid: cost };
  return { ok: true, upgradeFrom: null, sell: sell.item, paid: cost };
}

interface Ctx {
  input: AutoBuildInput;
  sc: ScenarioDef;
  ev: Map<number, ItemEvidence>;
  shop: LabItem[];
  byClass: Map<string, LabItem>;
  weapon: LabItem | undefined;
  abilities: LabItem[];
  lean: number;
  nw: Record<GamePhase, number>;
}

/** Ability "damage" (all spirit-scaled numbers) gained from extra spirit power, relative. */
function abilityGain(abilities: LabItem[], spBefore: number, spAfter: number): number {
  let num = 0;
  let den = 0;
  for (const ab of abilities)
    for (const v of scaledValues(ab, spBefore)) {
      num += v.scale * (spAfter - spBefore);
      den += Math.abs(v.value);
    }
  return den > 0 ? num / den : 0;
}

/** What the scenario wants from this item, and how much (WR units). */
function situational(sc: Scenario, it: LabItem, tags: Set<ItemTag>, owned: LabItem[], phase: GamePhase, lean: number): { bonus: number; why: string } {
  const has = (t: ItemTag, min = 1) => owned.filter((o) => itemTags(o).has(t)).length >= min;
  const resist = (key: string) => itemInnate(it).get(key) ?? 0;
  switch (sc) {
    case "lawan_heal":
      if (tags.has("anti_heal") && !has("anti_heal")) return { bonus: PHASE_IDX[phase] >= 1 ? 0.035 : 0.02, why: "Lawan heal: anti-heal pertama wajib, sebelum 20:00" };
      return { bonus: 0, why: "" };
    case "lawan_peluru": {
      const v = resist("MODIFIER_VALUE_BULLET_ARMOR_DAMAGE_RESIST");
      if (v >= 12 && !has("bullet_resist", 2)) return { bonus: 0.012 + v * 0.0004, why: `Lawan senjata: resist peluru ${v}%` };
      return { bonus: 0, why: "" };
    }
    case "lawan_spirit": {
      const v = resist("MODIFIER_VALUE_TECH_RESIST");
      if (v >= 12 && !has("spirit_resist", 2)) return { bonus: 0.012 + v * 0.0004, why: `Lawan spirit: resist spirit ${v}%` };
      return { bonus: 0, why: "" };
    }
    case "lawan_cc":
      if (tags.has("cc_resist") && !has("cc_resist") && PHASE_IDX[phase] >= 1) return { bonus: 0.03, why: "Lawan CC: item anti-CC / debuff remover" };
      return { bonus: 0, why: "" };
    case "lawan_tank": {
      const shred = lean >= 0.5 ? "spirit_shred" : "bullet_shred";
      if ((tags.has(shred) || tags.has("percent_damage")) && !(has("bullet_shred") || has("spirit_shred") || has("percent_damage", 2)))
        return { bonus: 0.02, why: tags.has("percent_damage") ? "Lawan tank: damage % HP" : `Lawan tank: kurangi resist ${shred === "spirit_shred" ? "spirit" : "peluru"} lawan` };
      return { bonus: 0, why: "" };
    }
    case "tertinggal":
      if ((tags.has("healing") || tags.has("barrier") || tags.has("lifesteal")) && PHASE_IDX[phase] <= 1) return { bonus: 0.006, why: "Tertinggal: sustain supaya bisa farm aman" };
      return { bonus: 0, why: "" };
    default:
      return { bonus: 0, why: "" };
  }
}

interface Scored {
  item: LabItem;
  score: number;
  reasons: string[];
  situational: boolean;
  place: Placement;
}

function scoreItem(ctx: Ctx, c: LabItem, owned: Owned[], phase: GamePhase, base: LabStats): Scored | null {
  const { sc, ev, input } = ctx;
  const p = place(owned, c, phase, ctx.byClass);
  if (!p.ok) return null;
  const e = ev.get(c.id);
  const build = owned.map((o) => o.item);
  const after = computeStats(input.hero, ctx.weapon, [...build.filter((b) => b.id !== p.upgradeFrom?.id && b.id !== p.sell?.id), c], ctx.nw[phase]);
  const rel = (a: number, b: number) => (b > 0 ? a / b - 1 : 0);
  const dps = rel(after.sustainedDps, base.sustainedDps);
  const ehpB = rel(after.ehpBullet, base.ehpBullet);
  const ehpS = rel(after.ehpSpirit, base.ehpSpirit);
  const abil = abilityGain(ctx.abilities, base.spiritPower, after.spiritPower);
  const offense = (1 - ctx.lean) * dps + ctx.lean * abil;
  const defence = sc.bulletShare * ehpB + (1 - sc.bulletShare) * ehpS;
  const stat = Math.max(-0.004, Math.min(0.015, 0.06 * (sc.offense * offense + sc.defence * defence)));

  const fit = kitFit(c, input.kitPct);
  const tags = itemTags(c);
  const sit = situational(sc.key, c, tags, build, phase, ctx.lean);
  const misfit = e?.modalPhase ? 0.007 * Math.abs(PHASE_IDX[e.modalPhase] - PHASE_IDX[phase]) : 0;
  const actives = build.filter((b) => b.is_active_item && b.id !== p.sell?.id && b.id !== p.upgradeFrom?.id).length;
  const fatigue = c.is_active_item && actives >= 2 ? (actives >= 3 ? 0.03 : 0.008) : 0;
  const upgrade = p.upgradeFrom ? 0.004 : 0;
  // ahead: richer, so higher tiers sooner; behind: souls per value matters, cheaper first
  const tierPref = sc.key === "unggul" ? 0.003 * ((c.item_tier ?? 1) - TIER_MIN[phase]) : sc.key === "tertinggal" ? -0.003 * ((c.item_tier ?? 1) - TIER_MIN[phase]) : 0;
  const score = dataScore(e) + stat + fit.score + sit.bonus + upgrade + tierPref - misfit - fatigue;

  const reasons: string[] = [];
  if (sit.why) reasons.push(sit.why);
  if (e && e.matches >= MIN_PROVEN) {
    const parts = [`dipakai ${Math.round(e.pickRate * 100)}% pemain hero ini (${e.matches.toLocaleString("id-ID")} match)`];
    if (e.adjDelta != null && Math.abs(e.adjDelta) >= 0.002) parts.push(`WR disesuaikan net worth ${pts(e.adjDelta)} poin`);
    if (e.tierDelta != null && Math.abs(e.tierDelta) >= 0.002) parts.push(`${pts(e.tierDelta)} poin vs item T${c.item_tier} lain`);
    reasons.push(parts.join(" · "));
  } else reasons.push(`Data tipis di hero ini (${e?.matches ?? 0} match): dipilih dari stat dan kondisi`);
  const statParts: string[] = [];
  if (Math.abs(dps) >= 0.02) statParts.push(`DPS senjata ${pctTxt(dps)}`);
  if (Math.abs(abil) >= 0.02) statParts.push(`ability ${pctTxt(abil)} (SP +${Math.round(after.spiritPower - base.spiritPower)})`);
  if (Math.abs(ehpB) >= 0.02 || Math.abs(ehpS) >= 0.02) statParts.push(`EHP peluru ${pctTxt(ehpB)} / spirit ${pctTxt(ehpS)}`);
  for (const s of ["weapon", "vitality", "spirit"] as Slot[])
    if (after.investment[s] !== base.investment[s] && after.investment[s] > base.investment[s])
      statParts.push(`lewat ambang bonus ${SLOT_ID[s]} (+${after.investment[s]}${s === "spirit" ? " SP" : "%"})`);
  if (statParts.length) reasons.push(`Di net worth ~${souls(ctx.nw[phase])}: ${statParts.join(", ")}`);
  if (fit.why) reasons.push(fit.why[0].toUpperCase() + fit.why.slice(1));
  if (p.upgradeFrom) reasons.push(`Upgrade dari ${p.upgradeFrom.name}: komponen dipotong, slot tidak bertambah`);
  if (fatigue > 0.01) reasons.push("Sudah 3 item aktif: tombol aktif makin banyak");
  return { item: c, score, reasons, situational: sit.bonus > 0, place: p };
}

function netWorthCurve(flow: FlowPhasePlan | null): Record<GamePhase, number> {
  const out = { ...DEFAULT_NW };
  if (!flow) return out;
  let prev = 0;
  for (const p of GAME_PHASES) {
    const v = flow.netWorthByPhase[p.key];
    out[p.key] = Math.max(prev + 3000, v > 0 ? v : DEFAULT_NW[p.key]);
    prev = out[p.key];
  }
  return out;
}

function makeCtx(input: AutoBuildInput, sc: ScenarioDef): Ctx {
  const byClass = new Map(input.items.map((i) => [i.class_name, i]));
  const shop = input.items.filter((i) => i.type === "upgrade" && i.shopable && !i.disabled && i.item_slot_type && itemCost(i) > 0);
  const weapon = input.hero.items?.weapon_primary ? byClass.get(input.hero.items.weapon_primary) : undefined;
  const abilities = [1, 2, 3, 4].map((n) => byClass.get(input.hero.items?.[`signature${n}`] ?? "")).filter((x): x is LabItem => !!x);
  return { input, sc, ev: itemEvidence(input), shop, byClass, weapon, abilities, lean: input.kitPct ?? 0.5, nw: netWorthCurve(input.flow) };
}

/** One build for one scenario. */
export function autoBuild(input: AutoBuildInput, scenario: Scenario = "standar", standard?: AutoBuild): AutoBuild {
  const sc = SCENARIOS.find((s) => s.key === scenario) ?? SCENARIOS[0];
  const ctx = makeCtx(input, sc);
  const owned: Owned[] = [];
  const bought = new Set<number>();
  const steps: AutoStep[] = [];
  const phases: PhaseSnapshot[] = [];
  let cumulative = 0;

  for (const ph of GAME_PHASES) {
    const phase = ph.key;
    const picks: Scored[] = [];
    while (picks.length < MAX_PER_PHASE[phase] && cumulative < ctx.nw[phase]) {
      const base = computeStats(input.hero, ctx.weapon, owned.map((o) => o.item), ctx.nw[phase]);
      const ownedIds = new Set(owned.map((o) => o.item.id));
      // components of something already owned are never bought back
      const covered = new Set(owned.flatMap((o) => (o.item.component_items ?? []).map((cls) => ctx.byClass.get(cls)?.id ?? -1)));
      let best: Scored | null = null;
      for (const c of ctx.shop) {
        const t = c.item_tier ?? 0;
        if (t < TIER_MIN[phase] || t > TIER_MAX[phase] || ownedIds.has(c.id) || bought.has(c.id) || covered.has(c.id)) continue;
        const s = scoreItem(ctx, c, owned, phase, base);
        if (s && (!best || s.score > best.score)) best = s;
      }
      if (!best) break;
      picks.push(best);
      bought.add(best.item.id);
      cumulative += best.place.paid;
      if (best.place.upgradeFrom) owned.splice(owned.findIndex((o) => o.item.id === best!.place.upgradeFrom!.id), 1);
      if (best.place.sell) owned.splice(owned.findIndex((o) => o.item.id === best!.place.sell!.id), 1);
      owned.push({ item: best.item, score: best.score });
      steps.push({
        order: steps.length + 1,
        itemId: best.item.id,
        name: best.item.name,
        slot: best.item.item_slot_type ?? null,
        tier: best.item.item_tier ?? 0,
        cost: best.place.paid,
        fullCost: itemCost(best.item),
        phase,
        cumulativeCost: cumulative,
        upgradeFrom: best.place.upgradeFrom?.id ?? null,
        sell: best.place.sell?.id ?? null,
        situational: best.situational,
        score: best.score,
        reasons: best.reasons,
      });
    }
    const s = computeStats(input.hero, ctx.weapon, owned.map((o) => o.item), ctx.nw[phase]);
    phases.push({
      phase,
      until: PHASE_UNTIL[phase],
      netWorth: ctx.nw[phase],
      dps: s.sustainedDps,
      ehpBullet: s.ehpBullet,
      ehpSpirit: s.ehpSpirit,
      spiritPower: s.spiritPower,
      health: s.health,
    });
  }
  // inside a phase, cheaper items first (affordable sooner); components stay before their upgrade
  const ordered = GAME_PHASES.flatMap((ph) => {
    const list = steps.filter((s) => s.phase === ph.key);
    const before = new Map(list.map((s, i) => [s.itemId, i]));
    return list
      .map((s) => ({ s, key: s.upgradeFrom != null && before.has(s.upgradeFrom) ? Math.max(s.tier, list.find((x) => x.itemId === s.upgradeFrom)!.tier + 0.5) : s.tier }))
      .sort((a, b) => a.key - b.key || before.get(a.s.itemId)! - before.get(b.s.itemId)!)
      .map((x) => x.s);
  });
  let cum = 0;
  ordered.forEach((s, i) => {
    s.order = i + 1;
    cum += s.cost;
    s.cumulativeCost = cum;
  });

  const finalIds = new Set(owned.map((o) => o.item.id));
  return {
    scenario: sc.key,
    steps: ordered,
    phases,
    totalCost: cum,
    estWr: estimateWr(input, ctx.ev, ordered),
    closest: closestPublic(input, ordered),
    summary: summarize(input, ctx, ordered, phases, finalIds),
    swaps: standard
      ? {
          out: standard.steps.map((s) => s.itemId).filter((id) => !ordered.some((s) => s.itemId === id)),
          in: ordered.map((s) => s.itemId).filter((id) => !standard.steps.some((s) => s.itemId === id)),
        }
      : { out: [], in: [] },
  };
}

/** Every scenario; the standard build first so the others can list their swaps. */
export function autoBuilds(input: AutoBuildInput): AutoBuild[] {
  const std = autoBuild(input, "standar");
  return [std, ...SCENARIOS.slice(1).map((s) => autoBuild(input, s.key, std))];
}

function estimateWr(input: AutoBuildInput, ev: Map<number, ItemEvidence>, steps: AutoStep[]): AutoBuild["estWr"] {
  const base = input.flow?.baselineWr ?? input.heroWr;
  if (base == null || !steps.length) return null;
  let num = 0;
  let den = 0;
  let proven = 0;
  for (const s of steps) {
    const e = ev.get(s.itemId);
    const edge = edgeOf(e);
    if (e && e.matches >= 200) proven++;
    if (edge == null || !e) continue;
    const w = Math.sqrt(e.matches);
    num += edge * w;
    den += w;
  }
  const mean = den > 0 ? num / den : 0;
  const value = Math.max(base - 0.04, Math.min(base + 0.06, base + 0.5 * mean));
  const share = proven / steps.length;
  const confidence = share >= 0.75 && input.heroMatches >= 2000 ? "tinggi" : share >= 0.5 ? "sedang" : "rendah";
  return {
    value,
    confidence,
    basis: `WR hero ${(base * 100).toFixed(1)}% + separuh rata-rata keunggulan item (${pts(mean)} poin, sudah disesuaikan net worth); ${proven}/${steps.length} item punya ≥200 match`,
  };
}

function closestPublic(input: AutoBuildInput, steps: AutoStep[]): AutoBuild["closest"] {
  const mine = new Set(steps.map((s) => s.itemId));
  let best: AutoBuild["closest"] = null;
  let bestKey = -1;
  for (const b of input.publicBuilds ?? []) {
    const set = new Set(b.items);
    const overlap = [...mine].filter((id) => set.has(id)).length;
    // overlap first, a measured winrate (sample-aware) breaks ties
    const key = overlap + Math.min(0.99, Math.max(0, b.winrate - 0.3)) * (b.matches / (b.matches + 100));
    if (key > bestKey) {
      bestKey = key;
      best = { id: b.id, name: b.name, winrate: b.winrate, matches: b.matches, overlap, size: mine.size };
    }
  }
  return best;
}

function summarize(input: AutoBuildInput, ctx: Ctx, steps: AutoStep[], phases: PhaseSnapshot[], finalIds: Set<number>): string[] {
  const out: string[] = [];
  const sc = ctx.sc;
  out.push(`Kondisi: ${sc.when}`);
  if (input.heroWr != null) out.push(`${input.hero.name}: WR ${(input.heroWr * 100).toFixed(1)}% dari ${input.heroMatches.toLocaleString("id-ID")} match di window data.`);
  if (input.kitPct != null) {
    const lean = kitLean(input.kitPct);
    out.push(
      lean === "spirit"
        ? `Kit skala spirit (persentil ${Math.round(input.kitPct * 100)}% dari semua hero): item spirit diberi bobot lebih, damage dihitung lewat ability.`
        : lean === "weapon"
          ? `Kit andalkan senjata (persentil spirit ${Math.round(input.kitPct * 100)}%): item weapon diberi bobot lebih, damage dihitung dari DPS senjata.`
          : `Kit campuran (persentil spirit ${Math.round(input.kitPct * 100)}%): damage dihitung separuh senjata, separuh ability.`,
    );
  }
  const top = [...steps].sort((a, b) => b.score - a.score).slice(0, 3);
  if (top.length) out.push(`Item paling menentukan: ${top.map((s) => s.name).join(", ")} (skor data + stat tertinggi di build ini).`);
  const first = phases[0];
  const last = phases[phases.length - 1];
  if (first && last)
    out.push(
      `Dari ${first.until} ke ${last.until}: DPS senjata ${Math.round(first.dps)} → ${Math.round(last.dps)}, EHP peluru ${Math.round(first.ehpBullet)} → ${Math.round(last.ehpBullet)}, spirit power ${Math.round(first.spiritPower)} → ${Math.round(last.spiritPower)}.`,
    );
  // weaknesses: what this build does not answer, and which scenario fixes it
  const owned = steps.filter((s) => finalIds.has(s.itemId) || steps.some((x) => x.upgradeFrom === s.itemId));
  const byId = new Map(ctx.shop.map((i) => [i.id, i]));
  const tagsOf = (t: ItemTag) => owned.some((s) => {
    const it = byId.get(s.itemId);
    return !!it && itemTags(it).has(t);
  });
  const weak: string[] = [];
  if (sc.key !== "lawan_heal" && !tagsOf("anti_heal")) weak.push("tanpa anti-heal (pakai 'Lawan heal' kalau lawan sustain)");
  if (sc.key !== "lawan_cc" && !tagsOf("cc_resist")) weak.push("tanpa anti-CC (pakai 'Lawan CC' kalau sering di-stun)");
  if (last && last.ehpSpirit < last.ehpBullet * 0.8 && sc.key !== "lawan_spirit") weak.push("tipis vs spirit burst (pakai 'Lawan spirit')");
  if (last && last.ehpBullet < last.ehpSpirit * 0.8 && sc.key !== "lawan_peluru") weak.push("tipis vs peluru (pakai 'Lawan senjata')");
  if (weak.length) out.push(`Celah: ${weak.join("; ")}.`);
  return out;
}

/** Plain-text order for copying into an in-game build. */
export function autoBuildText(b: AutoBuild): string {
  return GAME_PHASES.map((ph) => {
    const list = b.steps.filter((s) => s.phase === ph.key);
    if (!list.length) return "";
    return `${ph.label} (sampai ${PHASE_UNTIL[ph.key]}): ${list.map((s) => s.name).join(" > ")}`;
  })
    .filter(Boolean)
    .join("\n");
}
