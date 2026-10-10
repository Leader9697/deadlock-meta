/**
 * Game plan that survives the broadcast delay.
 *
 * Real-time macro calls ("push now, 2 enemies dead", "farm vs group") were stale by the
 * time they showed up (the broadcast is 1+ minute behind) and were removed. What stays
 * useful is slow information pinned to the in-game clock the player can see:
 *  - which phase each lineup is strongest in (from real match data per hero and phase),
 *  - where we are on the clock relative to that window,
 *  - the smoothed win chance (a trend over minutes, not the last pick-off).
 * The text only changes when the phase or the win band changes.
 */

import { formatClock } from "./stats";

export type PlanPhase = "early" | "mid" | "late";
export const PLAN_PHASE_END: Record<PlanPhase, number> = { early: 600, mid: 1200, late: Infinity };
const PHASE_LABEL: Record<PlanPhase, string> = { early: "early (0–10:00)", mid: "mid (10:00–20:00)", late: "late (20:00+)" };

export interface GamePlan {
  /** phase where my lineup gains most over the enemy lineup */
  ourWindow: PlanPhase;
  /** phase where the enemy lineup is strongest relative to us */
  theirWindow: PlanPhase;
  stance: "tekan" | "scale" | "tutup" | "seimbang";
  title: string;
  detail: string;
  /** in-game clock where this plan changes next (phase boundary), if any */
  untilClock: string | null;
  /** lineups are within ±0.4 WR points in every phase: no real window either way */
  flat: boolean;
}

export function gamePlan(input: {
  /** lineup strength per phase (WR points), mine vs enemy */
  mine: Record<PlanPhase, number>;
  enemy: Record<PlanPhase, number>;
  /** in-game clock now (broadcast time + delay) */
  clockS: number;
  /** smoothed win chance */
  winP: number | null;
}): GamePlan {
  const phases: PlanPhase[] = ["early", "mid", "late"];
  const edge = (ph: PlanPhase) => input.mine[ph] - input.enemy[ph];
  const ourWindow = [...phases].sort((a, b) => edge(b) - edge(a))[0];
  const theirWindow = [...phases].sort((a, b) => edge(a) - edge(b))[0];
  const spread = Math.max(...phases.map(edge)) - Math.min(...phases.map(edge));
  const flat = spread < 0.004 && phases.every((ph) => Math.abs(edge(ph)) < 0.004);
  const now: PlanPhase = input.clockS < 600 ? "early" : input.clockS < 1200 ? "mid" : "late";
  const idx = (p: PlanPhase) => phases.indexOf(p);
  const p = input.winP ?? 0.5;
  const strongNow = edge(now) > 0.005;
  const weakNow = edge(now) < -0.005;
  const end = PLAN_PHASE_END[now];
  const untilClock = Number.isFinite(end) ? formatClock(end) : null;
  const pts = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}`;

  let stance: GamePlan["stance"];
  let title: string;
  let detail: string;
  if (flat) {
    stance = "seimbang";
    title = "Lineup seimbang: main rapi";
    detail = "Kekuatan kedua lineup mirip di semua fase. Yang menentukan: farm, item tepat waktu, dan tidak mati sia-sia.";
  } else if (idx(ourWindow) > idx(now) && !strongNow) {
    // our window is still ahead: don't throw the game before it
    stance = "scale";
    title = `Main sabar sampai ${formatClock(ourWindow === "mid" ? 600 : 1200)}`;
    detail = `Lineup kamu paling kuat di ${PHASE_LABEL[ourWindow]} (${pts(edge(ourWindow))} poin vs lawan). Sebelum itu: farm, jaga tower, ambil fight hanya kalau jelas menang.`;
  } else if (ourWindow === now || strongNow) {
    stance = p < 0.4 ? "seimbang" : "tekan";
    title = untilClock ? `Window kamu: tekan sampai ${untilClock}` : "Window kamu: tekan sekarang";
    detail = `Lineup kamu unggul ${pts(edge(now))} poin di fase ini. Main bareng tim, cari objektif dan fight${untilClock ? ` sebelum ${untilClock}` : ""}.${
      p < 0.4 ? " Tapi kalian tertinggal souls: pilih fight yang aman dulu." : ""
    }`;
  } else if (idx(ourWindow) < idx(now) || weakNow) {
    // our best phase is behind us: the longer the game, the worse
    stance = p >= 0.55 ? "tutup" : "seimbang";
    title = p >= 0.55 ? "Tutup game: lawan makin kuat" : `Lawan lebih kuat di ${now}`;
    detail =
      p >= 0.55
        ? `Kamu masih unggul, tapi lineup lawan lebih kuat di ${PHASE_LABEL[theirWindow]}. Ubah lead jadi objektif sekarang, jangan farm berlama-lama.`
        : `Lineup lawan unggul ${pts(-edge(now))} poin di fase ini. Hindari fight 6v6 terbuka; cari pick-off dan main di dekat tower sendiri.`;
  } else {
    stance = "seimbang";
    title = "Seimbang: main rapi";
    detail = "Kekuatan lineup mirip di fase ini. Yang menentukan: farm, item tepat waktu, dan jangan mati sia-sia.";
  }
  return { ourWindow, theirWindow, stance, title, detail, untilClock, flat };
}
