import { NextResponse, type NextRequest } from "next/server";
import { getItemMap, getPhaseCounter } from "@/lib/data";
import { parseFilters, parseIdList } from "@/lib/filters";

/**
 * Counter items vs an enemy lineup, as an ordered per-phase buy plan.
 * GET /api/counter?hero=6&enemies=1,13,25&days=7&badge=61
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const f = parseFilters(Object.fromEntries(sp));
  const enemies = parseIdList(sp.get("enemies") ?? undefined);
  const hero = Number(sp.get("hero")) || undefined;
  if (!enemies.length) return NextResponse.json({ error: "enemies is required" }, { status: 400 });

  const [result, items] = await Promise.all([getPhaseCounter(hero, enemies, f), getItemMap()]);
  const info = (id: number) => {
    const it = items.get(id);
    return { name: it?.name, tier: it?.item_tier, slot: it?.item_slot_type, icon: it?.shop_image_small_webp ?? it?.image_webp };
  };
  return NextResponse.json({
    filters: f,
    hero: hero ?? null,
    enemies: result.coveredEnemies,
    phases: result.plan.map((p) => ({
      phase: p.phase.key,
      label: p.phase.label,
      fromS: p.phase.fromS,
      toS: p.phase.toS,
      steps: p.steps.map((s) => ({ ...s, ...info(s.itemId) })),
      alternatives: p.alternatives.map((a) => ({ ...a, ...info(a.itemId) })),
    })),
    avoid: result.avoid.map((c) => ({ itemId: c.itemId, phase: c.phase, score: c.score, ...info(c.itemId) })),
    bySlot: {
      weapon: result.bySlot.weapon.slice(0, 10).map((c) => ({ ...c, ...info(c.itemId) })),
      vitality: result.bySlot.vitality.slice(0, 10).map((c) => ({ ...c, ...info(c.itemId) })),
      spirit: result.bySlot.spirit.slice(0, 10).map((c) => ({ ...c, ...info(c.itemId) })),
    },
  });
}
