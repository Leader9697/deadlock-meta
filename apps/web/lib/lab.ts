import "server-only";
import { cache } from "react";
import type { LabHero, LabItem, RawProp } from "@deadlock/core";
import { api, getLiveHeroIds, memo } from "./data";

/** Raw assets with every field (the typed client trims nothing at runtime). */
const TTL = 3600_000;
const rawHeroes = cache(() => memo("raw-heroes", TTL, async () => (await api.get<unknown[]>("/v1/assets/heroes", { only_active: true }, { cache: "no-store" })) as LabHero[] & Record<string, unknown>[]));
// same URL as getItems(): share the download
const rawItems = cache(() => memo("items", TTL, () => api.items({ cache: "no-store" })) as unknown as Promise<LabItem[]>);

const KEEP_START = ["max_health", "base_health_regen", "max_move_speed", "sprint_speed", "reload_speed", "stamina", "bullet_armor_damage_reduction", "tech_armor_damage_reduction", "light_melee_damage", "heavy_melee_damage"];

function slimProps(props: Record<string, RawProp> | null | undefined): Record<string, RawProp> {
  const out: Record<string, RawProp> = {};
  for (const [k, p] of Object.entries(props ?? {})) {
    const v = p.value;
    if (v === null || v === undefined || v === "" || v === "0" || v === 0 || v === false) continue;
    const scaled = p.scale_function?.specific_stat_scale_type === "ETechPower" && p.scale_function.stat_scale;
    if (!p.provided_property_type && !scaled && !/Heal|Lifesteal|Slow|Silence|Stun|Disarm|Invis|Barrier|Damage|Resist|Armor|Reduction|Duration|Cooldown|CastRange|CastDelay|ChannelTime|Range$|Radius$|Charge|Threshold|Imbue|Multiplier|Charges|Immobil|Tether|Chain|Lift|Toss|Sleep|Freeze|Dash|Jump|Fly|Leap|Teleport|Reflected/.test(k)) continue;
    out[k] = {
      value: v,
      provided_property_type: p.provided_property_type ?? null,
      tooltip_section: p.tooltip_section ?? null,
      conditional: p.conditional ?? null,
      label: p.label ?? null,
      postfix: p.postfix ?? null,
      scale_function: scaled ? { specific_stat_scale_type: "ETechPower", stat_scale: p.scale_function!.stat_scale } : null,
    };
  }
  return out;
}

export interface LabData {
  heroes: (LabHero & { img?: string | null })[];
  items: LabItem[];
}

/** Compact dataset for the client-side Build Lab (~a few hundred KB instead of ~7 MB). */
export const getLabData = cache((): Promise<LabData> => memo("lab-data", TTL, buildLabData));

/** Lab items by id (all shop items + hero weapons/abilities) with tag-able properties. */
export const getLabItemMap = cache(async () => new Map((await getLabData()).items.map((i) => [i.id, i])));

async function buildLabData(): Promise<LabData> {
  const [heroes, items, live] = await Promise.all([rawHeroes(), rawItems(), getLiveHeroIds()]);
  const byClass = new Map(items.map((i) => [i.class_name, i]));
  const hs = (heroes as (LabHero & Record<string, unknown>)[]).filter((h) => live.has(h.id));
  const needed = new Set<string>();
  const outHeroes = hs.map((h) => {
    const its = h.items ?? {};
    const keep: Record<string, string> = {};
    for (const k of ["weapon_primary", "signature1", "signature2", "signature3", "signature4"]) {
      if (its[k]) {
        keep[k] = its[k];
        needed.add(its[k]);
      }
    }
    const images = (h.images ?? {}) as Record<string, string | null>;
    return {
      id: h.id,
      name: h.name,
      img: images.icon_image_small_webp ?? images.icon_image_small ?? null,
      items: keep,
      starting_stats: Object.fromEntries(KEEP_START.filter((k) => h.starting_stats?.[k] != null).map((k) => [k, h.starting_stats![k]])),
      standard_level_up_upgrades: h.standard_level_up_upgrades ?? {},
      level_info: Object.fromEntries(
        Object.entries(h.level_info ?? {}).map(([k, v]) => [k, { required_gold: v.required_gold, use_standard_upgrade: v.use_standard_upgrade }]),
      ),
      cost_bonuses: h.cost_bonuses
        ? Object.fromEntries(Object.entries(h.cost_bonuses).map(([k, v]) => [k, (v ?? []).map((s) => ({ gold_threshold: s.gold_threshold, bonus: s.bonus }))]))
        : null,
    };
  });

  const outItems: LabItem[] = [];
  for (const it of items) {
    const shop = it.type === "upgrade" && it.shopable && !it.disabled;
    if (!shop && !needed.has(it.class_name)) continue;
    const wi = it.weapon_info;
    outItems.push({
      id: it.id,
      name: it.name,
      class_name: it.class_name,
      type: it.type,
      item_slot_type: it.item_slot_type,
      item_tier: it.item_tier,
      cost: it.cost,
      shopable: it.shopable,
      disabled: it.disabled,
      image: it.shop_image_small_webp ?? it.image_webp ?? it.image ?? null,
      shop_filters: it.shop_filters ?? null,
      component_items: (it as { component_items?: string[] | null }).component_items ?? null,
      is_active_item: it.is_active_item,
      imbue: (it as { imbue?: string | null }).imbue ?? null,
      properties: slimProps(it.properties),
      weapon_info: wi
        ? {
            bullet_damage: wi.bullet_damage,
            bullets: wi.bullets,
            clip_size: wi.clip_size,
            reload_duration: wi.reload_duration,
            shots_per_second: wi.shots_per_second,
            cycle_time: wi.cycle_time,
            burst_shot_count: wi.burst_shot_count,
            intra_burst_cycle_time: wi.intra_burst_cycle_time,
            crit_bonus_start: wi.crit_bonus_start,
            damage_per_second: wi.damage_per_second,
            damage_per_second_with_reload: wi.damage_per_second_with_reload,
          }
        : null,
    });
  }
  void byClass;
  return { heroes: outHeroes.sort((a, b) => a.name.localeCompare(b.name)), items: outItems };
}
