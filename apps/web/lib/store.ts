import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import type { MatchLog } from "@deadlock/core";

/**
 * Local storage for overlay match logs. The desktop app sets DLM_DATA_DIR to its app
 * data folder; in development it is apps/web/.data. One JSON file per match.
 */
const dir = () => path.join(process.env.DLM_DATA_DIR || path.join(process.cwd(), ".data"), "match-logs");

export async function saveMatchLog(log: MatchLog): Promise<void> {
  if (!Number.isFinite(log.matchId) || log.matchId <= 0) throw new Error("matchId tidak valid");
  await fs.mkdir(dir(), { recursive: true });
  const file = path.join(dir(), `${Math.floor(log.matchId)}.json`);
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(log));
  await fs.rename(tmp, file);
}

export async function listMatchLogs(accountId?: number): Promise<MatchLog[]> {
  let names: string[] = [];
  try {
    names = (await fs.readdir(dir())).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const out: MatchLog[] = [];
  for (const n of names) {
    try {
      const l = JSON.parse(await fs.readFile(path.join(dir(), n), "utf8")) as MatchLog;
      if (!accountId || l.accountId === accountId) out.push(l);
    } catch {
      // ignore broken files
    }
  }
  return out.sort((a, b) => b.startedAt - a.startedAt);
}

export async function getMatchLog(matchId: number): Promise<MatchLog | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(dir(), `${Math.floor(matchId)}.json`), "utf8")) as MatchLog;
  } catch {
    return null;
  }
}
