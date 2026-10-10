import type { DeadlockClient, FetchInit, Query } from "./api";
import { scoreCounterItems, type CounterItem } from "./counter";
import { winrate } from "./stats";
import { CORE_TUNING, type CoreTuning } from "./tuning";
import type { Item, ItemFlowStats, ItemSlotType, ItemStats } from "./types";

/**
 * Game phases used to turn "a bag of good items" into an ordered buy plan.
 *
 *   Early      0–10 min   lane, T1/T2
 *   Mid       10–20 min   first T3s, mid boss fights
 *   Late      20–30 min   T3/T4 core
 *   Very late 30 min+     T4 luxury, final slots
 *
 * `budget` is the extra souls you typically spend inside the phase (net worth at the
 * end of the phase minus at its start, ranked-average). It only caps how many items a
 * phase can hold; the data (buy-time windows) decides *which* items.
 */
export type GamePhase = "early" | "mid" | "late" | "vlate";

export interface PhaseDef {
  key: GamePhase;
  label: string;
  fromS: number;
  toS: number | null;
  budget: number;
  maxItems: number;
}

export const GAME_PHASES: PhaseDef[] = [
  { key: "early", label: "Early", fromS: 0, toS: 600, budget: 10_000, maxItems: 5 },
  { key: "mid", label: "Mid", fromS: 600, toS: 1200, budget: 15_000, maxItems: 4 },
  { key: "late", label: "Late", fromS: 1200, toS: 1800, budget: 17_000, maxItems: 4 },
  { key: "vlate", label: "Very Late", fromS: 1800, toS: null, budget: 40_000, maxItems: 3 },
];

export const phaseRange = (p: PhaseDef) => (p.toS == null ? `${p.fromS / 60}m+` : `${p.fromS / 60}–${p.toS / 60}m`);

export interface PhaseCandidate {
  itemId: number;
  /** ranking score inside the phase (higher = buy first) */
  score: number;
  cost: number;
  tier: number;
  slot: ItemSlotType | null;
  matches: number;
}

export interface PlanStep extends PhaseCandidate {
  /** 1-based global buy order */
  order: number;
  phase: GamePhase;
  /** souls spent on the plan up to and including this item */
  cumulativeCost: number;
}

export interface PhasePlan {
  phase: PhaseDef;
  steps: PlanStep[];
  /** strong candidates that did not fit (swap options) */
  alternatives: PhaseCandidate[];
}

/**
 * Greedy plan: walk the phases in order, take the best unused candidates until the
 * phase's item cap or soul budget is hit (a phase always gets at least one item if it
 * has a candidate). Inside a phase, cheaper tiers go first because you can afford them
 * sooner; ties keep score order.
 */
export function planPhases(candidates: Map<GamePhase, PhaseCandidate[]>, opts: { maxTotal?: number; minScore?: number } = {}): PhasePlan[] {
  const used = new Set<number>();
  const maxTotal = opts.maxTotal ?? 16;
  const minScore = opts.minScore ?? 0;
  let order = 0;
  let cumulative = 0;
  const out: PhasePlan[] = [];

  for (const phase of GAME_PHASES) {
    const list = (candidates.get(phase.key) ?? []).filter((c) => !used.has(c.itemId) && c.score > minScore).sort((a, b) => b.score - a.score);
    const picked: PhaseCandidate[] = [];
    let spent = 0;
    for (const c of list) {
      if (order + picked.length >= maxTotal || picked.length >= phase.maxItems) break;
      if (picked.length > 0 && spent + c.cost > phase.budget) continue;
      picked.push(c);
      spent += c.cost;
    }
    picked.forEach((c) => used.add(c.itemId));
    picked.sort((a, b) => a.tier - b.tier || b.score - a.score);
    const steps = picked.map((c) => {
      cumulative += c.cost;
      return { ...c, order: ++order, phase: phase.key, cumulativeCost: cumulative };
    });
    out.push({ phase, steps, alternatives: list.filter((c) => !used.has(c.itemId)).slice(0, 3) });
  }
  return out;
}

export function planToText(plan: PhasePlan[], name: (id: number) => string): string {
  return plan
    .filter((p) => p.steps.length)
    .map((p) => `${p.phase.label} (${phaseRange(p.phase)}): ${p.steps.map((s) => name(s.itemId)).join(" > ")}`)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Counter items per phase
// ---------------------------------------------------------------------------

export interface PhaseCounterResult {
  /** counter score per phase, from items bought inside that phase's time window */
  byPhase: Map<GamePhase, CounterItem[]>;
  plan: PhasePlan[];
  /** items that do clearly worse vs this lineup in the phase they are bought */
  avoid: (CounterItem & { phase: GamePhase })[];
  /** match-weighted merge of all phases, per slot (for the "all items" view) */
  bySlot: Record<ItemSlotType, CounterItem[]>;
  coveredEnemies: number[];
}

async function limited<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const out: T[] = new Array(tasks.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, async () => {
      while (next < tasks.length) {
        const i = next++;
        out[i] = await tasks[i]();
      }
    }),
  );
  return out;
}

/**
 * Counter score per phase. For each phase we only count purchases made inside its
 * time window (`min/max_bought_at_s`), so "Spirit Shredder bought before 10 min vs
 * this lineup" is scored separately from the same item bought at 35 min.
 * Cost: 4 × (1 + enemies) analytics calls, max 8 in flight.
 */
export interface PhaseCounterRows {
  enemies: number[];
  /** per phase: [baseline, ...perEnemy] */
  rows: ItemStats[][];
}

/** The 4 × (1 + enemies) item-stats calls behind the phase counter (cache this). */
export async function fetchPhaseCounterRows(
  client: DeadlockClient,
  opts: { heroId?: number; enemyHeroIds: number[]; minAverageBadge?: number; minUnixTimestamp?: number },
  init?: FetchInit,
): Promise<PhaseCounterRows> {
  const enemies = [...new Set(opts.enemyHeroIds)].filter((id) => id !== opts.heroId).slice(0, 6);
  const common: Query = {
    hero_id: opts.heroId,
    min_average_badge: opts.minAverageBadge,
    min_unix_timestamp: opts.minUnixTimestamp,
    min_matches: 20,
  };
  const tasks: (() => Promise<ItemStats[]>)[] = [];
  for (const p of GAME_PHASES) {
    const win: Query = { ...common, min_bought_at_s: p.fromS || undefined, max_bought_at_s: p.toS ?? undefined };
    tasks.push(() => client.itemStats(win, init));
    for (const e of enemies) tasks.push(() => client.itemStats({ ...win, enemy_hero_ids: String(e) }, init).catch(() => []));
  }
  return { enemies, rows: await limited(tasks, 8) };
}

export async function getPhaseCounterItems(
  client: DeadlockClient,
  allItems: Item[],
  opts: { heroId?: number; enemyHeroIds: number[]; minAverageBadge?: number; minUnixTimestamp?: number; enemyWeights?: Map<number, number> },
  init?: FetchInit,
): Promise<PhaseCounterResult> {
  return scorePhaseCounter(await fetchPhaseCounterRows(client, opts, init), allItems, opts.enemyWeights);
}

/** Scoring part of the phase counter; cheap, so live weights can change every call. */
export function scorePhaseCounter(data: PhaseCounterRows, allItems: Item[], enemyWeights?: Map<number, number>): PhaseCounterResult {
  const { enemies } = data;
  const rows = data.rows;
  const opts = { enemyWeights };
  const shop = new Map(
    allItems.filter((it) => it.type === "upgrade" && it.shopable && !it.disabled && it.item_slot_type).map((it) => [it.id, it]),
  );

  const byPhase = new Map<GamePhase, CounterItem[]>();
  const candidates = new Map<GamePhase, PhaseCandidate[]>();
  const avoid: (CounterItem & { phase: GamePhase })[] = [];
  const stride = 1 + enemies.length;

  GAME_PHASES.forEach((p, pi) => {
    const baseline = rows[pi * stride];
    const perEnemy = new Map<number, ItemStats[]>();
    enemies.forEach((e, ei) => perEnemy.set(e, rows[pi * stride + 1 + ei]));
    // phases have fewer samples than the whole game → a bit more shrinkage
    const scored = scoreCounterItems(baseline, perEnemy, 200, opts.enemyWeights).filter((c) => shop.has(c.itemId));
    byPhase.set(p.key, scored);

    // only items that are actually bought in this window (≥0.5% of the phase's purchases)
    const total = baseline.reduce((s, r) => s + r.matches, 0);
    const common = scored.filter((c) => c.baselineMatches >= Math.max(40, total * 0.005));
    candidates.set(
      p.key,
      common.map((c) => {
        const it = shop.get(c.itemId)!;
        return { itemId: c.itemId, score: c.score, cost: it.cost ?? 0, tier: it.item_tier ?? 0, slot: it.item_slot_type ?? null, matches: c.baselineMatches };
      }),
    );
    for (const c of common) if (c.score < -0.01) avoid.push({ ...c, phase: p.key });
  });

  const plan = planPhases(candidates, { minScore: 0.002 });

  // merge phases → one score per item, weighted by matches
  const merged = new Map<number, { num: number; den: number; first: CounterItem }>();
  for (const list of byPhase.values())
    for (const c of list) {
      const m = merged.get(c.itemId) ?? { num: 0, den: 0, first: c };
      const w = Math.sqrt(c.baselineMatches);
      m.num += c.score * w;
      m.den += w;
      merged.set(c.itemId, m);
    }
  const all = [...merged.values()].map((m) => ({ ...m.first, score: m.den ? m.num / m.den : 0 })).sort((a, b) => b.score - a.score);
  const bySlot: Record<ItemSlotType, CounterItem[]> = { weapon: [], spirit: [], vitality: [] };
  for (const c of all) bySlot[shop.get(c.itemId)!.item_slot_type!].push(c);

  avoid.sort((a, b) => a.score - b.score);
  // never tell the user to avoid something the plan tells them to buy
  const seen = new Set<number>(plan.flatMap((p) => p.steps.map((s) => s.itemId)));
  return {
    byPhase,
    plan,
    avoid: avoid.filter((a) => !seen.has(a.itemId) && seen.add(a.itemId)).slice(0, 8),
    bySlot,
    coveredEnemies: enemies,
  };
}

// ---------------------------------------------------------------------------
// Hero build per phase from item-flow-stats
// ---------------------------------------------------------------------------

export interface FlowPhaseItem {
  itemId: number;
  /** phase where most purchases of this item happen */
  phase: GamePhase;
  matches: number;
  /** share of the hero's players that buy it in that phase */
  pickShare: number;
  /** net-worth-adjusted WR in that phase */
  adjustedWr: number;
  avgNetWorthAtBuy: number;
}

export interface FlowPhasePlan {
  baselineWr: number;
  matches: number;
  plan: PhasePlan[];
  /** every item's modal phase, for tagging recommendations */
  items: Record<number, FlowPhaseItem>;
  /** typical net worth at the end of each phase (from buy-time net worth) */
  netWorthByPhase: Record<GamePhase, number>;
}

const phaseOfSecond = (s: number): GamePhase => GAME_PHASES.find((p) => p.toS == null || s < p.toS)!.key;

/**
 * Core build per phase. An item is a candidate only in its *modal* phase (where most
 * people buy it), ranked by popularity plus its net-worth-adjusted WR edge:
 *
 *   score = pickWeight·√pickShare + (adjWR − baseWR)·n/(n+shrinkN)     (CORE_TUNING)
 *
 * so a near-universal core item (pick 60% → +0.046) still beats a niche item with a
 * lucky +3% WR on 80 matches (+0.009 shrunk), but between two common items the one
 * that wins more goes first.
 */
export function flowPhasePlan(flow: ItemFlowStats, phaseSeconds: number, allItems: Item[] | Map<number, Item>, tuning: Partial<CoreTuning> = {}): FlowPhasePlan {
  const tn: CoreTuning = { ...CORE_TUNING, ...tuning };
  const items = allItems instanceof Map ? allItems : new Map(allItems.map((i) => [i.id, i]));
  const baselineWr = winrate(flow.summary.wins, flow.summary.matches);
  const players = flow.summary.players || flow.summary.matches || 1;

  type Agg = { matches: number; wrNum: number; nwNum: number };
  const agg = new Map<number, Map<GamePhase, Agg>>();
  const nwPhase = new Map<GamePhase, { num: number; den: number; max: number }>();
  for (const n of flow.nodes) {
    const it = items.get(n.item_id);
    if (!it || it.type !== "upgrade" || !it.shopable || it.disabled) continue;
    const ph = phaseOfSecond(n.column * phaseSeconds);
    const byPh = agg.get(n.item_id) ?? new Map<GamePhase, Agg>();
    const a = byPh.get(ph) ?? { matches: 0, wrNum: 0, nwNum: 0 };
    a.matches += n.matches;
    a.wrNum += n.adjusted_win_rate * n.matches;
    a.nwNum += n.avg_net_worth_at_buy * n.matches;
    byPh.set(ph, a);
    agg.set(n.item_id, byPh);
    const w = nwPhase.get(ph) ?? { num: 0, den: 0, max: 0 };
    w.num += n.avg_net_worth_at_buy * n.matches;
    w.den += n.matches;
    w.max = Math.max(w.max, n.avg_net_worth_at_buy);
    nwPhase.set(ph, w);
  }

  const out: Record<number, FlowPhaseItem> = {};
  const candidates = new Map<GamePhase, PhaseCandidate[]>();
  for (const [itemId, byPh] of agg) {
    let best: [GamePhase, Agg] | null = null;
    for (const e of byPh) if (!best || e[1].matches > best[1].matches) best = e;
    if (!best) continue;
    const [ph, a] = best;
    const it = items.get(itemId)!;
    const fi: FlowPhaseItem = {
      itemId,
      phase: ph,
      matches: a.matches,
      pickShare: a.matches / players,
      adjustedWr: a.wrNum / a.matches,
      avgNetWorthAtBuy: a.nwNum / a.matches,
    };
    out[itemId] = fi;
    if (a.matches < tn.minMatches || fi.pickShare < tn.minPickShare) continue;
    const score = tn.pickWeight * Math.sqrt(fi.pickShare) + (fi.adjustedWr - baselineWr) * (a.matches / (a.matches + tn.shrinkN));
    const list = candidates.get(ph) ?? [];
    list.push({ itemId, score, cost: it.cost ?? 0, tier: it.item_tier ?? 0, slot: it.item_slot_type ?? null, matches: a.matches });
    candidates.set(ph, list);
  }

  // end-of-phase net worth ≈ the richest buy-time average seen in that phase
  const netWorthByPhase = {} as Record<GamePhase, number>;
  let prev = 0;
  for (const p of GAME_PHASES) {
    const w = nwPhase.get(p.key);
    const v = w ? Math.max(prev, Math.round(w.max / 500) * 500) : prev + p.budget;
    netWorthByPhase[p.key] = v;
    prev = v;
  }

  return { baselineWr, matches: flow.summary.matches, plan: planPhases(candidates, { minScore: -1 }), items: out, netWorthByPhase };
}

/** Which phase a given net worth falls into, using a hero's typical net worth curve. */
export function phaseForSouls(souls: number, netWorthByPhase: Record<GamePhase, number>): GamePhase {
  for (const p of GAME_PHASES) if (souls <= netWorthByPhase[p.key]) return p.key;
  return "vlate";
}

// ---------------------------------------------------------------------------
// Pre-game: hero core build adapted to an enemy lineup
// ---------------------------------------------------------------------------

export interface AdaptedStep {
  itemId: number;
  kind: "core" | "flex";
  /** counter score vs the lineup in this phase (if known) */
  score: number | null;
  reason: string;
  /** core item this flex replaces */
  replaces?: number;
}

export interface AdaptedPhase {
  phase: PhaseDef;
  steps: AdaptedStep[];
}

const FLEX_PER_PHASE: Record<GamePhase, number> = { early: 1, mid: 2, late: 2, vlate: 2 };
const TIER_CAP_PHASE: Record<GamePhase, number> = { early: 2, mid: 3, late: 4, vlate: 4 };
const TIER_FLOOR_PHASE: Record<GamePhase, number> = { early: 1, mid: 2, late: 3, vlate: 3 };

/**
 * Keeps the hero's core order and swaps a few items per phase for the strongest
 * counters vs this lineup (bought in that phase). A core item is swapped out first if
 * it performs clearly worse vs the lineup; otherwise the weakest core item of the same
 * slot (then any slot) makes room. Counters need ≥ +1.2 WR points to earn a slot.
 */
export function adaptCoreToLineup(
  core: FlowPhasePlan,
  counter: PhaseCounterResult,
  items: Map<number, Item>,
  heroName: (id: number) => string,
  minScore = 0.012,
): AdaptedPhase[] {
  const coreIds = new Set(core.plan.flatMap((p) => p.steps.map((s) => s.itemId)));
  const used = new Set<number>(coreIds);
  const pts = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
  return core.plan.map((p) => {
    const scored = new Map((counter.byPhase.get(p.phase.key) ?? []).map((c) => [c.itemId, c]));
    const steps: AdaptedStep[] = p.steps.map((s) => {
      const c = scored.get(s.itemId);
      const fi = core.items[s.itemId];
      return {
        itemId: s.itemId,
        kind: "core",
        score: c ? c.score : null,
        reason: fi ? `core · dibeli ${(fi.pickShare * 100).toFixed(0)}% pemain${c && Math.abs(c.score) >= 0.005 ? ` · vs lineup ${pts(c.score)}` : ""}` : "core",
      };
    });
    const candidates = [...scored.values()]
      .filter((c) => c.score >= minScore && !used.has(c.itemId) && (items.get(c.itemId)?.item_tier ?? 9) <= TIER_CAP_PHASE[p.phase.key] && (items.get(c.itemId)?.item_tier ?? 0) >= TIER_FLOOR_PHASE[p.phase.key])
      .sort((a, b) => b.score - a.score)
      .slice(0, FLEX_PER_PHASE[p.phase.key]);
    for (const c of candidates) {
      const slot = items.get(c.itemId)?.item_slot_type;
      const swappable = steps
        .map((s, i) => ({ s, i }))
        .filter(({ s }) => s.kind === "core")
        .sort((a, b) => {
          const sa = a.s.score ?? 0;
          const sb = b.s.score ?? 0;
          const slotA = items.get(a.s.itemId)?.item_slot_type === slot ? -0.004 : 0;
          const slotB = items.get(b.s.itemId)?.item_slot_type === slot ? -0.004 : 0;
          return sa + slotA - (sb + slotB);
        });
      const victim = swappable[0];
      // only swap if the counter is clearly better than what it replaces
      if (!victim || c.score - (victim.s.score ?? 0) < minScore) continue;
      const top = c.perEnemy[0];
      used.add(c.itemId);
      steps[victim.i] = {
        itemId: c.itemId,
        kind: "flex",
        score: c.score,
        replaces: victim.s.itemId,
        reason: `flex vs lineup ${pts(c.score)}${top && top.delta > 0.005 ? ` (terutama vs ${heroName(top.enemyHeroId)} ${pts(top.delta)})` : ""}`,
      };
    }
    return { phase: p.phase, steps };
  });
}
