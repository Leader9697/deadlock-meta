import { NextResponse, type NextRequest } from "next/server";
import { autoBuilds, flowPhasePlan, heroKit, SCENARIOS, spiritPercentiles } from "@deadlock/core";
import { dataWindow, getBuilds, getHeroItemStats, getHeroMeta, getItemFlow, getItemMap, ITEM_PHASE_S, memo } from "@/lib/data";
import { parseFilters } from "@/lib/filters";
import { getLabData } from "@/lib/lab";

/**
 * Auto build for the Build Lab: a full ordered build per situation (standard, ahead, behind,
 * vs guns / spirit / heal / CC / tanks), computed from this hero's item data, the item-flow
 * net-worth-adjusted WR, the Lab's stat formulas and the kit's spirit scaling. No input
 * besides the hero. Memoised 10 min per hero + filter (the analytics behind it refresh ~10 min).
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const heroId = Number((await ctx.params).id);
  const f = parseFilters(Object.fromEntries(req.nextUrl.searchParams));
  const lab = await getLabData();
  const hero = lab.heroes.find((h) => h.id === heroId);
  if (!hero) return NextResponse.json({ error: "unknown hero" }, { status: 404 });

  const body = await memo(`auto:${heroId}:${f.days}:${f.badge}`, 600_000, async () => {
    const [meta, rows, items, builds, flow, win] = await Promise.all([
      getHeroMeta(f.days, f.badge),
      getHeroItemStats(heroId, f.days, f.badge),
      getItemMap(),
      getBuilds(heroId, f.days, f.badge).catch(() => []),
      getItemFlow(heroId, f.days, f.badge).catch(() => null),
      dataWindow(f.days),
    ]);
    const me = meta.find((m) => m.heroId === heroId);
    const byClass = new Map(lab.items.map((i) => [i.class_name, i]));
    const kitPct = spiritPercentiles(new Map(lab.heroes.map((h) => [h.id, heroKit(h.items, byClass)]))).get(heroId) ?? null;
    const flowPlan = flow ? flowPhasePlan(flow, ITEM_PHASE_S, items) : null;
    const publicBuilds = builds.map((b) => ({
      id: b.build.hero_build_id,
      name: b.build.name,
      winrate: b.winrate,
      matches: b.matches,
      items: [...new Set(b.build.details.mod_categories.flatMap((c) => (c.mods ?? []).map((m) => m.ability_id)))].filter((id) => items.get(id)?.type === "upgrade"),
    }));
    const result = autoBuilds({ hero, items: lab.items, itemRows: rows, heroMatches: me?.matches ?? 0, heroWr: me?.winrate ?? null, flow: flowPlan, kitPct, publicBuilds });
    const fmtDate = (ts: number) => new Date(ts * 1000).toLocaleDateString("id-ID", { day: "numeric", month: "short", timeZone: "UTC" });
    const window = `${win.mode === "patch" && win.patchTs ? `sejak patch ${fmtDate(win.patchTs)} (${win.days} hari)` : `${win.days} hari terakhir`} · ${(me?.matches ?? 0).toLocaleString("id-ID")} match`;
    return { heroId, heroWr: me?.winrate ?? null, matches: me?.matches ?? 0, window, scenarios: SCENARIOS, builds: result };
  });
  return NextResponse.json(body);
}
