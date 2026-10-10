/**
 * Power-spike windows. A big item (T3/T4) changes a fight for a few minutes before the
 * other side answers it. From purchase times we score how much "fresh power" each team
 * got recently and tell you when to force a fight and when to wait one out.
 *
 *   fresh(item) = tierWeight · (1 − age / WINDOW)       (T3 = 1, T4 = 2)
 *   team score  = Σ fresh over players, × the buyer's net-worth share (fed carries count more)
 *
 * Times are corrected for the broadcast delay: an item seen now was bought ~delay ago.
 */

import type { LivePlayer } from "./live";
import type { Item } from "./types";

export const SPIKE_WINDOW_S = 180;
const TIER_W: Record<number, number> = { 3: 1, 4: 2 };

export interface SpikeItem {
  accountId: number;
  heroId: number;
  itemId: number;
  name: string;
  tier: number;
  /** seconds since purchase, real time */
  age: number;
}

export interface SpikeReport {
  mine: number;
  enemy: number;
  myItems: SpikeItem[];
  enemyItems: SpikeItem[];
  /** my own most recent big item still in its window */
  self: SpikeItem | null;
  /** seconds the stronger side keeps its edge */
  windowLeft: number;
  verdict: "fight" | "avoid" | "even";
}

export function powerSpikes(players: LivePlayer[], me: LivePlayer, gameTimeS: number, items: Map<number, Item>, delayS = 75): SpikeReport {
  const now = gameTimeS + delayS;
  const nwAvg = players.reduce((s, p) => s + p.netWorth, 0) / Math.max(1, players.length);
  const collect = (ps: LivePlayer[]) => {
    const out: (SpikeItem & { w: number })[] = [];
    for (const p of ps) {
      p.itemIds.forEach((id, i) => {
        const t = p.itemTimes?.[i];
        if (t == null || t < 0) return;
        const it = items.get(id);
        const tw = TIER_W[it?.item_tier ?? 0];
        if (!it || !tw) return;
        const age = now - t;
        if (age < 0 || age > SPIKE_WINDOW_S) return;
        const share = nwAvg > 0 ? Math.min(1.8, Math.max(0.6, p.netWorth / nwAvg)) : 1;
        out.push({ accountId: p.accountId, heroId: p.heroId, itemId: id, name: it.name, tier: it.item_tier ?? 0, age, w: tw * (1 - age / SPIKE_WINDOW_S) * share });
      });
    }
    return out.sort((a, b) => b.w - a.w);
  };
  const mineL = collect(players.filter((p) => p.team === me.team));
  const enemyL = collect(players.filter((p) => p.team !== me.team));
  const mine = mineL.reduce((s, x) => s + x.w, 0);
  const enemy = enemyL.reduce((s, x) => s + x.w, 0);
  const diff = mine - enemy;
  const lead = diff >= 0 ? mineL : enemyL;
  const windowLeft = lead.length ? Math.max(0, SPIKE_WINDOW_S - Math.min(...lead.slice(0, 3).map((x) => x.age))) : 0;
  const strip = ({ w: _w, ...x }: SpikeItem & { w: number }) => x;
  const self = mineL.filter((x) => x.accountId === me.accountId).sort((a, b) => a.age - b.age)[0];
  return {
    mine,
    enemy,
    myItems: mineL.map(strip),
    enemyItems: enemyL.map(strip),
    self: self ? strip(self) : null,
    windowLeft,
    verdict: diff >= 1.6 ? "fight" : diff <= -1.6 ? "avoid" : "even",
  };
}
