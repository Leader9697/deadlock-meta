import { NextResponse, type NextRequest } from "next/server";
import type { MatchLog } from "@deadlock/core";
import { listMatchLogs, saveMatchLog } from "@/lib/store";

/** The overlay saves its per-match advice log here (overwrites by match id). */
export async function POST(req: NextRequest) {
  let log: MatchLog;
  try {
    log = (await req.json()) as MatchLog;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!log?.matchId || !log.accountId || !Array.isArray(log.snapshots)) return NextResponse.json({ error: "matchId, accountId, snapshots wajib" }, { status: 400 });
  // keep files small: at most one snapshot per 20 s of game time
  const seen = new Set<number>();
  log.snapshots = log.snapshots.filter((s) => {
    const b = Math.floor(s.t / 20);
    if (seen.has(b)) return false;
    seen.add(b);
    return true;
  });
  await saveMatchLog(log);
  return NextResponse.json({ ok: true, snapshots: log.snapshots.length });
}

export async function GET(req: NextRequest) {
  const account = Number(req.nextUrl.searchParams.get("account")) || undefined;
  return NextResponse.json(await listMatchLogs(account));
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204 });
}
