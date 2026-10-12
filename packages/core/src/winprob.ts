/**
 * Live win probability from team net-worth lead, fitted on real match data.
 *
 * Data: deadlock-api bulk match metadata with player stats (CMsgMatchMetaDataContents:
 * players[].team, players[].stats[] = { time_stamp_s, net_worth }, match winning_team).
 * For every stats sample we take the lead fraction (A−B)/(A+B) and the outcome, then fit
 *   P(win) = σ(k(t) · leadFraction)
 * per game-time window (no intercept: the game is symmetric). k is interpolated between
 * windows. An empirical table (lead in souls × minute) is kept for display.
 */

export interface WinSample {
  t: number; // seconds
  frac: number; // lead fraction from team 0's view
  lead: number; // souls, team 0 − team 1
  y: 1 | -1; // +1 if team 0 won
}

export interface WinModel {
  /** window centers (s) and fitted slopes */
  windows: { from: number; to: number; center: number; k: number; n: number }[];
  matches: number;
  samples: number;
  /** win rate of the leading side by minute window and lead size */
  table: { from: number; to: number; leadMin: number; leadMax: number; winrate: number; n: number }[];
  fittedAt: number;
}

const WINDOWS_MIN = [0, 8, 15, 22, 30, 40, 90];
const LEAD_BINS = [1000, 3000, 6000, 10000, 15000, Infinity];

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

// ---------- tolerant parsing of the metadata shapes ----------

type AnyObj = Record<string, unknown>;

/** 0/1 from numbers (0/1 or Source-2 2/3) or enum strings ("Team1", "k_ECitadelLobbyTeam_Team1"). */
export function parseTeam(v: unknown): 0 | 1 | null {
  if (typeof v === "number") {
    if (v === 0 || v === 1) return v;
    if (v === 2 || v === 3) return (v - 2) as 0 | 1;
    return null;
  }
  if (typeof v === "string") {
    const m = v.match(/Team([01])\b|^([01])$/i);
    if (m) return Number(m[1] ?? m[2]) as 0 | 1;
  }
  return null;
}

/** [time_stamp_s, net_worth][] from array-of-objects, object-of-arrays, or flat "stats.x" keys. */
export function parseStats(player: AnyObj): [number, number][] {
  const out: [number, number][] = [];
  const st = player.stats;
  if (Array.isArray(st)) {
    for (const s of st) {
      if (s && typeof s === "object" && !Array.isArray(s)) {
        const o = s as AnyObj;
        const t = Number(o.time_stamp_s);
        const nw = Number(o.net_worth);
        if (Number.isFinite(t) && Number.isFinite(nw)) out.push([t, nw]);
      }
    }
  } else if (st && typeof st === "object") {
    const o = st as AnyObj;
    const ts = o.time_stamp_s;
    const nw = o.net_worth;
    if (Array.isArray(ts) && Array.isArray(nw)) ts.forEach((t, i) => out.push([Number(t), Number(nw[i])]));
  }
  const flatT = player["stats.time_stamp_s"];
  const flatN = player["stats.net_worth"];
  if (!out.length && Array.isArray(flatT) && Array.isArray(flatN)) flatT.forEach((t, i) => out.push([Number(t), Number(flatN[i])]));
  return out.filter(([t, n]) => Number.isFinite(t) && Number.isFinite(n)).sort((a, b) => a[0] - b[0]);
}

/** Net worth at time t: last sample at or before t. */
function nwAt(series: [number, number][], t: number): number | null {
  let v: number | null = null;
  for (const [ts, nw] of series) {
    if (ts > t) break;
    v = nw;
  }
  return v;
}

export function samplesFromMatch(match: unknown): WinSample[] {
  if (!match || typeof match !== "object") return [];
  const root = match as AnyObj;
  const info = (root.match_info && typeof root.match_info === "object" ? root.match_info : root) as AnyObj;
  const winner = parseTeam(info.winning_team ?? root.winning_team);
  const players = (Array.isArray(info.players) ? info.players : Array.isArray(root.players) ? root.players : []) as AnyObj[];
  if (winner === null || players.length < 10) return [];

  const teams: [number, number][][][] = [[], []];
  for (const p of players) {
    const team = parseTeam(p.team ?? p.player_team);
    if (team === null) continue;
    const s = parseStats(p);
    if (s.length) teams[team].push(s);
  }
  if (teams[0].length < 5 || teams[1].length < 5) return [];

  const times = [...new Set(teams.flat().flatMap((s) => s.map(([t]) => t)))].filter((t) => t >= 60).sort((a, b) => a - b);
  const out: WinSample[] = [];
  for (const t of times) {
    const sum = (team: [number, number][][]) => {
      let total = 0;
      for (const s of team) {
        const v = nwAt(s, t);
        if (v === null) return null;
        total += v;
      }
      return total;
    };
    const a = sum(teams[0]);
    const b = sum(teams[1]);
    if (a === null || b === null || a + b <= 0) continue;
    out.push({ t, frac: (a - b) / (a + b), lead: a - b, y: winner === 0 ? 1 : -1 });
  }
  return out;
}

// ---------- fitting ----------

/** 1-parameter logistic fit (no intercept) by Newton's method. */
export function fitSlope(xs: number[], ys: (1 | -1)[]): number {
  let k = 5;
  for (let iter = 0; iter < 50; iter++) {
    let g = 0;
    let h = 0;
    for (let i = 0; i < xs.length; i++) {
      const z = ys[i] * k * xs[i];
      const s = sigmoid(z);
      g += ys[i] * xs[i] * (1 - s);
      h -= xs[i] * xs[i] * s * (1 - s);
    }
    if (h === 0) break;
    const step = g / h;
    k -= step;
    if (Math.abs(step) < 1e-6) break;
  }
  return Math.max(0, Math.min(200, k));
}

export function fitWinModel(matches: unknown[]): WinModel {
  const perMatch = matches.map(samplesFromMatch).filter((s) => s.length > 0);
  const all = perMatch.flat();

  const windows: WinModel["windows"] = [];
  const table: WinModel["table"] = [];
  for (let i = 0; i < WINDOWS_MIN.length - 1; i++) {
    const from = WINDOWS_MIN[i] * 60;
    const to = WINDOWS_MIN[i + 1] * 60;
    const w = all.filter((s) => s.t >= from && s.t < to);
    if (w.length >= 50) {
      windows.push({ from, to, center: (from + Math.min(to, 50 * 60)) / 2, k: fitSlope(w.map((s) => s.frac), w.map((s) => s.y)), n: w.length });
    }
    // empirical: did the side that led by |lead| in [lo, hi) win?
    let lo = 0;
    for (const hi of LEAD_BINS) {
      const bin = w.filter((s) => Math.abs(s.lead) >= lo && Math.abs(s.lead) < hi);
      if (bin.length >= 20) {
        const wins = bin.filter((s) => (s.lead >= 0 ? s.y === 1 : s.y === -1)).length;
        table.push({ from, to, leadMin: lo, leadMax: hi, winrate: wins / bin.length, n: bin.length });
      }
      lo = hi;
    }
  }
  return { windows, matches: perMatch.length, samples: all.length, table, fittedAt: Date.now() };
}

/** k at game time t, linearly interpolated between window centers. */
function slopeAt(model: WinModel, t: number): number | null {
  const w = model.windows;
  if (!w.length) return null;
  if (t <= w[0].center) return w[0].k;
  for (let i = 1; i < w.length; i++) {
    if (t <= w[i].center) {
      const a = w[i - 1];
      const b = w[i];
      const f = (t - a.center) / (b.center - a.center);
      return a.k + f * (b.k - a.k);
    }
  }
  return w[w.length - 1].k;
}

export interface WinProbContext {
  /** Delta objectives destroyed (enemy stages destroyed − our stages destroyed). Positive = we destroyed more enemy towers */
  objectiveDelta?: number;
  /** Delta unlocked flex item slots (my team flex slots − enemy team flex slots) */
  flexSlotDelta?: number;
}

/** 
 * P(my team wins). `lead` and `total` are souls from my team's view.
 * Incorporates objective control and flex item slot deltas when available.
 */
export function winProbability(
  model: WinModel | null,
  gameTimeS: number,
  lead: number,
  total: number,
  ctx?: WinProbContext,
): number | null {
  if (!model || total <= 0) return null;
  const k = slopeAt(model, gameTimeS);
  if (k === null) return null;

  // Base net worth slope
  let z = k * (lead / total);

  // Objectives influence: each destroyed tier (Guardian/Walker/Base) confers significant map control & lane push pressure
  if (typeof ctx?.objectiveDelta === "number" && ctx.objectiveDelta !== 0) {
    // A lead of +2 objectives adds equivalent to ~4-6% win rate advantage
    const objWeight = gameTimeS < 600 ? 0.08 : 0.14;
    z += ctx.objectiveDelta * objWeight;
  }

  // Flex slot delta: each unlocked flex slot provides a 4th/5th slot for tier 3/4 items
  if (typeof ctx?.flexSlotDelta === "number" && ctx.flexSlotDelta !== 0) {
    const flexWeight = 0.12;
    z += ctx.flexSlotDelta * flexWeight;
  }

  return sigmoid(z);
}

/** Empirical row for display: "teams up 5–10k at 15–22 min won 71% (n=…)". */
export function empiricalFor(model: WinModel | null, gameTimeS: number, lead: number) {
  if (!model) return null;
  const a = Math.abs(lead);
  const row = model.table.find((r) => gameTimeS >= r.from && gameTimeS < r.to && a >= r.leadMin && a < r.leadMax);
  if (!row) return null;
  return { ...row, leaderIsMe: lead >= 0 };
}

export interface CalibrationReliabilityBucket {
  from: number;
  to: number;
  predicted: number;
  actual: number;
  n: number;
}

/**
 * Adjusts raw model win probability using personal calibration reliability data
 * (closing the loop from cross-match log calibration).
 * Only applies when player has sufficient sample size.
 */
export function calibrateProb(rawP: number | null, reliability?: CalibrationReliabilityBucket[] | null): number | null {
  if (rawP === null || !Number.isFinite(rawP)) return null;
  if (!reliability || reliability.length < 3) return rawP;

  // Find corresponding reliability bucket
  const bucket = reliability.find((b) => rawP >= b.from && rawP < b.to);
  if (!bucket || bucket.n < 3) return rawP;

  // Smoothly blend rawP with empirical actual win rate
  const weight = Math.min(0.4, bucket.n * 0.02);
  const adjusted = (1 - weight) * rawP + weight * bucket.actual;
  return Math.max(0.01, Math.min(0.99, adjusted));
}
