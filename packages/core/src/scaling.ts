/**
 * Kit scaling → item fit.
 *
 * Item recommendations are data first (counter WR vs this lineup, item WR on this hero). This
 * adds what the stats cannot see for a fresh patch or a rare item: how much the hero's own
 * abilities grow with spirit power (the `ETechPower` scale on their numbers, `Feat.spiritScale`).
 * A hero whose damage lives in spirit-scaling abilities gets more out of spirit items; a gun
 * hero with flat abilities gets more out of weapon items.
 *
 * Raw `stat_scale` sums are not comparable in absolute terms (different properties, different
 * units), so a hero is placed by **percentile among all heroes**: 1 = most spirit-reliant kit.
 * The nudge is small (≤ ±1.2 WR points) so real item data still decides when it exists.
 */
import type { LabItem } from "./buildlab";
import type { Feat } from "./playbook";

/** Total spirit scaling on a kit's abilities. */
export const kitSpiritScale = (kit: Feat[]): number => kit.reduce((s, a) => s + (a.spiritScale ?? 0), 0);

/** heroId → percentile (0..1) of kit spirit scaling among all heroes. */
export function spiritPercentiles(kits: Map<number, Feat[]>): Map<number, number> {
  const rows = [...kits].map(([id, kit]) => [id, kitSpiritScale(kit)] as const).filter(([, v]) => Number.isFinite(v));
  const out = new Map<number, number>();
  if (rows.length < 2) return out;
  const sorted = rows.map(([, v]) => v).sort((a, b) => a - b);
  for (const [id, v] of rows) {
    // mid-rank for ties, so equal kits get the same percentile
    const lo = sorted.findIndex((x) => x >= v);
    const hi = sorted.length - 1 - [...sorted].reverse().findIndex((x) => x <= v);
    out.set(id, (lo + hi) / 2 / (sorted.length - 1));
  }
  return out;
}

/** The item's own effect grows with spirit power (spirit items, some weapon/vitality actives). */
export const itemScalesWithSpirit = (it: LabItem): boolean =>
  Object.values(it.properties ?? {}).some((p) => p?.scale_function?.specific_stat_scale_type === "ETechPower" && (p.scale_function.stat_scale ?? 0) > 0);

export type KitLean = "spirit" | "weapon" | "mixed";
export const kitLean = (pct: number): KitLean => (pct >= 0.67 ? "spirit" : pct <= 0.33 ? "weapon" : "mixed");

/** Max nudge, in WR-delta units (same scale as counter / hero-item scores). */
export const KIT_FIT_MAX = 0.012;

/**
 * How well an item fits this kit. Positive = fits. Spirit slot / spirit-scaling items rise with
 * the percentile, weapon items fall with it; vitality is neutral. `why` is empty unless the
 * nudge is big enough to be worth a word in the HUD.
 */
export function kitFit(it: LabItem, pct: number | null | undefined): { score: number; why: string } {
  if (pct == null || !Number.isFinite(pct)) return { score: 0, why: "" };
  const lean = (pct - 0.5) * 2; // −1 (gun) … +1 (spirit)
  let dir = 0;
  if (it.item_slot_type === "spirit" || (it.item_slot_type !== "weapon" && itemScalesWithSpirit(it))) dir = 1;
  else if (it.item_slot_type === "weapon") dir = -1;
  const score = KIT_FIT_MAX * lean * dir;
  if (Math.abs(score) < KIT_FIT_MAX * 0.5) return { score, why: "" };
  const why =
    score > 0
      ? dir > 0
        ? "kit kamu skala spirit"
        : "kit kamu andalkan senjata"
      : dir > 0
        ? "kit kamu kurang skala spirit"
        : "kit kamu skala spirit, senjata kurang efektif";
  return { score, why };
}
