import type { CounterItem, Hero, Item, ItemSlotType, PhasePlan, PlanStep } from "@deadlock/core";
import { adaptCoreToLineup, flowPhasePlan, GAME_PHASES, phaseRange, planToText, type AdaptedPhase } from "@deadlock/core";
import { CopyButton } from "@/components/CopyButton";
import { FilterBar } from "@/components/FilterBar";
import { HeroPicker } from "@/components/HeroPicker";
import { Delta, EmptyState, heroImg, HeroIcon, ItemIcon, Panel, Pct, SLOT_LABEL, SLOT_TEXT } from "@/components/ui";
import { getHeroes, getItemFlow, getItemMap, getPhaseCounter, getRanks, ITEM_PHASE_S } from "@/lib/data";
import { parseFilters, parseIdList } from "@/lib/filters";

export const dynamic = "force-dynamic";

const SLOTS: ItemSlotType[] = ["weapon", "vitality", "spirit"];
const PHASE_LABEL = Object.fromEntries(GAME_PHASES.map((p) => [p.key, p.label]));
const fmt = (n: number) => n.toLocaleString("id-ID");

export default async function CounterPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const f = parseFilters(sp);
  const heroIdRaw = Number(Array.isArray(sp.hero) ? sp.hero[0] : sp.hero);
  const enemies = parseIdList(sp.enemies);

  const [heroes, ranks, items] = await Promise.all([getHeroes(), getRanks(), getItemMap()]);
  const heroMap = new Map(heroes.map((h) => [h.id, h]));
  const heroId = heroMap.has(heroIdRaw) ? heroIdRaw : undefined;
  const validEnemies = enemies.filter((e) => heroMap.has(e) && e !== heroId);

  const [result, flow] = await Promise.all([
    validEnemies.length ? getPhaseCounter(heroId, validEnemies, f) : null,
    heroId ? getItemFlow(heroId, f.days, f.badge).catch(() => null) : null,
  ]);
  const core = flow ? flowPhasePlan(flow, ITEM_PHASE_S, items) : null;
  const adapted =
    result && core && core.plan.some((p) => p.steps.length) ? adaptCoreToLineup(core, result, items, (id) => heroMap.get(id)?.name ?? `#${id}`) : null;
  const byPhase = result ? new Map(result.plan.map((p) => [p.phase.key, result.byPhase.get(p.phase.key) ?? []])) : null;
  const total = result?.plan.reduce((s, p) => s + p.steps.length, 0) ?? 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-bold">Build vs Lawan</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Urutan beli per fase melawan komposisi ini. Tiap fase dihitung terpisah dari item yang <b className="text-fg">dibeli di waktu itu</b>, jadi
            item yang bagus di early vs lineup ini tidak tercampur dengan item late game. Pilih hero kamu supaya hasilnya spesifik.
          </p>
        </div>
        <FilterBar ranks={ranks} days={f.days} badge={f.badge} />
      </div>

      <HeroPicker heroes={heroes.map((h) => ({ id: h.id, name: h.name, img: heroImg(h) }))} hero={heroId} enemies={validEnemies} />

      {!result ? (
        <Panel>
          <EmptyState>Pilih minimal satu hero lawan, lalu tekan “Hitung counter”.</EmptyState>
        </Panel>
      ) : (
        <>
          {adapted && heroId ? (
            <Panel
              title={`Build ${heroMap.get(heroId)?.name} vs lineup ini`}
              right={
                <CopyButton
                  text={adapted
                    .filter((p) => p.steps.length)
                    .map((p) => `${p.phase.label}: ${p.steps.map((s) => items.get(s.itemId)?.name ?? s.itemId).join(" > ")}`)
                    .join("\n")}
                  label="Copy build"
                />
              }
            >
              <AdaptedBuild phases={adapted} items={items} />
              <p className="mt-3 text-[11px] text-muted">
                Core = urutan item hero ini dari data match per fase. FLEX = slot yang diganti counter vs lineup ini (maks 1 di early, 2 per fase
                setelahnya, hanya kalau counter-nya jelas lebih baik dari item yang diganti). Saat main, overlay menyesuaikan lagi dari item lawan yang
                sebenarnya.
              </p>
            </Panel>
          ) : heroId ? null : (
            <Panel>
              <EmptyState>Pilih hero kamu juga untuk melihat core build yang sudah disesuaikan ke lineup ini.</EmptyState>
            </Panel>
          )}

          <Panel
            title="Urutan beli counter"
            right={
              total ? <CopyButton text={planToText(result.plan, (id) => items.get(id)?.name ?? String(id))} label="Copy urutan" /> : null
            }
          >
            {total === 0 ? (
              <EmptyState>Belum ada item yang naik jelas vs lineup ini (sampel per fase terlalu kecil). Coba perlebar rentang hari atau turunkan rank.</EmptyState>
            ) : (
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                {result.plan.map((p) => (
                  <PhaseColumn key={p.phase.key} plan={p} items={items} heroes={heroMap} scored={byPhase!.get(p.phase.key) ?? []} />
                ))}
              </div>
            )}
            <p className="mt-4 text-[11px] text-muted">
              Angka hijau = seberapa jauh WR item itu naik vs lineup ini dibanding biasanya, untuk pembelian di fase tersebut. Dalam satu fase, tier murah
              ditaruh duluan karena lebih cepat terbeli. Total souls = perkiraan kumulatif kalau kamu ikuti urutan ini.
            </p>
          </Panel>

          <Panel title="Hindari" right={<span className="text-xs text-muted">performanya turun vs lineup ini di fase belinya</span>}>
            {result.avoid.length ? (
              <ul className="grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-4">
                {result.avoid.map((c) => {
                  const it = items.get(c.itemId);
                  return (
                    <li key={c.itemId} className="flex items-center gap-2">
                      <ItemIcon item={it} size={32} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{it?.name}</span>
                        <span className="text-[11px] text-muted">{PHASE_LABEL[c.phase]}</span>
                      </span>
                      <Delta value={c.score} />
                    </li>
                  );
                })}
              </ul>
            ) : (
              <EmptyState>Tidak ada item yang turun jelas.</EmptyState>
            )}
          </Panel>

          <details className="group rounded-xl border border-line bg-panel/70">
            <summary className="cursor-pointer select-none px-4 py-3 font-display font-bold text-brass">Semua item counter per slot (gabungan semua fase)</summary>
            <div className="grid gap-6 p-4 pt-0 lg:grid-cols-3">
              {SLOTS.map((slot) => (
                <div key={slot}>
                  <h3 className={`mb-2 font-display font-bold ${SLOT_TEXT[slot]}`}>{SLOT_LABEL[slot]}</h3>
                  <CounterList rows={result.bySlot[slot].filter((c) => c.score > 0).slice(0, 7)} items={items} heroes={heroMap} />
                </div>
              ))}
            </div>
          </details>
        </>
      )}
    </div>
  );
}

function PhaseColumn({ plan, items, heroes, scored }: { plan: PhasePlan; items: Map<number, Item>; heroes: Map<number, Hero>; scored: CounterItem[] }) {
  const byId = new Map(scored.map((c) => [c.itemId, c]));
  return (
    <section className="rounded-lg border border-line bg-ink/30 p-3">
      <header className="mb-2 flex items-baseline justify-between">
        <h3 className="font-display text-lg font-bold">{plan.phase.label}</h3>
        <span className="text-xs text-muted">{phaseRange(plan.phase)}</span>
      </header>
      {plan.steps.length === 0 ? (
        <p className="py-3 text-center text-xs text-muted">Tidak ada counter khusus. Ikuti build biasa di fase ini.</p>
      ) : (
        <ol className="space-y-2.5">
          {plan.steps.map((s) => (
            <Step key={s.itemId} s={s} item={items.get(s.itemId)} c={byId.get(s.itemId)} heroes={heroes} />
          ))}
        </ol>
      )}
      {plan.alternatives.length ? (
        <div className="mt-3 border-t border-line pt-2">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-muted">Alternatif</div>
          <div className="flex flex-wrap gap-1.5">
            {plan.alternatives.map((a) => {
              const it = items.get(a.itemId);
              return (
                <span key={a.itemId} className="inline-flex items-center gap-1 rounded bg-panel-2 py-0.5 pl-0.5 pr-1.5 text-[11px]" title={it?.name}>
                  <ItemIcon item={it} size={20} />
                  <Delta value={a.score} />
                </span>
              );
            })}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function Step({ s, item, c, heroes }: { s: PlanStep; item?: Item; c?: CounterItem; heroes: Map<number, Hero> }) {
  return (
    <li className="flex gap-2.5">
      <span className="mt-1 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-brass text-[11px] font-bold text-ink">{s.order}</span>
      <ItemIcon item={item} size={36} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-sm font-medium">{item?.name}</span>
          <span className="text-sm font-semibold">
            <Delta value={s.score} />
          </span>
        </div>
        <div className="text-[11px] text-muted num">
          {fmt(s.cost)} · total {fmt(s.cumulativeCost)}
          {c ? (
            <>
              {" "}
              · base <Pct value={c.baselineWinrate} color={false} />
            </>
          ) : null}
        </div>
        {c?.perEnemy.length ? (
          <div className="mt-1 flex flex-wrap gap-1">
            {c.perEnemy.map((e) => (
              <span key={e.enemyHeroId} className="inline-flex items-center gap-1 rounded bg-panel-2 py-0.5 pl-0.5 pr-1.5 text-[10px]">
                <HeroIcon hero={heroes.get(e.enemyHeroId)} size={14} className="rounded-sm" />
                <Delta value={e.delta} />
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </li>
  );
}

function CounterList({ rows, items, heroes }: { rows: CounterItem[]; items: Map<number, Item>; heroes: Map<number, Hero> }) {
  if (!rows.length) return <EmptyState>Tidak ada item yang menonjol.</EmptyState>;
  return (
    <ul className="space-y-3">
      {rows.map((c) => {
        const item = items.get(c.itemId);
        return (
          <li key={c.itemId} className="flex gap-3">
            <ItemIcon item={item} size={40} />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-sm font-medium">{item?.name}</span>
                <span className="text-sm font-semibold">
                  <Delta value={c.score} />
                </span>
              </div>
              <div className="mt-0.5 flex gap-3 text-xs text-muted">
                <span>T{item?.item_tier}</span>
                <span>
                  base <Pct value={c.baselineWinrate} color={false} />
                </span>
              </div>
              <div className="mt-1.5 flex flex-wrap gap-1">
                {c.perEnemy.map((e) => (
                  <span key={e.enemyHeroId} className="inline-flex items-center gap-1 rounded bg-panel-2 py-0.5 pl-0.5 pr-1.5 text-[11px]">
                    <HeroIcon hero={heroes.get(e.enemyHeroId)} size={16} className="rounded-sm" />
                    <Delta value={e.delta} />
                  </span>
                ))}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function AdaptedBuild({ phases, items }: { phases: AdaptedPhase[]; items: Map<number, Item> }) {
  let n = 0;
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      {phases.map((p) => (
        <section key={p.phase.key} className="rounded-lg border border-line bg-ink/30 p-3">
          <header className="mb-2 flex items-baseline justify-between">
            <h3 className="font-display text-lg font-bold">{p.phase.label}</h3>
            <span className="text-xs text-muted">{phaseRange(p.phase)}</span>
          </header>
          {p.steps.length ? (
            <ol className="space-y-2">
              {p.steps.map((s) => {
                const it = items.get(s.itemId);
                n++;
                return (
                  <li key={s.itemId} className="flex gap-2.5">
                    <span className={`mt-1 grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px] font-bold text-ink ${s.kind === "flex" ? "bg-spirit" : "bg-brass"}`}>{n}</span>
                    <ItemIcon item={it} size={32} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-1.5">
                        <span className="truncate text-sm font-medium">{it?.name}</span>
                        {s.kind === "flex" ? <span className="rounded bg-spirit/20 px-1 text-[9px] font-bold text-spirit">FLEX</span> : null}
                      </div>
                      <div className="text-[11px] text-muted">
                        {s.reason}
                        {s.replaces ? ` · ganti ${items.get(s.replaces)?.name}` : ""}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className="py-2 text-center text-xs text-muted">–</p>
          )}
        </section>
      ))}
    </div>
  );
}
