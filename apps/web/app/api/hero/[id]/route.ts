import { NextResponse, type NextRequest } from "next/server";
import { getBuilds, getHeroItemStats, getHeroMap, getHeroMeta, getItemMap, getPhases } from "@/lib/data";
import { parseFilters } from "@/lib/filters";
import { heroItemsByTier } from "@/lib/hero-analysis";

/**
 * Everything the overlay shows at hero lock-in: phases, top builds (copyable ID), core items per tier.
 * GET /api/hero/6?days=7&badge=61
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const heroId = Number((await ctx.params).id);
  const f = parseFilters(Object.fromEntries(req.nextUrl.searchParams));
  const heroes = await getHeroMap();
  if (!heroes.has(heroId)) return NextResponse.json({ error: "unknown hero" }, { status: 404 });

  const [meta, phases, builds, itemRows, items] = await Promise.all([
    getHeroMeta(f.days, f.badge),
    getPhases(f.days, f.badge),
    getBuilds(heroId, f.days, f.badge).catch(() => []),
    getHeroItemStats(heroId, f.days, f.badge),
    getItemMap(),
  ]);
  const me = meta.find((m) => m.heroId === heroId) ?? null;
  const tiers = heroItemsByTier(itemRows, items, me?.matches ?? 0);

  return NextResponse.json({
    hero: { id: heroId, name: heroes.get(heroId)!.name },
    meta: me,
    phases: phases.get(heroId) ?? null,
    builds: builds.map((b) => ({ id: b.build.hero_build_id, name: b.build.name, winrate: b.winrate, matches: b.matches })),
    itemsByTier: Object.fromEntries(
      [...tiers].map(([t, rows]) => [
        t,
        rows
          .filter((r) => r.pickRate >= 0.03)
          .sort((a, b) => b.delta - a.delta)
          .slice(0, 6)
          .map((r) => ({ id: r.item.id, name: r.item.name, slot: r.item.item_slot_type, winrate: r.winrate, delta: r.delta, avgBuyTimeS: r.avgBuyTimeS })),
      ]),
    ),
  });
}
