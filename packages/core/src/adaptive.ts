/**
 * Adaptive build: keep the hero's data-driven core order, and spend a small number of
 * "flex" slots on answers to what the enemy team is actually doing right now.
 *
 *   enemy profile  ← live items (souls per slot + functional tags) + live hero stats
 *                    (hero damage, healing) + hero type prior
 *   needs          ← profile, weighted by each enemy's threat (net worth share, KDA)
 *   build path     ← core (item-flow phase plan) with ≤ FLEX_MAX[phase] need items
 *                    inserted; need items are ranked by phase counter score and the
 *                    hero's own item win rate, so the pick among e.g. anti-heal items
 *                    is data-driven too.
 *
 * Conservative by design: early game gets at most 1 flex item, mid 2, late 3.
 */

import { itemInnate, itemTags, type ItemTag, type LabItem } from "./buildlab";
import type { CounterItem } from "./counter";
import type { LivePlayer } from "./live";
import { GAME_PHASES, type FlowPhasePlan, type GamePhase } from "./phaseplan";
import type { HeroType, Item } from "./types";

export const phaseAt = (gameTimeS: number): GamePhase => GAME_PHASES.find((p) => p.toS == null || gameTimeS < p.toS)!.key;

const FLEX_MAX: Record<GamePhase, number> = { early: 1, mid: 2, late: 3, vlate: 3 };
const TIER_CAP: Record<GamePhase, number> = { early: 2, mid: 3, late: 4, vlate: 4 };
/** cheapest tier still worth a slot in each phase (an 800-soul item at 35 min is wasted space) */
export const TIER_FLOOR: Record<GamePhase, number> = { early: 1, mid: 2, late: 3, vlate: 3 };
const BULLET_PRIOR: Record<HeroType, number> = { marksman: 0.75, assassin: 0.65, brawler: 0.5, mystic: 0.3 };

export type NeedKind = "anti_heal" | "bullet_resist" | "spirit_resist" | "cc_resist" | "lockdown" | "shred";

const NEED_TAGS: Record<NeedKind, ItemTag[]> = {
  anti_heal: ["anti_heal"],
  bullet_resist: ["bullet_resist"],
  spirit_resist: ["spirit_resist"],
  cc_resist: ["cc_resist"],
  lockdown: ["slow", "stun", "silence"],
  shred: ["bullet_shred", "spirit_shred", "percent_damage"],
};

export const NEED_LABEL: Record<NeedKind, string> = {
  anti_heal: "anti-heal",
  bullet_resist: "resist peluru",
  spirit_resist: "resist spirit",
  cc_resist: "anti-CC",
  lockdown: "slow/stun",
  shred: "penembus armor",
};

export interface EnemyProfile {
  accountId: number;
  heroId: number;
  /** relative threat weight from summarize() (≈0.4–3) */
  weight: number;
  souls: { weapon: number; vitality: number; spirit: number };
  /** share of this enemy's damage expected to be bullets (items + hero type prior) */
  bulletShare: number;
  /** souls in items with each tag */
  tagSouls: Partial<Record<ItemTag, number>>;
  /** healing done per minute (hero + self), if the broadcast has it */
  healPerMin: number | null;
  archetypes: ("sustain" | "tank" | "slippery" | "cc")[];
  /** notable items with what they mean for you */
  notable: { itemId: number; name: string; note: string }[];
}

export interface Need {
  kind: NeedKind;
  /** 0..1 */
  urgency: number;
  reason: string;
  /** enemy heroes driving this need */
  heroIds: number[];
  satisfied: boolean;
}

export interface DamageProfile {
  /** share of enemy team damage that is bullets, threat-weighted */
  bullet: number;
  spirit: number;
}

const NOTE: Partial<Record<ItemTag, string>> = {
  anti_heal: "mengurangi heal kamu",
  lifesteal: "lifesteal, beli anti-heal kalau dia sering menang trade",
  cc_resist: "tahan CC, simpan stun/silence untuk target lain",
  stealth: "bisa invis, jangan farm sendirian di lane sepi",
  silence: "punya silence, jangan buang ability penting di depannya",
  stun: "punya stun tambahan",
  barrier: "barrier, burst kamu kurang efektif, pakai DPS sustained",
  mobility: "mobilitas tinggi, sulit dikejar",
};

const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

export function profileEnemies(
  enemies: { player: LivePlayer; weight: number }[],
  lab: Map<number, LabItem>,
  heroType: (heroId: number) => HeroType | null | undefined,
  gameTimeS: number,
): EnemyProfile[] {
  const minutes = Math.max(1, gameTimeS / 60);
  return enemies.map(({ player: p, weight }) => {
    const souls = { weapon: 0, vitality: 0, spirit: 0 };
    const tagSouls: Partial<Record<ItemTag, number>> = {};
    const notable: EnemyProfile["notable"] = [];
    for (const id of p.itemIds) {
      const it = lab.get(id);
      if (!it || it.type !== "upgrade") continue;
      const cost = it.cost ?? 0;
      if (it.item_slot_type) souls[it.item_slot_type] += cost;
      const tags = itemTags(it);
      for (const t of tags) tagSouls[t] = (tagSouls[t] ?? 0) + cost;
      const key = (["anti_heal", "cc_resist", "stealth", "silence", "barrier", "lifesteal"] as ItemTag[]).find((t) => tags.has(t));
      if (key && (it.item_tier ?? 0) >= 2) notable.push({ itemId: id, name: it.name, note: NOTE[key]! });
    }
    const prior = BULLET_PRIOR[heroType(p.heroId) ?? "brawler"] ?? 0.5;
    const dmgSouls = souls.weapon + souls.spirit;
    // items speak louder as the enemy invests more: full weight at ~8k damage souls
    const w = Math.min(1, dmgSouls / 8000);
    const bulletShare = (1 - w) * prior + w * (dmgSouls > 0 ? souls.weapon / dmgSouls : prior);

    const heal = (p.heroHealing ?? 0) + (p.selfHealing ?? 0);
    const healPerMin = p.heroHealing != null || p.selfHealing != null ? heal / minutes : null;
    const total = souls.weapon + souls.vitality + souls.spirit;
    const archetypes: EnemyProfile["archetypes"] = [];
    if ((tagSouls.lifesteal ?? 0) + (tagSouls.healing ?? 0) >= 3000 || (healPerMin ?? 0) >= 600) archetypes.push("sustain");
    if (total >= 6000 && souls.vitality / total >= 0.45) archetypes.push("tank");
    if ((tagSouls.mobility ?? 0) + (tagSouls.stealth ?? 0) >= 3000) archetypes.push("slippery");
    if ((tagSouls.stun ?? 0) + (tagSouls.silence ?? 0) + (tagSouls.slow ?? 0) >= 4000) archetypes.push("cc");
    return { accountId: p.accountId, heroId: p.heroId, weight, souls, bulletShare, tagSouls, healPerMin, archetypes, notable: notable.slice(-3).reverse() };
  });
}

export function damageProfile(profiles: EnemyProfile[]): DamageProfile {
  const w = sum(profiles.map((p) => p.weight)) || 1;
  const bullet = sum(profiles.map((p) => p.bulletShare * p.weight)) / w;
  return { bullet, spirit: 1 - bullet };
}

/** What the enemy team forces you to answer, strongest first. */
export function findNeeds(
  profiles: EnemyProfile[],
  dmg: DamageProfile,
  myItems: LabItem[],
  heroName: (id: number) => string,
  teamItems?: LabItem[][],
): Need[] {
  const have = new Set<ItemTag>();
  for (const it of myItems) for (const t of itemTags(it)) have.add(t);
  const teamHave = new Set<ItemTag>();
  if (teamItems) {
    for (const allyItems of teamItems) {
      for (const it of allyItems) for (const t of itemTags(it)) teamHave.add(t);
    }
  }
  // resist only counts as answered with a real amount (side stats of 5–8% do not)
  const resist = (type: string) => sum(myItems.map((it) => itemInnate(it).get(type) ?? 0));
  if (resist("MODIFIER_VALUE_BULLET_ARMOR_DAMAGE_RESIST") < 15) have.delete("bullet_resist");
  if (resist("MODIFIER_VALUE_TECH_RESIST") < 15) have.delete("spirit_resist");
  const W = sum(profiles.map((p) => p.weight)) || 1;
  const out: Need[] = [];
  const names = (ps: EnemyProfile[]) => ps.map((p) => heroName(p.heroId)).join(", ");

  const sustain = profiles.filter((p) => p.archetypes.includes("sustain"));
  if (sustain.length) {
    const share = sum(sustain.map((p) => p.weight)) / W;
    const hpm = sustain.map((p) => p.healPerMin).filter((x): x is number => x != null);
    const teamHasAntiHeal = teamHave.has("anti_heal");
    const teamGapNote = !teamHasAntiHeal && teamItems && teamItems.length >= 2 ? " (belum ada di tim)" : "";
    out.push({
      kind: "anti_heal",
      urgency: Math.min(1, (!teamHasAntiHeal ? 0.45 : 0.35) + share * 1.3),
      reason: `${names(sustain)} punya sustain besar${hpm.length ? ` (±${Math.round(Math.max(...hpm))} heal/menit)` : ""}${teamGapNote}`,
      heroIds: sustain.map((p) => p.heroId),
      satisfied: have.has("anti_heal"),
    });
  }

  // defence follows the damage mix; only push it when one type clearly dominates
  const side = dmg.bullet >= 0.6 ? "bullet_resist" : dmg.spirit >= 0.6 ? "spirit_resist" : null;
  if (side) {
    const share = side === "bullet_resist" ? dmg.bullet : dmg.spirit;
    const top = [...profiles].sort((a, b) => b.weight - a.weight).filter((p) => (side === "bullet_resist" ? p.bulletShare >= 0.55 : p.bulletShare <= 0.45));
    out.push({
      kind: side,
      urgency: Math.min(1, (share - 0.5) * 2.2),
      reason: `${Math.round(share * 100)}% damage lawan dari ${side === "bullet_resist" ? "peluru" : "spirit"}${top.length ? ` (${names(top.slice(0, 2))})` : ""}`,
      heroIds: top.map((p) => p.heroId),
      satisfied: have.has(side),
    });
  }

  const cc = profiles.filter((p) => p.archetypes.includes("cc"));
  if (cc.length >= 2 || (cc.length === 1 && cc[0].weight >= 1.3)) {
    out.push({
      kind: "cc_resist",
      urgency: Math.min(0.9, 0.3 + 0.2 * cc.length),
      reason: `${names(cc)} banyak CC (stun/silence/slow)`,
      heroIds: cc.map((p) => p.heroId),
      satisfied: have.has("cc_resist"),
    });
  }

  const slip = profiles.filter((p) => p.archetypes.includes("slippery") && p.weight >= 1);
  if (slip.length) {
    out.push({
      kind: "lockdown",
      urgency: Math.min(0.8, 0.3 + 0.25 * slip.length),
      reason: `${names(slip)} sulit dikunci (dash/invis)`,
      heroIds: slip.map((p) => p.heroId),
      satisfied: have.has("slow") || have.has("stun") || have.has("silence"),
    });
  }

  const tank = profiles.filter((p) => p.archetypes.includes("tank") && p.weight >= 1);
  if (tank.length) {
    out.push({
      kind: "shred",
      urgency: Math.min(0.8, 0.3 + 0.25 * tank.length),
      reason: `${names(tank)} tanky (banyak item vitality)`,
      heroIds: tank.map((p) => p.heroId),
      satisfied: have.has("bullet_shred") || have.has("spirit_shred") || have.has("percent_damage"),
    });
  }
  return out.sort((a, b) => b.urgency - a.urgency);
}

export interface AdaptiveStep {
  itemId: number;
  name: string;
  cost: number;
  tier: number;
  slot?: string;
  kind: "core" | "flex";
  phase: GamePhase | null;
  missing: number;
  affordable: boolean;
  reason: string;
  /** need this flex item answers */
  needKind?: NeedKind;
  /** held as the target since an earlier call; not replaced until bought */
  locked?: boolean;
  /** owned component this upgrades from (its cost is deducted) */
  upgradeFrom?: number;
  /** shop price before the component deduction */
  fullCost?: number;
}

export interface AdaptiveInput {
  me: LivePlayer;
  gameTimeS: number;
  lab: Map<number, LabItem>;
  items: Map<number, Item>;
  core: FlowPhasePlan | null;
  /** counter scores for the current phase (bought-in-window), enemy-weighted */
  phaseCounter: CounterItem[];
  /** WR delta of each item on my hero vs its tier */
  heroItemDelta: (itemId: number) => number | null;
  needs: Need[];
  heroName: (id: number) => string;
  limit?: number;
  /** the item the overlay has been showing as #1 (kept until bought or invalid) */
  commit?: { itemId: number; sinceS: number } | null;
}

const pts = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;

/** Best shop item answering a need, for this phase and this hero. */
export function pickForNeed(need: Need, input: AdaptiveInput, exclude: Set<number>): { item: LabItem; score: number; why: string } | null {
  const phase = phaseAt(input.gameTimeS);
  // never below the phase's tier floor (late game does not recommend cheap tiers, even for a need)
  return pickInTiers(need, input, exclude, TIER_FLOOR[phase]);
}

function pickInTiers(need: Need, input: AdaptiveInput, exclude: Set<number>, floor: number): { item: LabItem; score: number; why: string } | null {
  const phase = phaseAt(input.gameTimeS);
  const cap = TIER_CAP[phase];
  const counter = new Map(input.phaseCounter.map((c) => [c.itemId, c]));
  const want = NEED_TAGS[need.kind];
  let best: { item: LabItem; score: number; why: string } | null = null;
  for (const it of input.lab.values()) {
    if (it.type !== "upgrade" || !it.shopable || it.disabled || exclude.has(it.id)) continue;
    if ((it.item_tier ?? 9) > cap || (it.item_tier ?? 0) < floor || !(it.cost ?? 0)) continue;
    const tags = itemTags(it);
    if (!want.some((t) => tags.has(t))) continue;
    // resist needs: the resist must be the point of the item, not a 5% side stat
    let magnitude = 0;
    if (need.kind === "bullet_resist" || need.kind === "spirit_resist") {
      const v = itemInnate(it).get(need.kind === "bullet_resist" ? "MODIFIER_VALUE_BULLET_ARMOR_DAMAGE_RESIST" : "MODIFIER_VALUE_TECH_RESIST") ?? 0;
      if (v < 12) continue;
      magnitude = v * 0.001; // 30% resist ≈ +3 WR points of preference
    }
    const c = counter.get(it.id);
    const hd = input.heroItemDelta(it.id);

    // Active item fatigue protection: Deadlock only has 4 active item keys (Z, X, C, V or 1, 2, 3, 4).
    // If the player already owns 2 or more active items, heavily penalize additional active items to prevent keybind fatigue.
    const activeOwned = input.me.itemIds.filter((id) => input.lab.get(id)?.is_active_item).length;
    const activePenalty = it.is_active_item && activeOwned >= 2 ? (activeOwned >= 3 ? 0.05 : 0.02) : 0;

    // data first; mild preference for the phase's natural tier
    const score = (c?.score ?? 0) * 1.0 + (hd ?? 0) * 0.5 + magnitude + ((it.item_tier ?? 1) === cap ? 0.004 : 0) + ((it.item_tier ?? 1) === cap - 1 ? 0.002 : 0) - activePenalty;
    if (!best || score > best.score) {
      const why = [c && Math.abs(c.score) >= 0.003 ? `vs lineup ${pts(c.score)}` : "", hd != null && Math.abs(hd) >= 0.005 ? `di hero kamu ${pts(hd)}` : ""].filter(Boolean).join(", ");
      best = { item: it, score, why };
    }
  }
  return best;
}

export function adaptivePath(input: AdaptiveInput): { steps: AdaptiveStep[]; phase: GamePhase; flexUsed: number; flexMax: number; switched: string | null } {
  const { me, lab, core, heroName } = input;
  const limit = input.limit ?? 6;
  const phase = phaseAt(input.gameTimeS);
  const owned = new Set(me.itemIds);
  const coreIds = new Set(core?.plan.flatMap((p) => p.steps.map((s) => s.itemId)) ?? []);
  const myItems = me.itemIds.map((id) => lab.get(id)).filter((x): x is LabItem => !!x);

  // flex already spent = owned items outside the core plan that answer a need tag
  const needTags = new Set(Object.values(NEED_TAGS).flat());
  const flexOwned = myItems.filter((it) => !coreIds.has(it.id) && [...itemTags(it)].some((t) => needTags.has(t))).length;
  const flexMax = FLEX_MAX[phase];
  let flexLeft = Math.max(0, flexMax - flexOwned);

  // core queue: everything from the plan not yet owned, earlier phases first
  const coreQueue: AdaptiveStep[] = [];
  // a missed early item is not worth buying late: skip plan items more than one phase
  // behind, and cheap tiers once the economy has moved on
  const PH_IDX: Record<GamePhase, number> = { early: 0, mid: 1, late: 2, vlate: 3 };
  const minTier = Math.max(1, TIER_CAP[phase] - 1);
  for (const p of core?.plan ?? []) {
    if (PH_IDX[p.phase.key] < PH_IDX[phase] - 1) continue;
    for (const s of p.steps) {
      if (owned.has(s.itemId) || s.tier < minTier) continue;
      const it = lab.get(s.itemId);
      if (!it) continue;
      const fi = core!.items[s.itemId];
      const reason = fi
        ? `Core ${p.phase.label} · dibeli ${(fi.pickShare * 100).toFixed(0)}% pemain · WR ${pts(fi.adjustedWr - core!.baselineWr)}`
        : "Core";
      coreQueue.push({ itemId: it.id, name: it.name, cost: it.cost ?? 0, tier: it.item_tier ?? 0, slot: it.item_slot_type ?? undefined, kind: "core", phase: p.phase.key, missing: 0, affordable: false, reason });
    }
  }

  // flex picks for unsatisfied needs
  const flex: { step: AdaptiveStep; urgent: boolean; urgency: number }[] = [];
  const taken = new Set<number>([...owned]);
  for (const need of input.needs) {
    if (flexLeft <= 0) break;
    if (need.satisfied || need.urgency < 0.35) continue;
    const pick = pickForNeed(need, input, taken);
    if (!pick) continue;
    taken.add(pick.item.id);
    flexLeft--;
    const it = pick.item;
    flex.push({
      urgent: need.urgency >= 0.6,
      urgency: need.urgency,
      step: {
        itemId: it.id,
        name: it.name,
        cost: it.cost ?? 0,
        tier: it.item_tier ?? 0,
        slot: it.item_slot_type ?? undefined,
        kind: "flex",
        phase,
        missing: 0,
        affordable: false,
        reason: `Flex ${NEED_LABEL[need.kind]}: ${need.reason}${pick.why ? ` · ${pick.why}` : ""}`,
        needKind: need.kind,
      },
    });
  }

  const dedup = coreQueue.filter((s) => !flex.some((f) => f.step.itemId === s.itemId));
  // urgent answers go first, others right after the next core item
  const steps: AdaptiveStep[] = [...flex.filter((f) => f.urgent).map((f) => f.step)];
  if (dedup.length) steps.push(dedup[0]);
  steps.push(...flex.filter((f) => !f.urgent).map((f) => f.step), ...dedup.slice(1));

  // no core data, or the core is (nearly) all bought late in the game → best counters of
  // this phase's tiers (never the old cheap items of a popular build)
  if (!core || steps.length < 3) {
    for (const c of input.phaseCounter) {
      if (steps.length >= limit) break;
      const it = lab.get(c.itemId);
      if (!it || owned.has(it.id) || steps.some((s) => s.itemId === it.id) || c.score <= 0.005 || (it.item_tier ?? 9) > TIER_CAP[phase] || (it.item_tier ?? 0) < TIER_FLOOR[phase]) continue;
      const top = c.perEnemy[0];
      steps.push({
        itemId: it.id,
        name: it.name,
        cost: it.cost ?? 0,
        tier: it.item_tier ?? 0,
        slot: it.item_slot_type ?? undefined,
        kind: "core",
        phase,
        missing: 0,
        affordable: false,
        reason: top ? `${core ? "Core selesai · " : ""}Counter ${heroName(top.enemyHeroId)} (${pts(top.delta)})` : "Counter lineup",
      });
    }
  }

  // ---- commitment: once an item has been the #1 call, keep it until it is bought,
  // unless its reason is gone or a clearly more urgent answer appears
  let switched: string | null = null;
  const c = input.commit;
  if (c && !owned.has(c.itemId)) {
    let cs = steps.find((x) => x.itemId === c.itemId);
    const it = lab.get(c.itemId);
    if (!cs && it) {
      cs = { itemId: it.id, name: it.name, cost: it.cost ?? 0, tier: it.item_tier ?? 0, slot: it.item_slot_type ?? undefined, kind: "core", phase, missing: 0, affordable: false, reason: "Target sebelumnya" };
    }
    const needGone = cs?.needKind ? input.needs.some((n) => n.kind === cs!.needKind && n.satisfied) || !input.needs.some((n) => n.kind === cs!.needKind) : false;
    const urgentFlex = flex.find((f) => f.step.itemId !== c.itemId && f.urgency >= 0.8);
    const outgrown = (cs?.tier ?? 9) < Math.max(1, TIER_CAP[phase] - 1);
    if (!cs || needGone) {
      switched = cs ? `${cs.name} tidak lagi perlu (kebutuhannya sudah terjawab)` : null;
    } else if (outgrown) {
      switched = `${cs.name} (T${cs.tier}) sudah tidak sepadan di fase ini`;
    } else if (urgentFlex && cs.kind === "core") {
      switched = `${cs.name} ditunda: ${urgentFlex.step.reason}`;
    } else {
      const i = steps.indexOf(cs);
      if (i >= 0) steps.splice(i, 1);
      steps.unshift({ ...cs, locked: true });
    }
  }

  // ---- upgrades: an owned component is consumed and its price deducted
  const byClass = new Map([...lab.values()].map((x) => [x.class_name, x]));
  for (const st of steps) {
    const it = lab.get(st.itemId);
    const comp = (it?.component_items ?? []).map((cls) => byClass.get(cls)).find((x) => x && owned.has(x.id));
    if (comp) {
      st.fullCost = st.cost;
      st.cost = Math.max(0, st.cost - (comp.cost ?? 0));
      st.upgradeFrom = comp.id;
      st.reason += ` · upgrade dari ${comp.name} (bayar selisih)`;
    }
  }

  // souls are spent in order
  let remaining = me.souls ?? 0;
  const out = steps.slice(0, limit).map((s) => {
    const affordable = s.cost <= remaining;
    const r = { ...s, affordable, missing: Math.max(0, s.cost - remaining) };
    remaining = affordable ? remaining - s.cost : 0;
    return r;
  });
  return { steps: out, phase, flexUsed: Math.min(flexMax, flexOwned + flex.length), flexMax, switched };
}

// ---------------------------------------------------------------------------
// Selling: when slots are full, which item to sell for the next buy, and why
// ---------------------------------------------------------------------------

/** Base item slots before flex slots (assumed from the current shop UI; verify in game). */
export const BASE_ITEM_SLOTS = 12; // 3 categories × 4

export interface SellAdvice {
  sellId: number;
  sellName: string;
  /** souls back (assumed 50% of price) */
  refund: number;
  forId: number;
  forName: string;
  reason: string;
  slotsUsed: number;
  capacity: number;
}

/** Deadlock: 4 slots per category (weapon / vitality / spirit) + flex slots (any category) unlocked by objectives. */
export const SLOTS_PER_CATEGORY = 4;
export const MAX_FLEX_SLOTS = 4;
const CAT_NAME: Record<string, string> = { weapon: "weapon", vitality: "vitality", spirit: "spirit" };

export function slotUsage(owned: LabItem[], flexUnlocked: number) {
  const count = { weapon: 0, vitality: 0, spirit: 0 } as Record<"weapon" | "vitality" | "spirit", number>;
  for (const it of owned) if (it.item_slot_type) count[it.item_slot_type]++;
  const flexUsed = (Object.values(count) as number[]).reduce((a, c) => a + Math.max(0, c - SLOTS_PER_CATEGORY), 0);
  const flex = Math.min(MAX_FLEX_SLOTS, Math.max(0, flexUnlocked));
  return { count, flexUsed, flexFree: Math.max(0, flex - flexUsed), flex };
}

/**
 * Sell advice per category: the next item needs a slot of its own category, or a free
 * flex slot. When neither is open (typical before the flex slots unlock), say which owned
 * item to sell: never a core item if a non-core one can go, never a component of what is
 * planned or a combo item, preferring cheap / weak-on-this-hero / not answering the enemy.
 */
export function sellAdvice(input: {
  me: LivePlayer;
  lab: Map<number, LabItem>;
  next: AdaptiveStep[];
  needs: Need[];
  flexUnlocked: number;
  heroItemDelta: (id: number) => number | null;
  /** abilities/items used in the combo (keep) */
  keepIds?: Set<number>;
  /** the hero's core build (sell these last) */
  coreIds?: Set<number>;
  /** game time (for the phase's minimum tier) */
  gameTimeS?: number;
}): SellAdvice | null {
  const { me, lab, next, needs } = input;
  const owned = me.itemIds.map((id) => lab.get(id)).filter((x): x is LabItem => !!x && x.type === "upgrade");
  const use = slotUsage(owned, input.flexUnlocked);
  // the next item that needs a new slot (an upgrade takes its component's slot)
  const target = next.find((st) => !st.upgradeFrom);
  if (!target) return null;
  const cat = (target.slot ?? lab.get(target.itemId)?.item_slot_type) as "weapon" | "vitality" | "spirit" | undefined;
  if (!cat) return null;
  // selling to make room for a cheap item is never right
  if (input.gameTimeS != null && (target.tier || 0) < TIER_FLOOR[phaseAt(input.gameTimeS)]) return null;
  if (use.count[cat] < SLOTS_PER_CATEGORY || use.flexFree > 0) return null;

  const byClass = new Map([...lab.values()].map((x) => [x.class_name, x]));
  const components = new Set(next.flatMap((st) => (lab.get(st.itemId)?.component_items ?? []).map((c) => byClass.get(c)?.id).filter((x): x is number => !!x)));
  const openNeeds = new Set(needs.filter((n) => n.urgency >= 0.35).map((n) => n.kind));
  const needTagsOf = (it: LabItem) => {
    const tags = itemTags(it);
    return (Object.entries(NEED_TAGS) as [NeedKind, ItemTag[]][]).filter(([k, ts]) => openNeeds.has(k) && ts.some((t) => tags.has(t))).map(([k]) => k);
  };
  // what can free a usable slot: any item of the same category, or (if flex slots exist)
  // an item of another category that sits in a flex slot (its category is over 4)
  const frees = (it: LabItem) =>
    it.item_slot_type === cat || (use.flex > 0 && !!it.item_slot_type && use.count[it.item_slot_type] > SLOTS_PER_CATEGORY);
  const scored = owned
    .filter((it) => frees(it) && !components.has(it.id) && !input.keepIds?.has(it.id) && (it.item_tier ?? 0) < (target.tier || 4) && !next.some((st) => st.itemId === it.id))
    .map((it) => {
      const answers = needTagsOf(it);
      const d = input.heroItemDelta(it.id) ?? 0;
      const isCore = !!input.coreIds?.has(it.id);
      // cheap, weak on this hero, not answering anything the enemy forces, not core → sell first
      const keep = (it.item_tier ?? 1) * 10 + d * 100 + answers.length * 25 + (it.is_active_item ? 5 : 0) + (isCore ? 40 : 0);
      return { it, keep, answers, d, isCore };
    })
    .sort((a, b) => a.keep - b.keep);
  const pick = scored[0];
  if (!pick) return null;
  const refund = Math.round((pick.it.cost ?? 0) * 0.5);
  const why = [
    pick.isCore ? "core, tapi paling lemah di antara pilihan" : "bukan core build",
    `T${pick.it.item_tier} (${Math.round((pick.it.cost ?? 0) / 100) / 10}k)`,
    pick.d < -0.005 ? `WR di hero kamu ${(pick.d * 100).toFixed(1)}%` : "",
    pick.answers.length ? "" : "tidak menjawab ancaman lawan saat ini",
  ].filter(Boolean);
  const flexTxt = use.flex === 0 ? "flex slot belum terbuka" : `flex ${use.flexUsed}/${use.flex} terpakai`;
  const capacity = SLOTS_PER_CATEGORY * 3 + use.flex;
  return {
    sellId: pick.it.id,
    sellName: pick.it.name,
    refund,
    forId: target.itemId,
    forName: target.name,
    reason: `Slot ${CAT_NAME[cat]} penuh (${use.count[cat]}/${SLOTS_PER_CATEGORY}), ${flexTxt}. Jual ${pick.it.name}: ${why.join(", ")}. Refund ±${Math.round(refund / 100) / 10}k untuk ${target.name}.`,
    slotsUsed: owned.length,
    capacity,
  };
}
