/**
 * Post-match review from Valve's match metadata (deadlock-api /v1/matches/{id}/metadata):
 * your economy against your hero's benchmark, your lane against your lane opponents,
 * item timings against the average for your hero, deaths and time spent dead, and where
 * your souls came from compared with your team.
 */

import type { Item } from "./types";

type O = Record<string, unknown>;
const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);
const arr = (v: unknown): O[] => (Array.isArray(v) ? (v.filter((x) => x && typeof x === "object") as O[]) : []);

/** Rows from array-of-objects or object-of-arrays. */
function rows(v: unknown): O[] {
  if (Array.isArray(v)) return arr(v);
  if (v && typeof v === "object") {
    const o = v as O;
    const keys = Object.keys(o).filter((k) => Array.isArray(o[k]));
    const n = Math.max(0, ...keys.map((k) => (o[k] as unknown[]).length));
    return Array.from({ length: n }, (_, i) => Object.fromEntries(keys.map((k) => [k, (o[k] as unknown[])[i]])));
  }
  return [];
}

const teamOf = (v: unknown): number | null => {
  if (typeof v === "number") return v >= 2 ? v - 2 : v;
  if (typeof v === "string") {
    const m = v.match(/Team([01])/i);
    return m ? Number(m[1]) : null;
  }
  return null;
};

export interface MetaPlayer {
  accountId: number;
  slot: number;
  team: number;
  heroId: number;
  lane: number | null;
  kills: number;
  deaths: number;
  assists: number;
  netWorth: number;
  lastHits: number;
  denies: number;
  items: { t: number; itemId: number; soldT: number | null }[];
  stats: O[];
  deathDetails: { t: number; killerSlot: number | null; durationS: number }[];
}

export interface ParsedMatch {
  matchId: number;
  durationS: number;
  winningTeam: number | null;
  averageBadge: number | null;
  players: MetaPlayer[];
}

export function parseMatchMetadata(raw: unknown): ParsedMatch | null {
  const root = ((raw as O)?.match_info ?? raw) as O;
  if (!root || typeof root !== "object") return null;
  const players = arr(root.players).map((p) => ({
    accountId: num(p.account_id),
    slot: num(p.player_slot),
    team: teamOf(p.team) ?? 0,
    heroId: num(p.hero_id),
    lane: Number.isFinite(num(p.assigned_lane)) ? num(p.assigned_lane) : null,
    kills: num(p.kills) || 0,
    deaths: num(p.deaths) || 0,
    assists: num(p.assists) || 0,
    netWorth: num(p.net_worth) || 0,
    lastHits: num(p.last_hits) || 0,
    denies: num(p.denies) || 0,
    items: rows(p.items)
      .map((i) => ({ t: num(i.game_time_s), itemId: num(i.item_id), soldT: Number.isFinite(num(i.sold_time_s)) && num(i.sold_time_s) > 0 ? num(i.sold_time_s) : null }))
      .filter((i) => Number.isFinite(i.t) && i.itemId > 0),
    stats: rows(p.stats).sort((a, b) => num(a.time_stamp_s) - num(b.time_stamp_s)),
    deathDetails: rows(p.death_details).map((d) => ({
      t: num(d.game_time_s),
      killerSlot: Number.isFinite(num(d.killer_player_slot)) ? num(d.killer_player_slot) : null,
      durationS: num(d.death_duration_s) || 0,
    })),
  }));
  const b0 = num(root.average_badge_team0);
  const b1 = num(root.average_badge_team1);
  return {
    matchId: num(root.match_id),
    durationS: num(root.duration_s) || 0,
    winningTeam: teamOf(root.winning_team),
    averageBadge: Number.isFinite(b0) && Number.isFinite(b1) ? Math.round((b0 + b1) / 2) : null,
    players,
  };
}

const statAt = (p: MetaPlayer, t: number, field: string): number | null => {
  let v: number | null = null;
  for (const s of p.stats) {
    if (num(s.time_stamp_s) > t) break;
    const x = num(s[field]);
    if (Number.isFinite(x)) v = x;
  }
  return v;
};
const last = (p: MetaPlayer, field: string) => {
  for (let i = p.stats.length - 1; i >= 0; i--) {
    const x = num(p.stats[i][field]);
    if (Number.isFinite(x)) return x;
  }
  return null;
};

export interface PostMatchInput {
  accountId: number;
  items: Map<number, Item>;
  heroName: (id: number) => string;
  /** average buy time (s) of each item on this hero, from item-stats */
  avgBuyTime: Map<number, number>;
  /** typical net worth of this hero at 10/20/30 min (from item-flow) */
  netWorthBench: { 600: number; 1200: number; 1800: number } | null;
}

export interface PostMatchReview {
  matchId: number;
  won: boolean | null;
  heroId: number;
  durationS: number;
  kda: string;
  netWorth: number;
  soulsPerMin: number;
  /** net worth checkpoints: me vs hero benchmark vs lane opponents */
  checkpoints: { t: number; mine: number; bench: number | null; laneOpp: number | null }[];
  /** items bought clearly later than average on this hero */
  lateItems: { itemId: number; name: string; boughtS: number; avgS: number; deltaS: number }[];
  deaths: { t: number; killer: string | null; durationS: number }[];
  deadSeconds: number;
  /** souls by source vs my team average */
  farm: { source: string; mine: number; teamAvg: number }[];
  fixes: string[];
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const k = (n: number) => `${(n / 1000).toFixed(1)}k`;

export function reviewMatch(m: ParsedMatch, input: PostMatchInput): PostMatchReview | null {
  const me = m.players.find((p) => p.accountId === input.accountId);
  if (!me) return null;
  const won = m.winningTeam == null ? null : m.winningTeam === me.team;
  const enemies = m.players.filter((p) => p.team !== me.team);
  const team = m.players.filter((p) => p.team === me.team);
  const laneOpps = me.lane != null ? enemies.filter((p) => p.lane === me.lane) : [];
  const bySlot = new Map(m.players.map((p) => [p.slot, p]));

  const checkpoints = ([600, 1200, 1800] as const)
    .filter((t) => t < m.durationS)
    .map((t) => {
      const opp = laneOpps.map((p) => statAt(p, t, "net_worth")).filter((x): x is number => x != null);
      return {
        t,
        mine: statAt(me, t, "net_worth") ?? 0,
        bench: input.netWorthBench?.[t] ?? null,
        laneOpp: t === 600 && opp.length ? opp.reduce((s, x) => s + x, 0) / opp.length : null,
      };
    });

  const lateItems = me.items
    .filter((i) => {
      const it = input.items.get(i.itemId);
      return it?.type === "upgrade" && (it.item_tier ?? 0) >= 2 && input.avgBuyTime.has(i.itemId);
    })
    .map((i) => {
      const avg = input.avgBuyTime.get(i.itemId)!;
      return { itemId: i.itemId, name: input.items.get(i.itemId)?.name ?? `#${i.itemId}`, boughtS: i.t, avgS: avg, deltaS: i.t - avg };
    })
    .filter((x) => x.deltaS >= 150)
    .sort((a, b) => b.deltaS - a.deltaS)
    .slice(0, 5);

  const deaths = me.deathDetails.map((d) => {
    const kp = d.killerSlot != null ? bySlot.get(d.killerSlot) : undefined;
    return { t: d.t, killer: kp && kp.team !== me.team ? input.heroName(kp.heroId) : null, durationS: d.durationS };
  });
  const deadSeconds = deaths.reduce((s, d) => s + d.durationS, 0);

  const sources: [string, string][] = [
    ["gold_lane_creep", "Creep lane"],
    ["gold_neutral_creep", "Camp jungle"],
    ["gold_player", "Kill/assist"],
    ["gold_boss", "Objektif"],
    ["gold_treasure", "Breakable/urn"],
    ["gold_denied", "Deny"],
  ];
  const farm = sources
    .map(([f, label]) => {
      const mine = last(me, f);
      const others = team.map((p) => last(p, f)).filter((x): x is number => x != null);
      return mine == null || !others.length ? null : { source: label, mine, teamAvg: others.reduce((s, x) => s + x, 0) / others.length };
    })
    .filter((x): x is { source: string; mine: number; teamAvg: number } => !!x);

  // ---- fixes, most impactful first
  const fixes: { w: number; text: string }[] = [];
  const cp10 = checkpoints.find((c) => c.t === 600);
  if (cp10?.laneOpp != null && cp10.mine < cp10.laneOpp - 800) {
    fixes.push({ w: (cp10.laneOpp - cp10.mine) / 500, text: `Kalah lane: menit 10 kamu ${k(cp10.mine)} vs lawan lane ${k(cp10.laneOpp)}. Fokus last-hit dan amankan orb sebelum trade.` });
  }
  for (const c of checkpoints) {
    if (c.bench && c.mine < c.bench * 0.85) {
      fixes.push({ w: ((c.bench - c.mine) / c.bench) * 10, text: `Souls menit ${c.t / 60}: ${k(c.mine)} vs rata-rata hero ini ${k(c.bench)} (${Math.round((c.mine / c.bench - 1) * 100)}%).` });
      break;
    }
  }
  const jungle = farm.find((f) => f.source === "Camp jungle");
  if (jungle && jungle.teamAvg > 0 && jungle.mine < jungle.teamAvg * 0.6) {
    fixes.push({ w: 3, text: `Farm jungle kamu ${k(jungle.mine)} vs rata-rata tim ${k(jungle.teamAvg)}: ambil camp terdekat di antara wave.` });
  }
  if (lateItems[0]) {
    fixes.push({ w: lateItems[0].deltaS / 120, text: `${lateItems[0].name} dibeli ${clock(lateItems[0].boughtS)}, rata-rata ${clock(lateItems[0].avgS)} (telat ${clock(lateItems[0].deltaS)}).` });
  }
  if (deadSeconds >= 180) {
    const pct = m.durationS ? deadSeconds / m.durationS : 0;
    fixes.push({ w: deadSeconds / 60, text: `Total ${clock(deadSeconds)} mati (${Math.round(pct * 100)}% match). Setiap kematian = souls dan waktu farm hilang.` });
  }
  const early = deaths.filter((d) => d.t < 600).length;
  if (early >= 3) fixes.push({ w: early, text: `${early}× mati sebelum menit 10: main lane lebih aman.` });
  const killers = new Map<string, number>();
  for (const d of deaths) if (d.killer) killers.set(d.killer, (killers.get(d.killer) ?? 0) + 1);
  const rep = [...killers.entries()].sort((a, b) => b[1] - a[1])[0];
  if (rep && rep[1] >= 3) fixes.push({ w: rep[1], text: `${rep[0]} membunuhmu ${rep[1]}×: hindari 1v1 dengannya, cek posisinya sebelum farm sendirian.` });

  return {
    matchId: m.matchId,
    won,
    heroId: me.heroId,
    durationS: m.durationS,
    kda: `${me.kills}/${me.deaths}/${me.assists}`,
    netWorth: me.netWorth,
    soulsPerMin: m.durationS ? me.netWorth / (m.durationS / 60) : 0,
    checkpoints,
    lateItems,
    deaths,
    deadSeconds,
    farm,
    fixes: fixes.sort((a, b) => b.w - a.w).map((f) => f.text).slice(0, 5),
  };
}

// ---------------------------------------------------------------------------
// Personal profile: which heroes are good *for you*, and are you on tilt
// ---------------------------------------------------------------------------

export interface PersonalHero {
  heroId: number;
  matches: number;
  winrate: number;
  /** your shrunk WR minus the hero's global WR */
  edge: number;
  globalWr: number;
}

/** Shrinks your per-hero WR toward the hero's global WR (k = 15 matches). */
export function personalHeroes(mine: { hero_id: number; matches: number; wins: number }[], globalWr: Map<number, number>, k = 15): PersonalHero[] {
  return mine
    .filter((r) => r.matches >= 3)
    .map((r) => {
      const g = globalWr.get(r.hero_id) ?? 0.5;
      const shrunk = (r.wins + g * k) / (r.matches + k);
      return { heroId: r.hero_id, matches: r.matches, winrate: r.wins / r.matches, edge: shrunk - g, globalWr: g };
    })
    .sort((a, b) => b.edge - a.edge);
}

export interface TiltCheck {
  streak: number;
  /** "loss" streak or "win" streak */
  streakKind: "win" | "loss" | null;
  last10: { wins: number; games: number };
  warning: string | null;
}

/** outcomes newest first, true = win */
export function tiltCheck(outcomes: boolean[]): TiltCheck {
  let streak = 0;
  const first = outcomes[0];
  for (const o of outcomes) {
    if (o !== first) break;
    streak++;
  }
  const l10 = outcomes.slice(0, 10);
  const wins = l10.filter(Boolean).length;
  let warning: string | null = null;
  if (first === false && streak >= 3) warning = `${streak} kalah beruntun. Istirahat 10–15 menit sebelum queue lagi; main saat tilt biasanya memperpanjang streak.`;
  else if (l10.length >= 8 && wins / l10.length <= 0.3) warning = `${wins}/${l10.length} menang di 10 match terakhir. Pertimbangkan ganti ke hero terbaikmu atau istirahat.`;
  return { streak, streakKind: first == null ? null : first ? "win" : "loss", last10: { wins, games: l10.length }, warning };
}
