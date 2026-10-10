"use client";

/* eslint-disable @next/next/no-img-element */
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";
import type { PickerHero } from "./HeroPicker";

const MAX = 6;

export function DraftPicker({ heroes, a, b }: { heroes: PickerHero[]; a: number[]; b: number[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [pending, start] = useTransition();
  const [side, setSide] = useState<"a" | "b">("a");
  const [q, setQ] = useState("");
  const byId = new Map(heroes.map((h) => [h.id, h]));

  function push(nextA: number[], nextB: number[]) {
    const p = new URLSearchParams(sp.toString());
    nextA.length ? p.set("a", nextA.join(",")) : p.delete("a");
    nextB.length ? p.set("b", nextB.join(",")) : p.delete("b");
    start(() => router.push(`${pathname}?${p.toString()}`, { scroll: false }));
  }

  function toggle(id: number) {
    if (a.includes(id)) return push(a.filter((x) => x !== id), b);
    if (b.includes(id)) return push(a, b.filter((x) => x !== id));
    if (side === "a" && a.length < MAX) push([...a, id], b);
    else if (side === "b" && b.length < MAX) push(a, [...b, id]);
  }

  const team = (ids: number[], label: string, s: "a" | "b", ring: string) => (
    <button
      type="button"
      onClick={() => setSide(s)}
      className={`rounded-xl border p-3 text-left transition ${side === s ? "border-brass bg-brass/5" : "border-line bg-panel/70"}`}
    >
      <div className="mb-2 flex items-center justify-between text-xs uppercase tracking-wide text-muted">
        <span>{label}</span>
        <span>{ids.length}/6</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {Array.from({ length: MAX }).map((_, i) => {
          const h = ids[i] != null ? byId.get(ids[i]) : undefined;
          return (
            <span key={i} className={`flex h-12 w-12 items-center justify-center overflow-hidden rounded-lg bg-panel-2 ring-1 ${h ? ring : "ring-line"}`}>
              {h?.img ? <img src={h.img} alt={h.name} className="h-full w-full object-cover" /> : <span className="text-[10px] text-muted">{h?.name ?? "+"}</span>}
            </span>
          );
        })}
      </div>
    </button>
  );

  return (
    <div className={`space-y-3 transition-opacity ${pending ? "opacity-60" : ""}`}>
      <div className="grid gap-3 md:grid-cols-2">
        {team(a, "Tim kamu (klik untuk pilih sisi)", "a", "ring-win")}
        {team(b, "Tim lawan", "b", "ring-loss")}
      </div>
      <div className="rounded-xl border border-line bg-panel/70 p-3">
        <div className="mb-3 flex items-center gap-2">
          <span className="text-xs text-muted">Menambah ke: <b className={side === "a" ? "text-win" : "text-loss"}>{side === "a" ? "tim kamu" : "lawan"}</b></span>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Cari hero…"
            className="min-w-0 flex-1 rounded-md border border-line bg-panel-2 px-3 py-1.5 text-sm outline-none focus:border-brass"
          />
          {(a.length || b.length) ? (
            <button type="button" onClick={() => push([], [])} className="rounded-md bg-panel-2 px-3 py-1.5 text-xs text-muted hover:text-fg">
              Reset
            </button>
          ) : null}
        </div>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(52px,1fr))] gap-1.5">
          {heroes
            .filter((h) => h.name.toLowerCase().includes(q.toLowerCase()))
            .map((h) => {
              const inA = a.includes(h.id);
              const inB = b.includes(h.id);
              return (
                <button
                  key={h.id}
                  type="button"
                  title={h.name}
                  onClick={() => toggle(h.id)}
                  className={`aspect-square overflow-hidden rounded-md ring-2 transition ${inA ? "ring-win" : inB ? "ring-loss" : "ring-transparent opacity-80 hover:opacity-100"}`}
                >
                  {h.img ? <img src={h.img} alt={h.name} className="h-full w-full object-cover" /> : <span className="text-[10px]">{h.name}</span>}
                </button>
              );
            })}
        </div>
      </div>
    </div>
  );
}
