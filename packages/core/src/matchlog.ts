/**
 * Match log written by the overlay (what the coach said, when) and the calibration
 * computed from many logs: are the win probabilities honest, and do matches go better
 * when the advice is followed?
 */

export interface LogSnapshot {
  /** game time, seconds */
  t: number;
  /** win probability as shown (calibrated + smoothed) */
  winP: number | null;
  /**
   * raw server win probability (no calibration, no smoothing). The calibration table is
   * built from this value, because it is applied to this value: building it from the shown
   * (already calibrated) value would make it correct its own corrections.
   */
  winRaw?: number | null;
  /** team net worth lead, my view */
  lead: number;
  phase?: string;
  macro?: string;
  tips: { kind: string; title: string }[];
  /** first steps of the recommended build path */
  next: { itemId: number; kind?: string }[];
  needs: { kind: string; satisfied: boolean }[];
  /** my items at this moment */
  items: number[];
  deaths: number;
  /** my net worth (souls earned), for the cross-match habits */
  nw?: number;
}

export interface MatchLog {
  matchId: number;
  accountId: number;
  heroId: number;
  team: number;
  startedAt: number;
  updatedAt: number;
  snapshots: LogSnapshot[];
  /** 0/1 once the game is over */
  winningTeam?: number;
  /** final item list (from the last snapshot) */
  finalItems?: number[];
}

export const won = (m: MatchLog) => (m.winningTeam == null ? null : m.winningTeam === m.team);

/**
 * Fills `winningTeam` for logs whose broadcast ended before the game-over row arrived,
 * from the account's match history (`match_result` = winning team). Returns the logs that
 * changed, so the caller can save them.
 */
export function backfillOutcomes(logs: MatchLog[], history: { match_id: number; match_result: number }[]): MatchLog[] {
  const byId = new Map(history.map((h) => [h.match_id, h.match_result]));
  const changed: MatchLog[] = [];
  for (const l of logs) {
    if (l.winningTeam != null) continue;
    const r = byId.get(l.matchId);
    if (r !== 0 && r !== 1) continue;
    l.winningTeam = r;
    changed.push(l);
  }
  return changed;
}

export interface Calibration {
  matches: number;
  finished: number;
  wins: number;
  /** reliability of the win probability: bucket → predicted vs actual */
  reliability: { from: number; to: number; predicted: number; actual: number; n: number }[];
  /** mean squared error of winP vs result (0.25 = coin flip) */
  brier: number | null;
  /** did I buy what the overlay recommended (within 4 minutes), and how did it go */
  follow: { followedRate: number | null; winFollowed: number | null; winIgnored: number | null; n: number };
  /** win rate in matches where a tip kind showed up as the top tip */
  tipKinds: { kind: string; matches: number; winrate: number }[];
  /** need kinds that were left unanswered for >5 min, and the win rate then */
  ignoredNeeds: { kind: string; matches: number; winrate: number }[];
  notes: string[];
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

export function calibrate(logs: MatchLog[]): Calibration {
  const done = logs.filter((l) => won(l) != null && l.snapshots.length >= 3);
  const notes: string[] = [];

  // --- win probability reliability (one sample per minute per match to avoid overweighting long games)
  const buckets = [0, 0.2, 0.35, 0.5, 0.65, 0.8, 1.0001];
  const rel = buckets.slice(0, -1).map((from, i) => ({ from, to: buckets[i + 1], p: [] as number[], y: [] as number[] }));
  const sq: number[] = [];
  for (const l of done) {
    const y = won(l) ? 1 : 0;
    let lastMin = -1;
    for (const s of l.snapshots) {
      if (s.winP == null || s.t < 180) continue;
      const m = Math.floor(s.t / 60);
      if (m === lastMin) continue;
      lastMin = m;
      // reliability maps the raw model value (what calibrateProb is applied to); logs from
      // before v0.3.26 only have the shown value
      const raw = s.winRaw !== undefined ? s.winRaw : s.winP;
      const b = raw == null ? undefined : rel.find((r) => raw >= r.from && raw < r.to);
      if (b && raw != null) {
        b.p.push(raw);
        b.y.push(y);
      }
      // Brier scores what the player actually saw
      sq.push((s.winP - y) ** 2);
    }
  }
  const reliability = rel.filter((r) => r.p.length).map((r) => ({ from: r.from, to: Math.min(1, r.to), predicted: mean(r.p)!, actual: mean(r.y)!, n: r.p.length }));
  const brier = mean(sq);

  // --- follow-through on item advice
  let followed = 0;
  let total = 0;
  const followRes: { f: number; y: number }[] = [];
  for (const l of done) {
    let f = 0;
    let n = 0;
    for (let i = 0; i < l.snapshots.length; i++) {
      const s = l.snapshots[i];
      const rec = s.next[0]?.itemId;
      if (!rec || s.items.includes(rec)) continue;
      n++;
      const later = l.snapshots.find((x) => x.t > s.t && x.t <= s.t + 240 && x.items.includes(rec));
      if (later) f++;
    }
    if (n) {
      followed += f;
      total += n;
      followRes.push({ f: f / n, y: won(l) ? 1 : 0 });
    }
  }
  const hi = followRes.filter((x) => x.f >= 0.5);
  const lo = followRes.filter((x) => x.f < 0.5);
  const follow = {
    followedRate: total ? followed / total : null,
    winFollowed: hi.length ? mean(hi.map((x) => x.y)) : null,
    winIgnored: lo.length ? mean(lo.map((x) => x.y)) : null,
    n: followRes.length,
  };

  // --- tip kinds as the top tip
  const kinds = new Map<string, { m: number; w: number }>();
  for (const l of done) {
    const seen = new Set(l.snapshots.map((s) => s.tips[0]?.kind).filter(Boolean) as string[]);
    for (const k of seen) {
      const e = kinds.get(k) ?? { m: 0, w: 0 };
      e.m++;
      e.w += won(l) ? 1 : 0;
      kinds.set(k, e);
    }
  }
  const tipKinds = [...kinds.entries()].map(([kind, e]) => ({ kind, matches: e.m, winrate: e.w / e.m })).sort((a, b) => b.matches - a.matches);

  // --- needs left unanswered for more than 5 minutes
  const ign = new Map<string, { m: number; w: number }>();
  for (const l of done) {
    const firstSeen = new Map<string, number>();
    const flagged = new Set<string>();
    for (const s of l.snapshots) {
      for (const n of s.needs) {
        if (n.satisfied) {
          firstSeen.delete(n.kind);
          continue;
        }
        if (!firstSeen.has(n.kind)) firstSeen.set(n.kind, s.t);
        else if (s.t - firstSeen.get(n.kind)! >= 300) flagged.add(n.kind);
      }
    }
    for (const k of flagged) {
      const e = ign.get(k) ?? { m: 0, w: 0 };
      e.m++;
      e.w += won(l) ? 1 : 0;
      ign.set(k, e);
    }
  }
  const ignoredNeeds = [...ign.entries()].map(([kind, e]) => ({ kind, matches: e.m, winrate: e.w / e.m })).sort((a, b) => b.matches - a.matches);

  if (done.length < 10) notes.push(`Baru ${done.length} match selesai tercatat; angka di bawah mulai bisa dipercaya setelah ±10–20 match.`);
  if (brier != null && done.length >= 10) {
    notes.push(
      brier < 0.2
        ? `Peluang menang cukup akurat (Brier ${brier.toFixed(3)}, makin kecil makin baik; tebak koin = 0,25).`
        : `Peluang menang belum akurat untuk match kamu (Brier ${brier.toFixed(3)}), perlakukan sebagai kasar.`,
    );
  }
  if (follow.winFollowed != null && follow.winIgnored != null && follow.n >= 10) {
    const d = follow.winFollowed - follow.winIgnored;
    notes.push(
      `Match saat kamu mengikuti saran item: WR ${Math.round(follow.winFollowed * 100)}% vs ${Math.round(follow.winIgnored * 100)}% saat tidak (${d >= 0 ? "+" : ""}${Math.round(d * 100)} poin). Ini korelasi, bukan bukti sebab-akibat.`,
    );
  }

  return {
    matches: logs.length,
    finished: done.length,
    wins: done.filter((l) => won(l)).length,
    reliability,
    brier,
    follow,
    tipKinds,
    ignoredNeeds,
    notes,
  };
}
