import { NextResponse, type NextRequest } from "next/server";
import { dataWindow, getBuilds, getCounterMatrix, getHeroItemStats, getHeroMap, getHeroMeta, getItemMap, getPhases } from "@/lib/data";
import { parseFilters } from "@/lib/filters";
import { getLabData } from "@/lib/lab";
import { buildStale, heroKit, kitLean, spiritPercentiles } from "@deadlock/core";
import { heroItemsByTier, matchupsFor } from "@/lib/hero-analysis";

/**
 * Everything the overlay shows at hero lock-in: phases, top builds (copyable ID), core items per tier, and draft counters.
 * GET /api/hero/6?days=7&badge=61
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const heroId = Number((await ctx.params).id);
  const f = parseFilters(Object.fromEntries(req.nextUrl.searchParams));
  const heroes = await getHeroMap();
  if (!heroes.has(heroId)) return NextResponse.json({ error: "unknown hero" }, { status: 404 });

  const [meta, phases, builds, itemRows, items, matrix, win, lab] = await Promise.all([
    getHeroMeta(f.days, f.badge),
    getPhases(f.days, f.badge),
    getBuilds(heroId, f.days, f.badge).catch(() => []),
    getHeroItemStats(heroId, f.days, f.badge),
    getItemMap(),
    getCounterMatrix(f.days, f.badge).catch(() => []),
    dataWindow(f.days),
    getLabData().catch(() => null),
  ]);
  // how spirit-reliant this hero's kit is, among all heroes (what the coach weighs items by)
  let kit: { spiritPct: number; lean: string } | null = null;
  if (lab) {
    const byClass = new Map(lab.items.map((i) => [i.class_name, i]));
    const pct = spiritPercentiles(new Map(lab.heroes.map((h) => [h.id, heroKit(h.items, byClass)]))).get(heroId);
    if (pct != null) kit = { spiritPct: pct, lean: kitLean(pct) };
  }
  const me = meta.find((m) => m.heroId === heroId) ?? null;
  const tiers = heroItemsByTier(itemRows, items, me?.matches ?? 0);

  const heroWr = me?.winrate ?? 0.5;
  const allMatchups = matrix.length ? matchupsFor(heroId, matrix, heroWr) : [];
  allMatchups.sort((a, b) => b.delta - a.delta);

  const advantages = allMatchups
    .filter((m) => m.delta > 0.005)
    .slice(0, 3)
    .map((m) => ({ heroId: m.heroId, name: heroes.get(m.heroId)?.name ?? `#${m.heroId}`, delta: m.delta, winrate: m.winrate }));

  const threats = [...allMatchups]
    .reverse()
    .filter((m) => m.delta < -0.005)
    .slice(0, 3)
    .map((m) => ({ heroId: m.heroId, name: heroes.get(m.heroId)?.name ?? `#${m.heroId}`, delta: m.delta, winrate: m.winrate }));

  return NextResponse.json({
    hero: { id: heroId, name: heroes.get(heroId)!.name },
    meta: me,
    phases: phases.get(heroId) ?? null,
    window: win,
    kit,
    builds: builds.map((b) => ({
      id: b.build.hero_build_id,
      name: b.build.name,
      winrate: b.winrate,
      matches: b.matches,
      players: b.players,
      version: b.build.version,
      updatedAt: b.build.last_updated_timestamp ?? null,
      stale: buildStale(b.build.last_updated_timestamp, win.patchTs),
    })),
    itemsByTier: Object.fromEntries(
      [...tiers].map(([t, rows]) => [
        t,
        rows
          .filter((r) => r.pickRate >= 0.03)
          .sort((a, b) => b.delta - a.delta)
          .slice(0, 6)
          .map((r) => ({ id: r.item.id, name: r.item.name, slot: r.item.item_slot_type, cost: r.item.cost ?? null, winrate: r.winrate, delta: r.delta, avgBuyTimeS: r.avgBuyTimeS })),
      ]),
    ),
    counters: { advantages, threats },
  });
}
