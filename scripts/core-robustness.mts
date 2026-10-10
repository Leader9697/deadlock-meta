/**
 * Is the recommended core build robust, or does it just echo noise?
 *
 *   npx tsx scripts/core-robustness.mts [--days 28] [--badge 0] [--heroes 12] [--hero 15]
 *
 * For each hero it builds the core plan from two independent halves of the time window
 * (first half vs second half) and compares them, then moves the score weights ×0.5…×2 and
 * counts how many items flip. Needs access to api.deadlock-api.com (use the office proxy
 * env vars if needed). Prints a table; nothing is written.
 *
 * Reading the result
 *   - overlap ≥ 0.6  : both halves agree on most of the plan → real signal
 *   - 0.4–0.6        : partly noise; trust the first items of each phase, not the tail
 *   - < 0.4          : the plan for this hero/filter is mostly noise (too few matches)
 *   - sensitivity    : if ×0.5/×2 of pickWeight keeps overlap ≥ 0.7 the exact weight does not
 *                      matter; if it drops below 0.5 the weight is deciding, not the data.
 * Caveat: a patch in the middle of the window will lower the overlap for the wrong reason;
 * run with --days small enough to stay inside one patch.
 */
import { createClient, daysAgo, GAME_PHASES, coreSensitivity, coreStability, stabilityVerdict, type ItemFlowStats } from "../packages/core/src/index";

const arg = (name: string, def: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : def;
};
const days = arg("days", 28);
const badge = arg("badge", 0);
const topHeroes = arg("heroes", 12);
const onlyHero = arg("hero", 0);
const PHASE_S = 300;

const api = createClient({ baseUrl: process.env.DEADLOCK_API_BASE });
const now = Math.floor(Date.now() / 1000);
const start = daysAgo(days);
const mid = start + Math.floor((now - start) / 2);

const flow = (heroId: number, from: number, to: number): Promise<ItemFlowStats> =>
  api.itemFlowStats({ min_unix_timestamp: from, max_unix_timestamp: to, min_average_badge: badge || undefined, hero_ids: String(heroId), phase_interval_s: PHASE_S, phase_count: 8, min_matches: 20 });

const pct = (x: number | null) => (x == null ? "  – " : `${Math.round(x * 100).toString().padStart(3)}%`);

const [items, heroes, stats] = await Promise.all([api.items(), api.heroes(), api.heroStats({ min_unix_timestamp: start, min_average_badge: badge || undefined })]);
const name = new Map(heroes.map((h) => [h.id, h.name]));
const ids = onlyHero ? [onlyHero] : [...stats].sort((a, b) => b.matches - a.matches).slice(0, topHeroes).map((s) => s.hero_id);

console.log(`window ${days}d, badge ${badge || "all"}: A=first half, B=second half\n`);
console.log("hero".padEnd(18), "matches A/B".padEnd(14), "overlap", "samePh", "  verdict", " | per phase (E M L VL)");
const overall: number[] = [];
const sens: Record<string, number[]> = {};
for (const id of ids) {
  try {
    const [a, b] = await Promise.all([flow(id, start, mid), flow(id, mid, now)]);
    const st = coreStability(a, b, PHASE_S, items);
    if (st.overall != null) overall.push(st.overall);
    console.log(
      (name.get(id) ?? `#${id}`).padEnd(18),
      `${a.summary.matches}/${b.summary.matches}`.padEnd(14),
      pct(st.overall).padEnd(7),
      pct(st.samePhase).padEnd(6),
      stabilityVerdict(st).padStart(15),
      "|",
      GAME_PHASES.map((g) => pct(st.phases.find((p) => p.phase === g.key)?.jaccard ?? null)).join(" "),
    );
    // sensitivity on the full window
    const full = await flow(id, start, now);
    for (const r of coreSensitivity(full, PHASE_S, items)) {
      const key = `${r.param} ×${(r.value / (r.param === "pickWeight" ? 0.06 : 200)).toFixed(2)}`;
      (sens[key] ??= []).push(r.vsBase.overall ?? 0);
    }
  } catch (e) {
    console.log((name.get(id) ?? `#${id}`).padEnd(18), `skip: ${(e as Error).message.slice(0, 80)}`);
  }
}
const avg = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
console.log(`\nrata-rata overlap antar-paruh: ${pct(avg(overall))}  (${overall.length} hero)`);
console.log("\nsensitivitas bobot (rata-rata overlap dengan plan asli):");
for (const [k, v] of Object.entries(sens)) console.log(" ", k.padEnd(18), pct(avg(v)));
