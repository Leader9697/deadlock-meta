"use client";

/* eslint-disable @next/next/no-img-element */
import { useEffect, useMemo, useState } from "react";
import { autoBuildText, GAME_PHASES, type AutoBuild, type GamePhase, type LabItem, type Scenario, type ScenarioDef } from "@deadlock/core";

type AutoData = { heroId: number; heroWr: number | null; matches: number; window: string; scenarios: ScenarioDef[]; builds: AutoBuild[] };

const PHASE_LABEL: Record<GamePhase, string> = { early: "Early", mid: "Mid", late: "Late", vlate: "Very Late" };
const PHASE_CLS: Record<GamePhase, string> = { early: "bg-win/20 text-win", mid: "bg-brass/20 text-brass", late: "bg-weapon/20 text-weapon", vlate: "bg-spirit/20 text-spirit" };
const SLOT_RING: Record<string, string> = { weapon: "ring-weapon/60", vitality: "ring-vitality/60", spirit: "ring-spirit/60" };
const SLOT_TXT: Record<string, string> = { weapon: "text-weapon", vitality: "text-vitality", spirit: "text-spirit" };
const CONF_CLS = { tinggi: "text-win", sedang: "text-brass", rendah: "text-loss" } as const;

const fmt = (n: number, d = 0) => n.toLocaleString("id-ID", { maximumFractionDigits: d, minimumFractionDigits: d });
const pct = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`;

/** Items in the inventory at the end of the build (sold items and used components removed). */
export function finalInventory(b: AutoBuild): number[] {
  const owned: number[] = [];
  for (const s of b.steps) {
    for (const gone of [s.sell, s.upgradeFrom]) if (gone != null && owned.includes(gone)) owned.splice(owned.indexOf(gone), 1);
    owned.push(s.itemId);
  }
  return owned;
}

export function AutoBuildPanel({
  heroId,
  heroName,
  itemById,
  onLoad,
}: {
  heroId: number;
  heroName: string;
  itemById: Map<number, LabItem>;
  onLoad: (ids: number[], souls: number) => void;
}) {
  const [data, setData] = useState<AutoData | null | "error">(null);
  const [scenario, setScenario] = useState<Scenario>("standar");
  const [open, setOpen] = useState<number | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setData(null);
    setOpen(null);
    fetch(`/api/lab/auto/${heroId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => alive && setData(d ?? "error"))
      .catch(() => alive && setData("error"));
    return () => {
      alive = false;
    };
  }, [heroId]);

  const build = useMemo(() => (data && data !== "error" ? data.builds.find((b) => b.scenario === scenario) ?? data.builds[0] : null), [data, scenario]);
  const copy = (key: string, text: string) => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied(null), 1500);
    });
  };

  if (data === null) return <section className="rounded-xl border border-line bg-panel/70 p-3 text-sm text-muted">Menghitung build otomatis {heroName} dari data match…</section>;
  if (data === "error" || !build) return <section className="rounded-xl border border-line bg-panel/70 p-3 text-sm text-muted">Build otomatis belum bisa dihitung (data API tidak tersedia).</section>;

  const sc = data.scenarios.find((s) => s.key === build.scenario);
  const name = (id: number | null) => (id != null ? itemById.get(id)?.name ?? `#${id}` : "");
  const last = build.phases[build.phases.length - 1];

  return (
    <section className="rounded-xl border border-brass/50 bg-panel/70 p-3">
      <div className="mb-2 flex flex-wrap items-baseline gap-2">
        <h2 className="font-display text-xl font-bold text-brass">Build otomatis · {heroName}</h2>
        <span className="text-xs text-muted">Data: {data.window}</span>
      </div>

      {/* scenarios */}
      <div className="mb-2 flex flex-wrap gap-1">
        {data.scenarios.map((s) => (
          <button
            key={s.key}
            type="button"
            title={s.when}
            onClick={() => {
              setScenario(s.key);
              setOpen(null);
            }}
            className={`rounded-md px-2.5 py-1 text-xs font-semibold ${s.key === build.scenario ? "bg-brass text-ink" : "bg-panel-2 text-muted hover:text-fg"}`}
          >
            {s.label}
          </button>
        ))}
      </div>
      {sc ? <p className="mb-3 text-xs text-muted">{sc.when}</p> : null}

      {/* headline numbers */}
      <div className="mb-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-lg border border-line bg-ink/30 p-2.5">
          <div className="text-[11px] uppercase tracking-wide text-muted">Perkiraan WR build ini</div>
          {build.estWr ? (
            <>
              <div className="font-display text-2xl font-bold num">{pct(build.estWr.value)}</div>
              <div className="text-[11px] text-muted" title={build.estWr.basis}>
                keyakinan <b className={CONF_CLS[build.estWr.confidence]}>{build.estWr.confidence}</b> · {build.estWr.basis}
              </div>
            </>
          ) : (
            <div className="text-sm text-muted">WR hero belum ada di window ini.</div>
          )}
        </div>
        <div className="rounded-lg border border-line bg-ink/30 p-2.5">
          <div className="text-[11px] uppercase tracking-wide text-muted">WR {heroName}</div>
          <div className="font-display text-2xl font-bold num">{data.heroWr != null ? pct(data.heroWr) : "–"}</div>
          <div className="text-[11px] text-muted">{fmt(data.matches)} match di window data</div>
        </div>
        <div className="rounded-lg border border-line bg-ink/30 p-2.5">
          <div className="text-[11px] uppercase tracking-wide text-muted">Total belanja</div>
          <div className="font-display text-2xl font-bold num">{fmt(build.totalCost)}</div>
          <div className="text-[11px] text-muted">
            {build.steps.length} pembelian, harga persis dari tabel tier toko
          </div>
        </div>
        <div className="rounded-lg border border-line bg-ink/30 p-2.5">
          <div className="text-[11px] uppercase tracking-wide text-muted">Build publik paling mirip (untuk Auto-buy)</div>
          {build.closest ? (
            <>
              <div className="truncate text-sm font-semibold" title={build.closest.name}>
                {build.closest.name}
              </div>
              <div className="text-[11px] text-muted num">
                WR terukur {pct(build.closest.winrate)} · {fmt(build.closest.matches)} match · {build.closest.overlap}/{build.closest.size} item sama
              </div>
              <button type="button" onClick={() => copy("id", String(build.closest!.id))} className="mt-1 rounded bg-brass/15 px-2 py-0.5 text-xs font-semibold text-brass">
                {copied === "id" ? "ID tersalin" : `Copy ID ${build.closest.id}`}
              </button>
            </>
          ) : (
            <div className="text-sm text-muted">Belum ada build publik dengan cukup match.</div>
          )}
        </div>
      </div>

      {build.swaps.in.length || build.swaps.out.length ? (
        <p className="mb-3 text-xs">
          <span className="text-muted">Beda dari Standar: </span>
          {build.swaps.in.length ? <span className="text-win">+ {build.swaps.in.map(name).join(", ")}</span> : null}
          {build.swaps.in.length && build.swaps.out.length ? <span className="text-muted"> · </span> : null}
          {build.swaps.out.length ? <span className="text-loss">− {build.swaps.out.map(name).join(", ")}</span> : null}
        </p>
      ) : null}

      {/* the order, per phase */}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {GAME_PHASES.map((ph) => {
          const steps = build.steps.filter((s) => s.phase === ph.key);
          const snap = build.phases.find((p) => p.phase === ph.key);
          return (
            <div key={ph.key} className="rounded-lg border border-line bg-ink/30 p-2.5">
              <div className="mb-2 flex items-baseline gap-2">
                <span className={`rounded px-1.5 py-0.5 text-xs font-bold ${PHASE_CLS[ph.key]}`}>{PHASE_LABEL[ph.key]}</span>
                <span className="text-xs text-muted">sampai {snap?.until}</span>
                {snap ? <span className="ml-auto text-[11px] text-muted num">~{fmt(snap.netWorth)} souls</span> : null}
              </div>
              <ol className="space-y-1">
                {steps.map((s) => {
                  const it = itemById.get(s.itemId);
                  const isOpen = open === s.itemId;
                  return (
                    <li key={s.itemId}>
                      <button
                        type="button"
                        onClick={() => setOpen(isOpen ? null : s.itemId)}
                        className={`flex w-full items-center gap-2 rounded px-1 py-1 text-left text-sm hover:bg-panel-2/60 ${isOpen ? "bg-panel-2/60" : ""}`}
                      >
                        <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-brass text-[10px] font-bold text-ink">{s.order}</span>
                        <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded ring-1 ${s.slot ? SLOT_RING[s.slot] : ""} bg-panel-2`}>
                          {it?.image ? <img src={it.image} alt="" className="h-[72%] w-[72%] object-contain" /> : null}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className={`block truncate ${s.slot ? SLOT_TXT[s.slot] : ""}`}>
                            {s.name}
                            {s.situational ? <span className="ml-1 rounded bg-brass/20 px-1 text-[9px] font-bold text-brass">KONDISI</span> : null}
                          </span>
                          <span className="block text-[10px] text-muted num">
                            {s.upgradeFrom != null ? `bayar ${fmt(s.cost)} (harga ${fmt(s.fullCost)})` : fmt(s.cost)} · total {fmt(s.cumulativeCost)}
                            {s.sell != null ? ` · jual ${name(s.sell)}` : ""}
                          </span>
                        </span>
                      </button>
                      <p className={`px-1 pb-1 text-[11px] text-muted ${isOpen ? "" : "line-clamp-1"}`}>{s.reasons[0]}</p>
                      {isOpen ? (
                        <ul className="mb-1 list-disc space-y-0.5 pl-6 pr-1 text-[11px] text-muted">
                          {s.reasons.slice(1).map((r) => (
                            <li key={r}>{r}</li>
                          ))}
                        </ul>
                      ) : null}
                    </li>
                  );
                })}
                {!steps.length ? <li className="py-2 text-center text-xs text-muted">Tidak ada item yang cocok di fase ini.</li> : null}
              </ol>
              {snap ? (
                <div className="mt-2 border-t border-line pt-2 text-[10px] text-muted num">
                  DPS {fmt(snap.dps)} · EHP peluru {fmt(snap.ehpBullet)} · spirit {fmt(snap.ehpSpirit)} · SP {fmt(snap.spiritPower)}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {/* reasoning */}
      <div className="mt-3 rounded-lg border border-line bg-ink/30 p-2.5">
        <h3 className="mb-1 font-display text-sm font-bold text-brass">Kenapa build ini</h3>
        <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted">
          {build.summary.map((l) => (
            <li key={l}>{l}</li>
          ))}
          <li>
            Cara hitung: tiap slot dipilih dari WR item di hero ini (disesuaikan net worth, dibandingkan item tier yang sama, disusutkan kalau match-nya sedikit) + popularitas +
            tambahan stat nyata di net worth fase itu (rumus Kalkulator) + skala kit + kebutuhan kondisi. Tier minimum per fase dijaga (late game tidak beli T1/T2), 4 slot
            per kategori + slot flex, upgrade memotong harga komponen, slot hanya dibebaskan dengan menjual item tier lebih rendah.
          </li>
        </ul>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => onLoad(finalInventory(build), last?.netWorth ?? 40000)}
          className="rounded bg-brass/15 px-3 py-1.5 text-xs font-semibold text-brass"
        >
          Muat build akhir ke kalkulator
        </button>
        <button type="button" onClick={() => copy("text", autoBuildText(build))} className="rounded bg-panel-2 px-3 py-1.5 text-xs text-muted hover:text-fg">
          {copied === "text" ? "Urutan tersalin" : "Copy urutan beli"}
        </button>
        <span className="self-center text-[11px] text-muted">
          Auto-buy di game: pakai build publik di atas (Copy ID, cari di menu Build) atau buat build in-game dengan urutan ini sekali per hero.
        </span>
      </div>
    </section>
  );
}
