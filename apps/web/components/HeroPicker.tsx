"use client";

/* eslint-disable @next/next/no-img-element */
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState, useTransition } from "react";

export interface PickerHero {
  id: number;
  name: string;
  img?: string;
}

const MAX_ENEMIES = 6;

export function HeroPicker({ heroes, hero, enemies }: { heroes: PickerHero[]; hero?: number; enemies: number[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [pending, start] = useTransition();
  const [mode, setMode] = useState<"me" | "enemy">(hero ? "enemy" : "me");
  const [me, setMe] = useState<number | undefined>(hero);
  const [foes, setFoes] = useState<number[]>(enemies);
  const [query, setQuery] = useState("");

  const byId = useMemo(() => new Map(heroes.map((h) => [h.id, h])), [heroes]);
  const shown = heroes.filter((h) => h.name.toLowerCase().includes(query.toLowerCase()));
  const dirty = me !== hero || foes.join(",") !== enemies.join(",");

  function click(id: number) {
    if (mode === "me") {
      setMe(me === id ? undefined : id);
      setFoes((f) => f.filter((x) => x !== id));
      setMode("enemy");
    } else {
      if (id === me) return;
      setFoes((f) => (f.includes(id) ? f.filter((x) => x !== id) : f.length >= MAX_ENEMIES ? f : [...f, id]));
    }
  }

  function apply() {
    const p = new URLSearchParams(sp.toString());
    if (me) p.set("hero", String(me));
    else p.delete("hero");
    if (foes.length) p.set("enemies", foes.join(","));
    else p.delete("enemies");
    start(() => router.push(`${pathname}?${p.toString()}`, { scroll: false }));
  }

  const slot = (id: number | undefined, label: string, onClear: () => void, active: boolean, onActivate: () => void) => (
    <button
      type="button"
      onClick={id ? onClear : onActivate}
      className={`flex h-14 w-14 items-center justify-center overflow-hidden rounded-lg border text-[10px] text-muted ${
        active ? "border-brass" : "border-line"
      } bg-panel-2`}
      title={id ? `Hapus ${byId.get(id)?.name}` : label}
    >
      {id && byId.get(id)?.img ? (
        <img src={byId.get(id)!.img} alt="" className="h-full w-full object-cover" />
      ) : id ? (
        <span className="px-1 text-center text-fg">{byId.get(id)?.name}</span>
      ) : (
        label
      )}
    </button>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-6">
        <div>
          <p className="mb-1.5 text-xs uppercase tracking-wide text-muted">Hero kamu</p>
          {slot(me, "pilih", () => setMe(undefined), mode === "me", () => setMode("me"))}
        </div>
        <div>
          <p className="mb-1.5 text-xs uppercase tracking-wide text-muted">Tim lawan ({foes.length}/6)</p>
          <div className="flex flex-wrap gap-1.5">
            {Array.from({ length: MAX_ENEMIES }).map((_, i) => (
              <span key={i}>
                {slot(foes[i], "+", () => setFoes((f) => f.filter((x) => x !== foes[i])), mode === "enemy" && i === foes.length, () => setMode("enemy"))}
              </span>
            ))}
          </div>
        </div>
        <button
          type="button"
          onClick={apply}
          disabled={!foes.length || pending}
          className={`h-10 rounded-md px-5 text-sm font-semibold transition ${
            foes.length && dirty ? "bg-brass text-ink hover:brightness-110" : "bg-panel-2 text-muted"
          } disabled:opacity-50`}
        >
          {pending ? "Menghitung…" : "Hitung counter"}
        </button>
      </div>

      <div className="rounded-xl border border-line bg-panel/70 p-3">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="flex rounded-md border border-line p-0.5 text-xs">
            {(["me", "enemy"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`rounded px-3 py-1 ${mode === m ? "bg-brass text-ink" : "text-muted"}`}
              >
                {m === "me" ? "Pilih hero saya" : "Pilih lawan"}
              </button>
            ))}
          </div>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Cari hero…"
            className="min-w-0 flex-1 rounded-md border border-line bg-panel-2 px-3 py-1.5 text-sm outline-none focus:border-brass"
          />
        </div>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(52px,1fr))] gap-1.5">
          {shown.map((h) => {
            const isMe = h.id === me;
            const isFoe = foes.includes(h.id);
            return (
              <button
                key={h.id}
                type="button"
                onClick={() => click(h.id)}
                title={h.name}
                className={`relative aspect-square overflow-hidden rounded-md ring-2 transition ${
                  isMe ? "ring-win" : isFoe ? "ring-loss" : "ring-transparent opacity-80 hover:opacity-100"
                }`}
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
