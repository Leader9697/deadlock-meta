/**
 * Your hero's own combo, built from the ability numbers (same feature extraction as the
 * item playbook): open with the strongest lock, shred before damage, keep targets in
 * area damage while they are locked, finish with the execute / ultimate, and keep the
 * escape for leaving. Owned CC items are slotted in right after the opener ends.
 */

import { isCC, lockSeconds, type Feat } from "./playbook";


export interface ComboStep {
  id: number;
  name: string;
  role: "buka" | "item" | "shred" | "damage" | "tutup" | "kabur";
  note: string;
  isItem: boolean;
}

export interface HeroCombo {
  steps: ComboStep[];
  notes: string[];
}

/** seconds the target is affected (stun/sleep/hold, else slow duration) */
const effectSeconds = (f: Feat) => f.stun ?? f.sleep ?? f.hold ?? f.silence ?? f.slow?.dur ?? 0;
const s1 = (x: number) => (Math.round(x * 100) / 100).toString().replace(".", ",");
const lockText = (f: Feat) =>
  f.stun ? `stun ${s1(f.stun)} dtk` : f.sleep ? `sleep ${s1(f.sleep)} dtk` : f.hold ? `kunci ${s1(f.hold)} dtk` : f.silence ? `silence ${s1(f.silence)} dtk` : f.slow ? `slow ${f.slow.pct}%` : "CC";

export function heroCombo(kit: Feat[], ownedItems: Feat[] = []): HeroCombo {
  const used = new Set<number>();
  const steps: ComboStep[] = [];
  const add = (f: Feat, role: ComboStep["role"], note: string) => {
    used.add(f.id);
    steps.push({ id: f.id, name: f.name, role, note, isItem: f.isItem });
  };

  // opener: strongest lock; an ultimate only if it is the only CC
  const cc = kit.filter((a) => isCC(a) && lockSeconds(a) > 0).sort((a, b) => Number(a.ult) - Number(b.ult) || lockSeconds(b) - lockSeconds(a));
  const opener = cc[0];
  if (opener) add(opener, "buka", `${lockText(opener)}${opener.castRange ? `, jarak ${Math.round(opener.castRange)}m` : ""}: buka di sini supaya sisa combo pasti kena`);

  // owned CC item extends the lock right after the opener ends
  const ccItem = ownedItems.filter((i) => i.active && isCC(i) && !i.silence && !i.disarm).sort((a, b) => lockSeconds(b) - lockSeconds(a))[0];
  if (opener && ccItem) add(ccItem, "item", `tepat saat ${opener.name} habis: target tertahan ±${s1(effectSeconds(opener) + effectSeconds(ccItem))} dtk, bukan ${s1(Math.max(effectSeconds(opener), effectSeconds(ccItem)))} dtk kalau dipakai bersamaan`);

  const shred = kit.find((a) => !used.has(a.id) && (a.shredBullet || a.shredSpirit));
  if (shred) add(shred, "shred", `resist ${shred.shredBullet ? `peluru −${shred.shredBullet}%` : `spirit −${shred.shredSpirit}%`}: semua damage berikutnya lebih besar`);

  const zone = kit.filter((a) => !used.has(a.id) && !a.ult && (a.dot || a.aoe || a.burst) && !a.mobility).sort((a, b) => Number(b.dot) - Number(a.dot));
  for (const z of zone.slice(0, 2)) add(z, "damage", z.dot ? `damage berkelanjutan${z.duration ? ` ${s1(z.duration)} dtk` : ""}: pakai selagi target terkunci` : "burst selagi target tidak bisa kabur");

  const ult = kit.find((a) => a.ult && !used.has(a.id));
  const execute = kit.find((a) => !used.has(a.id) && a.execute);
  const finisher = execute ?? ult;
  if (finisher) {
    const note = finisher.execute
      ? `penutup saat target di bawah ${finisher.execute}% HP${finisher.skillshot ? "; perlu aim/charge, pakai saat target masih terkunci/melambat" : ""}`
      : finisher.channel
        ? `channel ${s1(finisher.channel)} dtk: pastikan target terkunci dan tidak ada yang bisa memotong`
        : finisher.skillshot
          ? "perlu aim/charge: pakai selagi target terkunci"
          : "penutup / damage terbesar";
    add(finisher, "tutup", note);
  }

  const escape = kit.find((a) => !used.has(a.id) && (a.mobility || a.stealth));
  if (escape) add(escape, "kabur", "simpan untuk keluar setelah combo atau saat di-gank; jangan dipakai untuk masuk kecuali target pasti mati");

  // anything left (e.g. utility) at the end without forcing a role
  const notes: string[] = [];
  const inCombo = steps.map((st) => kit.find((a) => a.id === st.id)).filter((a): a is Feat => !!a && !!a.cooldown);
  const basic = inCombo.filter((a) => !a.ult && steps.find((st) => st.id === a.id)?.role !== "kabur").map((a) => a.cooldown!);
  const ultF = inCombo.find((a) => a.ult);
  if (basic.length) notes.push(`Combo tanpa ult siap tiap ±${Math.round(Math.max(...basic))} dtk. Di antara itu, trade pendek saja.`);
  if (ultF?.cooldown)
    notes.push(
      ultF.cooldown >= 90
        ? `${ultF.name} (ult) cooldown ${Math.round(ultF.cooldown)} dtk: simpan untuk fight yang menentukan (objektif, mid boss), jangan untuk 1 kill di lane.`
        : `${ultF.name} (ult) cooldown cuma ${Math.round(ultF.cooldown)} dtk: pakai setiap ada target yang bisa dibunuh.`,
    );
  if (!opener) notes.push("Hero ini tidak punya CC pengunci: buka fight setelah teman memberi CC, atau pakai item slow/stun.");
  return { steps, notes };
}
