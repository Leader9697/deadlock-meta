"use client";

/* eslint-disable @next/next/no-img-element */
import { useEffect, useMemo, useState } from "react";
import {
  GAME_PHASES,
  computeStats,
  heroWeapon,
  itemInnate,
  marginalGains,
  phaseForSouls,
  phaseRange,
  scaledValues,
  type FlowPhaseItem,
  type GamePhase,
  type ItemTag,
  type LabHero,
  type LabItem,
  type LabStats,
  type PhaseCandidate,
  type PlanStep,
} from "@deadlock/core";
import type { LabInit } from "@/lib/lab-init";
import { AutoBuildPanel } from "./AutoBuildPanel";

type Slot = "weapon" | "vitality" | "spirit";
type HeroData = {
  heroWr: number | null;
  winrates: Record<number, { wr: number; delta: number; pick: number; matches: number }>;
  topBuild: { id: number; name: string; winrate: number; matches: number; items: number[] } | null;
  phases: {
    plan: { phase: GamePhase; steps: PlanStep[]; alternatives: PhaseCandidate[] }[];
    items: Record<number, FlowPhaseItem>;
    netWorthByPhase: Record<GamePhase, number>;
    baselineWr: number;
    matches: number;
  } | null;
};
const EMPTY_HERO_DATA: HeroData = { heroWr: null, winrates: {}, topBuild: null, phases: null };
const PHASE_IDX: Record<GamePhase, number> = { early: 0, mid: 1, late: 2, vlate: 3 };
const PHASE_LABEL: Record<GamePhase, string> = { early: "Early", mid: "Mid", late: "Late", vlate: "Very Late" };
const PHASE_CLS: Record<GamePhase, string> = { early: "bg-win/20 text-win", mid: "bg-brass/20 text-brass", late: "bg-weapon/20 text-weapon", vlate: "bg-spirit/20 text-spirit" };

const SLOT_CLS: Record<Slot, string> = { weapon: "text-weapon", vitality: "text-vitality", spirit: "text-spirit" };
const SLOT_RING: Record<Slot, string> = { weapon: "ring-weapon/60", vitality: "ring-vitality/60", spirit: "ring-spirit/60" };
const SLOT_LABEL: Record<Slot, string> = { weapon: "Weapon", vitality: "Vitality", spirit: "Spirit" };
const TAG_LABEL: Partial<Record<ItemTag, string>> = {
  anti_heal: "anti-heal",
  bullet_resist: "resist peluru",
  spirit_resist: "resist spirit",
  bullet_shred: "shred peluru",
  spirit_shred: "shred spirit",
  lifesteal: "lifesteal",
  healing: "heal",
  barrier: "barrier",
  slow: "slow",
  silence: "silence",
  stun: "stun",
  disarm: "disarm",
  cc_resist: "anti-CC",
  mobility: "mobilitas",
  stealth: "stealth",
  percent_damage: "dmg % HP",
};
const MAX_ITEMS = 16;

const fmt = (n: number, d = 0) => n.toLocaleString("id-ID", { maximumFractionDigits: d, minimumFractionDigits: d });
const pct = (x: number, d = 1) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(d)}%`;

export function BuildLab({ heroes, items, init = {} }: { heroes: (LabHero & { img?: string | null })[]; items: LabItem[]; init?: LabInit }) {
  const [heroId, setHeroId] = useState<number>(init.hero && heroes.some((h) => h.id === init.hero) ? init.hero : heroes[0]?.id);
  const [souls, setSouls] = useState(init.souls ?? 15000);
  const [builds, setBuilds] = useState<{ A: number[]; B: number[] }>({ A: init.a ?? [], B: init.b ?? [] });
  const [active, setActive] = useState<"A" | "B">("A");
  const [slotTab, setSlotTab] = useState<Slot>("weapon");
  const [mode, setMode] = useState<"offense" | "defense" | "balanced">("balanced");
  const [bulletShare, setBulletShare] = useState(0.5);
  const [heroData, setHeroData] = useState<HeroData | null>(null);
  const [phaseOnly, setPhaseOnly] = useState(true);

  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const shop = useMemo(() => items.filter((i) => i.type === "upgrade" && i.shopable && !i.disabled && (i.cost ?? 0) > 0 && (i.cost ?? 0) < 9999), [items]);
  const hero = heroes.find((h) => h.id === heroId)!;
  const weapon = useMemo(() => heroWeapon(hero, items), [hero, items]);
  const abilities = useMemo(
    () => [1, 2, 3, 4].map((n) => items.find((i) => i.class_name === hero.items?.[`signature${n}`])).filter((x): x is LabItem => !!x),
    [hero, items],
  );

  useEffect(() => {
    let alive = true;
    setHeroData(null);
    fetch(`/api/lab/hero/${heroId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => alive && setHeroData(d ?? EMPTY_HERO_DATA))
      .catch(() => alive && setHeroData(EMPTY_HERO_DATA));
    return () => {
      alive = false;
    };
  }, [heroId]);

  useEffect(() => {
    const p = new URLSearchParams({ hero: String(heroId), souls: String(souls) });
    if (builds.A.length) p.set("a", builds.A.join(","));
    if (builds.B.length) p.set("b", builds.B.join(","));
    window.history.replaceState(null, "", `?${p.toString()}`);
  }, [heroId, souls, builds]);

  const toItems = (ids: number[]) => ids.map((id) => itemById.get(id)).filter((x): x is LabItem => !!x);
  const buildA = toItems(builds.A);
  const buildB = toItems(builds.B);
  const statsA = useMemo(() => computeStats(hero, weapon, buildA, souls), [hero, weapon, buildA, souls]);
  const statsB = useMemo(() => (buildB.length ? computeStats(hero, weapon, buildB, souls) : null), [hero, weapon, buildB, souls]);
  const current = active === "A" ? buildA : buildB;
  const currentStats = active === "A" ? statsA : statsB ?? computeStats(hero, weapon, [], souls);
  const spentTotal = current.reduce((s, i) => s + (i.cost ?? 0), 0);

  const toggleItem = (id: number) =>
    setBuilds((b) => {
      const list = b[active];
      const next = list.includes(id) ? list.filter((x) => x !== id) : list.length >= MAX_ITEMS ? list : [...list, id];
      return { ...b, [active]: next };
    });

  const phaseInfo = heroData?.phases ?? null;
  const curPhase: GamePhase | null = phaseInfo ? phaseForSouls(souls, phaseInfo.netWorthByPhase) : null;
  const gains = useMemo(() => {
    const g = marginalGains(hero, weapon, current, shop, souls, bulletShare);
    const score = (x: (typeof g)[number]) =>
      mode === "offense" ? x.offensePer1k : mode === "defense" ? x.defencePer1k : 0.5 * x.offensePer1k + 0.5 * x.defencePer1k;
    // "sesuai fase": only items people normally buy by this phase (or earlier)
    const fits = (id: number) => {
      if (!phaseOnly || !curPhase || !phaseInfo) return true;
      const ph = phaseInfo.items[id]?.phase;
      return !ph || PHASE_IDX[ph] <= PHASE_IDX[curPhase];
    };
    return g.filter((x) => fits(x.itemId)).sort((a, b) => score(b) - score(a)).slice(0, 10);
  }, [hero, weapon, current, shop, souls, bulletShare, mode, phaseOnly, curPhase, phaseInfo]);

  /** Build A = plan steps up to and including `upto`, souls = typical net worth at the end of that phase. */
  const loadPlan = (upto: GamePhase) => {
    if (!phaseInfo) return;
    const ids = phaseInfo.plan.filter((p) => PHASE_IDX[p.phase] <= PHASE_IDX[upto]).flatMap((p) => p.steps.map((s) => s.itemId));
    setBuilds((b) => ({ ...b, A: ids.filter((id) => itemById.has(id)).slice(0, MAX_ITEMS) }));
    setActive("A");
    setSouls(Math.min(60000, Math.max(souls > 0 ? 500 : 0, phaseInfo.netWorthByPhase[upto])));
  };

  const tierGroups = [1, 2, 3, 4].map((t) => ({ t, list: shop.filter((i) => i.item_slot_type === slotTab && i.item_tier === t).sort((a, b) => a.name.localeCompare(b.name)) }));

  const itemTitle = (it: LabItem) => {
    const innate = [...itemInnate(it)].map(([k, v]) => `${k.replace("MODIFIER_VALUE_", "").toLowerCase()}: ${v}`).join("\n");
    const wr = heroData?.winrates[it.id];
    return `${it.name} (${fmt(it.cost ?? 0)})\n${innate}${wr ? `\nWR di hero ini: ${(wr.wr * 100).toFixed(1)}% (${pct(wr.delta)} vs tier) · pick ${(wr.pick * 100).toFixed(0)}%` : ""}`;
  };

  return (
    <div className="space-y-5">
      {/* hero + souls */}
      <div className="rounded-xl border border-line bg-panel/70 p-3">
        <div className="flex flex-wrap gap-1.5">
          {heroes.map((h) => (
            <button
              key={h.id}
              type="button"
              title={h.name}
              onClick={() => setHeroId(h.id)}
              className={`h-10 w-10 overflow-hidden rounded-md ring-2 ${h.id === heroId ? "ring-brass" : "ring-transparent opacity-70 hover:opacity-100"}`}
            >
              {h.img ? <img src={h.img} alt={h.name} className="h-full w-full object-cover" /> : <span className="text-[9px]">{h.name}</span>}
            </button>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-4">
          <span className="font-display text-xl font-bold">{hero.name}</span>
          <label className="flex flex-1 items-center gap-3 text-sm text-muted">
            Souls (net worth)
            <input type="range" min={0} max={60000} step={500} value={souls} onChange={(e) => setSouls(Number(e.target.value))} className="flex-1 accent-[var(--color-brass)]" />
            <span className="w-28 text-right text-fg num">
              {fmt(souls)} · lvl {statsA.level}
            </span>
            {curPhase ? <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${PHASE_CLS[curPhase]}`}>{PHASE_LABEL[curPhase]}</span> : null}
          </label>
          {spentTotal > souls ? <span className="text-xs text-loss">Build ({fmt(spentTotal)}) melebihi souls</span> : null}
        </div>
      </div>

      <AutoBuildPanel
        heroId={heroId}
        heroName={hero.name}
        itemById={itemById}
        onLoad={(ids, nw) => {
          setBuilds((b) => ({ ...b, A: ids.filter((id) => itemById.has(id)).slice(0, MAX_ITEMS) }));
          setActive("A");
          setSouls(Math.min(60000, Math.round(nw / 500) * 500));
        }}
      />

      <h2 className="font-display pt-2 text-lg font-bold">Kalkulator manual</h2>

      <PhasePlanPanel
        data={phaseInfo}
        loading={heroData === null}
        itemById={itemById}
        heroWinrates={heroData?.winrates ?? {}}
        owned={new Set(current.map((i) => i.id))}
        onToggle={toggleItem}
        onLoad={loadPlan}
      />

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_380px]">
        {/* shop */}
        <section className="rounded-xl border border-line bg-panel/70 p-3">
          <div className="mb-3 flex gap-1">
            {(["weapon", "vitality", "spirit"] as Slot[]).map((s) => (
              <button key={s} type="button" onClick={() => setSlotTab(s)} className={`flex-1 rounded-md px-2 py-1.5 text-sm font-semibold ${slotTab === s ? "bg-panel-2 " + SLOT_CLS[s] : "text-muted"}`}>
                {SLOT_LABEL[s]}
              </button>
            ))}
          </div>
          {tierGroups.map(({ t, list }) => (
            <div key={t} className="mb-3">
              <div className="mb-1 text-[11px] uppercase tracking-wide text-muted">Tier {t}{list[0] ? ` · ${fmt(list[0].cost ?? 0)}` : ""}</div>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(44px,1fr))] gap-1.5">
                {list.map((it) => {
                  const owned = current.some((c) => c.id === it.id);
                  const wr = heroData?.winrates[it.id];
                  return (
                    <button
                      key={it.id}
                      type="button"
                      title={itemTitle(it)}
                      onClick={() => toggleItem(it.id)}
                      className={`relative flex aspect-square items-center justify-center rounded-md ring-1 ${SLOT_RING[slotTab]} ${owned ? "bg-brass/30 ring-2 ring-brass" : "bg-panel-2 hover:bg-panel-2/60"}`}
                    >
                      {it.image ? <img src={it.image} alt={it.name} className="h-[72%] w-[72%] object-contain" /> : <span className="text-[8px]">{it.name}</span>}
                      {wr && Math.abs(wr.delta) >= 0.01 ? (
                        <span className={`absolute bottom-0 right-0 rounded-tl px-0.5 text-[8px] font-bold ${wr.delta > 0 ? "bg-win/80 text-ink" : "bg-loss/80 text-ink"}`}>
                          {wr.delta > 0 ? "+" : "−"}
                          {Math.abs(wr.delta * 100).toFixed(0)}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          <p className="text-[11px] text-muted">Angka kecil di pojok = WR item di hero ini vs item lain di tier yang sama (data match nyata).</p>
        </section>

        {/* builds */}
        <section className="space-y-3">
          {(["A", "B"] as const).map((k) => {
            const list = k === "A" ? buildA : buildB;
            return (
              <div key={k} className={`rounded-xl border p-3 ${active === k ? "border-brass bg-brass/5" : "border-line bg-panel/70"}`}>
                <div className="mb-2 flex items-center gap-2">
                  <button type="button" onClick={() => setActive(k)} className="font-display text-lg font-bold">
                    Build {k} {active === k ? <span className="text-xs text-brass">(aktif)</span> : null}
                  </button>
                  <span className="text-xs text-muted num">{fmt(list.reduce((s, i) => s + (i.cost ?? 0), 0))} souls</span>
                  <span className="ml-auto flex gap-1">
                    {k === "A" && heroData?.topBuild ? (
                      <button
                        type="button"
                        title={`${heroData.topBuild.name} · WR ${(heroData.topBuild.winrate * 100).toFixed(1)}% · ${heroData.topBuild.matches} match`}
                        onClick={() => setBuilds((b) => ({ ...b, A: heroData.topBuild!.items.filter((id) => itemById.has(id)).slice(0, MAX_ITEMS) }))}
                        className="rounded bg-brass/15 px-2 py-1 text-xs font-semibold text-brass"
                      >
                        Muat build terbaik
                      </button>
                    ) : null}
                    {k === "A" ? (
                      <button type="button" onClick={() => setBuilds((b) => ({ ...b, B: [...b.A] }))} className="rounded bg-panel-2 px-2 py-1 text-xs text-muted hover:text-fg">
                        Salin ke B
                      </button>
                    ) : null}
                    <button type="button" onClick={() => setBuilds((b) => ({ ...b, [k]: [] }))} className="rounded bg-panel-2 px-2 py-1 text-xs text-muted hover:text-fg">
                      Kosongkan
                    </button>
                  </span>
                </div>
                <div className="grid grid-cols-8 gap-1.5">
                  {Array.from({ length: MAX_ITEMS }).map((_, i) => {
                    const it = list[i];
                    return (
                      <button
                        key={i}
                        type="button"
                        title={it ? `${it.name} — klik untuk hapus` : "slot kosong"}
                        onClick={() => {
                          setActive(k);
                          if (it) setBuilds((b) => ({ ...b, [k]: b[k].filter((x) => x !== it.id) }));
                        }}
                        className={`relative flex aspect-square items-center justify-center rounded-md ring-1 ${it?.item_slot_type ? SLOT_RING[it.item_slot_type] + " bg-panel-2" : "ring-line bg-ink/40"}`}
                      >
                        {it?.image ? <img src={it.image} alt={it.name} className="h-[72%] w-[72%] object-contain" /> : null}
                        {it ? <span className="absolute left-0.5 top-0 text-[9px] font-bold text-muted">{i + 1}</span> : null}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}

          {/* recommendations */}
          <div className="rounded-xl border border-line bg-panel/70 p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <h3 className="font-display font-bold text-brass">Item berikutnya untuk Build {active}</h3>
              <div className="ml-auto flex rounded-md border border-line p-0.5 text-xs">
                {(
                  [
                    ["offense", "Damage"],
                    ["balanced", "Seimbang"],
                    ["defense", "Bertahan"],
                  ] as const
                ).map(([m, l]) => (
                  <button key={m} type="button" onClick={() => setMode(m)} className={`rounded px-2 py-0.5 ${mode === m ? "bg-brass text-ink" : "text-muted"}`}>
                    {l}
                  </button>
                ))}
              </div>
            </div>
            {curPhase ? (
              <label className="mb-1 flex items-center gap-2 text-xs text-muted">
                <input type="checkbox" checked={phaseOnly} onChange={(e) => setPhaseOnly(e.target.checked)} className="accent-[var(--color-brass)]" />
                Hanya item yang biasa dibeli sampai fase <b className={`rounded px-1 ${PHASE_CLS[curPhase]}`}>{PHASE_LABEL[curPhase]}</b> (ikut slider souls)
              </label>
            ) : null}
            <label className="mb-2 flex items-center gap-2 text-xs text-muted">
              Damage musuh: peluru {Math.round(bulletShare * 100)}% / spirit {Math.round((1 - bulletShare) * 100)}%
              <input type="range" min={0} max={1} step={0.05} value={bulletShare} onChange={(e) => setBulletShare(Number(e.target.value))} className="flex-1" />
            </label>
            <ul className="divide-y divide-line">
              {gains.map((g) => {
                const it = itemById.get(g.itemId)!;
                const wr = heroData?.winrates[g.itemId];
                return (
                  <li key={g.itemId}>
                    <button type="button" onClick={() => toggleItem(g.itemId)} className="flex w-full items-center gap-2 py-1.5 text-left text-sm hover:bg-panel-2/50">
                      <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded ring-1 ${it.item_slot_type ? SLOT_RING[it.item_slot_type] : ""} bg-panel-2`}>
                        {it.image ? <img src={it.image} alt="" className="h-[72%] w-[72%] object-contain" /> : null}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{it.name}</span>
                        <span className="block truncate text-[11px] text-muted">
                          {fmt(it.cost ?? 0)} · DPS {pct(g.dps)} · EHP {pct(g.defence)}
                          {g.spiritPower ? ` · SP +${fmt(g.spiritPower, 1)}` : ""}
                          {g.tags.filter((t) => TAG_LABEL[t]).length ? ` · ${g.tags.map((t) => TAG_LABEL[t]).filter(Boolean).join(", ")}` : ""}
                        </span>
                        {g.crossesThreshold ? (
                          <span className={`text-[10px] ${SLOT_CLS[g.crossesThreshold]}`}>
                            ↑ lewat ambang bonus investasi {SLOT_LABEL[g.crossesThreshold]}, item {SLOT_LABEL[g.crossesThreshold].toLowerCase()} apa pun memberi efek ini
                          </span>
                        ) : null}
                      </span>
                      {phaseInfo?.items[g.itemId] ? (
                        <span className={`rounded px-1 text-[10px] font-semibold ${PHASE_CLS[phaseInfo.items[g.itemId].phase]}`} title="fase saat item ini paling sering dibeli">
                          {PHASE_LABEL[phaseInfo.items[g.itemId].phase]}
                        </span>
                      ) : null}
                      {wr ? (
                        <span className={`text-xs num ${wr.delta >= 0 ? "text-win" : "text-loss"}`} title="WR item di hero ini vs tier-nya">
                          {pct(wr.delta)}
                        </span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
            <p className="mt-2 text-[11px] text-muted">
              Diurutkan dari tambahan DPS/EHP per 1.000 souls, termasuk efek melewati ambang bonus investasi slot. Efek pasif/aktif (proc, aura, debuff) tidak
              masuk angka DPS/EHP, lihat tag dan WR datanya.
            </p>
          </div>
        </section>

        {/* stats */}
        <section className="rounded-xl border border-line bg-panel/70 p-3">
          <StatsTable a={statsA} b={statsB} />
          <div className="mt-4">
            <h3 className="font-display mb-2 text-sm font-bold text-brass">Ability dengan Spirit Power {fmt(currentStats.spiritPower, 1)}</h3>
            <ul className="space-y-1.5 text-xs">
              {abilities.map((ab) => {
                const vals = scaledValues(ab, currentStats.spiritPower);
                return (
                  <li key={ab.id}>
                    <span className="font-medium">{ab.name}</span>
                    {vals.length ? (
                      <span className="text-muted">
                        {" "}
                        —{" "}
                        {vals.map((v) => (
                          <span key={v.key} className="mr-2">
                            {v.label}: <b className="text-fg">{fmt(v.value, 1)}</b>
                            {v.postfix} <span className="text-[10px]">({v.base}+{v.scale}×SP)</span>
                          </span>
                        ))}
                      </span>
                    ) : (
                      <span className="text-muted"> — tidak berskala spirit</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
          <div className="mt-4 text-[11px] text-muted">
            Bonus investasi:{" "}
            {(["weapon", "vitality", "spirit"] as Slot[]).map((s) => (
              <span key={s} className={`mr-2 ${SLOT_CLS[s]}`}>
                {SLOT_LABEL[s]} {fmt(currentStats.spent[s])} → +{currentStats.investment[s]}
                {s === "spirit" ? " SP" : "%"}
              </span>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function PhasePlanPanel({
  data,
  loading,
  itemById,
  heroWinrates,
  owned,
  onToggle,
  onLoad,
}: {
  data: HeroData["phases"];
  loading: boolean;
  itemById: Map<number, LabItem>;
  heroWinrates: HeroData["winrates"];
  owned: Set<number>;
  onToggle: (id: number) => void;
  onLoad: (upto: GamePhase) => void;
}) {
  if (loading) return <div className="rounded-xl border border-line bg-panel/70 p-3 text-sm text-muted">Memuat urutan build dari data match…</div>;
  if (!data || data.plan.every((p) => !p.steps.length))
    return <div className="rounded-xl border border-line bg-panel/70 p-3 text-sm text-muted">Data timing item untuk hero ini belum cukup.</div>;
  const text = data.plan
    .filter((p) => p.steps.length)
    .map((p) => `${PHASE_LABEL[p.phase]}: ${p.steps.map((s) => itemById.get(s.itemId)?.name ?? s.itemId).join(" > ")}`)
    .join("\n");
  return (
    <section className="rounded-xl border border-line bg-panel/70 p-3">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h3 className="font-display text-lg font-bold text-brass">Urutan build per fase</h3>
        <span className="text-xs text-muted">
          dari {fmt(data.matches)} match · item ditaruh di fase saat paling sering dibeli, diurutkan dari popularitas + WR (disesuaikan net worth)
        </span>
        <span className="ml-auto flex gap-1">
          <button type="button" onClick={() => onLoad("vlate")} className="rounded bg-brass/15 px-2 py-1 text-xs font-semibold text-brass">
            Muat semua ke Build A
          </button>
          <button type="button" onClick={() => navigator.clipboard?.writeText(text)} className="rounded bg-panel-2 px-2 py-1 text-xs text-muted hover:text-fg">
            Copy urutan
          </button>
        </span>
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {data.plan.map((p) => {
          const def = GAME_PHASES.find((g) => g.key === p.phase)!;
          return (
            <div key={p.phase} className="rounded-lg border border-line bg-ink/30 p-2.5">
              <div className="mb-2 flex items-baseline gap-2">
                <span className={`rounded px-1.5 py-0.5 text-xs font-bold ${PHASE_CLS[p.phase]}`}>{PHASE_LABEL[p.phase]}</span>
                <span className="text-xs text-muted">{phaseRange(def)}</span>
                <span className="ml-auto text-[11px] text-muted num">~{fmt(data.netWorthByPhase[p.phase])} souls</span>
              </div>
              {p.steps.length ? (
                <ol className="space-y-1">
                  {p.steps.map((s) => {
                    const it = itemById.get(s.itemId);
                    const fi = data.items[s.itemId];
                    const wr = heroWinrates[s.itemId];
                    if (!it) return null;
                    return (
                      <li key={s.itemId}>
                        <button
                          type="button"
                          onClick={() => onToggle(s.itemId)}
                          title={`${it.name}\nDibeli ${fi ? (fi.pickShare * 100).toFixed(0) : "?"}% pemain di fase ini · WR disesuaikan ${fi ? (fi.adjustedWr * 100).toFixed(1) : "?"}% (dasar ${(data.baselineWr * 100).toFixed(1)}%)\nKlik untuk tambah/hapus di build aktif`}
                          className={`flex w-full items-center gap-2 rounded px-1 py-1 text-left text-sm hover:bg-panel-2/60 ${owned.has(s.itemId) ? "bg-brass/10" : ""}`}
                        >
                          <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-brass text-[10px] font-bold text-ink">{s.order}</span>
                          <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded ring-1 ${it.item_slot_type ? SLOT_RING[it.item_slot_type] : ""} bg-panel-2`}>
                            {it.image ? <img src={it.image} alt="" className="h-[72%] w-[72%] object-contain" /> : null}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate">{it.name}</span>
                            <span className="block text-[10px] text-muted num">
                              {fmt(s.cost)} · total {fmt(s.cumulativeCost)}
                              {fi ? ` · pick ${(fi.pickShare * 100).toFixed(0)}%` : ""}
                            </span>
                          </span>
                          {fi ? (
                            <span className={`text-[11px] num ${fi.adjustedWr >= data.baselineWr ? "text-win" : "text-loss"}`}>
                              {pct(fi.adjustedWr - data.baselineWr)}
                            </span>
                          ) : wr ? (
                            <span className="text-[11px] text-muted num">{pct(wr.delta)}</span>
                          ) : null}
                          {owned.has(s.itemId) ? <span className="text-[10px] text-brass">✓</span> : null}
                        </button>
                      </li>
                    );
                  })}
                </ol>
              ) : (
                <p className="py-2 text-center text-xs text-muted">Belum ada data.</p>
              )}
              {p.alternatives.length ? (
                <div className="mt-2 flex items-center gap-1 border-t border-line pt-2">
                  <span className="text-[10px] uppercase tracking-wide text-muted">alt</span>
                  {p.alternatives.map((a) => {
                    const it = itemById.get(a.itemId);
                    return it ? (
                      <button key={a.itemId} type="button" title={`${it.name} — klik untuk tambah`} onClick={() => onToggle(a.itemId)} className={`flex h-6 w-6 items-center justify-center rounded ring-1 ${it.item_slot_type ? SLOT_RING[it.item_slot_type] : ""} bg-panel-2`}>
                        {it.image ? <img src={it.image} alt="" className="h-[72%] w-[72%] object-contain" /> : null}
                      </button>
                    ) : null;
                  })}
                </div>
              ) : null}
              <button type="button" onClick={() => onLoad(p.phase)} className="mt-2 w-full rounded bg-panel-2 py-1 text-[11px] text-muted hover:text-fg">
                Lihat stat di akhir {PHASE_LABEL[p.phase]} →
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function StatsTable({ a, b }: { a: LabStats; b: LabStats | null }) {
  // [label, value, decimals, unit, lowerIsBetter]
  const rows: [string, (s: LabStats) => number, number, string?, boolean?][] = [
    ["DPS sustained", (s) => s.sustainedDps, 1],
    ["DPS burst", (s) => s.burstDps, 1],
    ["DPS headshot", (s) => s.burstDps * s.headshotMult, 1],
    ["Damage / peluru", (s) => s.bulletDamage * (1 + s.weaponDamagePct / 100), 2],
    ["Weapon damage", (s) => s.weaponDamagePct, 0, "%"],
    ["Fire rate", (s) => s.fireRatePct, 0, "%"],
    ["Magazin", (s) => s.clip, 0],
    ["Reload", (s) => s.reloadS, 2, "s", true],
    ["Health", (s) => s.health, 0],
    ["Resist peluru", (s) => s.bulletResist * 100, 1, "%"],
    ["Resist spirit", (s) => s.spiritResist * 100, 1, "%"],
    ["EHP vs peluru", (s) => s.ehpBullet, 0],
    ["EHP vs spirit", (s) => s.ehpSpirit, 0],
    ["Spirit power", (s) => s.spiritPower, 1],
    ["Cooldown", (s) => s.cooldownPct, 0, "%"],
    ["Lifesteal peluru", (s) => s.bulletLifestealPct, 0, "%"],
    ["Lifesteal spirit", (s) => s.spiritLifestealPct, 0, "%"],
    ["Move speed", (s) => s.moveSpeed, 2],
  ];
  return (
    <table className="w-full text-sm">
      <thead className="text-xs text-muted">
        <tr>
          <th className="pb-1 text-left font-medium">Stat</th>
          <th className="pb-1 text-right font-medium">A</th>
          {b ? <th className="pb-1 text-right font-medium">B</th> : null}
          {b ? <th className="pb-1 text-right font-medium">Δ</th> : null}
        </tr>
      </thead>
      <tbody className="divide-y divide-line/60">
        {rows.map(([label, f, d, unit, lowerBetter]) => {
          const va = f(a);
          const vb = b ? f(b) : null;
          const diff = vb != null ? vb - va : null;
          const good = diff != null && (lowerBetter ? diff < 0 : diff > 0);
          const worse = diff != null && (lowerBetter ? diff > 0 : diff < 0);
          return (
            <tr key={label}>
              <td className="py-1 text-muted">{label}</td>
              <td className="py-1 text-right num">
                {fmt(va, d)}
                {unit ?? ""}
              </td>
              {b ? (
                <td className="py-1 text-right num">
                  {fmt(vb!, d)}
                  {unit ?? ""}
                </td>
              ) : null}
              {b ? (
                <td className={`py-1 text-right num ${good ? "text-win" : worse ? "text-loss" : "text-muted"}`}>
                  {diff! > 0 ? "+" : ""}
                  {fmt(diff!, d)}
                </td>
              ) : null}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
