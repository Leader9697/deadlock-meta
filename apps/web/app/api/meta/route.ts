import { NextResponse, type NextRequest } from "next/server";
import { detectMeta } from "@deadlock/core";
import { dataWindow, getHeroMap, getHeroMeta, getMetaWindows } from "@/lib/data";
import { parseFilters } from "@/lib/filters";

/**
 * Hero tier list for the desktop app. GET /api/meta?days=7&badge=61
 *
 * Besides the tier it says what the numbers cover (`window`: since which patch / how many days,
 * how many matches) and how each hero is moving against the previous window of equal length
 * (`trend`: WR change, pick change, ban share, a meta status with a one-line reason), so the
 * launcher can show "naik", "sleeper" or "populer tapi WR rendah" instead of a bare winrate.
 */
export async function GET(req: NextRequest) {
  const f = parseFilters(Object.fromEntries(req.nextUrl.searchParams));
  const [meta, heroes, win, windows] = await Promise.all([
    getHeroMeta(f.days, f.badge),
    getHeroMap(),
    dataWindow(f.days),
    getMetaWindows(f.days, f.badge).catch(() => null),
  ]);
  const trendBy = new Map(windows ? detectMeta(windows.now, windows.prev, windows.bans).map((r) => [r.heroId, r]) : []);
  const totalMatches = Math.round(meta.reduce((s, m) => s + m.matches, 0) / 12);
  return NextResponse.json({
    filters: f,
    window: { ...win, matches: totalMatches },
    heroes: meta
      .filter((m) => heroes.has(m.heroId))
      .map((m) => {
        const h = heroes.get(m.heroId)!;
        const t = trendBy.get(m.heroId);
        // slug lets the overlay build CDN icon URLs for heroes released after its build
        return {
          ...m,
          name: h.name,
          icon: h.images.icon_image_small_webp ?? h.images.icon_image_small ?? null,
          slug: h.class_name.replace(/^hero_/, ""),
          trend: t ? { wr: t.wrTrend, pick: t.pickTrend, banShare: t.banShare, status: t.status, reason: t.reasons[0] ?? "" } : null,
        };
      }),
  });
}
