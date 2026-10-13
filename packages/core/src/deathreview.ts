/**
 * "Why did I die?" from the game's own death recap (DeathReplayDataEvent: damage per
 * source, debuffs on you) plus the killfeed and the match situation at that moment.
 * Each cause comes with a concrete fix derived from the actual ability/item numbers
 * (cast range, cooldown, CC duration) and from what is in the shop.
 */

import { itemInnate, type LabItem } from "./buildlab";
import type { LivePlayer } from "./live";
import { features, type Feat } from "./playbook";
import { isPriced, itemCost } from "./prices";

export interface DeathDamage {
  attackerHeroId: number;
  abilityId: number;
  damage: number;
  hits: number;
  damageType: number;
  critDamage: number;
  absorbed: number;
  killingBlow: boolean;
}

export interface DeathModifier {
  abilityId: number;
  casterAccount?: number;
  startS: number;
  endS: number;
  debuff: boolean;
}

/** Mirrors DeathRecord in crates/deadlock-live/src/state.rs */
export interface DeathRecord {
  tick: number;
  gameTimeS: number;
  killerAccount?: number;
  assisterAccounts: number[];
  killerAbilityId?: number;
  durationS?: number;
  totalDamage?: number;
  lostGold?: number;
  damage: DeathDamage[];
  modifiers: DeathModifier[];
  alliesAlive: number;
  enemiesAlive: number;
  netWorth: number;
  itemIds: number[];
}

export interface DamageSource {
  heroId: number;
  heroName: string;
  name: string;
  kind: "peluru" | "ability" | "item" | "melee" | "tower/creep";
  damage: number;
  pct: number;
  critPct: number;
  killingBlow: boolean;
}

export interface DeathCause {
  key: "outnumbered" | "burst" | "cc" | "duel" | "tower" | "headshots" | "antiheal" | "unknown";
  weight: number;
  title: string;
  detail: string;
  fixes: string[];
}

export interface DeathReview {
  tick: number;
  gameTimeS: number;
  killer: string | null;
  headline: string;
  sources: DamageSource[];
  cc: { name: string; by: string; seconds: number; type: string }[];
  causes: DeathCause[];
  /** short "what to do differently" list, best first */
  fixes: string[];
  hasRecap: boolean;
}

export interface DeathPattern {
  deaths: number;
  text: string[];
}

export interface ReviewInput {
  me: LivePlayer;
  players: LivePlayer[];
  lab: Map<number, LabItem>;
  heroName: (heroId: number) => string;
  /** my abilities as features (for escape advice) */
  myKit: Feat[];
  /** hero → its abilities as features (for "keep distance from X") */
  kitOf: (heroId: number) => Feat[];
  matchupDelta: (enemyHeroId: number) => number | null;
}

const s1 = (x: number) => (Math.round(x * 10) / 10).toString().replace(".", ",");
const pct = (x: number) => `${Math.round(x * 100)}%`;
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const k = (n: number) => `${(n / 1000).toFixed(1)}k`;

function sourceKind(it: LabItem | undefined, heroId: number): DamageSource["kind"] {
  if (!heroId) return "tower/creep";
  if (!it) return "peluru";
  if (it.type === "weapon") return "peluru";
  if (it.type === "upgrade") return "item";
  if (/melee/i.test(it.class_name)) return "melee";
  return "ability";
}

/** Shop items that answer a need, cheapest tier first (names only, for advice). */
function shopFor(lab: Map<number, LabItem>, pick: (it: LabItem) => boolean, max = 2): string[] {
  return [...lab.values()]
    .filter((it) => it.type === "upgrade" && it.shopable && !it.disabled && isPriced(it) && pick(it))
    .sort((a, b) => (a.item_tier ?? 0) - (b.item_tier ?? 0) || itemCost(a) - itemCost(b))
    .slice(0, max)
    .map((it) => it.name);
}

export function reviewDeath(d: DeathRecord, input: ReviewInput): DeathReview {
  const { lab, heroName, players, me } = input;
  const byAccount = new Map(players.map((p) => [p.accountId, p]));
  const owned = new Set(me.itemIds);

  // ---- damage sources ----
  const total = d.damage.reduce((s, x) => s + x.damage, 0) || d.totalDamage || 0;
  const sources: DamageSource[] = d.damage
    .map((x) => {
      const it = lab.get(x.abilityId);
      const kind = sourceKind(it, x.attackerHeroId);
      return {
        heroId: x.attackerHeroId,
        heroName: x.attackerHeroId ? heroName(x.attackerHeroId) : "Tower/creep",
        name: kind === "peluru" ? "Tembakan" : kind === "tower/creep" ? "Tower/creep" : (it?.name ?? `#${x.abilityId}`),
        kind,
        damage: x.damage,
        pct: total ? x.damage / total : 0,
        critPct: x.damage ? x.critDamage / x.damage : 0,
        killingBlow: x.killingBlow,
      };
    })
    .sort((a, b) => b.damage - a.damage);
  const byHero = new Map<number, number>();
  for (const s of sources) if (s.heroId) byHero.set(s.heroId, (byHero.get(s.heroId) ?? 0) + s.damage);
  const heroesHit = [...byHero.entries()].sort((a, b) => b[1] - a[1]);
  const attackers = new Set([...byHero.keys(), ...(d.killerAccount ? [byAccount.get(d.killerAccount)?.heroId ?? 0] : []), ...d.assisterAccounts.map((a) => byAccount.get(a)?.heroId ?? 0)].filter(Boolean));

  // ---- CC on me ----
  const cc = d.modifiers
    .filter((m) => m.debuff && m.endS - m.startS >= 0.4)
    .map((m) => {
      const it = lab.get(m.abilityId);
      const f = it ? features(it) : null;
      const type = f ? (f.stun ? "stun" : f.sleep ? "sleep" : f.hold ? "dikunci" : f.silence ? "silence" : f.disarm ? "disarm" : f.slow ? "slow" : f.antiHeal ? "anti-heal" : "") : "";
      const caster = m.casterAccount ? byAccount.get(m.casterAccount) : undefined;
      return { name: it?.name ?? `#${m.abilityId}`, by: caster ? heroName(caster.heroId) : "?", seconds: m.endS - m.startS, type, f };
    })
    .filter((c) => c.type);
  const hardCC = cc.filter((c) => ["stun", "sleep", "dikunci", "silence"].includes(c.type));
  const hardSeconds = hardCC.reduce((s, c) => s + c.seconds, 0);

  const killerP = d.killerAccount ? byAccount.get(d.killerAccount) : undefined;
  const killer = killerP ? heroName(killerP.heroId) : heroesHit[0] ? heroName(heroesHit[0][0]) : null;
  const causes: DeathCause[] = [];
  const myEscape = input.myKit.filter((a) => a.mobility || a.stealth);

  // 1) outnumbered
  const numbersGap = d.enemiesAlive - d.alliesAlive;
  if (attackers.size >= 3 || numbersGap >= 2) {
    causes.push({
      key: "outnumbered",
      weight: 3 + attackers.size * 0.5 + Math.max(0, numbersGap),
      title: `Dikeroyok ${attackers.size || "beberapa"} lawan`,
      detail: `Saat itu ${d.alliesAlive + 1} tim kamu hidup vs ${d.enemiesAlive} lawan. ${[...attackers].map((h) => heroName(h)).join(", ")} ikut memberi damage.`,
      fixes: [
        "Kalau ≥2 lawan tidak terlihat di minimap, farm di sisi sendiri atau dekat teman, bukan di lane/jungle lawan.",
        numbersGap >= 2 ? "Jangan ambil fight saat jumlah kalah; tunggu teman respawn, cukup clear wave dari jauh." : "Masuk fight bareng tim; kamu sampai duluan dan jadi target pertama.",
      ],
    });
  }

  // 2) burst: one source (or one hero) did most damage fast
  const top = sources.find((s) => s.kind !== "tower/creep");
  const fast = (d.durationS ?? 99) <= 3;
  if (top && top.kind !== "peluru" && top.pct >= 0.35) {
    const it = lab.get(d.damage.find((x) => x.damage === top.damage)?.abilityId ?? 0);
    const f = it ? features(it) : null;
    const isSpirit = top.kind === "ability" || top.kind === "item";
    const resistItems = isSpirit
      ? shopFor(lab, (x) => (itemInnate(x).get("MODIFIER_VALUE_TECH_RESIST") ?? 0) >= 12 && !owned.has(x.id))
      : shopFor(lab, (x) => (itemInnate(x).get("MODIFIER_VALUE_BULLET_ARMOR_DAMAGE_RESIST") ?? 0) >= 12 && !owned.has(x.id));
    const fixes: string[] = [];
    if (f?.castRange) fixes.push(`Jaga jarak lebih dari ${Math.round(f.castRange)}m dari ${top.heroName} saat ${top.name} siap${f.cooldown ? ` (cooldown ${Math.round(f.cooldown)} dtk: setelah dia pakai, kamu punya window ±${Math.round(f.cooldown)} dtk)` : ""}.`);
    else if (f?.cooldown) fixes.push(`Hitung cooldown ${top.name} (${Math.round(f.cooldown)} dtk): fight saat sudah dipakai, mundur saat siap.`);
    if (f?.skillshot) fixes.push(`${top.name} perlu aim/charge: gerak menyamping dan jangan berdiri diam di garis lurus dengannya.`);
    if (resistItems.length) fixes.push(`Resist ${isSpirit ? "spirit" : "peluru"}: ${resistItems.join(" atau ")}.`);
    causes.push({
      key: "burst",
      weight: 2 + top.pct * 4 + (fast ? 1 : 0),
      title: `${fast ? "Burst" : "Damage utama"}: ${top.name} dari ${top.heroName}`,
      detail: `${top.name} = ${pct(top.pct)} damage yang membunuhmu${d.durationS ? `, semua dalam ${s1(d.durationS)} dtk` : ""}.`,
      fixes,
    });
  }

  // 3) bullets with lots of headshots
  const bullets = sources.filter((s) => s.kind === "peluru");
  const bulletDmg = bullets.reduce((s, x) => s + x.damage, 0);
  const critDmg = bullets.reduce((s, x) => s + x.critPct * x.damage, 0);
  if (total && bulletDmg / total >= 0.5) {
    const shooter = bullets[0];
    const resistItems = shopFor(lab, (x) => (itemInnate(x).get("MODIFIER_VALUE_BULLET_ARMOR_DAMAGE_RESIST") ?? 0) >= 12 && !owned.has(x.id));
    const crit = bulletDmg ? critDmg / bulletDmg : 0;
    causes.push({
      key: "headshots",
      weight: 1.5 + (bulletDmg / total) * 2 + crit * 2,
      title: `Ditembak ${shooter.heroName}${crit >= 0.25 ? `, ${pct(crit)} headshot` : ""}`,
      detail: `${pct(bulletDmg / total)} damage dari peluru.`,
      fixes: [
        crit >= 0.25 ? "Banyak headshot: gerak tidak terduga (lompat/slide/ganti arah), jangan diam di garis tembaknya." : `Jangan berdiri di jarak tembak ${shooter.heroName} tanpa cover; putus line of sight lewat tembok/pilar.`,
        ...(resistItems.length ? [`Resist peluru: ${resistItems.join(" atau ")}.`] : []),
      ],
    });
  }

  // 4) CC chain
  if (hardSeconds >= 1.2) {
    const worst = [...hardCC].sort((a, b) => b.seconds - a.seconds)[0];
    const isCleanse = (x: LabItem | undefined) => !!x?.is_active_item && (x.shop_filters ?? []).some((f) => f === "anti_cc" || f === "debuff_resist");
    const cleanse = shopFor(lab, (x) => isCleanse(x) && !owned.has(x.id));
    const ownedCleanse = [...owned].map((id) => lab.get(id)).find(isCleanse);
    const enemyF = worst.f;
    causes.push({
      key: "cc",
      weight: 2 + hardSeconds,
      title: `Kena ${worst.name} (${worst.type} ${s1(worst.seconds)} dtk) dari ${worst.by}`,
      detail: `Total ${s1(hardSeconds)} dtk tidak bisa bergerak/pakai ability sebelum mati: ${hardCC.map((c) => `${c.name} (${c.by})`).join(", ")}.`,
      fixes: [
        ownedCleanse ? `Kamu punya ${ownedCleanse.name}: pakai begitu kena ${worst.name}, jangan ditahan.` : cleanse.length ? `Anti-CC: ${cleanse.join(" atau ")}.` : "Beli item anti-CC.",
        enemyF?.castRange ? `Jangan jalan duluan dalam ${Math.round(enemyF.castRange)}m dari ${worst.by} saat ${worst.name} siap${enemyF.cooldown ? ` (CD ${Math.round(enemyF.cooldown)} dtk)` : ""}.` : `Biarkan teman di depan saat ${worst.by} punya ${worst.name}.`,
        ...(myEscape.length ? [`Simpan ${myEscape[0].name} untuk keluar setelah CC habis, bukan untuk masuk.`] : []),
      ],
    });
  }

  // 5) lost a duel
  if (attackers.size <= 1 && heroesHit[0] && (d.durationS ?? 0) >= 3) {
    const enemy = players.find((p) => p.heroId === heroesHit[0][0] && p.team !== me.team);
    const md = input.matchupDelta(heroesHit[0][0]);
    const nwGap = enemy ? enemy.netWorth - d.netWorth : 0;
    const why: string[] = [];
    if (md != null && md <= -0.02) why.push(`matchup berat (${Math.round(md * 1000) / 10}%)`);
    if (nwGap >= 2000) why.push(`dia ${k(nwGap)} lebih kaya`);
    causes.push({
      key: "duel",
      weight: 2 + (why.length ? 1.5 : 0),
      title: `Kalah 1v1 vs ${heroName(heroesHit[0][0])}`,
      detail: why.length ? `Duel yang sulit: ${why.join(", ")}.` : `Fight ${s1(d.durationS ?? 0)} dtk, satu lawan.`,
      fixes: why.length
        ? [`Hindari 1v1 dengan ${heroName(heroesHit[0][0])} sampai selisih souls tertutup atau ada teman.`, "Ambil trade pendek lalu mundur, jangan all-in."]
        : ["Fight satu lawan tetap kalah: cek cooldown ability utama kamu sebelum masuk, dan mundur saat HP <50%."],
    });
  }

  // 6) tower
  const towerPct = sources.filter((s) => s.kind === "tower/creep").reduce((s, x) => s + x.pct, 0);
  if (towerPct >= 0.25) {
    causes.push({
      key: "tower",
      weight: 1.5 + towerPct * 3,
      title: "Mati di bawah tower lawan",
      detail: `${pct(towerPct)} damage dari tower/creep.`,
      fixes: ["Jangan kejar ke bawah Guardian/Walker lawan tanpa wave atau tank di depan.", "Biarkan target kabur kalau dia sudah di bawah tower."],
    });
  }

  // 7) heal cut
  const ah = cc.filter((c) => c.type === "anti-heal");
  if (ah.length && input.myKit.concat(me.itemIds.map((id) => lab.get(id)).filter((x): x is LabItem => !!x).map((x) => features(x))).some((f) => f.heal)) {
    causes.push({
      key: "antiheal",
      weight: 1,
      title: `Heal kamu dipotong (${ah.map((a) => a.name).join(", ")})`,
      detail: `${ah[0].by} memasang anti-heal, sustain kamu tidak menyelamatkan.`,
      fixes: [`Melawan ${ah[0].by}, jangan andalkan heal: trade pendek dan mundur lebih cepat.`],
    });
  }

  if (!causes.length) {
    causes.push({
      key: "unknown",
      weight: 0,
      title: killer ? `Dibunuh ${killer}` : "Mati",
      detail: d.damage.length ? "Damage tersebar, tidak ada satu penyebab dominan." : "Detail damage tidak tersedia di broadcast (hanya killfeed).",
      fixes: d.alliesAlive < d.enemiesAlive ? ["Jumlah tim kamu kalah saat itu: main lebih dekat dengan tim."] : [],
    });
  }

  causes.sort((a, b) => b.weight - a.weight);
  const fixes = [...new Set(causes.flatMap((c) => c.fixes))].slice(0, 4);
  const headline = `${clock(d.gameTimeS)} · ${causes[0].title}${d.lostGold ? ` · −${k(d.lostGold)} souls` : ""}`;
  return {
    tick: d.tick,
    gameTimeS: d.gameTimeS,
    killer,
    headline,
    sources: sources.slice(0, 6),
    cc: cc.map(({ f: _f, ...c }) => c),
    causes,
    fixes,
    hasRecap: d.damage.length > 0,
  };
}

/** Patterns across all my deaths this match. */
export function deathPatterns(reviews: DeathReview[], deaths: DeathRecord[], heroName: (id: number) => string, players: LivePlayer[]): DeathPattern {
  const text: string[] = [];
  const byAccount = new Map(players.map((p) => [p.accountId, p]));
  const killers = new Map<string, number>();
  for (const d of deaths) {
    const kp = d.killerAccount ? byAccount.get(d.killerAccount) : undefined;
    if (kp) killers.set(heroName(kp.heroId), (killers.get(heroName(kp.heroId)) ?? 0) + 1);
  }
  const rep = [...killers.entries()].sort((a, b) => b[1] - a[1])[0];
  if (rep && rep[1] >= 2) text.push(`${rep[0]} sudah membunuhmu ${rep[1]}×: anggap dia ancaman utama, cek posisinya sebelum farm sendirian.`);
  const causeCount = new Map<string, number>();
  for (const r of reviews) causeCount.set(r.causes[0].key, (causeCount.get(r.causes[0].key) ?? 0) + 1);
  const label: Record<string, string> = {
    outnumbered: "dikeroyok",
    burst: "kena burst",
    cc: "kena CC lalu mati",
    duel: "kalah 1v1",
    tower: "mati di tower",
    headshots: "ditembak dari jauh",
  };
  for (const [key, n] of causeCount) if (n >= 2 && label[key]) text.push(`${n}× ${label[key]}: ini pola, bukan kebetulan. Perbaiki ini dulu.`);
  const early = deaths.filter((d) => d.gameTimeS < 600).length;
  if (early >= 3) text.push(`${early}× mati di 10 menit pertama: main lane lebih aman, farm dulu.`);
  const lonely = deaths.filter((d) => d.enemiesAlive - d.alliesAlive >= 2).length;
  if (lonely >= 2) text.push(`${lonely}× mati saat tim kalah jumlah: tunggu teman respawn sebelum bergerak.`);
  return { deaths: deaths.length, text };
}
