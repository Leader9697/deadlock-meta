/**
 * Macro plan: farm / hold lane / defend / push / group, decided from the match state
 * (objectives per lane, who is dead and for how long, economy, win probability,
 * scaling) rather than from averages.
 *
 * Broadcast data is 60–90 s behind, so this works at the 1–2 minute decision level.
 *
 * Objective bits (ECitadelTeamObjective): 1–4 guardian lane 1–4, 5–8 walker lane 1–4,
 * 12–15 base guardian lane 1–4. Lane colours (m_nAssignedLane, ELaneColor): Yellow 1,
 * Green 3, Blue 4, Purple 6 → objective lane 1–4 in that order (assumed).
 */

import type { LivePlayer, LiveState } from "./live";
import { formatClock } from "./stats";

export type MacroAction = "lane" | "farm" | "defend" | "push" | "group" | "siege" | "carry";

export interface LaneState {
  color: number;
  name: string;
  /** 0 guardian up, 1 guardian down, 2 walker down, 3 base guardian down */
  ourStage: number;
  enemyStage: number;
  status: "seimbang" | "kita tekan" | "kita ditekan";
  /** enemy laners on this lane, and whether they are dead (real time) */
  enemyLaners: { heroId: number; dead: boolean }[];
}

export interface MacroPlan {
  action: MacroAction;
  title: string;
  detail: string;
  why: string[];
  /** lane the plan points at, if any */
  lane: LaneState | null;
  lanes: LaneState[];
  /**
   * In-game clock (what the player sees on screen) until which this plan holds; the
   * broadcast is 1+ minute late, so windows are written as clock times, not "±40 s".
   */
  until?: number;
  /** built from a short numbers window (deaths): may change quickly */
  urgent?: boolean;
}

const LANE_ORDER = [1, 3, 4, 6];
const LANE_NAME: Record<number, string> = { 1: "Kuning", 3: "Hijau", 4: "Biru", 6: "Ungu" };
const STAGE_NAME = ["Guardian", "Walker", "Base Guardian", "Shrine/Patron"];
const bit = (mask: number, i: number) => Math.floor(mask / 2 ** i) % 2 === 1;

export interface MacroInput {
  state: LiveState;
  me: LivePlayer;
  /** my team − enemy team */
  netWorthLead: number;
  winP: number | null;
  /** >0 = my lineup is stronger late */
  scalingDiff: number;
  delayS: number;
  heroName: (id: number) => string;
}

/**
 * Objective lane indexes (1..4) of the lanes players are actually assigned to. A map with
 * fewer lanes leaves the unused lane's bits clear, which would read as "destroyed".
 */
export function activeLaneIndexes(players: { lane?: number }[]): number[] {
  const idx = new Set<number>();
  for (const p of players) {
    const i = p.lane != null ? LANE_ORDER.indexOf(p.lane) : -1;
    if (i >= 0) idx.add(i + 1);
  }
  return [...idx].sort((a, b) => a - b);
}

/**
 * Total stages destroyed given an objective mask (3 per lane). Pass `lanes` (from
 * `activeLaneIndexes`) to count only the lanes in play; without it all 4 are counted.
 */
export function countDestroyedStages(mask: number | undefined, lanes?: number[]): number {
  if (typeof mask !== "number" || Number.isNaN(mask)) return 0;
  let destroyed = 0;
  for (const idx of lanes && lanes.length ? lanes : [1, 2, 3, 4]) {
    // stage 0: guardian down (bit idx clear)
    if (!bit(mask, idx)) destroyed++;
    // stage 1: walker down (bit 4+idx clear)
    if (!bit(mask, 4 + idx)) destroyed++;
    // stage 2: base guardian down (bit 11+idx clear)
    if (!bit(mask, 11 + idx)) destroyed++;
  }
  return destroyed;
}

export function laneStates(input: MacroInput): LaneState[] {
  const { state, me } = input;
  const colors = [...new Set(state.players.map((p) => p.lane).filter((l): l is number => l != null && LANE_ORDER.includes(l)))].sort((a, b) => a - b);
  const masks = state.objectiveMasks;
  const realDead = (p: LivePlayer) => !!p.dead && (p.respawnInS ?? 0) - input.delayS > 5;
  const out: LaneState[] = [];
  for (const color of colors) {
    const idx = LANE_ORDER.indexOf(color) + 1; // 1..4
    const stage = (team: number) => {
      if (!masks) return 0;
      const m = masks[team] ?? 0;
      // bit set = objective still standing
      if (bit(m, idx)) return 0;
      if (bit(m, 4 + idx)) return 1;
      if (bit(m, 11 + idx)) return 2;
      return 3;
    };
    const ours = stage(me.team);
    const theirs = stage(1 - me.team);
    out.push({
      color,
      name: LANE_NAME[color] ?? `#${color}`,
      ourStage: ours,
      enemyStage: theirs,
      status: theirs > ours ? "kita tekan" : ours > theirs ? "kita ditekan" : "seimbang",
      enemyLaners: state.players.filter((p) => p.team !== me.team && p.lane === color).map((p) => ({ heroId: p.heroId, dead: realDead(p) })),
    });
  }
  // sanity: if the masks say every lane lost its guardian in the first 3 minutes, the
  // bit meaning is inverted (or the mask is not what we think): ignore objectives.
  if (state.gameTimeS < 180 && out.length && out.every((l) => l.ourStage > 0 && l.enemyStage > 0)) {
    for (const l of out) {
      l.ourStage = 0;
      l.enemyStage = 0;
      l.status = "seimbang";
    }
  }
  return out;
}

const k = (n: number) => `${(n / 1000).toFixed(1)}k`;

export function macroPlan(input: MacroInput): MacroPlan {
  const { state, me, winP, scalingDiff, delayS, heroName } = input;
  const lanes = laneStates(input);
  const t = state.gameTimeS;
  const allies = state.players.filter((p) => p.team === me.team);
  const enemies = state.players.filter((p) => p.team !== me.team);
  const real = (p: LivePlayer) => (p.dead ? Math.max(0, (p.respawnInS ?? 0) - delayS) : 0);
  // a window needs ≥25 s left in real time: walking there and hitting a tower takes that long
  const deadEnemies = enemies.filter((p) => real(p) >= 25);
  const deadAllies = allies.filter((p) => p.accountId !== me.accountId && real(p) >= 25);
  /** in-game clock `s` seconds from now (broadcast time + delay + s) */
  const clockIn = (s: number) => formatClock(t + delayS + s);
  const numbers = enemies.length - deadEnemies.length - (allies.length - deadAllies.length);
  const p = winP ?? 0.5;
  const teamAvg = allies.reduce((s, x) => s + x.netWorth, 0) / Math.max(1, allies.length);
  const myShare = teamAvg > 0 ? me.netWorth / teamAvg : 1;
  const myLane = lanes.find((l) => l.color === me.lane) ?? null;
  const why: string[] = [];
  const plan = (action: MacroAction, title: string, detail: string, lane: LaneState | null = null): MacroPlan => ({ action, title, detail, why, lane, lanes });

  // lane to hit: where the enemy is closest to losing the next objective, prefer
  // lanes whose laners are dead
  const pushLane = [...lanes].sort(
    (a, b) => b.enemyStage - a.enemyStage + (b.enemyLaners.filter((x) => x.dead).length - a.enemyLaners.filter((x) => x.dead).length) * 0.6 || b.enemyStage - b.ourStage - (a.enemyStage - a.ourStage),
  )[0];
  const threatened = [...lanes].filter((l) => l.ourStage > l.enemyStage).sort((a, b) => b.ourStage - a.ourStage)[0];
  const nextObj = (l: LaneState) => STAGE_NAME[Math.min(3, l.enemyStage)];

  // 1) numbers windows
  if (-numbers >= 2 && deadEnemies.length >= 2) {
    // the window closes when the *first* of them is back, not the last
    const shortest = Math.min(...deadEnemies.map(real));
    const longest = Math.max(...deadEnemies.map(real));
    why.push(`${deadEnemies.length} musuh mati (hidup lagi mulai jam ${clockIn(shortest)})`);
    const until = t + delayS + shortest;
    if (pushLane) {
      return {
        ...plan(
          "push",
          `Push ${pushLane.name} sampai ${clockIn(shortest)}`,
          `${deadEnemies.map((x) => heroName(x.heroId)).join(", ")} mati. Hancurkan ${nextObj(pushLane)} di lane ${pushLane.name}; mundur di jam game ${clockIn(shortest)} (semua hidup lagi ${clockIn(longest)}). Lewat jam itu: abaikan saran ini.`,
          pushLane,
        ),
        until,
        urgent: true,
      };
    }
    return { ...plan("push", `Push sampai ${clockIn(shortest)}`, `${deadEnemies.length} musuh mati: ambil objektif terdekat bersama tim, mundur di jam game ${clockIn(shortest)}.`), until, urgent: true };
  }
  if (numbers >= 2 && deadAllies.length >= 2) {
    const back = Math.max(...deadAllies.map(real));
    why.push(`${deadAllies.length} teman mati (hidup lagi ±${clockIn(back)})`);
    const l = threatened ?? myLane;
    return {
      ...plan(
        "defend",
        l ? `Jaga ${l.name} sampai ${clockIn(back)}` : `Bertahan sampai ${clockIn(back)}`,
        `Kalah jumlah. Clear wave di bawah ${l ? STAGE_NAME[Math.min(3, l.ourStage)] : "tower"} kamu, jangan fight sampai jam game ${clockIn(back)} (teman hidup lagi).`,
        l,
      ),
      until: t + delayS + back,
      urgent: true,
    };
  }

  // 2) laning phase
  const guardiansUp = myLane ? myLane.ourStage === 0 && myLane.enemyStage === 0 : t < 540;
  if (t < 600 && guardiansUp) {
    const opp = myLane?.enemyLaners ?? [];
    const oppPlayers = enemies.filter((e) => e.lane === me.lane);
    const oppNw = oppPlayers.length ? oppPlayers.reduce((s, x) => s + x.netWorth, 0) / oppPlayers.length : null;
    if (opp.length && opp.every((x) => x.dead)) {
      why.push("lawan lane mati");
      return plan("push", "Dorong wave ke Guardian lawan", "Lawan lane kamu mati: push wave sampai Guardian, ambil orb, lalu kembali ke posisi aman sebelum dia respawn.", myLane);
    }
    if (oppNw != null && me.netWorth - oppNw <= -1500) {
      why.push(`tertinggal ${k(oppNw - me.netWorth)} dari lawan lane`);
      return plan(
        "farm",
        "Lane: farm aman",
        "Last-hit dari belakang wave, ambil camp jungle terdekat saat wave masih jauh, jangan trade. Tujuannya menyamakan souls, bukan kill.",
        myLane,
      );
    }
    const freeNeighbour = lanes.find((l) => l.color !== me.lane && l.enemyLaners.length > 0 && l.enemyLaners.every((x) => x.dead));
    if (freeNeighbour && oppNw != null && me.netWorth >= oppNw) {
      why.push(`lawan lane ${freeNeighbour.name} mati`);
      return plan("push", `Bantu ${freeNeighbour.name}`, `Lawan di lane ${freeNeighbour.name} mati semua. Kalau wave kamu aman, rotasi untuk bantu push Guardian di sana.`, freeNeighbour);
    }
    return plan("lane", "Tetap di lane", "Fase lane: last-hit, deny orb, trade saat ability utama lawan cooldown. Jangan roaming kecuali ada lawan lane lain yang mati.", myLane);
  }

  // 3) our base is open somewhere → that lane decides the game
  if (threatened && threatened.ourStage >= 2) {
    why.push(`${STAGE_NAME[threatened.ourStage - 1]} ${threatened.name} sudah hancur`);
    return plan(
      "defend",
      `Jaga ${threatened.name}`,
      `Base kamu terbuka di ${threatened.name}. Farm wave di lane itu dulu sebelum jungle jauh; satu wave yang lolos bisa memberi lawan Base Guardian.`,
      threatened,
    );
  }

  // 4) economy + win probability
  if (p >= 0.62) {
    why.push(`peluang menang ${Math.round(p * 100)}%`);
    if (scalingDiff < -0.01) {
      why.push("lawan lebih kuat di late");
      return plan(
        "siege",
        pushLane ? `Tutup game: tekan ${pushLane.name}` : "Tutup game sekarang",
        `Unggul tapi lawan menang kalau game panjang. Main bareng tim, paksa ${pushLane ? `${nextObj(pushLane)} ${pushLane.name}` : "objektif"} setiap ada 1 musuh mati.`,
        pushLane ?? null,
      );
    }
    if (myShare >= 1.25) {
      why.push(`souls kamu ${Math.round(myShare * 100)}% rata-rata tim`);
      return plan("carry", "Kamu win condition: jangan mati", "Tetap dekat tim, ambil fight hanya kalau tim lengkap. Satu kematian kamu di sini = momentum lawan.", null);
    }
    return plan(
      "siege",
      pushLane ? `Tekan ${pushLane.name} bareng tim` : "Tekan objektif",
      `Unggul dan tidak kalah scaling. Push lane ${pushLane?.name ?? "terdekat"} bersama tim, sisanya farm wave di lane lain supaya tekanan merata.`,
      pushLane ?? null,
    );
  }
  if (p <= 0.4) {
    why.push(`peluang menang ${Math.round(p * 100)}%`);
    const safe = [...lanes].sort(
      (a, b) => b.enemyLaners.filter((x) => x.dead).length - a.enemyLaners.filter((x) => x.dead).length || Math.abs(a.ourStage - a.enemyStage) - Math.abs(b.ourStage - b.enemyStage),
    )[0];
    if (scalingDiff > 0.01) {
      why.push("tim kamu lebih kuat di late");
      return plan(
        "farm",
        "Farm aman, tunggu power spike",
        `Tertinggal tapi lineup kamu menang late. Farm wave dan camp di sisi sendiri${safe ? ` (lane ${safe.name} paling aman)` : ""}, hindari fight 6v6, datang hanya untuk defend.`,
        safe ?? null,
      );
    }
    if (threatened) {
      return plan("defend", `Jaga ${threatened.name}`, `Tertinggal dan lane ${threatened.name} ditekan. Tahan wave di sana, cari pick-off saat lawan push terlalu dalam.`, threatened);
    }
    return plan("farm", "Farm + cari pick-off", "Tertinggal dan lawan tidak kalah scaling: farm efisien di sisi sendiri, gabung tim hanya untuk fight dengan jumlah unggul.", safe ?? null);
  }

  // 5) even game: personal economy decides
  if (myShare <= 0.8) {
    why.push(`souls kamu ${Math.round(myShare * 100)}% rata-rata tim`);
    // safest souls: lanes whose enemy laners are dead, then lanes that are even (waves meet mid-lane)
    const lane = [...lanes].sort(
      (a, b) =>
        b.enemyLaners.filter((x) => x.dead).length - a.enemyLaners.filter((x) => x.dead).length ||
        Math.abs(a.ourStage - a.enemyStage) - Math.abs(b.ourStage - b.enemyStage),
    )[0];
    return plan("farm", "Kejar souls dulu", `Kamu paling miskin di tim. Ambil wave ${lane ? `lane ${lane.name}` : "yang kosong"} dan camp jungle terdekat sampai item berikutnya, baru gabung.`, lane ?? null);
  }
  if (threatened) {
    why.push(`lane ${threatened.name} ditekan`);
    return plan("defend", `Tahan ${threatened.name}`, `Game seimbang tapi ${threatened.name} tertinggal satu objektif. Clear wave di sana sebelum ikut fight.`, threatened);
  }
  return plan("group", "Gabung tim, kontrol jungle tengah", "Game seimbang: bergerak bareng tim, farm camp sambil tunggu lawan muncul, ambil fight saat ada yang terpisah.", null);
}
