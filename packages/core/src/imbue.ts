/**
 * Imbue advice: for an item that empowers one ability (Duration Extender, Compress
 * Cooldown, Extra Charge, Mystic Reverb, …), which of *my* abilities should get it, and why.
 *
 * Two independent arguments, shown side by side:
 *  1. Stat argument: what the item changes (cooldown, duration, range, charges, damage echo)
 *     applied to each ability's real numbers (stun seconds, damage, cooldown, spirit scaling),
 *     plus how much the ability matters (max-first priority from ability-order stats).
 *  2. Data argument: which ability the played hero builds imbue it into
 *     (`imbue_target_ability_id` in the builds), weighted by how many matches those builds
 *     were played in (hero-build-stats, from demo analysis), with the win rate per target.
 * The final pick blends both; when they disagree the advice says so.
 */

import type { DeadlockClient, FetchInit, Query } from "./api";
import { maxOrder } from "./abilities";
import type { LabItem, RawProp } from "./buildlab";
import { isCC as isCCFeat, lockSeconds, type Feat } from "./playbook";
import type { AbilityOrderStats, HeroBuild } from "./types";

/** proc: the item's effect fires each time the imbued ability is cast (reload, slow, bonus damage …) */
export type ImbueKind = "cooldown" | "duration" | "range" | "charges" | "echo" | "lifesteal" | "proc" | "other";

export interface ImbueEffect {
  kind: ImbueKind;
  /** percent (cooldown/duration/range/echo/lifesteal) */
  pct: number;
  /** extra charges for "charges" */
  extra: number;
  label: string;
  noUlt: boolean;
  /** extra effect that only triggers when the imbued ability deals damage (Frostbite freeze) */
  onHit?: string;
}

const num = (p?: RawProp) => {
  const v = p?.value;
  if (v == null || typeof v === "boolean") return 0;
  const x = typeof v === "number" ? v : parseFloat(String(v).replace(/m$/, ""));
  return Number.isFinite(x) ? Math.abs(x) : 0;
};

export const isImbueItem = (it: Pick<LabItem, "imbue"> | undefined | null) => !!it?.imbue;

export function imbueEffect(item: LabItem): ImbueEffect | null {
  if (!isImbueItem(item)) return null;
  const P = item.properties ?? {};
  const g = (...ks: string[]) => ks.map((k) => num(P[k])).find((x) => x > 0) ?? 0;
  const noUlt = item.imbue === "imbue_active_non_ult";
  const charges = g("BonusAbilityCharges");
  const chargeCd = g("CooldownBetweenChargeReduction", "CooldownReductionOnChargedAbilities");
  if (charges || chargeCd) return { kind: "charges", pct: chargeCd, extra: charges, label: `${charges ? `+${charges} charge` : ""}${charges && chargeCd ? ", " : ""}${chargeCd ? `jeda charge −${chargeCd}%` : ""}`, noUlt };
  if (item.imbue === "imbue_active" || item.imbue === "imbue_active_non_ult") {
    // on-cast items: their other stats (duration %, CDR …) are general bonuses, not the imbue
    const echo = g("TechDamagePercent");
    if (echo) return { kind: "echo", pct: echo, extra: 0, label: `damage skill memantul lagi ${echo}%`, noUlt };
    const ls = g("ImbueAbilityLifesteal");
    if (ls) return { kind: "lifesteal", pct: ls, extra: 0, label: `lifesteal skill +${ls}%`, noUlt };
    return { kind: "proc", pct: 0, extra: 0, label: "efeknya terpicu setiap skill itu dipakai", noUlt };
  }
  const icdr = g("ImbuedCooldownReduction");
  if (icdr) {
    const sp = g("ImbuedTechPower");
    const frz = g("FreezeDuration");
    const dmg = g("Damage");
    const onHit = frz || dmg ? `saat skill kena: ${frz ? `freeze ${f1(frz)} dtk` : ""}${frz && dmg ? " + " : ""}${dmg ? `${Math.round(dmg)} damage` : ""}` : undefined;
    return { kind: "cooldown", pct: icdr, extra: sp, label: `cooldown −${icdr}%${sp ? `, +${sp} spirit ke skill itu` : ""}${onHit ? `, ${onHit}` : ""}`, noUlt, onHit };
  }
  const dur = g("BonusAbilityDurationPercent");
  if (dur) return { kind: "duration", pct: dur, extra: 0, label: `durasi +${dur}%`, noUlt };
  const cdr = g("CooldownReduction");
  if (cdr) return { kind: "cooldown", pct: cdr, extra: 0, label: `cooldown −${cdr}%`, noUlt };
  const range = g("TechRangeMultiplier", "TechRadiusMultiplier");
  if (range) return { kind: "range", pct: range, extra: 0, label: `range/radius +${range}%`, noUlt };
  return { kind: "other", pct: 0, extra: 0, label: "memperkuat 1 skill", noUlt };
}

// ---------------------------------------------------------------------------
// data side
// ---------------------------------------------------------------------------

export interface ImbueTargetStat {
  builds: number;
  matches: number;
  wins: number;
}

export interface ImbueData {
  /** item id → ability id → usage */
  byItem: Map<number, Map<number, ImbueTargetStat>>;
  builds: number;
  matches: number;
}

export function aggregateImbue(rows: { build: HeroBuild; matches: number; wins: number }[]): ImbueData {
  const byItem = new Map<number, Map<number, ImbueTargetStat>>();
  let matches = 0;
  for (const r of rows) {
    matches += r.matches;
    const seen = new Set<number>();
    for (const cat of r.build.details?.mod_categories ?? []) {
      for (const m of cat.mods ?? []) {
        const t = m.imbue_target_ability_id;
        if (!t || seen.has(m.ability_id)) continue;
        seen.add(m.ability_id);
        const per = byItem.get(m.ability_id) ?? new Map<number, ImbueTargetStat>();
        const e = per.get(t) ?? { builds: 0, matches: 0, wins: 0 };
        e.builds++;
        e.matches += r.matches;
        e.wins += r.wins;
        per.set(t, e);
        byItem.set(m.ability_id, per);
      }
    }
  }
  return { byItem, builds: rows.length, matches };
}

/**
 * Most-played builds of a hero (by matches in the window) with their imbue targets,
 * plus the most-favourited builds this week (no match counts, adds coverage for new items).
 */
export async function fetchImbueData(client: DeadlockClient, heroId: number, base: Query, init?: FetchInit, opts: { top?: number } = {}): Promise<ImbueData> {
  const [stats, fav] = await Promise.all([
    client.heroBuildStats(heroId, { ...base, min_matches: 10 }, init).catch(() => []),
    client.builds({ hero_id: heroId, sort_by: "weekly_favorites", sort_direction: "desc", only_latest: true, limit: 40 }, init).catch(() => []),
  ]);
  const top = [...stats].sort((a, b) => b.matches - a.matches).slice(0, opts.top ?? 30);
  const favById = new Map(fav.map((b) => [b.hero_build.hero_build_id, b.hero_build]));
  const details = await Promise.all(
    top.map((s) =>
      favById.get(s.hero_build_id)
        ? Promise.resolve(favById.get(s.hero_build_id)!)
        : client
            .builds({ build_id: s.hero_build_id, only_latest: true, limit: 1 }, init)
            .then((b) => b[0]?.hero_build ?? null)
            .catch(() => null),
    ),
  );
  const rows: { build: HeroBuild; matches: number; wins: number }[] = [];
  const used = new Set<number>();
  top.forEach((s, i) => {
    const b = details[i];
    if (b && b.hero_id === heroId) {
      rows.push({ build: b, matches: s.matches, wins: s.wins });
      used.add(b.hero_build_id);
    }
  });
  for (const b of fav) if (!used.has(b.hero_build.hero_build_id) && b.hero_build.hero_id === heroId) rows.push({ build: b.hero_build, matches: 0, wins: 0 });
  return aggregateImbue(rows);
}

/** Share of matches in which each (non-ult) ability is the first one maxed. */
export function maxFirstShare(rows: AbilityOrderStats[], ultId: number | null): Map<number, number> {
  const out = new Map<number, number>();
  let total = 0;
  for (const r of rows) {
    if (r.abilities.length < 8) continue;
    const first = maxOrder(r.abilities).find((id) => id !== ultId);
    if (first == null) continue;
    out.set(first, (out.get(first) ?? 0) + r.matches);
    total += r.matches;
  }
  if (total) for (const [k, v] of out) out.set(k, v / total);
  return out;
}

// ---------------------------------------------------------------------------
// stat side
// ---------------------------------------------------------------------------

const f1 = (x: number) => (Math.round(x * 10) / 10).toString().replace(".", ",");
const pc = (x: number) => `${Math.round(x * 100)}%`;

/** Short description of what an ability does, from its numbers. */
export function abilityTraits(a: Feat): string[] {
  const t: string[] = [];
  if (a.stun) t.push(`stun ${f1(a.stun)} dtk`);
  if (a.sleep) t.push(`sleep ${f1(a.sleep)} dtk`);
  if (a.hold) t.push(`kunci ${f1(a.hold)} dtk`);
  if (a.silence) t.push(`silence ${f1(a.silence)} dtk`);
  if (a.slow) t.push(`slow ${Math.round(a.slow.pct)}%`);
  if (a.damage) t.push(`damage ${Math.round(a.damage)}${a.dot ? "/dtk" : ""}${a.aoe ? " area" : ""}`);
  else if (a.dot) t.push("damage-over-time");
  if (a.spiritScale) t.push("skala spirit");
  if (a.heal) t.push("heal");
  if (a.barrier) t.push("barrier");
  if (a.mobility) t.push("mobilitas");
  return t.slice(0, 3);
}

function impact(a: Feat, prio: number): number {
  const lock = Math.min(3, lockSeconds(a));
  const dmg = a.damage ? Math.min(2, a.damage / 120) : a.burst || a.dot ? 0.8 : 0;
  return (
    0.3 +
    lock * 1.2 +
    dmg +
    (a.dot ? 0.4 : 0) +
    (a.spiritScale ? Math.min(1, a.spiritScale * 0.5) : 0) +
    (a.silence ? 0.6 : 0) +
    (a.heal ? 0.5 : 0) +
    (a.barrier ? 0.4 : 0) +
    (a.mobility ? 0.3 : 0) +
    (a.ult ? 0.6 : 0) +
    prio * 1.5
  );
}

interface StatScore {
  a: Feat;
  ok: boolean;
  score: number;
  /** what the item does to this ability, concretely */
  gain: string;
}

function statScore(e: ImbueEffect, a: Feat, prio: number): StatScore {
  const no = (gain: string): StatScore => ({ a, ok: false, score: 0, gain });
  if (e.noUlt && a.ult) return no("tidak bisa ke ultimate");
  const imp = impact(a, prio);
  const p = e.pct / 100;
  switch (e.kind) {
    case "cooldown": {
      if (!a.cooldown) return no("tidak punya cooldown");
      const cd2 = a.cooldown * (1 - p);
      const extra = 300 / cd2 - 300 / a.cooldown;
      const hits = !!(a.damage || a.dot || a.burst);
      // on-hit bonus (freeze + damage) only works if the ability actually damages enemies
      const hitMul = e.onHit ? (hits ? 1.35 * (a.aoe ? 1.15 : 1) : 0.4) : 1;
      const spMul = e.extra && a.spiritScale ? 1.15 : 1;
      const gain = `cooldown ${f1(a.cooldown)} → ${f1(cd2)} dtk (+${f1(extra)} cast per 5 menit)${e.onHit ? (hits ? `, ${e.onHit}` : ", tapi data skill tidak mencatat damage langsung: freeze hanya terpicu kalau skill ini benar-benar kena musuh") : ""}`;
      return { a, ok: true, score: imp * Math.sqrt(Math.min(extra, 12)) * hitMul * spMul, gain };
    }
    case "duration": {
      const lock = lockSeconds(a);
      if (!a.duration && !lock) return no("tidak punya efek berdurasi");
      const base = lock * 3 + (a.dot ? 1 : 0) + (a.barrier || a.heal || a.resistBuff ? 0.6 : 0) + (a.duration ? 0.3 : 0) + prio * 1.5 + (a.ult ? 0.4 : 0);
      const cc = a.stun ? ["stun", a.stun] : a.sleep ? ["sleep", a.sleep] : a.hold ? ["kunci", a.hold] : a.silence ? ["silence", a.silence] : a.slow ? ["slow", a.slow.dur] : null;
      const gain = cc
        ? `${cc[0]} ${f1(cc[1] as number)} → ${f1((cc[1] as number) * (1 + p))} dtk`
        : `durasi ${f1(a.duration!)} → ${f1(a.duration! * (1 + p))} dtk${a.dot ? ` (total damage +${e.pct}%)` : ""}`;
      return { a, ok: true, score: base * p * 5, gain };
    }
    case "range": {
      if (!a.castRange && !a.radius && !a.skillshot) return no("tidak punya range/area");
      const gain = a.radius
        ? `radius ${f1(a.radius)} → ${f1(a.radius * (1 + p))} m`
        : a.castRange
          ? `range ${f1(a.castRange)} → ${f1(a.castRange * (1 + p))} m`
          : `jangkauan +${e.pct}%`;
      return { a, ok: true, score: imp * (a.radius ? 1.2 : 1) * (a.skillshot ? 1.15 : 1), gain };
    }
    case "charges": {
      if (!a.cooldown) return no("tidak punya cooldown");
      const key = abilityTraits(a)[0];
      const gain = a.charges
        ? `${a.charges} → ${a.charges + (e.extra || 0)} charge${e.pct ? `, jeda −${e.pct}%` : ""}`
        : `jadi ${1 + (e.extra || 1)} charge: ${key ? `${key} ` : ""}bisa dipakai beruntun dalam 1 fight`;
      return { a, ok: true, score: imp * (a.cooldown >= 10 ? 1 : 0.6) * (a.charges ? 1.15 : 1), gain };
    }
    case "echo":
    case "lifesteal": {
      if (!a.cooldown) return no("skill pasif, item aktif tidak bisa di-imbue ke sini");
      if (!a.damage && !a.dot && !a.burst) return no("tidak memberi damage");
      const dmg = a.damage ? Math.min(2.5, a.damage / 100) : 0.8;
      const freq = a.cooldown ? Math.sqrt(Math.min(3, 15 / a.cooldown)) : 1;
      const score = (dmg + (a.dot ? 0.5 : 0) + (a.aoe ? 0.4 : 0) + (a.spiritScale ? Math.min(1, a.spiritScale * 0.5) : 0) + prio * 1.5) * freq;
      const gain =
        e.kind === "echo"
          ? `damage ${a.damage ? Math.round(a.damage) : "skill"} kena lagi +${e.pct}%${a.cooldown ? `, tiap ${f1(a.cooldown)} dtk` : ""}`
          : `heal dari damage ${a.damage ? Math.round(a.damage) : "skill"}${a.aoe ? " area (banyak target)" : ""}${a.cooldown ? `, tiap ${f1(a.cooldown)} dtk` : ""}`;
      return { a, ok: true, score, gain };
    }
    case "proc": {
      // fires on every cast: cast often, and (for on-hit effects) actually hit enemies, ideally several
      if (!a.cooldown) return no("bukan skill aktif");
      const hits = !!(a.damage || a.dot || a.burst || isCCFeat(a));
      const freq = Math.sqrt(Math.min(3, 15 / a.cooldown));
      const score = ((hits ? 1 : 0.45) * (a.aoe ? 1.25 : 1) + prio * 0.8 + (a.ult ? -0.3 : 0)) * freq;
      const gain = `terpicu tiap ${f1(a.cooldown)} dtk${hits ? (a.aoe ? ", kena banyak target sekaligus" : ", kena musuh") : ""}`;
      return { a, ok: true, score, gain };
    }
    default:
      return { a, ok: true, score: imp, gain: abilityTraits(a).join(", ") || "skill utama" };
  }
}

// ---------------------------------------------------------------------------
// advice
// ---------------------------------------------------------------------------

export interface ImbueAdvice {
  itemId: number;
  itemName: string;
  kind: ImbueKind;
  effect: string;
  target: { id: number; name: string };
  /** one-line answer for small UIs */
  short: string;
  /** full argument: stat reason, data reason, priority, disagreement */
  reasons: string[];
  source: "stat" | "data+stat";
  /** stat and data point at the same ability */
  agree: boolean | null;
  data: { matches: number; builds: number; share: number; winrate: number | null; otherWinrate: number | null } | null;
  alternatives: { id: number; name: string; gain: string; share: number | null }[];
}

export function recommendImbue(
  item: LabItem,
  kit: Feat[],
  opts: { data?: ImbueData | null; prio?: Map<number, number> } = {},
): ImbueAdvice | null {
  const e = imbueEffect(item);
  if (!e || !kit.length) return null;
  const prio = opts.prio ?? new Map<number, number>();
  const stats = kit.map((a) => statScore(e, a, prio.get(a.id) ?? 0));
  const ok = stats.filter((s) => s.ok);
  if (!ok.length) return null;
  const sumS = ok.reduce((s, x) => s + x.score, 0) || 1;
  const statTop = [...ok].sort((a, b) => b.score - a.score)[0];

  const per = opts.data?.byItem.get(item.id);
  const okIds = new Set(ok.map((s) => s.a.id));
  const rows = per ? [...per.entries()].filter(([id]) => okIds.has(id)) : [];
  const dMatches = rows.reduce((s, [, v]) => s + v.matches, 0);
  const dBuilds = rows.reduce((s, [, v]) => s + v.builds, 0);
  // a single author's choice is not evidence: need several builds, and enough matches or builds
  const useData = dBuilds >= 3 && (dMatches >= 150 || dBuilds >= 4);
  const dShare = (id: number) => {
    const v = per?.get(id);
    if (!v) return 0;
    return dMatches >= 150 ? v.matches / dMatches : v.builds / Math.max(1, dBuilds);
  };
  const wrAll = dMatches ? rows.reduce((s, [, v]) => s + v.wins, 0) / dMatches : 0.5;

  const final = ok.map((s) => {
    let v = s.score / sumS;
    if (useData) {
      const d = per?.get(s.a.id);
      const wrAdj = d && d.matches ? (d.wins / d.matches - wrAll) * (d.matches / (d.matches + 400)) : 0;
      v = 0.55 * dShare(s.a.id) + 0.45 * v + 2 * wrAdj;
    }
    return { s, v };
  });
  final.sort((a, b) => b.v - a.v);
  const pick = final[0].s;
  const name = pick.a.name;

  const reasons: string[] = [];
  const traits = abilityTraits(pick.a);
  reasons.push(`Stat: ${item.name} (${e.label}) ke ${name} → ${pick.gain}.${traits.length ? ` ${name}: ${traits.join(", ")}.` : ""}`);
  const runner = final.find((x) => x.s.a.id !== pick.a.id)?.s;
  if (runner && pick.a.id === statTop.a.id) reasons.push(`Kenapa bukan ${runner.a.name}: ${runner.gain}, dampaknya lebih kecil.`);

  let data: ImbueAdvice["data"] = null;
  let agree: boolean | null = null;
  if (useData) {
    const d = per!.get(pick.a.id);
    const others = rows.filter(([id]) => id !== pick.a.id);
    const oM = others.reduce((s, [, v]) => s + v.matches, 0);
    const oW = others.reduce((s, [, v]) => s + v.wins, 0);
    data = {
      matches: dMatches,
      builds: dBuilds,
      share: dShare(pick.a.id),
      winrate: d && d.matches >= 30 ? d.wins / d.matches : null,
      otherWinrate: oM >= 30 ? oW / oM : null,
    };
    const basis = dMatches >= 150 ? `${dMatches.toLocaleString("id-ID")} match dari ${dBuilds} build yang paling banyak dipakai` : `${dBuilds} build populer minggu ini`;
    let line = `Data: ${pc(data.share)} dari ${basis} imbue ${item.name} ke ${name}.`;
    if (data.winrate != null && data.otherWinrate != null) line += ` WR ${pc(data.winrate)} vs ${pc(data.otherWinrate)} kalau ke skill lain.`;
    else if (data.winrate != null) line += ` WR ${pc(data.winrate)}.`;
    reasons.push(line);
    const dataTop = [...rows].sort((a, b) => dShare(b[0]) - dShare(a[0]))[0]?.[0];
    agree = dataTop === statTop.a.id;
    if (!agree) {
      if (pick.a.id === statTop.a.id) {
        const dn = kit.find((a) => a.id === dataTop)?.name;
        if (dn) reasons.push(`Catatan: kebanyakan pemain memilih ${dn}, tapi win rate/angka stat lebih mendukung ${name}.`);
      } else {
        reasons.push(`Catatan: hitungan stat lebih condong ke ${statTop.a.name} (${statTop.gain}), tapi data pemain (pemakaian + win rate) lebih mendukung ${name}. Ikut ${name} kecuali kamu sengaja main gaya ${statTop.a.name}.`);
      }
    }
  } else {
    reasons.push("Data build untuk item ini belum cukup; saran murni dari angka skill.");
  }
  const pr = prio.get(pick.a.id) ?? 0;
  if (pr >= 0.3) reasons.push(`${pc(pr)} pemain max-kan ${name} duluan: ini skill andalan hero ini.`);

  const alternatives = final.slice(1, 3).map((x) => ({ id: x.s.a.id, name: x.s.a.name, gain: x.s.gain, share: useData ? dShare(x.s.a.id) : null }));
  const short = `Imbue → ${name}: ${pick.gain}${data ? ` · ${pc(data.share)} pemain${data.winrate != null ? `, WR ${pc(data.winrate)}` : ""}` : ""}`;
  return {
    itemId: item.id,
    itemName: item.name,
    kind: e.kind,
    effect: e.label,
    target: { id: pick.a.id, name },
    short,
    reasons,
    source: useData ? "data+stat" : "stat",
    agree,
    data,
    alternatives,
  };
}
