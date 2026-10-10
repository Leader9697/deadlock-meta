import type { FlowPhasePlan, GamePhase } from "./phaseplan";
import { flowPhasePlan, GAME_PHASES } from "./phaseplan";
import { CORE_TUNING, type CoreTuning } from "./tuning";
import type { Item, ItemFlowStats } from "./types";

/**
 * "Is the recommended core robust, or does it just echo noise?"
 *
 * Two questions, both answerable from item-flow data alone:
 *   1. Stability across data: build the core from two disjoint samples of the same hero
 *      (e.g. two halves of the time window). If a real signal drives the plan, both halves
 *      pick mostly the same items. Low overlap = the plan is chasing noise.
 *   2. Sensitivity to the weights: move a tunable (pickWeight, shrinkN …) up and down. If
 *      half the plan flips for a ±50% change, the number was doing the deciding, not the data.
 */

export interface PhaseOverlap {
  phase: GamePhase;
  a: number;
  b: number;
  shared: number;
  /** |A∩B| / |A∪B|, null when both are empty */
  jaccard: number | null;
}

export interface PlanOverlap {
  phases: PhaseOverlap[];
  /** overlap of the whole plan ignoring phase (right item, wrong phase still counts) */
  overall: number | null;
  /** overlap requiring the same phase too */
  samePhase: number | null;
}

const idsOf = (p: FlowPhasePlan) => new Map(p.plan.flatMap((ph) => ph.steps.map((s) => [s.itemId, ph.phase.key] as const)));
const jaccard = (a: Set<number>, b: Set<number>) => {
  const union = new Set([...a, ...b]).size;
  if (!union) return null;
  let shared = 0;
  for (const x of a) if (b.has(x)) shared++;
  return shared / union;
};

export function planOverlap(a: FlowPhasePlan, b: FlowPhasePlan): PlanOverlap {
  const phases: PhaseOverlap[] = GAME_PHASES.map((g) => {
    const sa = new Set(a.plan.find((p) => p.phase.key === g.key)?.steps.map((s) => s.itemId) ?? []);
    const sb = new Set(b.plan.find((p) => p.phase.key === g.key)?.steps.map((s) => s.itemId) ?? []);
    let shared = 0;
    for (const x of sa) if (sb.has(x)) shared++;
    return { phase: g.key, a: sa.size, b: sb.size, shared, jaccard: jaccard(sa, sb) };
  });
  const ma = idsOf(a);
  const mb = idsOf(b);
  const overall = jaccard(new Set(ma.keys()), new Set(mb.keys()));
  const same = new Set([...ma].filter(([id, ph]) => mb.get(id) === ph).map(([id]) => id));
  const union = new Set([...ma.keys(), ...mb.keys()]).size;
  return { phases, overall, samePhase: union ? same.size / union : null };
}

/** Core built from two independent samples of the same hero, compared. */
export function coreStability(
  flowA: ItemFlowStats,
  flowB: ItemFlowStats,
  phaseSeconds: number,
  items: Item[] | Map<number, Item>,
  tuning: Partial<CoreTuning> = {},
): PlanOverlap {
  return planOverlap(flowPhasePlan(flowA, phaseSeconds, items, tuning), flowPhasePlan(flowB, phaseSeconds, items, tuning));
}

export interface SensitivityRow {
  param: keyof CoreTuning;
  value: number;
  vsBase: PlanOverlap;
}

/** How much the core changes when one tunable moves by `factors` (default ×0.5 … ×2). */
export function coreSensitivity(
  flow: ItemFlowStats,
  phaseSeconds: number,
  items: Item[] | Map<number, Item>,
  params: (keyof CoreTuning)[] = ["pickWeight", "shrinkN"],
  factors: number[] = [0.5, 0.75, 1.5, 2],
): SensitivityRow[] {
  const base = flowPhasePlan(flow, phaseSeconds, items);
  const rows: SensitivityRow[] = [];
  for (const param of params) {
    for (const f of factors) {
      const value = CORE_TUNING[param] * f;
      rows.push({ param, value, vsBase: planOverlap(base, flowPhasePlan(flow, phaseSeconds, items, { [param]: value })) });
    }
  }
  return rows;
}

/**
 * Verdict thresholds for a stability result. Two halves of the same window will never match
 * perfectly (sample noise alone), so ≥0.6 is "stable", 0.4–0.6 "partly noise", below that the
 * plan is mostly chasing noise for this hero/filter.
 */
export function stabilityVerdict(o: PlanOverlap): "stabil" | "sebagian noise" | "banyak noise" | "tidak ada data" {
  if (o.overall == null) return "tidak ada data";
  return o.overall >= 0.6 ? "stabil" : o.overall >= 0.4 ? "sebagian noise" : "banyak noise";
}
