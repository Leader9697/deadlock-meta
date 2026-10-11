/**
 * "What to do now": turns the live state + historical stats into a short list of
 * prioritised instructions, a build path with reasons, and per-enemy matchup notes.
 *
 * Every rule is driven by data we actually have (live broadcast + deadlock-api
 * analytics). Timers are corrected for the spectator broadcast delay.
 */

import { NEED_LABEL, phaseAt, type DamageProfile, type EnemyProfile, type Need } from "./adaptive";
import type { CounterResult } from "./counter";
import type { MacroPlan } from "./macro";
import type { GamePlan } from "./gameplan";
import { formatClock } from "./stats";
import { detectMode, type LivePlayer, type LiveState, type LiveSummary } from "./live";
import type { HeroPhases, PhaseKey } from "./phases";
import type { HeroBuild, Item } from "./types";

export type TipKind = "push" | "retreat" | "objective" | "buy" | "tempo" | "threat" | "momentum" | "farm" | "death";

export interface Tip {
  kind: TipKind;
  priority: number;
  title: string;
  detail: string;
}

export interface TeamPhaseCompare {
  mine: Record<PhaseKey, number>;
  enemy: Record<PhaseKey, number>;
  /** (my late − my early) − (enemy late − enemy early); >0 = we outscale */
  scalingDiff: number;
}

export interface BuildStep {
  itemId: number;
  name: string;
  cost: number;
  tier: number;
  slot?: string;
  missing: number;
  affordable: boolean;
  reason: string;
  /** adaptive path: core item from the hero's phase plan, or a flex answer to the enemy */
  kind?: "core" | "flex";
  phase?: string | null;
}

export interface EnemyMatchup {
  accountId: number;
  heroId: number;
  heroName: string;
  netWorth: number;
  nwDiff: number;
  kda: string;
  dead: boolean;
  respawnInS: number | null;
  matchupDelta: number | null;
  recentItems: string[];
  bestCounter: { name: string; delta: number } | null;
  verdict: "duel" | "avoid" | "even" | "dead";
  advice: string;
  /** shares my assigned lane */
  laneOpponent: boolean;
  archetypes: EnemyProfile["archetypes"];
  notable: { name: string; note: string }[];
  /** expected share of this enemy's damage that is bullets */
  bulletShare: number | null;
  /** Primary focus target in teamfights (highest threat with lowest defensive buffer) */
  isTargetPriority?: boolean;
  priorityReason?: string;
}

export interface CoachInput {
  state: LiveState;
  me: LivePlayer;
  summary: LiveSummary;
  winP: number | null;
  /** lead change over the last `seconds` (souls, my view) */
  trend: { seconds: number; leadDelta: number } | null;
  phases: Map<number, HeroPhases>;
  counter: CounterResult;
  items: Map<number, Item>;
  heroName: (id: number) => string;
  topBuild: HeroBuild | null;
  /** my hero vs enemy hero: shrunk WR delta (0.03 = +3%) */
  matchupDelta: (enemyHeroId: number) => number | null;
  /** spectator broadcast delay in seconds (Valve: ~60–90 s) */
  broadcastDelayS?: number;
  /** adaptive build path (core + flex); replaces the static build path when given */
  path?: BuildStep[];
  needs?: Need[];
  profiles?: EnemyProfile[];
  damage?: DamageProfile;
  /** situation-based farm/defend/push plan; replaces the generic tempo tips */
  macro?: MacroPlan;
  /** delay-proof plan from lineup strength per phase (replaces macro/tempo calls) */
  gamePlan?: GamePlan;
  /** real lane data: my hero (any partner) vs this enemy lane duo at sampleS */
  laneStats?: { netWorthDiff: number; winrate: number; matches: number; sampleMatches: number; sampleS: number } | null;
}

export interface CoachOutput {
  tips: Tip[];
  teamPhases: TeamPhaseCompare | null;
  buildPath: BuildStep[];
  matchups: EnemyMatchup[];
}

const k = (n: number) => `${(n / 1000).toFixed(1)}k`;
const pts = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
const secs = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}` : `${Math.round(s)} dtk`);

export function compareTeamPhases(phases: Map<number, HeroPhases>, mine: number[], enemy: number[]): TeamPhaseCompare | null {
  const avg = (ids: number[]) => {
    const hs = ids.map((id) => phases.get(id)).filter((h): h is HeroPhases => !!h);
    if (hs.length < 2) return null;
    const r = { early: 0, mid: 0, late: 0 } as Record<PhaseKey, number>;
    for (const h of hs) for (const p of ["early", "mid", "late"] as const) r[p] += h.phases[p].winrate / hs.length;
    return r;
  };
  const a = avg(mine);
  const b = avg(enemy);
  if (!a || !b) return null;
  return { mine: a, enemy: b, scalingDiff: a.late - a.early - (b.late - b.early) };
}

/** Best counter item against one enemy hero, from the per-enemy contributions. */
function bestCounterVs(counter: CounterResult, items: Map<number, Item>, heroId: number, owned: Set<number>) {
  let best: { name: string; delta: number } | null = null;
  for (const c of counter.items) {
    if (owned.has(c.itemId)) continue;
    const e = c.perEnemy.find((p) => p.enemyHeroId === heroId);
    if (e && e.delta > 0.005 && (!best || e.delta > best.delta)) best = { name: items.get(c.itemId)?.name ?? String(c.itemId), delta: e.delta };
  }
  return best;
}

export function buildPath(input: CoachInput, limit = 5): BuildStep[] {
  const { topBuild, items, me, counter, heroName } = input;
  const owned = new Set(me.itemIds);
  // Souls are spent in order: a step is affordable only if everything before it fits too.
  let remaining = me.souls ?? 0;
  const counterById = new Map(counter.items.map((c) => [c.itemId, c]));
  const out: BuildStep[] = [];
  const seen = new Set<number>();

  // same rule as the adaptive path: no cheap tiers once the game has moved on
  const floor = { early: 1, mid: 2, late: 3, vlate: 3 }[phaseAt(input.state.gameTimeS)];
  const push = (itemId: number, fallbackReason: string) => {
    const it = items.get(itemId);
    if (!it || it.type !== "upgrade" || !it.shopable || owned.has(itemId) || seen.has(itemId) || (it.item_tier ?? 0) < floor) return;
    seen.add(itemId);
    const cost = it.cost ?? 0;
    const c = counterById.get(itemId);
    const top = c?.perEnemy[0];
    const reason =
      c && c.score > 0.005 && top && top.delta > 0.005
        ? `Counter ${heroName(top.enemyHeroId)} (${pts(top.delta)})`
        : fallbackReason;
    const affordable = cost <= remaining;
    out.push({ itemId, name: it.name, cost, tier: it.item_tier ?? 0, slot: it.item_slot_type, missing: Math.max(0, cost - remaining), affordable, reason });
    remaining = affordable ? remaining - cost : 0;
  };

  for (const cat of topBuild?.details.mod_categories ?? []) {
    for (const m of cat.mods ?? []) push(m.ability_id, cat.name ? `Build: ${cat.name}` : "Build terbaik");
    if (out.length >= limit) break;
  }
  // Fill with the strongest counters if the build is short or already done.
  for (const c of counter.items) {
    if (out.length >= limit) break;
    if (c.score > 0.005) push(c.itemId, "Counter lineup");
  }
  return out.slice(0, limit);
}

const ARCH_ADVICE: Record<EnemyProfile["archetypes"][number], string> = {
  sustain: "sustain tinggi: fight singkat + anti-heal",
  tank: "tanky: jangan fokus dia, cari target lain dulu",
  slippery: "lincah: simpan slow/stun sampai dia pakai dash",
  cc: "banyak CC: jaga jarak, tunggu CC-nya habis",
};

export function enemyMatchups(input: CoachInput, delay: number): EnemyMatchup[] {
  const { summary, me, items, counter, heroName, matchupDelta } = input;
  const owned = new Set(me.itemIds);
  const prof = new Map((input.profiles ?? []).map((p) => [p.accountId, p]));
  const early = phaseAt(input.state.gameTimeS) === "early";
  const list: EnemyMatchup[] = summary.threats.map(({ player: p }) => {
    const pr = prof.get(p.accountId);
    const laneOpponent = me.lane != null && p.lane != null && me.lane === p.lane;
    const md = matchupDelta(p.heroId);
    const nwDiff = p.netWorth - me.netWorth;
    const realRespawn = p.dead && p.respawnInS != null ? Math.max(0, p.respawnInS - delay) : null;
    const score = (md ?? 0) * 100 - nwDiff / 2000;
    const verdict: EnemyMatchup["verdict"] = p.dead ? "dead" : score > 2 ? "duel" : score < -2 ? "avoid" : "even";
    const parts: string[] = [];
    if (md != null && Math.abs(md) >= 0.02) parts.push(`matchup ${md > 0 ? "menguntungkan" : "berat"} (${pts(md)})`);
    if (Math.abs(nwDiff) >= 3000) parts.push(`${nwDiff > 0 ? "lebih kaya" : "lebih miskin"} ${k(Math.abs(nwDiff))} dari kamu`);
    for (const a of pr?.archetypes ?? []) parts.push(ARCH_ADVICE[a]);
    if (laneOpponent && early) parts.unshift("lawan lane kamu");
    const lead =
      verdict === "dead"
        ? realRespawn != null && realRespawn > 0
          ? `Mati, respawn ±${secs(realRespawn)}`
          : "Mati / baru respawn"
        : verdict === "duel"
          ? "Boleh duel"
          : verdict === "avoid"
            ? "Hindari 1v1"
            : "Seimbang, main bareng tim";
    return {
      accountId: p.accountId,
      heroId: p.heroId,
      heroName: heroName(p.heroId),
      netWorth: p.netWorth,
      nwDiff,
      kda: `${p.kills}/${p.deaths}/${p.assists}`,
      dead: !!p.dead,
      respawnInS: realRespawn,
      matchupDelta: md,
      recentItems: p.itemIds.slice(-3).reverse().map((id) => items.get(id)?.name ?? `#${id}`),
      bestCounter: bestCounterVs(counter, items, p.heroId, owned),
      verdict,
      advice: parts.length ? `${lead} — ${parts.join(", ")}` : lead,
      laneOpponent,
      archetypes: pr?.archetypes ?? [],
      notable: (pr?.notable ?? []).map((n) => ({ name: n.name, note: n.note })),
      bulletShare: pr ? pr.bulletShare : null,
    };
  });

  // Calculate Primary Target Priority in teamfights:
  // Identify the highest-threat enemy that is alive and not a pure tank
  const aliveEnemies = list.filter((e) => !e.dead);
  if (aliveEnemies.length > 0) {
    // Sort by net worth descending, prioritizing squishy carries over tanks
    const target = [...aliveEnemies].sort((a, b) => {
      const aTank = a.archetypes.includes("tank") ? 1 : 0;
      const bTank = b.archetypes.includes("tank") ? 1 : 0;
      if (aTank !== bTank) return aTank - bTank; // Non-tanks prioritized
      return b.netWorth - a.netWorth; // Highest NW prioritized
    })[0];

    if (target) {
      target.isTargetPriority = true;
      target.priorityReason = target.archetypes.includes("tank")
        ? `Fokus tumbangkan bersama tim (${k(target.netWorth)} souls)`
        : `Target burst utama (Carry ${k(target.netWorth)} souls, minim defensif)`;
    }
  }

  return list;
}

export function coach(input: CoachInput): CoachOutput {
  const delay = input.broadcastDelayS ?? 75;
  const { state, me, summary, winP, trend, heroName } = input;
  const tips: Tip[] = [];

  const allies = state.players.filter((p) => p.team === me.team);
  const enemies = state.players.filter((p) => p.team !== me.team);
  const realRespawn = (p: LivePlayer) => (p.dead && p.respawnInS != null ? p.respawnInS - delay : p.dead ? 0 : -1);

  const teamPhases = compareTeamPhases(
    input.phases,
    allies.map((p) => p.heroId),
    enemies.map((p) => p.heroId),
  );
  const path = input.path ?? buildPath(input);
  const matchups = enemyMatchups(input, delay);

  if (state.winningTeam !== undefined) {
    return { tips: [], teamPhases, buildPath: path, matchups };
  }

  // --- numbers advantage from deaths (corrected for broadcast delay) ---
  const deadEnemies = enemies.filter((p) => realRespawn(p) >= 12);
  const deadAllies = allies.filter((p) => realRespawn(p) >= 12);
  const aliveEnemies = enemies.length - deadEnemies.length;
  const aliveAllies = allies.length - deadAllies.length;
  // Real-time calls from deaths ("push, 2 dead" / "retreat, 2 allies dead") and the macro
  // farm/group plan were removed: with the broadcast 1+ minute late they arrived after the
  // window had closed. The stable game plan (gameplan.ts) replaces them.
  const mode = detectMode(state);
  if (mode.isBrawl) {
    tips.push({
      kind: "tempo",
      priority: 45,
      title: "Street Brawl 4v4: Teamfight cepat",
      detail: "Draft 3 item acak per ronde. Prioritaskan item aktif & counter langsung untuk memenangkan ronde ini.",
    });
  } else if (input.gamePlan) {
    const g = input.gamePlan;
    tips.push({ kind: g.stance === "tekan" || g.stance === "tutup" ? "push" : g.stance === "scale" ? "farm" : "tempo", priority: 40, title: g.title, detail: g.detail });
  }

  // --- mid boss & objective windows ---
  if (state.midBossInS != null) {
    const real = state.midBossInS - delay;
    if (real > -30 && real < 120) {
      // spawn time as the clock the player sees (broadcast time + delay + remaining)
      const when = real > 0 ? `spawn jam ${formatClock(state.gameTimeS + delay + real)}` : "sudah spawn";
      const favoured = (winP ?? 0.5) >= 0.55;
      const behind = (winP ?? 0.5) < 0.45;
      const why = `peluang menang ${Math.round((winP ?? 0.5) * 100)}%`;
      tips.push(
        favoured
          ? { kind: "objective", priority: 80, title: `Mid boss ${when}`, detail: `Posisi kuat (${why}): kumpul di mid lebih awal, kuasai area sebelum spawn.` }
          : behind
            ? { kind: "objective", priority: 70, title: `Mid boss ${when}`, detail: "Posisi lemah: jangan contest kecuali kamu lihat sendiri 2+ musuh mati. Pakai waktu itu untuk farm/push lane lain." }
            : { kind: "objective", priority: 65, title: `Mid boss ${when}`, detail: "Seimbang: datang bersama tim, contest hanya kalau jumlah tidak kalah." },
      );
    }
  } else if (state.gameTimeS >= 600 && deadEnemies.length >= 2 && aliveAllies >= 4 && !me.dead) {
    // Window emas: musuh kalah jumlah di mid/late game saat mid-boss sudah ada di map
    tips.push({
      kind: "objective",
      priority: 85,
      title: "Mid-Boss Terbuka: Ambil Sekarang!",
      detail: `${deadEnemies.length} musuh mati dan tim kamu unggul jumlah. Paksa Mid-Boss atau hancurkan Base Guardian lawan sekarang!`,
    });
  }

  // --- laning (first 10 min): your lane opponent(s) ---
  if (phaseAt(state.gameTimeS) === "early" && me.lane != null) {
    const opp = matchups.filter((m) => m.laneOpponent);
    if (opp.length) {
      const md = opp.map((m) => m.matchupDelta ?? 0).reduce((a, b) => a + b, 0) / opp.length;
      const nw = opp.reduce((s2, m) => s2 - m.nwDiff, 0) / opp.length; // + = I am richer
      const ls = input.laneStats && input.laneStats.sampleMatches >= 20 ? input.laneStats : null;
      // real lane data outweighs the general matchup when we have it
      const score = (ls ? ls.netWorthDiff / 400 : md * 100) + nw / 1500;
      const laneNote = ls
        ? ` Data lane: duo kamu rata-rata ${ls.netWorthDiff >= 0 ? "+" : "−"}${k(Math.abs(ls.netWorthDiff))} souls di menit ${Math.round(ls.sampleS / 60)} melawan duo ini (${ls.sampleMatches} match).`
        : "";
      const who = opp.map((m) => m.heroName).join(" + ");
      tips.push(
        score > 1.5
            ? { kind: "push", priority: 52, title: `Lane: tekan ${who}`, detail: `Matchup ${pts(md)}${Math.abs(nw) >= 500 ? `, kamu ${nw > 0 ? "unggul" : "tertinggal"} ${k(Math.abs(nw))}` : ""}.${laneNote} Trade agresif, deny orb, push wave saat dia recall.` }
            : score < -1.5
              ? { kind: "retreat", priority: 52, title: `Lane: main aman vs ${who}`, detail: `Matchup ${pts(md)}${Math.abs(nw) >= 500 ? `, kamu ${nw > 0 ? "unggul" : "tertinggal"} ${k(Math.abs(nw))}` : ""}.${laneNote} Last-hit dari belakang wave, jangan trade panjang, minta rotasi kalau dia all-in.` }
              : { kind: "tempo", priority: 30, title: `Lane seimbang vs ${who}`, detail: `Fokus last-hit dan orb. Trade hanya saat ability utamanya cooldown.${laneNote}` },
      );
    }
  }

  // --- adaptive needs: the enemy forces an answer you have not bought yet ---
  const urgent = (input.needs ?? []).find((n) => !n.satisfied && n.urgency >= 0.6);
  if (urgent) {
    const step = path.find((st) => st.kind === "flex" && st.reason.startsWith(`Flex ${NEED_LABEL[urgent.kind]}`));
    // don't contradict a locked #1 target ("save for X" while the overlay says buy Y)
    const lockedOther = (path[0] as BuildStep & { locked?: boolean })?.locked && path[0] !== step;
    if (step && !step.affordable && !lockedOther) {
      tips.push({
        kind: "buy",
        priority: 48,
        title: `Siapkan ${step.name}`,
        detail: `${urgent.reason}. Kurang ${k(step.missing)}, jangan beli item lain dulu.`,
      });
    }
  }
  if (input.damage && state.gameTimeS >= 480) {
    const d = input.damage;
    const side = d.bullet >= 0.68 ? "peluru" : d.spirit >= 0.68 ? "spirit" : null;
    const hasResist = (input.needs ?? []).some((n) => (n.kind === "bullet_resist" || n.kind === "spirit_resist") && n.satisfied);
    if (side && !hasResist) {
      tips.push({
        kind: "threat",
        priority: 38,
        title: `${Math.round(Math.max(d.bullet, d.spirit) * 100)}% damage lawan: ${side}`,
        detail: `Resist ${side} memberi EHP paling banyak per soul saat ini.`,
      });
    }
  }

  // --- shopping ---
  const unspent = me.souls ?? 0;
  const next = path[0];
  if (next && unspent >= next.cost && next.cost > 0) {
    tips.push({
      kind: "buy",
      // dead = at the shop anyway → top; alive it must not drown fight/plan calls
      priority: me.dead ? 90 : unspent >= 3000 ? 62 : 45,
      title: me.dead ? `Kamu mati: belanja sekarang` : `${k(unspent)} souls nganggur`,
      detail: `Beli ${next.name} (${k(next.cost)}). ${next.reason}.`,
    });
  }

  // --- biggest threat ---
  const top = summary.threats[0];
  if (top && top.nwShare >= 1.25) {
    const m = matchups.find((x) => x.accountId === top.player.accountId);
    tips.push({
      kind: "threat",
      priority: 35,
      title: `Ancaman: ${heroName(top.player.heroId)}`,
      detail: `${k(top.player.netWorth)} souls (${Math.round((top.nwShare - 1) * 100)}% di atas rata-rata timnya).${m?.archetypes.length ? ` ${m.archetypes.map((a) => ARCH_ADVICE[a]).join("; ")}.` : ""}${m?.bestCounter ? ` Counter terbaik: ${m.bestCounter.name} (${pts(m.bestCounter.delta)}).` : ""}`,
    });
  }

  tips.sort((a, b) => b.priority - a.priority);
  return { tips: tips.slice(0, 3), teamPhases, buildPath: path, matchups };
}
