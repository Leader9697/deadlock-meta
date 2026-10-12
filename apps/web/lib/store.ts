import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import type { MatchLog } from "@deadlock/core";

/**
 * Local storage for overlay match logs. The desktop app sets DLM_DATA_DIR to its app
 * data folder; in development it is apps/web/.data. One JSON file per match.
 */
const dir = () => path.join(process.env.DLM_DATA_DIR || path.join(process.cwd(), ".data"), "match-logs");

const MAX_STORED_LOGS = 200;

export async function saveMatchLog(log: MatchLog): Promise<void> {
  if (!Number.isFinite(log.matchId) || log.matchId <= 0) throw new Error("matchId tidak valid");
  try {
    await fs.mkdir(dir(), { recursive: true });
    const file = path.join(dir(), `${Math.floor(log.matchId)}.json`);
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(log));
    await fs.rename(tmp, file);

    // Prune logs older than MAX_STORED_LOGS to keep disk bounded
    const names = (await fs.readdir(dir())).filter((n) => n.endsWith(".json"));
    if (names.length > MAX_STORED_LOGS) {
      names.sort((a, b) => {
        const idA = parseInt(a.replace(".json", ""), 10) || 0;
        const idB = parseInt(b.replace(".json", ""), 10) || 0;
        return idB - idA;
      });
      const toRemove = names.slice(MAX_STORED_LOGS);
      await Promise.allSettled(toRemove.map((n) => fs.unlink(path.join(dir(), n))));
    }
  } catch (err) {
    // In read-only serverless environments, don't crash the request
    console.warn("[store] saveMatchLog disk write failed (read-only environment?):", err);
  }
}

export async function listMatchLogs(accountId?: number, limit = 50): Promise<MatchLog[]> {
  let names: string[] = [];
  try {
    names = (await fs.readdir(dir())).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  // Newer matches have higher numeric matchIds: sort descending first so we only read the newest N files
  names.sort((a, b) => {
    const idA = parseInt(a.replace(".json", ""), 10) || 0;
    const idB = parseInt(b.replace(".json", ""), 10) || 0;
    return idB - idA;
  });
  const targetNames = names.slice(0, Math.max(limit * 2, 100));
  const out: MatchLog[] = [];
  for (const n of targetNames) {
    try {
      const l = JSON.parse(await fs.readFile(path.join(dir(), n), "utf8")) as MatchLog;
      if (!accountId || l.accountId === accountId) {
        out.push(l);
        if (out.length >= limit) break;
      }
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
