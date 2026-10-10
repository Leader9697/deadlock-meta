import "server-only";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { daysAgo, fitWinModel, type WinModel } from "@deadlock/core";
import { api } from "./data";

/**
 * Win-probability model fitted on recent real matches (net worth over time + winner).
 * Refit every 12 h; cached in memory and on disk so a restart doesn't refetch.
 */
const TTL_MS = 12 * 3600 * 1000;
const CACHE_FILE = path.join(os.tmpdir(), "deadlock-meta-winmodel.json");

let current: WinModel | null = null;
let inflight: Promise<WinModel | null> | null = null;
export let lastError: string | null = null;
export let lastShape: string | null = null;

async function fetchMatches(): Promise<unknown[]> {
  const raw = await api.get<unknown>(
    "/v1/matches/metadata",
    {
      include_info: true,
      include_player_info: true,
      include_player_stats: true,
      game_mode: "normal",
      min_unix_timestamp: daysAgo(3),
      min_duration_s: 900,
      order_by: "match_id",
      order_direction: "desc",
      limit: 400,
    },
    { cache: "no-store" },
  );
  const list = Array.isArray(raw) ? raw : [];
  // keep a short description of the shape for /api/winmodel debugging
  const first = list[0] as Record<string, unknown> | undefined;
  if (first) {
    const players = (first.players ?? (first.match_info as Record<string, unknown> | undefined)?.players) as unknown[] | undefined;
    const p0 = Array.isArray(players) ? (players[0] as Record<string, unknown>) : undefined;
    lastShape = JSON.stringify({
      matchKeys: Object.keys(first).slice(0, 25),
      playerKeys: p0 ? Object.keys(p0).slice(0, 25) : null,
      statsType: p0 ? (Array.isArray(p0.stats) ? `array[${(p0.stats as unknown[]).length}]` : typeof p0.stats) : null,
      stats0: p0 && Array.isArray(p0.stats) ? Object.keys((p0.stats as Record<string, unknown>[])[0] ?? {}).slice(0, 10) : null,
    });
  }
  return list;
}

async function build(): Promise<WinModel | null> {
  try {
    const matches = await fetchMatches();
    const model = fitWinModel(matches);
    if (model.matches < 50 || model.windows.length < 3) {
      lastError = `Hanya ${model.matches} match yang bisa dibaca dari ${matches.length}; model tidak dipakai.`;
      return null;
    }
    lastError = null;
    await fs.writeFile(CACHE_FILE, JSON.stringify(model)).catch(() => {});
    return model;
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
    return null;
  }
}

export async function getWinModel(): Promise<WinModel | null> {
  if (current && Date.now() - current.fittedAt < TTL_MS) return current;
  if (!current) {
    try {
      const disk = JSON.parse(await fs.readFile(CACHE_FILE, "utf8")) as WinModel;
      if (Date.now() - disk.fittedAt < TTL_MS) return (current = disk);
    } catch {}
  }
  inflight ??= build().then((m) => {
    if (m) current = m;
    inflight = null;
    return m ?? current;
  });
  // Don't block a live request on the first (slow) fit: return what we have.
  return current ?? (await Promise.race([inflight, new Promise<null>((r) => setTimeout(() => r(null), 4000))]));
}
