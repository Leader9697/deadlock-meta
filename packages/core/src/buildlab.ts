/**
 * Build Lab: hero + items + souls → stats, from the official asset data
 * (/v1/assets/heroes, /v1/assets/items).
 *
 * Rules:
 * - Self stats come only from item properties in the `innate` tooltip section with no
 *   `conditional` (passive/active sections are effects, often debuffs on enemies).
 * - Level = highest level whose `required_gold` ≤ souls; each level flagged
 *   `use_standard_upgrade` adds `standard_level_up_upgrades` once.
 * - Shop investment bonus per slot = last `cost_bonuses[slot]` step whose threshold ≤
 *   souls spent in that slot (weapon → % weapon damage, vitality → % base health,
 *   spirit → spirit power).
 * - Resists stack multiplicatively: 1 − Π(1 − rᵢ).
 * - DPS uses the weapon's own cycle data. Burst DPS matches `weapon_info.damage_per_second`
 *   exactly for all heroes; sustained DPS matches `damage_per_second_with_reload` within 1%
 *   for 38/40 heroes (3-round-burst weapons are within ~3%).
 */

export interface RawProp {
  value?: string | number | boolean | null;
  provided_property_type?: string | null;
  tooltip_section?: string | null;
  conditional?: string | null;
  label?: string | null;
  postfix?: string | null;
  scale_function?: { specific_stat_scale_type?: string | null; stat_scale?: number | null } | null;
}

export interface LabItem {
  /** class names of the component items this upgrades from */
  component_items?: string[] | null;
  id: number;
  name: string;
  class_name: string;
  type: string;
  item_slot_type?: "weapon" | "vitality" | "spirit";
  item_tier?: number;
  cost?: number | null;
  shopable?: boolean;
  disabled?: boolean | null;
  image?: string | null;
  image_webp?: string | null;
  shop_image_small_webp?: string | null;
  shop_filters?: string[] | null;
  is_active_item?: boolean;
  /** imbue items: the buyer picks one of their abilities to empower */
  imbue?: "imbue_active" | "imbue_active_non_ult" | "imbue_modifier_value" | string | null;
  properties?: Record<string, RawProp> | null;
  weapon_info?: WeaponInfo | null;
}

export interface WeaponInfo {
  bullet_damage: number;
  bullets: number;
  clip_size: number;
  reload_duration: number;
  shots_per_second?: number;
  cycle_time?: number;
  burst_shot_count?: number;
  intra_burst_cycle_time?: number;
  crit_bonus_start?: number;
  damage_per_second?: number;
  damage_per_second_with_reload?: number;
  reload_single?: boolean;
}

export interface LabHero {
  id: number;
  name: string;
  items?: Record<string, string>;
  starting_stats?: Record<string, { value: number } | number | null>;
  standard_level_up_upgrades?: Record<string, number> | null;
  level_info?: Record<string, { required_gold?: number; use_standard_upgrade?: boolean }> | null;
  cost_bonuses?: Partial<Record<"weapon" | "vitality" | "spirit", { gold_threshold: number; bonus: number }[]>> | null;
}

const num = (v: unknown): number => {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
};

const start = (h: LabHero, key: string): number => {
  const s = h.starting_stats?.[key];
  return typeof s === "number" ? s : num(s?.value);
};

/** Always-on self stats of an item: provided type → summed value. */
export function itemInnate(item: LabItem): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of Object.values(item.properties ?? {})) {
    const t = p.provided_property_type;
    if (!t || t === "MODIFIER_VALUE_INVALID" || p.conditional || p.tooltip_section !== "innate") continue;
    const v = num(p.value);
    if (v) out.set(t, (out.get(t) ?? 0) + v);
  }
  return out;
}

export type ItemTag =
  | "anti_heal"
  | "bullet_resist"
  | "spirit_resist"
  | "bullet_shred"
  | "spirit_shred"
  | "lifesteal"
  | "healing"
  | "barrier"
  | "slow"
  | "silence"
  | "stun"
  | "disarm"
  | "cc_resist"
  | "mobility"
  | "stealth"
  | "hp"
  | "cooldown"
  | "fire_rate"
  | "weapon_damage"
  | "spirit_power"
  | "burst"
  | "percent_damage";

/** Functional tags from property keys, provided types and shop filters. */
export function itemTags(item: LabItem): Set<ItemTag> {
  const tags = new Set<ItemTag>();
  const filters = new Set(item.shop_filters ?? []);
  for (const [k, p] of Object.entries(item.properties ?? {})) {
    const v = num(p.value);
    if (!v) continue;
    const t = p.provided_property_type ?? "";
    if ((/HealAmpReceivePenalty|HealAmpRegenPenalty/.test(k) || t === "MODIFIER_VALUE_HEAL_AMP_RECEIVE_PERCENT") && v < 0) tags.add("anti_heal");
    // only always-on resist counts (Warp Stone / Return Fire resist is a short active window)
    const always = p.tooltip_section === "innate" && !p.conditional;
    if (t === "MODIFIER_VALUE_BULLET_ARMOR_DAMAGE_RESIST" && v > 0 && always) tags.add("bullet_resist");
    if (t === "MODIFIER_VALUE_TECH_RESIST" && v > 0 && always) tags.add("spirit_resist");
    if (t === "MODIFIER_VALUE_BULLET_AND_MELEE_RESIST_REDUCTION" || /BulletResistReduction|BulletArmorReduction/.test(k)) tags.add("bullet_shred");
    if (t === "MODIFIER_VALUE_TECH_RESIST_REDUCTION" || /TechArmorReduction|TechResistReduction/.test(k)) tags.add("spirit_shred");
    if (/Lifesteal|HealthStealPct|LifestrikeHeal/.test(k) || t === "MODIFIER_VALUE_BULLET_LIFESTEAL" || t === "MODIFIER_VALUE_TECH_LIFESTEAL") tags.add("lifesteal");
    if (/^Heal(Amount|PercentAmount|OnActivate|PerStack|ingPerCast)$|TotalHealthRegen|HealthRegen/.test(k)) tags.add("healing");
    if (t === "MODIFIER_VALUE_BARRIER_HEALTH" || /Barrier$|CombatBarrier/.test(k)) tags.add("barrier");
    if (t === "MODIFIER_VALUE_MOVEMENT_SPEED_SLOW_PERCENT" || /SlowPercent|MovementSpeedSlow|FireRateSlow/.test(k)) tags.add("slow");
    if (/SilenceDuration/.test(k)) tags.add("silence");
    if (/StunDuration/.test(k)) tags.add("stun");
    if (/Disarm/.test(k)) tags.add("disarm");
    if (t === "MODIFIER_VALUE_STATUS_RESISTANCE" || t === "MODIFIER_VALUE_MOVEMENT_SLOW_RESISTANCE") tags.add("cc_resist");
    if (t === "MODIFIER_VALUE_HEALTH_MAX" && p.tooltip_section === "innate") tags.add("hp");
    if (t === "MODIFIER_VALUE_COOLDOWN_REDUCTION_PERCENTAGE") tags.add("cooldown");
    if (t === "MODIFIER_VALUE_FIRE_RATE" && v > 0) tags.add("fire_rate");
    if (t === "MODIFIER_VALUE_WEAPON_DAMAGE_INCREASE" && v > 0) tags.add("weapon_damage");
    if (t === "MODIFIER_VALUE_TECH_POWER" && v > 0) tags.add("spirit_power");
    if (/MaxHealthDamage|CurrentHealthDamage|HealthPctDamage|MaxHealthPercentAsDPS|DotHealthPercent/.test(k)) tags.add("percent_damage");
    if (/^(SpiritDamage|Damage|BonusDamage|ProcBonusMagicDamage)$/.test(k) && p.tooltip_section !== "innate") tags.add("burst");
    if (/Invis/.test(k)) tags.add("stealth");
  }
  if (filters.has("anti_cc") || filters.has("debuff_resist")) tags.add("cc_resist");
  if (filters.has("jump_and_dash") || filters.has("teleport")) tags.add("mobility");
  if (filters.has("stealth")) tags.add("stealth");
  if (filters.has("status_stun")) tags.add("stun");
  if (filters.has("status_immobilize") || filters.has("mobility_reduction")) tags.add("slow");
  return tags;
}

export function heroWeapon(hero: LabHero, items: LabItem[]): LabItem | undefined {
  const cls = hero.items?.weapon_primary;
  return cls ? items.find((i) => i.class_name === cls) : undefined;
}

export function heroLevel(hero: LabHero, souls: number): { level: number; standardUpgrades: number } {
  let level = 1;
  let standardUpgrades = 0;
  const levels = Object.entries(hero.level_info ?? {})
    .map(([k, v]) => ({ n: Number(k), ...v }))
    .sort((a, b) => a.n - b.n);
  for (const l of levels) {
    if ((l.required_gold ?? 0) > souls) break;
    level = l.n;
    if (l.use_standard_upgrade) standardUpgrades++;
  }
  return { level, standardUpgrades };
}

export function investmentBonus(hero: LabHero, slot: "weapon" | "vitality" | "spirit", spent: number): number {
  let b = 0;
  for (const step of hero.cost_bonuses?.[slot] ?? []) if (spent >= step.gold_threshold) b = step.bonus;
  return b;
}

/** Fixed delay before a reload starts (fitted from the official per-weapon DPS). */
export const RELOAD_DELAY_S = 0.25;

export interface LabStats {
  level: number;
  souls: number;
  spent: Record<"weapon" | "vitality" | "spirit", number>;
  investment: Record<"weapon" | "vitality" | "spirit", number>;
  // weapon
  bulletDamage: number;
  weaponDamagePct: number;
  fireRatePct: number;
  shotsPerSecond: number;
  clip: number;
  reloadS: number;
  burstDps: number;
  sustainedDps: number;
  headshotMult: number;
  magazineDamage: number;
  // durability
  health: number;
  bulletResist: number;
  spiritResist: number;
  ehpBullet: number;
  ehpSpirit: number;
  // spirit & utility
  spiritPower: number;
  cooldownPct: number;
  moveSpeed: number;
  bulletLifestealPct: number;
  spiritLifestealPct: number;
  healthRegen: number;
  /** all summed innate stats, for display */
  totals: Record<string, number>;
}

export function computeStats(hero: LabHero, weapon: LabItem | undefined, build: LabItem[], souls: number): LabStats {
  const { level, standardUpgrades: n } = heroLevel(hero, souls);
  const std = hero.standard_level_up_upgrades ?? {};
  const totals = new Map<string, number>();
  const spent = { weapon: 0, vitality: 0, spirit: 0 };
  const bulletRes: number[] = [];
  const spiritRes: number[] = [];

  for (const it of build) {
    if (it.item_slot_type && it.cost && it.cost < 9999) spent[it.item_slot_type] += it.cost;
    for (const [t, v] of itemInnate(it)) {
      totals.set(t, (totals.get(t) ?? 0) + v);
      if (t === "MODIFIER_VALUE_BULLET_ARMOR_DAMAGE_RESIST") bulletRes.push(v);
      if (t === "MODIFIER_VALUE_TECH_RESIST") spiritRes.push(v);
    }
  }
  const T = (k: string) => totals.get(`MODIFIER_VALUE_${k}`) ?? 0;
  const investment = {
    weapon: investmentBonus(hero, "weapon", spent.weapon),
    vitality: investmentBonus(hero, "vitality", spent.vitality),
    spirit: investmentBonus(hero, "spirit", spent.spirit),
  };

  // ---- weapon ----
  const wi = weapon?.weapon_info;
  const bulletDamage = (wi?.bullet_damage ?? 0) + n * (std.MODIFIER_VALUE_BASE_BULLET_DAMAGE_FROM_LEVEL ?? 0);
  const weaponDamagePct = T("WEAPON_DAMAGE_INCREASE") + investment.weapon;
  const fireRatePct = T("FIRE_RATE");
  const baseSps = wi?.shots_per_second ?? (wi?.cycle_time ? 1 / wi.cycle_time : 0);
  const shotsPerSecond = baseSps * (1 + fireRatePct / 100);
  const clip = Math.max(1, Math.round((wi?.clip_size ?? 0) * (1 + T("AMMO_CLIP_SIZE_PERCENT") / 100) + T("AMMO_CLIP_SIZE")));
  const reloadMult = Math.max(0.1, start(hero, "reload_speed") || 1) * (1 + T("RELOAD_SPEED") / 100);
  const reloadS = (wi?.reload_duration ?? 0) / reloadMult;
  const perShot = bulletDamage * (1 + weaponDamagePct / 100) * (wi?.bullets ?? 1);
  const burstDps = perShot * shotsPerSecond;
  const magTime = shotsPerSecond > 0 ? clip / shotsPerSecond : 0;
  // Measured against weapon_info.damage_per_second_with_reload for all 40 heroes:
  // each reload cycle carries a fixed 0.25 s delay, minus the intra-burst gap.
  const cycle = magTime + reloadS + RELOAD_DELAY_S - (wi?.intra_burst_cycle_time ?? 0);
  const sustainedDps = cycle > 0 ? (perShot * clip) / cycle : 0;

  // ---- durability ----
  const baseHp = start(hero, "max_health") + n * (std.MODIFIER_VALUE_BASE_HEALTH_FROM_LEVEL ?? 0);
  const health = baseHp * (1 + investment.vitality / 100) + T("HEALTH_MAX");
  const stack = (rs: number[]) => 1 - rs.reduce((p, r) => p * (1 - r / 100), 1);
  const bulletResist = stack([...bulletRes, start(hero, "bullet_armor_damage_reduction") * 100].filter(Boolean));
  const spiritResist = stack([...spiritRes, start(hero, "tech_armor_damage_reduction") * 100].filter(Boolean));

  return {
    level,
    souls,
    spent,
    investment,
    bulletDamage,
    weaponDamagePct,
    fireRatePct,
    shotsPerSecond,
    clip,
    reloadS,
    burstDps,
    sustainedDps,
    headshotMult: wi?.crit_bonus_start ?? 1,
    magazineDamage: perShot * clip,
    health,
    bulletResist,
    spiritResist,
    ehpBullet: health / Math.max(0.05, 1 - bulletResist),
    ehpSpirit: health / Math.max(0.05, 1 - spiritResist),
    spiritPower: n * (std.MODIFIER_VALUE_TECH_POWER ?? 0) + T("TECH_POWER") + investment.spirit,
    cooldownPct: T("COOLDOWN_REDUCTION_PERCENTAGE"),
    moveSpeed: start(hero, "max_move_speed") + T("MOVEMENT_SPEED_MAX"),
    bulletLifestealPct: T("BULLET_LIFESTEAL"),
    spiritLifestealPct: T("TECH_LIFESTEAL"),
    healthRegen: start(hero, "base_health_regen") + T("HEALTH_REGEN_PER_SECOND"),
    totals: Object.fromEntries(totals),
  };
}

/** Spirit-scaled values (abilities and item effects) at a given spirit power. */
export function scaledValues(item: LabItem, spiritPower: number) {
  const out: { key: string; label: string; base: number; scale: number; value: number; postfix: string }[] = [];
  for (const [k, p] of Object.entries(item.properties ?? {})) {
    const sf = p.scale_function;
    if (sf?.specific_stat_scale_type !== "ETechPower" || !sf.stat_scale) continue;
    const base = num(p.value);
    if (!base) continue;
    out.push({ key: k, label: p.label ?? k, base, scale: sf.stat_scale, value: base + sf.stat_scale * spiritPower, postfix: p.postfix ?? "" });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Marginal value: what does one more item add to this build?
// ---------------------------------------------------------------------------

export interface MarginalGain {
  itemId: number;
  dps: number; // relative change in sustained DPS
  burst: number;
  ehpBullet: number;
  ehpSpirit: number;
  spiritPower: number; // absolute
  /** blended defence gain weighted by the incoming damage profile */
  defence: number;
  /** per 1,000 souls */
  offensePer1k: number;
  defencePer1k: number;
  tags: ItemTag[];
  /** slot whose investment bonus step this purchase crosses, if any */
  crossesThreshold: "weapon" | "vitality" | "spirit" | null;
}

export function marginalGains(
  hero: LabHero,
  weapon: LabItem | undefined,
  build: LabItem[],
  candidates: LabItem[],
  souls: number,
  /** share of incoming damage that is bullet (0..1); 0.5 if unknown */
  bulletShare = 0.5,
): MarginalGain[] {
  const base = computeStats(hero, weapon, build, souls);
  const owned = new Set(build.map((b) => b.id));
  return candidates
    .filter((c) => !owned.has(c.id) && c.shopable && !c.disabled && (c.cost ?? 0) > 0 && (c.cost ?? 0) < 9999)
    .map((c) => {
      // net worth does not change when souls are spent, so level stays the same
      const s = computeStats(hero, weapon, [...build, c], souls);
      const rel = (a: number, b: number) => (b > 0 ? a / b - 1 : 0);
      const dps = rel(s.sustainedDps, base.sustainedDps);
      const ehpB = rel(s.ehpBullet, base.ehpBullet);
      const ehpS = rel(s.ehpSpirit, base.ehpSpirit);
      const defence = bulletShare * ehpB + (1 - bulletShare) * ehpS;
      const k = (c.cost ?? 1) / 1000;
      return {
        itemId: c.id,
        dps,
        burst: rel(s.burstDps, base.burstDps),
        ehpBullet: ehpB,
        ehpSpirit: ehpS,
        spiritPower: s.spiritPower - base.spiritPower,
        defence,
        offensePer1k: dps / k,
        defencePer1k: defence / k,
        tags: [...itemTags(c)],
        crossesThreshold:
          c.item_slot_type && s.investment[c.item_slot_type] !== base.investment[c.item_slot_type] ? c.item_slot_type : null,
      };
    });
}
