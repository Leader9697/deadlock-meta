/**
 * Draft Win Odds & Lineup Analysis.
 *
 * Estimates match win probability before economy/net-worth data exists, combining:
 * 1. Baseline Hero Win Rates in the current patch/badge (Bayesian-shrunk toward 50%)
 * 2. Head-to-Head Hero Matchups (Counter advantage)
 * 3. Team Synergy (Hero-pair winrate delta)
 * 4. Phase Curves (Early / Mid / Late win rates per team)
 */

import { shrink } from "./stats";
import type { HeroCounterStats, HeroSynergyStats } from "./types";
import type { HeroPhases, PhaseKey } from "./phases";

export interface HeroDraftStats {
  heroId: number;
  winrate: number;
  matches: number;
}

export interface DraftAdvantage {
  ourHeroId: number;
  enemyHeroId: number;
  delta: number;
  reason: string;
}

export interface DraftOddsResult {
  /** Predicted win chance for our team (0..1) */
  winProbability: number;
  /** Component point deltas */
  components: {
    heroBaseDelta: number;
    matchupDelta: number;
    synergyDelta: number;
  };
  /** Team strengths per phase: early, mid, late */
  phases: Record<PhaseKey, { mine: number; enemy: number; delta: number }>;
  /** Peak phase for our team */
  peakPhase: PhaseKey;
  /** Key notable matchup counters */
  advantages: DraftAdvantage[];
  threats: DraftAdvantage[];
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

/**
 * Calculates win odds for our lineup vs enemy lineup from hero stats,
 * counter matrix, synergies, and phase performance.
 */
export function calculateDraftOdds(input: {
  allies: number[];
  enemies: number[];
  heroStats: Map<number, HeroDraftStats>;
  counterMatrix?: HeroCounterStats[];
  synergies?: HeroSynergyStats[];
  heroPhases?: Map<number, HeroPhases>;
}): DraftOddsResult {
  const { allies, enemies, heroStats, counterMatrix = [], synergies = [], heroPhases } = input;

  // 1. Baseline Hero Win Rates (Bayesian shrink toward 0.50, k = 150)
  const allyBases = allies.map((id) => {
    const s = heroStats.get(id);
    return s && s.matches > 0 ? shrink(s.winrate * s.matches, s.matches, 0.5, 150) : 0.5;
  });
  const enemyBases = enemies.map((id) => {
    const s = heroStats.get(id);
    return s && s.matches > 0 ? shrink(s.winrate * s.matches, s.matches, 0.5, 150) : 0.5;
  });

  const allyAvg = allyBases.length ? allyBases.reduce((a, b) => a + b, 0) / allyBases.length : 0.5;
  const enemyAvg = enemyBases.length ? enemyBases.reduce((a, b) => a + b, 0) / enemyBases.length : 0.5;
  const heroBaseDelta = allyAvg - enemyAvg;

  // 2. Head-to-Head Matchup Matrix (Allies vs Enemies)
  const counterMap = new Map<string, { wins: number; matches: number }>();
  for (const r of counterMatrix) {
    counterMap.set(`${r.hero_id}:${r.enemy_hero_id}`, { wins: r.wins, matches: r.matches_played });
  }

  let totalMatchupDelta = 0;
  let matchupPairsCount = 0;
  const advantages: DraftAdvantage[] = [];
  const threats: DraftAdvantage[] = [];

  for (const a of allies) {
    const aWr = heroStats.get(a)?.winrate ?? 0.5;
    for (const e of enemies) {
      let pair = counterMap.get(`${a}:${e}`);
      let reversed = false;
      if (!pair) {
        const rev = counterMap.get(`${e}:${a}`);
        if (rev) {
          pair = { wins: rev.matches - rev.wins, matches: rev.matches };
          reversed = true;
        }
      }
      if (pair && pair.matches >= 20) {
        // Delta relative to hero baseline winrate, shrunk with k=100
        const matchupWr = shrink(pair.wins, pair.matches, aWr, 100);
        const delta = matchupWr - aWr;
        totalMatchupDelta += delta;
        matchupPairsCount++;

        if (delta >= 0.02) {
          advantages.push({ ourHeroId: a, enemyHeroId: e, delta, reason: `Keunggulan matchup (+${(delta * 100).toFixed(1)}%)` });
        } else if (delta <= -0.02) {
          threats.push({ ourHeroId: a, enemyHeroId: e, delta, reason: `Matchup berat (${(delta * 100).toFixed(1)}%)` });
        }
      }
    }
  }

  const matchupDelta = matchupPairsCount > 0 ? totalMatchupDelta / matchupPairsCount : 0;
  advantages.sort((x, y) => y.delta - x.delta);
  threats.sort((x, y) => x.delta - y.delta);

  // 3. Team Synergies (Duo winrates within own team vs enemy team)
  const synMap = new Map<string, { wins: number; matches: number }>();
  for (const s of synergies) {
    const k1 = `${s.hero_id1}:${s.hero_id2}`;
    const k2 = `${s.hero_id2}:${s.hero_id1}`;
    synMap.set(k1, { wins: s.wins, matches: s.matches_played });
    synMap.set(k2, { wins: s.wins, matches: s.matches_played });
  }

  const teamSynergy = (team: number[]) => {
    let sum = 0;
    let count = 0;
    for (let i = 0; i < team.length; i++) {
      const h1 = team[i];
      const wr1 = heroStats.get(h1)?.winrate ?? 0.5;
      for (let j = i + 1; j < team.length; j++) {
        const h2 = team[j];
        const pair = synMap.get(`${h1}:${h2}`);
        if (pair && pair.matches >= 20) {
          const pairWr = shrink(pair.wins, pair.matches, wr1, 100);
          sum += pairWr - wr1;
          count++;
        }
      }
    }
    return count > 0 ? sum / count : 0;
  };

  const allySyn = teamSynergy(allies);
  const enemySyn = teamSynergy(enemies);
  const synergyDelta = allySyn - enemySyn;

  // 4. Combined Draft Win Probability (Logistic regression scale)
  // Scaling constant: delta of +5% (+0.05) yields ~60% probability.
  // z = 8.0 * (0.45 * heroBaseDelta + 0.40 * matchupDelta + 0.15 * synergyDelta)
  const compositeScore = 0.45 * heroBaseDelta + 0.4 * matchupDelta + 0.15 * synergyDelta;
  const z = compositeScore * 8.0;
  const winProbability = Math.min(0.92, Math.max(0.08, sigmoid(z)));

  // 5. Team Phase Curves (Early / Mid / Late)
  const phaseList: PhaseKey[] = ["early", "mid", "late"];
  const phasesOut = {} as Record<PhaseKey, { mine: number; enemy: number; delta: number }>;
  let bestPhase: PhaseKey = "mid";
  let maxPhaseDelta = -Infinity;

  for (const ph of phaseList) {
    const allyPh = allies.map((id) => heroPhases?.get(id)?.phases[ph]?.winrate ?? 0.5);
    const enemyPh = enemies.map((id) => heroPhases?.get(id)?.phases[ph]?.winrate ?? 0.5);
    const mine = allyPh.length ? allyPh.reduce((a, b) => a + b, 0) / allyPh.length : 0.5;
    const enemy = enemyPh.length ? enemyPh.reduce((a, b) => a + b, 0) / enemyPh.length : 0.5;
    const delta = mine - enemy;
    phasesOut[ph] = { mine, enemy, delta };
    if (delta > maxPhaseDelta) {
      maxPhaseDelta = delta;
      bestPhase = ph;
    }
  }

  return {
    winProbability,
    components: { heroBaseDelta, matchupDelta, synergyDelta },
    phases: phasesOut,
    peakPhase: bestPhase,
    advantages: advantages.slice(0, 3),
    threats: threats.slice(0, 3),
  };
}
