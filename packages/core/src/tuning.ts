/**
 * Every hand-picked number behind the build recommendations, in one place.
 *
 * None of these are fitted to real matches yet ("unverified"): they are starting points.
 * `scripts/core-robustness.mts` shows how much the core build moves when the core weights
 * change, and `calibrate()` (matchlog.ts) is where they get checked against the matches
 * Faris actually played. Change a value here, not inside the modules.
 */

/** Core build score: score = pickWeight·√pickShare + (adjWR − baseWR)·n/(n+shrinkN) */
export const CORE_TUNING = {
  /** weight of popularity vs. the win-rate edge */
  pickWeight: 0.06,
  /** shrinkage of the WR edge towards 0 (bigger = trusts small samples less) */
  shrinkN: 200,
  /** an item needs this many matches in its modal phase … */
  minMatches: 30,
  /** … and this share of the hero's players */
  minPickShare: 0.03,
} as const;

export type CoreTuning = { -readonly [K in keyof typeof CORE_TUNING]: number };

/** Enemy-driven needs (adaptive.ts findNeeds / adaptivePath). */
export const NEED_TUNING = {
  /** below this urgency a need does not get a flex slot */
  minUrgency: 0.35,
  /** at/above this the answer goes in front of the next core item */
  urgent: 0.6,
  /** at/above this a locked target is dropped for the answer */
  switchUrgency: 0.8,
  /** one damage type must be at least this share of enemy damage to ask for resist */
  damageDominance: 0.6,
  /** total resist % an owned set needs before the resist need counts as answered */
  resistAnswered: 15,
  /** a resist item must give at least this % to count as "the point of the item" */
  resistItemMin: 12,
} as const;

/**
 * Full-build audit (adaptive.ts buildAudit): swap an owned item for a better one.
 * Win-rate points are fractions (0.02 = 2 WR points).
 */
export const AUDIT_TUNING = {
  /** the new item must beat the owned one by this much (vs the lineup + on this hero) */
  margin: 0.02,
  /** core items are sold last: they need this multiple of the margin */
  coreMarginFactor: 2,
  /** the owned item needs evidence it is weak: its own value must be below this */
  weakBelow: 0.005,
  /** at most this many swaps are suggested at once */
  maxSwaps: 2,
} as const;
