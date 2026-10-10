/**
 * Cross-match habits from the overlay match logs (DLM_DATA_DIR): the few things that
 * repeat every match and are fixable before the next one — deaths before 10:00, souls at
 * 10:00 against the hero average, and items that are always bought late.
 *
 * Everything here is *pre-game* material: it is computed from finished logs, never from the
 * live (delayed) broadcast, so the HUD can show it before the match starts.
 */

import type { MatchLog } from "./matchlog";

export interface HabitsInput {
  /** hero → typical souls at 10:00 for that hero (flowPhasePlan.netWorthByPhase.early) */
  soulsBench?: Map<number, number>;
  /** item → average buy time in seconds on your heroes (item-stats avg_buy_time_s) */
  avgBuyTime?: Map<number, number>;
  itemName?: (id: number) => string;
  /** tier of an item; only tier ≥2 upgrades are judged "late" */
  itemTier?: (id: number) => number | undefined;
  /** how many matches a number needs before it is shown (default 3) */
  minMatches?: number;
}

export interface HabitMatch {
  matchId: number;
  heroId: number;
  startedAt: number;
  /** deaths by 10:00, null when the log does not reach that far */
  deaths10: number | null;
  /** my net worth at 10:00, null for logs written before the overlay recorded it */
  souls10: number | null;
}

export interface HabitLateItem {
  itemId: number;
  name: string;
  /** my average buy time (s) */
  mineS: number;
  /** average buy time for this item (s) */
  benchS: number;
  /** mine − bench, seconds (positive = late) */
  deltaS: number;
  matches: number;
}

export interface Habits {
  /** logs that reached 10:00 and could be used */
  matches: number;
  deaths10: { avg: number | null; worst: number | null; matches: number };
  souls10: { avg: number | null; bench: number | null; deltaPct: number | null; matches: number };
  perHero: { heroId: number; matches: number; souls10: number | null; bench: number | null; deaths10: number | null }[];
  lateItems: HabitLateItem[];
  /** 1–2 short plain-text lines for the HUD before a match (empty when there is not enough data) */
  hudLines: string[];
  notes: string[];
}

/** game clock, 10:00 ± 1 snapshot interval (the overlay writes one snapshot per 20 s) */
const AT10 = 600;
const WINDOW = 60;
const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const k = (n: number) => `${(n / 1000).toFixed(1)}k`;
const mins = (s: number) => `${Math.round(s / 60)}m`;

/** the snapshot closest to 10:00, or null when the log never got that far */
function snapshotAt10(log: MatchLog) {
  let best: MatchLog["snapshots"][number] | null = null;
  for (const s of log.snapshots) {
    if (Math.abs(s.t - AT10) > WINDOW) continue;
    if (!best || Math.abs(s.t - AT10) < Math.abs(best.t - AT10)) best = s;
  }
  return best;
}

/** first game time each item shows up in the log (≈ when it was bought, ±20 s) */
function firstSeen(log: MatchLog): Map<number, number> {
  const out = new Map<number, number>();
  for (const s of log.snapshots) for (const id of s.items) if (!out.has(id)) out.set(id, s.t);
  return out;
}

/** one row per log that reached 10:00 */
function habitList(logs: MatchLog[]): HabitMatch[] {
  const out: HabitMatch[] = [];
  for (const l of logs) {
    const s = snapshotAt10(l);
    if (!s) continue;
    out.push({
      matchId: l.matchId,
      heroId: l.heroId,
      startedAt: l.startedAt,
      deaths10: Number.isFinite(s.deaths) ? s.deaths : null,
      souls10: typeof s.nw === "number" && s.nw > 0 ? s.nw : null,
    });
  }
  return out;
}

export function habits(logs: MatchLog[], input: HabitsInput = {}): Habits {
  const min = input.minMatches ?? 3;
  const notes: string[] = [];

  const used = habitList(logs);

  const d10 = used.map((m) => m.deaths10).filter((x): x is number => x != null);
  const s10 = used.map((m) => m.souls10).filter((x): x is number => x != null);

  // souls benchmark: the hero average, weighted by how often I played each hero
  const benchPer: number[] = [];
  for (const m of used) {
    if (m.souls10 == null) continue;
    const b = input.soulsBench?.get(m.heroId);
    if (b && b > 0) benchPer.push(b);
  }
  const soulsAvg = mean(s10);
  const bench = mean(benchPer);
  const deltaPct = soulsAvg != null && bench ? soulsAvg / bench - 1 : null;

  // per hero (for the web detail view)
  const byHero = new Map<number, HabitMatch[]>();
  for (const m of used) byHero.set(m.heroId, [...(byHero.get(m.heroId) ?? []), m]);
  const perHero = [...byHero.entries()]
    .map(([heroId, ms]) => ({
      heroId,
      matches: ms.length,
      souls10: mean(ms.map((m) => m.souls10).filter((x): x is number => x != null)),
      bench: input.soulsBench?.get(heroId) ?? null,
      deaths10: mean(ms.map((m) => m.deaths10).filter((x): x is number => x != null)),
    }))
    .sort((a, b) => b.matches - a.matches);

  // items that are late match after match
  const buys = new Map<number, number[]>();
  for (const l of logs) {
    for (const [itemId, t] of firstSeen(l)) {
      // an item already there in the first snapshot was bought before the log started
      if (t <= (l.snapshots[0]?.t ?? 0)) continue;
      const tier = input.itemTier?.(itemId);
      if (tier == null || tier < 2) continue;
      if (!input.avgBuyTime?.has(itemId)) continue;
      buys.set(itemId, [...(buys.get(itemId) ?? []), t]);
    }
  }
  const lateItems = [...buys.entries()]
    .filter(([, ts]) => ts.length >= Math.min(min, 2))
    .map(([itemId, ts]) => {
      const mineS = mean(ts)!;
      const benchS = input.avgBuyTime!.get(itemId)!;
      return {
        itemId,
        name: input.itemName?.(itemId) ?? `#${itemId}`,
        mineS,
        benchS,
        deltaS: mineS - benchS,
        matches: ts.length,
      };
    })
    .filter((x) => x.deltaS >= 120)
    .sort((a, b) => b.deltaS - a.deltaS)
    .slice(0, 6);

  // ---- HUD lines: at most two, only what is actually off
  const hudLines: string[] = [];
  if (d10.length >= min || s10.length >= min) {
    const bits: string[] = [];
    const avgD = mean(d10);
    if (avgD != null && d10.length >= min) bits.push(`mati sebelum 10:00 ${avgD.toFixed(1)}×`);
    if (soulsAvg != null && s10.length >= min) {
      bits.push(
        deltaPct != null
          ? `souls 10:00 ${k(soulsAvg)} (${deltaPct >= 0 ? "+" : "−"}${Math.round(Math.abs(deltaPct) * 100)}% vs rata-rata hero)`
          : `souls 10:00 ${k(soulsAvg)}`,
      );
    }
    if (bits.length) hudLines.push(`📊 ${used.length} match terakhir: ${bits.join(" · ")}`);
  }
  if (lateItems.length) {
    hudLines.push(`🐢 Item langganan telat: ${lateItems.slice(0, 2).map((x) => `${x.name} +${mins(x.deltaS)}`).join(" · ")}`);
  }

  if (used.length < min) {
    notes.push(`Baru ${used.length} match dengan log sampai menit 10. Angkanya mulai berarti setelah ±${min}–10 match.`);
  }
  if (used.length && !s10.length) {
    notes.push("Souls menit 10 belum terekam di log lama; mulai tercatat dari match berikutnya dengan versi overlay ini.");
  }
  if (deltaPct != null && deltaPct <= -0.12) {
    notes.push(`Souls menit 10 kamu ${Math.round(Math.abs(deltaPct) * 100)}% di bawah rata-rata hero yang kamu pakai: rapikan last-hit dan ambil camp di antara wave.`);
  }
  const avgD = mean(d10);
  if (avgD != null && d10.length >= min && avgD >= 2) {
    notes.push(`Rata-rata ${avgD.toFixed(1)} kematian sebelum menit 10. Tiap mati di laning ±600–900 souls plus waktu farm.`);
  }

  return {
    matches: used.length,
    deaths10: { avg: avgD, worst: d10.length ? Math.max(...d10) : null, matches: d10.length },
    souls10: { avg: soulsAvg, bench, deltaPct, matches: s10.length },
    perHero,
    lateItems,
    hudLines,
    notes,
  };
}

/** the matches behind the numbers, newest first (web detail view) */
export function habitMatches(logs: MatchLog[]): HabitMatch[] {
  return habitList(logs).sort((a, b) => b.startedAt - a.startedAt);
}
