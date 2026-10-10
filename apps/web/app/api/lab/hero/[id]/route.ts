import { NextResponse, type NextRequest } from "next/server";
import { flowPhasePlan } from "@deadlock/core";
import { getBuilds, getHeroItemStats, getHeroMeta, getItemFlow, getItemMap, ITEM_PHASE_S } from "@/lib/data";
import { parseFilters } from "@/lib/filters";
import { heroItemsByTier } from "@/lib/hero-analysis";

/**
 * Real-match data for the Build Lab: per-item WR delta for this hero (vs items of the
 * same tier), the top build's item list, and a per-phase build order from item-flow.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const heroId = Number((await ctx.params).id);
  const f = parseFilters(Object.fromEntries(req.nextUrl.searchParams));
  const [meta, rows, items, builds, flow] = await Promise.all([
    getHeroMeta(f.days, f.badge),
    getHeroItemStats(heroId, f.days, f.badge),
    getItemMap(),
    getBuilds(heroId, f.days, f.badge).catch(() => []),
    getItemFlow(heroId, f.days, f.badge).catch(() => null),
  ]);
  const phases = flow ? flowPhasePlan(flow, ITEM_PHASE_S, items) : null;
  const me = meta.find((m) => m.heroId === heroId);
  const tiers = heroItemsByTier(rows, items, me?.matches ?? 0);
  const winrates: Record<number, { wr: number; delta: number; pick: number; matches: number }> = {};
  for (const list of tiers.values()) for (const r of list) winrates[r.item.id] = { wr: r.winrate, delta: r.delta, pick: r.pickRate, matches: r.matches };
  const top = builds[0];
  return NextResponse.json({
    heroWr: me?.winrate ?? null,
    winrates,
    phases: phases
      ? {
          plan: phases.plan.map((p) => ({ phase: p.phase.key, steps: p.steps, alternatives: p.alternatives })),
          items: phases.items,
          netWorthByPhase: phases.netWorthByPhase,
          baselineWr: phases.baselineWr,
          matches: phases.matches,
        }
      : null,
    topBuild: top
      ? {
          id: top.build.hero_build_id,
          name: top.build.name,
          winrate: top.winrate,
          matches: top.matches,
          items: [...new Set(top.build.details.mod_categories.flatMap((c) => (c.mods ?? []).map((m) => m.ability_id)))].filter((id) => items.get(id)?.type === "upgrade"),
        }
      : null,
  });
}
