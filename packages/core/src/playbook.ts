/**
 * Item playbook: for an item, *when* to use it, *on whom*, and *which combo* with your
 * own abilities. Everything is derived from the real numbers in the asset data
 * (CC durations, slow %, charge times, execute thresholds, cooldowns) and from the
 * live enemy profiles, not from hand-written per-hero text.
 */

import { itemTags, type LabItem, type RawProp } from "./buildlab";
import type { EnemyProfile } from "./adaptive";

// ---------------------------------------------------------------------------
// Feature extraction (abilities and item actives share the same property names)
// ---------------------------------------------------------------------------

export interface Feat {
  id: number;
  name: string;
  isItem: boolean;
  ult: boolean;
  active: boolean;
  cooldown?: number;
  castRange?: number;
  duration?: number;
  stun?: number;
  sleep?: number;
  silence?: number;
  /** tether / chain / immobilize / lift: target can't walk away */
  hold?: number;
  slow?: { pct: number; dur: number };
  dashReduce?: number;
  disarm?: number;
  antiHeal?: { pct: number; dur: number };
  shredBullet?: number;
  shredSpirit?: number;
  dot: boolean;
  burst: boolean;
  aoe: boolean;
  execute?: number;
  /** needs aim/charge: easier on a slowed/held target */
  skillshot: boolean;
  /** channel ≥ 1 s: can be interrupted */
  channel?: number;
  mobility: boolean;
  stealth: boolean;
  barrier: boolean;
  heal: boolean;
  resistBuff?: "bullet" | "spirit";
  cleanse: boolean;
  reflect: boolean;
  /** largest single damage number (impact/burst or per-second), 0 if none */
  damage?: number;
  /** charges (abilities with AbilityCharges ≥ 2) */
  charges?: number;
  /** sum of spirit-power scaling factors on the ability's numbers */
  spiritScale?: number;
  /** AoE radius in m */
  radius?: number;
}

const n = (v: RawProp["value"]) => {
  if (v == null || typeof v === "boolean") return 0;
  const x = typeof v === "number" ? v : parseFloat(String(v).replace(/m$/, ""));
  return Number.isFinite(x) ? x : 0;
};

export function features(it: LabItem, opts: { ult?: boolean } = {}): Feat {
  const P = new Map(Object.entries(it.properties ?? {}).map(([k, p]) => [k, p]));
  const v = (...keys: string[]) => {
    for (const k of keys) {
      const p = P.get(k);
      const x = p ? n(p.value) : 0;
      if (x) return x;
    }
    return 0;
  };
  const has = (re: RegExp) => [...P.entries()].some(([k, p]) => re.test(k) && n(p.value) !== 0);
  const isItem = it.type === "upgrade";
  const tags = isItem ? itemTags(it) : null;
  const dur = v("AbilityDuration", "DebuffDuration", "BuffDuration");
  const slowPct = Math.abs(v("SlowPercent", "MovementSpeedSlow", "MovementSlowPct", "EnemySlowPct", "MaxSlowPercent", "AuraSlowAmount", "ClubSlowPercent"));
  const slowDur = v("SlowDuration", "MovementSlowDuration", "ClubSlowDuration", "MaxSlowDuration") || dur;
  const ahPct = Math.abs(v("HealAmpReceivePenaltyPercent", "HealAmpRegenPenaltyPercent"));
  const f: Feat = {
    id: it.id,
    name: it.name,
    isItem,
    ult: !!opts.ult,
    active: isItem ? !!it.is_active_item : true,
    cooldown: v("AbilityCooldown") || undefined,
    castRange: v("AbilityCastRange", "Range", "MaxRange", "DashRange") || undefined,
    duration: dur || v("AbilityChannelTime", "MaxLifetime", "GroundFlameDuration") || undefined,
    stun: v("StunDuration") || undefined,
    sleep: v("SleepDuration") || undefined,
    silence: v("SilenceDuration") || undefined,
    hold: v("ImmobilizeDuration", "ChainDuration", "TetherDuration", "LiftDuration", "TossDuration", "InitialFreezeTime") || undefined,
    slow: slowPct ? { pct: slowPct, dur: slowDur } : undefined,
    dashReduce: Math.abs(v("GroundDashReductionPercent", "MaxGroundDashReductionPercent")) || undefined,
    disarm: has(/Disarm/) || (isItem && /Disarm/i.test(it.name)) ? dur || 3 : undefined,
    antiHeal: ahPct ? { pct: ahPct, dur: dur || 0 } : undefined,
    shredBullet: Math.abs(v("BulletResistReduction", "BulletArmorReduction")) || undefined,
    shredSpirit: Math.abs(v("TechArmorDamageReduction", "TechResistReduction")) || undefined,
    dot: has(/DotHealthPercent|DamagePerSecond|^DPS$|BurnDuration/),
    burst: has(/^(Damage|ImpactDamage|SpiritDamage|BonusDamage)$/),
    aoe: has(/^(Radius|ShockRadius|AuraRadius|ExplosionRadius|ExplodeRadius|ImpactRadius|FlameAuraRadius)$/),
    execute: v("LowHealthEnemyThresholdPct", "EnemyMinHealthPct") || undefined,
    skillshot: v("TimeToFullCharge", "MaxChargeDuration") >= 0.5 || (v("ShotRadius") > 0 && v("ShotRadius") <= 6) || v("AbilityCastDelay") >= 0.5,
    channel: v("AbilityChannelTime") >= 1 ? v("AbilityChannelTime") : undefined,
    mobility: has(/Dash(Speed|Range)|JumpVelocity|JumpSpeed|MaxFlyHeight|Teleport|Leap/) || !!tags?.has("mobility"),
    stealth: has(/Invis/) || !!tags?.has("stealth"),
    barrier: has(/Barrier/),
    heal: has(/^Heal(Amount|PercentAmount)$|HealingPerSecond|HealthRegen$/),
    resistBuff: isItem && it.is_active_item && v("BulletResist") >= 15 ? "bullet" : isItem && it.is_active_item && v("TechResist") >= 15 ? "spirit" : undefined,
    cleanse: !!it.is_active_item && (it.shop_filters ?? []).some((x) => x === "anti_cc" || x === "debuff_resist"),
    reflect: has(/Reflected/),
    damage: v("Damage", "ImpactDamage", "SpiritDamage", "TechDamage", "BonusDamage", "ExplodeDamage", "DamagePerSecond", "DPS", "BurnDamage") || undefined,
    charges: v("AbilityCharges") >= 2 ? v("AbilityCharges") : undefined,
    spiritScale:
      [...P.values()].reduce((s, p) => s + (p.scale_function?.specific_stat_scale_type === "ETechPower" ? Math.abs(p.scale_function.stat_scale ?? 0) : 0), 0) || undefined,
    radius: v("Radius", "AuraRadius", "ExplosionRadius", "ExplodeRadius", "ImpactRadius", "ShockRadius") || undefined,
  };
  return f;
}

/** Strongest lockdown the feature gives: seconds of stun/sleep/hold, or slow scaled down. */
export const lockSeconds = (f: Feat) => (f.stun ?? 0) + (f.sleep ?? 0) + (f.hold ?? 0) + (f.slow ? (f.slow.dur * f.slow.pct) / 100 : 0);
export const isCC = (f: Feat) => !!(f.stun || f.sleep || f.hold || f.slow || f.silence || f.disarm);
const isDanger = (f: Feat) => f.ult || (f.stun ?? 0) >= 1 || (f.hold ?? 0) >= 1 || (f.sleep ?? 0) >= 1 || (f.silence ?? 0) >= 1;

const s1 = (x: number) => (Math.round(x * 100) / 100).toString().replace(".", ",");

// ---------------------------------------------------------------------------
// Playbook
// ---------------------------------------------------------------------------

export interface PlayEnemy {
  profile: EnemyProfile;
  name: string;
  dead: boolean;
  abilities: Feat[];
}

export interface ItemPlay {
  itemId: number;
  name: string;
  active: boolean;
  cooldownS: number | null;
  /** who to use it on (offence) or against (defence) */
  target: { heroId: number; name: string; why: string } | null;
  when: string;
  combo: string[];
}

function pickTarget(enemies: PlayEnemy[], score: (e: PlayEnemy) => number) {
  let best: { e: PlayEnemy; s: number } | null = null;
  for (const e of enemies) {
    const s = score(e);
    if (s > 0 && (!best || s > best.s)) best = { e, s };
  }
  return best?.e ?? null;
}

const escapes = (e: PlayEnemy) => e.abilities.filter((a) => a.mobility || a.stealth);
const dangers = (e: PlayEnemy) => e.abilities.filter(isDanger).sort((a, b) => lockSeconds(b) + (b.ult ? 2 : 0) - (lockSeconds(a) + (a.ult ? 2 : 0)));

export function itemPlaybook(item: LabItem, mine: Feat[], enemies: PlayEnemy[]): ItemPlay {
  const f = features(item);
  const alive = enemies.filter((e) => !e.dead);
  const pool = alive.length ? alive : enemies;
  const combo: string[] = [];
  let target: ItemPlay["target"] = null;
  let when = "";
  const cd = f.cooldown
    ? f.cooldown >= 25
      ? ` Cooldown ${Math.round(f.cooldown)} dtk, jadi biasanya 1× per fight.`
      : ` Cooldown ${Math.round(f.cooldown)} dtk, bisa 2× dalam fight panjang.`
    : "";
  const moveCC = !!(f.stun || f.hold || f.sleep || f.slow);

  const offensiveCC = f.active && isCC(f);
  if (f.antiHeal) {
    const t = pickTarget(pool, (e) => (e.profile.archetypes.includes("sustain") ? 3 : 0) + (e.profile.healPerMin ?? 0) / 500 + e.profile.weight * 0.3);
    if (t) target = { heroId: t.profile.heroId, name: t.name, why: t.profile.healPerMin ? `heal ±${Math.round(t.profile.healPerMin)}/menit` : "sustain paling besar" };
    when = f.active
      ? `Pasang di awal trade sebelum dia sempat heal (−${f.antiHeal.pct}% heal selama ${s1(f.antiHeal.dur)} dtk).${cd}`
      : `Pasif: setiap ${item.item_slot_type === "spirit" ? "damage spirit" : item.item_slot_type === "weapon" ? "tembakan" : "damage"} kamu memberi −${f.antiHeal.pct}% heal${f.antiHeal.dur ? ` selama ${s1(f.antiHeal.dur)} dtk` : ""}. Fokus damage ke target ini, jangan disebar.`;
  } else if (offensiveCC) {
    // who: silence → the enemy with the scariest ability; slow/hold → the slipperiest; disarm → the gun carry
    if (f.silence) {
      const t = pickTarget(pool, (e) => dangers(e).length * 1.5 + escapes(e).length + e.profile.weight);
      const d = t ? dangers(t)[0] ?? escapes(t)[0] : undefined;
      if (t) target = { heroId: t.profile.heroId, name: t.name, why: d ? `cegah ${d.name}` : "ancaman terbesar" };
      when = `Silence saat dia mulai masuk fight, sebelum ${d ? d.name : "ultimate-nya"} keluar. Jangan dipakai setelah ability-nya sudah jalan.${cd}`;
    } else if (f.disarm) {
      const t = pickTarget(pool, (e) => e.profile.bulletShare * e.profile.weight * 2);
      if (t) target = { heroId: t.profile.heroId, name: t.name, why: `${Math.round(t.profile.bulletShare * 100)}% damage-nya dari peluru` };
      when = `Pakai saat dia mulai menembak dari jarak aman; ${s1(f.disarm)} dtk tanpa senjata = window kamu untuk masuk.${cd}`;
    } else {
      const t = pickTarget(pool, (e) => escapes(e).length * 1.5 + (e.profile.archetypes.includes("slippery") ? 2 : 0) + e.profile.weight);
      const esc = t ? escapes(t)[0] : undefined;
      if (t) target = { heroId: t.profile.heroId, name: t.name, why: esc ? `punya ${esc.name} untuk kabur` : "target paling bernilai" };
      const what = f.stun ? `stun ${s1(f.stun)} dtk` : f.hold ? `kunci ${s1(f.hold)} dtk` : f.slow ? `slow ${f.slow.pct}% selama ${s1(f.slow.dur)} dtk${f.dashReduce ? `, dash −${f.dashReduce}%` : ""}` : "CC";
      when = esc
        ? `Tahan sampai ${t!.name} memakai ${esc.name}, lalu pakai (${what}) supaya dia tidak bisa kabur lagi.${cd}`
        : `Pakai untuk membuka fight atau mengejar target yang kabur (${what}).${cd}`;
    }
    // interrupts: stun/silence/sleep cancel channelled enemy abilities
    if (f.stun || f.silence || f.sleep) {
      const ch = pool.flatMap((e) => e.abilities.filter((a) => a.channel).map((a) => ({ e, a }))).sort((x, y) => (y.a.channel ?? 0) - (x.a.channel ?? 0))[0];
      if (ch) combo.push(`Bisa membatalkan ${ch.a.name} milik ${ch.e.name} (channel ${s1(ch.a.channel!)} dtk): simpan untuk momen itu kalau dia punya ult siap.`);
    }
    // combos with my abilities
    const myCC = mine.filter((a) => isCC(a) && !a.isItem).sort((a, b) => lockSeconds(b) - lockSeconds(a));
    const first = myCC[0];
    if (f.disarm && !moveCC) {
      combo.push(`Disarm dulu, baru kamu commit: selama ${s1(f.disarm)} dtk dia tidak bisa membalas tembakan.`);
    }
    if (moveCC && first && (first.hold || first.stun || first.sleep)) {
      const a = (first.hold ?? 0) + (first.stun ?? 0) + (first.sleep ?? 0);
      const b = (f.stun ?? 0) + (f.hold ?? 0) + (f.slow?.dur ?? 0);
      combo.push(`${first.name} dulu (${s1(a)} dtk), pakai ${item.name} tepat saat efeknya habis: target terkunci ±${s1(a + b)} dtk, bukan ${s1(Math.max(a, b))} dtk kalau dipakai bersamaan.`);
    }
    for (const a of mine.filter((x) => x.skillshot && moveCC)) {
      combo.push(`${item.name} sebelum ${a.name}: target ${f.slow ? `melambat ${f.slow.pct}%` : "terkunci"}, ${a.name} (perlu aim/charge) jauh lebih mudah kena.`);
    }
    for (const a of mine.filter((x) => moveCC && x.dot && x.aoe && (x.duration ?? 0) >= 3 && !x.skillshot).sort((a, b) => Number(b.ult) - Number(a.ult)).slice(0, 1)) {
      combo.push(
        a.ult
          ? `${item.name} dulu, baru ${a.name} (${s1(a.duration!)} dtk area): target yang ${f.slow && !f.stun && !f.hold ? "melambat" : "terkunci"} tidak sempat keluar dari ult kamu.`
          : `Pakai saat target berada di ${a.name} (${s1(a.duration!)} dtk) supaya dia tidak bisa keluar dari area damage.`,
      );
    }
  } else if (f.active && (f.resistBuff || f.barrier || f.reflect)) {
    const side = f.resistBuff ?? (f.reflect ? "bullet" : null);
    const t = pickTarget(pool, (e) => e.profile.weight * (side === "bullet" ? e.profile.bulletShare : side === "spirit" ? 1 - e.profile.bulletShare : 1));
    if (t) target = { heroId: t.profile.heroId, name: t.name, why: side ? `sumber damage ${side === "bullet" ? "peluru" : "spirit"} terbesar` : "ancaman terbesar" };
    const d = t ? dangers(t)[0] : undefined;
    when = f.reflect
      ? `Aktifkan saat ${t?.name ?? "carry lawan"} mulai fokus tembak kamu; damage-nya memantul balik.${cd}`
      : `Jangan dipakai di awal. Aktifkan saat ${t?.name ?? "lawan"} commit ke kamu${d ? ` (biasanya setelah ${d.name})` : ""}.${cd}`;
  } else if (f.active && f.cleanse) {
    const t = pickTarget(pool, (e) => dangers(e).reduce((s, a) => s + lockSeconds(a), 0) * e.profile.weight);
    const d = t ? dangers(t)[0] : undefined;
    if (t) target = { heroId: t.profile.heroId, name: t.name, why: d ? `${d.name} (${s1(lockSeconds(d))} dtk CC)` : "CC paling berat" };
    when = d
      ? `Simpan khusus untuk ${d.name} milik ${t!.name}. Begitu kena, langsung aktifkan. Jangan dipakai untuk slow kecil.${cd}`
      : `Simpan untuk CC terberat lawan.${cd}`;
  } else if (f.active && (f.mobility || f.stealth)) {
    const t = pickTarget(pool, (e) => dangers(e).length + e.profile.weight);
    const d = t ? dangers(t)[0] : undefined;
    when = `Item kabur: simpan sampai ${d ? `${t!.name} memakai ${d.name}` : "kamu di-gank"}, jangan dipakai untuk masuk fight kalau ini satu-satunya escape.${cd}`;
    if (t) target = { heroId: t.profile.heroId, name: t.name, why: d ? `hindari ${d.name}` : "ancaman terbesar" };
  } else if (f.shredBullet || f.shredSpirit) {
    const t = pickTarget(pool, (e) => (e.profile.archetypes.includes("tank") ? 3 : 0) + e.profile.weight);
    if (t) target = { heroId: t.profile.heroId, name: t.name, why: t.profile.archetypes.includes("tank") ? "paling tanky" : "target utama" };
    when = `${f.active ? "Pasang di awal fight" : "Pasif"}: resist ${f.shredBullet ? `peluru −${f.shredBullet}%` : `spirit −${f.shredSpirit}%`}; semua damage tim ke target itu ikut naik.`;
  } else if (f.active) {
    when = `Aktif.${cd}`;
  } else {
    when = "Pasif, tidak perlu diaktifkan.";
  }

  // general combos from my kit that apply to any item
  for (const a of mine.filter((x) => (x.shredBullet || x.shredSpirit) && !x.isItem).slice(0, 1)) {
    if (f.burst || f.dot || offensiveCC) combo.push(`${a.name} dulu (resist −${a.shredBullet ?? a.shredSpirit}%), baru burst: semua damage berikutnya lebih besar.`);
  }
  const offensive = offensiveCC || !!f.antiHeal || !!f.shredBullet || !!f.shredSpirit || f.burst;
  for (const a of mine.filter((x) => x.execute && offensive).slice(0, 1)) {
    combo.push(`Tutup dengan ${a.name} saat target di bawah ${a.execute}% HP (bonus damage execute).`);
  }

  return { itemId: item.id, name: item.name, active: f.active, cooldownS: f.cooldown ?? null, target, when, combo: [...new Set(combo)].slice(0, 3) };
}

/** Abilities of a hero as features (signature4 = ultimate). */
export function heroKit(heroItems: Record<string, string> | undefined, byClass: Map<string, LabItem>): Feat[] {
  const out: Feat[] = [];
  for (let i = 1; i <= 4; i++) {
    const it = byClass.get(heroItems?.[`signature${i}`] ?? "");
    if (it) out.push(features(it, { ult: i === 4 }));
  }
  return out;
}
