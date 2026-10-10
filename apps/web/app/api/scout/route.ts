import { NextResponse, type NextRequest } from "next/server";
import { getScout } from "@/lib/data";
import { parseLobby } from "@/lib/scout-parse";

/**
 * Lobby scouting for the desktop overlay.
 * GET /api/scout?ids=12345:6:0,67890:13:1   (account_id[:hero_id[:team]], max 12)
 */
export async function GET(req: NextRequest) {
  const lobby = parseLobby(req.nextUrl.searchParams.get("ids") ?? undefined);
  if (!lobby.length) return NextResponse.json({ error: "ids is required" }, { status: 400 });
  const scouts = await getScout(lobby.map((l) => ({ accountId: l.accountId, heroId: l.heroId })));
  return NextResponse.json({
    players: lobby.map((l) => ({ ...l, scout: scouts.find((s) => s.accountId === l.accountId) ?? null })),
  });
}
