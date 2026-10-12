import { NextResponse, type NextRequest } from "next/server";
import type { MatchLog } from "@deadlock/core";
import { listMatchLogs, saveMatchLog } from "@/lib/store";

function isAuthorized(req: NextRequest): boolean {
  const host = req.headers.get("host") || "";
  const isLocal = host.startsWith("localhost") || host.startsWith("127.0.0.1") || host.startsWith("[::1]");
  if (isLocal) return true;
  const token = req.headers.get("x-dlm-token");
  const secret = process.env.DLM_INTERNAL_TOKEN;
  return !!secret && token === secret;
}

/** The overlay saves its per-match advice log here (overwrites by match id). */
export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Akses ditolak" }, { status: 403 });
  }
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
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Akses ditolak" }, { status: 403 });
  }
  const account = Number(req.nextUrl.searchParams.get("account")) || undefined;
  return NextResponse.json(await listMatchLogs(account));
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204 });
}
