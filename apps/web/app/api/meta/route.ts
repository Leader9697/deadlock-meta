import { NextResponse, type NextRequest } from "next/server";
import { getHeroMap, getHeroMeta } from "@/lib/data";
import { parseFilters } from "@/lib/filters";

/** Hero tier list for the desktop app. GET /api/meta?days=7&badge=61 */
export async function GET(req: NextRequest) {
  const f = parseFilters(Object.fromEntries(req.nextUrl.searchParams));
  const [meta, heroes] = await Promise.all([getHeroMeta(f.days, f.badge), getHeroMap()]);
  return NextResponse.json({
    filters: f,
    heroes: meta
      .filter((m) => heroes.has(m.heroId))
      .map((m) => ({ ...m, name: heroes.get(m.heroId)!.name, icon: heroes.get(m.heroId)!.images.icon_image_small_webp })),
  });
}
