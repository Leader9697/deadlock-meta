import type { MacroPlan } from "./macro";
import type { Tip } from "./coach";

export interface WinSmoothState {
  p: number;
  t: number;
  matchId: number | null;
}

/**
 * Exponentially smooths the win probability prediction across time,
 * avoiding rapid flickering during brief kill-trades while preserving trends.
 */
export function smoothWinProb(
  prev: WinSmoothState | null,
  raw: number | null,
  t: number,
  matchId: number | null,
  tauS = 150,
): { p: number | null; state: WinSmoothState | null } {
  if (raw == null) return { p: prev?.p ?? null, state: prev };
  if (!prev || prev.matchId !== matchId || t < prev.t) {
    const next = { p: raw, t, matchId };
    return { p: raw, state: next };
  }
  const a = 1 - Math.exp(-Math.max(0, t - prev.t) / tauS);
  const smoothed = prev.p + a * (raw - prev.p);
  const next = { p: smoothed, t, matchId };
  return { p: smoothed, state: next };
}

export interface MacroHoldState {
  plan: MacroPlan;
  since: number;
  matchId: number | null;
}

/**
 * Macro plan stabilizer: prevents non-urgent macro plans from thrashing
 * every broadcast update, holding plans for at least `holdDurationS` (default 45s).
 */
export function holdMacroPlan(
  prev: MacroHoldState | null,
  current: MacroPlan | undefined,
  t: number,
  matchId: number | null,
  lagS = 75,
  holdDurationS = 45,
): { plan: MacroPlan | undefined; state: MacroHoldState | null } {
  if (!current) return { plan: current, state: prev };
  const validPrev = prev && prev.matchId === matchId ? prev : null;
  const nowClock = t + lagS;
  const prevExpired = !!validPrev?.plan.until && nowClock > validPrev.plan.until;
  if (
    validPrev &&
    !current.urgent &&
    !prevExpired &&
    validPrev.plan.action !== current.action &&
    t - validPrev.since < holdDurationS
  ) {
    return { plan: { ...validPrev.plan, lanes: current.lanes }, state: validPrev };
  }
  const next =
    !validPrev || validPrev.plan.action !== current.action || validPrev.plan.title !== current.title
      ? { plan: current, since: t, matchId }
      : validPrev;
  return { plan: current, state: next };
}

export interface TipHoldState {
  title: string;
  priority: number;
  since: number;
}

/**
 * Prevents coaching callout flickering: top callout stays at least `minHoldMs` (default 20s)
 * unless a significantly more urgent tip (exceeding priorityThreshold) arrives.
 */
export function stabilizeTips(
  prev: TipHoldState | null,
  tips: Tip[],
  nowMs: number,
  minHoldMs = 20_000,
  priorityThreshold = 10,
): { tips: Tip[]; state: TipHoldState | null } {
  const first = tips[0];
  if (!first) return { tips, state: null };
  const keep = prev && tips.find((t) => t.title === prev.title);
  if (
    keep &&
    first.title !== keep.title &&
    nowMs - prev.since < minHoldMs &&
    first.priority < prev.priority + priorityThreshold
  ) {
    return { tips: [keep, ...tips.filter((t) => t !== keep)], state: prev };
  }
  const fresh = !prev || prev.title !== first.title;
  const next = fresh ? { title: first.title, priority: first.priority, since: nowMs } : prev;
  return { tips, state: next };
}

export interface LagAnchor {
  wall: number;
  game: number;
  matchId: number | null;
}

/**
 * Measures real spectate broadcast delay by tracking drift between wall-clock time
 * and game clock since the initial match anchor.
 */
export function computeLagSeconds(
  anchor: LagAnchor | null,
  gameTimeS: number,
  matchId: number | null,
  nowMs: number,
  baseDelayS = 75,
  minDelayS = 30,
): number {
  if (!anchor || anchor.matchId !== matchId) return baseDelayS;
  const drift = (nowMs - anchor.wall) / 1000 - (gameTimeS - anchor.game);
  return Math.max(minDelayS, Math.round(baseDelayS + drift));
}

export interface PendingBuyItem {
  itemId: number;
  name: string;
  cost: number;
  atS: number;
  matchId: number | null;
}

/**
 * Filters out pending buy items that have been purchased or expired.
 */
export function filterPendingBuys(
  pending: PendingBuyItem[],
  ownedItemIds: number[],
  currentGameTimeS: number,
  currentMatchId: number | null,
  maxAgeS = 360,
): PendingBuyItem[] {
  return pending.filter(
    (p) =>
      p.matchId === currentMatchId &&
      !ownedItemIds.includes(p.itemId) &&
      currentGameTimeS - p.atS < maxAgeS,
  );
}

export interface SoulsPacing {
  current: number;
  target: number;
  delta: number;
  ratePerMin: number;
  targetPerMin: number;
  label: string;
  isAhead: boolean;
}

/**
 * Calculates laning souls pacing benchmark for real-time coaching feedback.
 * In high-level Deadlock, pacing ramps smoothly to ~9,200 souls at minute 10.
 */
export function computeSoulsPacing(
  currentSouls: number,
  gameTimeS: number,
  heroBenchmark10m?: number,
): SoulsPacing | null {
  if (gameTimeS <= 60) return null;
  const mins = gameTimeS / 60;
  const base10m = heroBenchmark10m && Number.isFinite(heroBenchmark10m)
    ? Math.max(6000, Math.min(13000, heroBenchmark10m))
    : 9200;

  let target: number;
  if (gameTimeS <= 600) {
    // Quadratic ramp during 0-10m laning phase to match creep wave value scaling
    const progress = gameTimeS / 600;
    target = Math.round(base10m * (0.6 * progress + 0.4 * progress * progress));
  } else {
    // Post-laning progression: base10m + scaling/min
    const postRate = Math.round(base10m * 0.139);
    target = Math.round(base10m + (mins - 10) * postRate);
  }

  const delta = currentSouls - target;
  const ratePerMin = Math.round(currentSouls / mins);
  const targetPerMin = Math.round(target / mins);
  const isAhead = delta >= 0;
  const deltaStr = isAhead ? `+${(delta / 1000).toFixed(1)}k` : `${(delta / 1000).toFixed(1)}k`;

  return {
    current: currentSouls,
    target,
    delta,
    ratePerMin,
    targetPerMin,
    isAhead,
    label: `Target ${(target / 1000).toFixed(1)}k (${deltaStr})`,
  };
}
