import { NextResponse, type NextRequest } from "next/server";
import { backfillOutcomes, calibrate, personalHeroes, tiltCheck } from "@deadlock/core";
import { isAuthorized } from "@/lib/auth";
import { getHeroMap, getHeroMeta, getMatchHistory, getPlayerHeroes } from "@/lib/data";
import { AUTO } from "@/lib/filters";
import { loadHabits } from "@/lib/habits";
import { listMatchLogs, saveMatchLog } from "@/lib/store";

/** Pre-game summary for the overlay: tilt check, your best heroes, cross-match habits, calibration. GET /api/me/summary?account=123 */
export async function GET(req: NextRequest) {
  const account = Number(req.nextUrl.searchParams.get("account"));
  if (!account) return NextResponse.json({ error: "account wajib" }, { status: 400 });
  // habits and calibration come from this PC's match logs: only for the overlay itself
  const own = isAuthorized(req.headers);
  const [hist, mine, meta, heroes, logs] = await Promise.all([
    getMatchHistory(account),
    getPlayerHeroes(account),
    getHeroMeta(AUTO, 0),
    getHeroMap(),
    own ? listMatchLogs(account, 50).catch(() => []) : Promise.resolve([]),
  ]);
  // broadcasts that ended before the game-over row: take the result from the match history
  const filled = backfillOutcomes(logs, hist);
  await Promise.allSettled(filled.map((l) => saveMatchLog(l)));
  const hb = own ? await loadHabits(account, logs).catch(() => null) : null;
  const outcomes = [...hist].sort((a, b) => b.start_time - a.start_time).map((m) => m.match_result === m.player_team);
  const best = personalHeroes(
    mine.map((r) => ({ hero_id: r.hero_id, matches: r.matches_played, wins: r.wins })),
    new Map(meta.map((m) => [m.heroId, m.winrate])),
  )
    .filter((h) => heroes.has(h.heroId))
    .slice(0, 5)
    .map((h) => ({ ...h, name: heroes.get(h.heroId)?.name }));

  const cal = logs.length ? calibrate(logs) : null;

  return NextResponse.json({
    tilt: tiltCheck(outcomes),
    best,
    habits: hb ? { matches: hb.habits.matches, hudLines: hb.habits.hudLines, notes: hb.habits.notes } : null,
    calibration: cal && cal.finished >= 10 ? { reliability: cal.reliability, brier: cal.brier } : null,
    matches: [...hist].sort((a, b) => b.start_time - a.start_time).slice(0, 10),
  });
}

/** CORS preflight: the overlay sends `x-dlm-token`, which makes the browser ask first. */
export function OPTIONS() {
  return new NextResponse(null, { status: 204 });
}
