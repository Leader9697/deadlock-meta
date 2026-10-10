"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

export interface RankOption {
  tier: number;
  name: string;
}

const DAYS: [string, string][] = [
  ["auto", "Otomatis (disarankan)"],
  ["patch", "Sejak patch"],
  ["3", "3 hari"],
  ["7", "7 hari"],
  ["14", "14 hari"],
  ["30", "30 hari"],
];

export function FilterBarClient({ ranks, days, badge, note }: { ranks: RankOption[]; days: number; badge: number; note?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [pending, start] = useTransition();

  function set(key: string, value: string, def: string) {
    const p = new URLSearchParams(sp.toString());
    if (value === def) p.delete(key);
    else p.set(key, value);
    const q = p.toString();
    start(() => router.push(q ? `${pathname}?${q}` : pathname, { scroll: false }));
  }

  const select =
    "rounded-md border border-line bg-panel-2 px-2.5 py-1.5 text-sm text-fg outline-none focus:border-brass";

  return (
    <div className={`flex flex-wrap items-center justify-end gap-2 transition-opacity ${pending ? "opacity-60" : ""}`}>
      <label className="flex items-center gap-2 text-xs text-muted" title="Rentang waktu match yang dihitung. Otomatis = sejak patch terakhir kalau datanya sudah cukup.">
        Periode
        <select className={select} value={days === -1 ? "auto" : days === 0 ? "patch" : String(days)} onChange={(e) => set("days", e.target.value, "auto")}>
          {DAYS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2 text-xs text-muted" title="Hanya hitung match dengan rata-rata rank minimal ini. Pilih rank kamu (atau satu di bawahnya) supaya datanya mirip lobby kamu.">
        Rank min.
        <select className={select} value={badge} onChange={(e) => set("badge", e.target.value, "0")}>
          <option value={0}>Semua rank</option>
          {ranks
            .filter((r) => r.tier > 0)
            .map((r) => (
              <option key={r.tier} value={r.tier * 10 + 1}>
                {r.name}+
              </option>
            ))}
        </select>
      </label>
      {pending ? <span className="text-xs text-brass">memuat…</span> : null}
      {note ? <span className="basis-full text-right text-[11px] text-muted">{note}</span> : null}
    </div>
  );
}
