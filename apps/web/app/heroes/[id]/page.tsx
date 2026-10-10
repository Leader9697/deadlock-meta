import Link from "next/link";
import { notFound } from "next/navigation";
import { analyzeAbilityOrders, formatClock, formatPct, heroAbilities, PHASES, type RankedBuild, type Item } from "@deadlock/core";
import { AbilityOrderPanel } from "@/components/AbilityOrderPanel";
import { CopyButton } from "@/components/CopyButton";
import { FilterBar } from "@/components/FilterBar";
import { HeroComboPanel } from "@/components/HeroComboPanel";
import { HeroImbuePanel } from "@/components/HeroImbuePanel";
import { HeroPatchCore } from "@/components/HeroPatchCore";
import { Delta, EmptyState, HeroIcon, ItemIcon, Panel, Pct, TierBadge, WinBar } from "@/components/ui";
import { getAbilityOrders, getBuilds, getCounterMatrix, getHeroItemStats, getHeroMap, getHeroMeta, getItemMap, getItems, getPhases, getRanks, getSynergy } from "@/lib/data";
import { filterQuery, parseFilters } from "@/lib/filters";
import { heroItemsByTier, matchupsFor, synergiesFor, TIER_COST, type Matchup } from "@/lib/hero-analysis";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function HeroPage({ params, searchParams }: Props) {
  const heroId = Number((await params).id);
  const f = parseFilters(await searchParams);
  const heroes = await getHeroMap();
  const hero = heroes.get(heroId);
  if (!hero) notFound();

  const [meta, itemRows, items, counters, synergy, ranks, phases, builds, orderRows, itemList] = await Promise.all([
    getHeroMeta(f.days, f.badge),
    getHeroItemStats(heroId, f.days, f.badge),
    getItemMap(),
    getCounterMatrix(f.days, f.badge),
    getSynergy(f.days, f.badge),
    getRanks(),
    getPhases(f.days, f.badge),
    getBuilds(heroId, f.days, f.badge).catch(() => [] as RankedBuild[]),
    getAbilityOrders(heroId, f.days, f.badge).catch(() => []),
    getItems(),
  ]);
  const abilities = heroAbilities(hero, itemList);
  const orders = analyzeAbilityOrders(orderRows, abilities.find((a) => a.slot === 4)?.id ?? null);
  const phase = phases.get(heroId);

  const me = meta.find((m) => m.heroId === heroId);
  const heroWr = me?.winrate ?? 0.5;
  const heroMatches = me?.matches ?? 0;

  const tiers = heroItemsByTier(itemRows, items, heroMatches);
  const matchups = matchupsFor(heroId, counters, heroWr).filter((m) => heroes.has(m.heroId));
  const best = [...matchups].sort((a, b) => b.delta - a.delta).slice(0, 6);
  const worst = [...matchups].sort((a, b) => a.delta - b.delta).slice(0, 6);
  const syn = synergiesFor(heroId, synergy, heroWr)
    .filter((m) => heroes.has(m.heroId))
    .sort((a, b) => b.delta - a.delta)
    .slice(0, 6);

  const counterLink = `/counter${filterQuery(f, { hero: heroId, enemies: worst.slice(0, 3).map((w) => w.heroId).join(",") })}`;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex items-center gap-4">
          <HeroIcon hero={hero} size={72} />
          <div>
            <div className="flex items-center gap-2">
              <h1 className="font-display text-3xl font-bold">{hero.name}</h1>
              {me ? <TierBadge tier={me.tier} /> : null}
            </div>
            {me ? (
              <p className="mt-1 text-sm text-muted">
                WR <Pct value={me.winrate} /> · pick {formatPct(me.pickRate)} · KDA {me.kda.toFixed(2)} ·{" "}
                {me.matches.toLocaleString("id-ID")} match
              </p>
            ) : (
              <p className="mt-1 text-sm text-muted">Belum ada data untuk filter ini.</p>
            )}
          </div>
        </div>
        <div className="flex flex-col items-end gap-2">
          <FilterBar ranks={ranks} days={f.days} badge={f.badge} />
          <Link href={`/heroes/${heroId}/items${filterQuery(f)}`} className="rounded-md bg-brass/15 px-3 py-1.5 text-sm font-medium text-brass hover:bg-brass/25">
            Timing & alur item →
          </Link>
        </div>
      </div>

      <HeroPatchCore heroId={heroId} heroName={hero.name} f={f} counterLink={counterLink} />

      <HeroComboPanel heroId={heroId} />

      <HeroImbuePanel heroId={heroId} f={f} />

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,320px)_1fr]">
        <Panel title="Kekuatan per fase" right={<span className="text-xs text-muted">berdasar durasi match</span>}>
          {phase ? (
            <div className="space-y-3">
              {PHASES.map((p) => {
                const st = phase.phases[p.key];
                return (
                  <div key={p.key}>
                    <div className="flex items-baseline justify-between text-sm">
                      <span className={phase.peak === p.key ? "font-semibold text-brass" : ""}>{p.label}</span>
                      <span>
                        <Pct value={st.winrate} /> <span className="text-xs text-muted num">· {st.matches.toLocaleString("id-ID")}</span>
                      </span>
                    </div>
                    <div className="mt-1">
                      <WinBar value={st.winrate} />
                    </div>
                  </div>
                );
              })}
              <p className="text-xs text-muted">
                {phase.scaling > 0.02
                  ? "Scaling: makin lama game, makin kuat. Main aman, jangan buang waktu."
                  : phase.scaling < -0.02
                    ? "Fall-off: kuat di awal. Tekan objektif sebelum menit ~28."
                    : "Stabil di semua fase."}
              </p>
            </div>
          ) : (
            <EmptyState>Data kurang.</EmptyState>
          )}
        </Panel>

        <Panel title="Build terbaik" right={<span className="text-xs text-muted">winrate dari match asli, bukan favorit</span>}>
          {builds.length === 0 ? (
            <EmptyState>Belum ada build dengan sampel cukup.</EmptyState>
          ) : (
            <ul className="space-y-4">
              {builds.map((b) => (
                <BuildRow key={b.build.hero_build_id} b={b} items={items} />
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <AbilityOrderPanel analysis={orders} abilities={abilities} />

      <Panel
        title="Item per tier"
        right={<span className="text-xs text-muted">Δ = vs rata-rata WR item di tier yang sama</span>}
      >
        <div className="grid gap-5 lg:grid-cols-2">
          {[1, 2, 3, 4].map((t) => {
            const rows = (tiers.get(t) ?? []).filter((r) => r.pickRate >= 0.03).sort((a, b) => b.delta - a.delta).slice(0, 8);
            return (
              <div key={t}>
                <h3 className="font-display mb-2 text-sm font-bold text-brass">
                  Tier {t} · {TIER_COST[t]} souls
                </h3>
                {rows.length === 0 ? (
                  <EmptyState>Data kurang.</EmptyState>
                ) : (
                  <ul className="divide-y divide-line">
                    {rows.map((r) => (
                      <li key={r.item.id} className="flex items-center gap-3 py-1.5 text-sm">
                        <ItemIcon item={r.item} size={32} />
                        <span className="min-w-0 flex-1 truncate">{r.item.name}</span>
                        <span className="w-12 text-right text-xs text-muted num" title="Rata-rata waktu beli">
                          {formatClock(r.avgBuyTimeS)}
                        </span>
                        <span className="w-12 text-right text-xs text-muted num" title="Pick rate">
                          {formatPct(r.pickRate, 0)}
                        </span>
                        <span className="w-12 text-right num">
                          <Pct value={r.winrate} />
                        </span>
                        <span className="w-12 text-right">
                          <Delta value={r.delta} />
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      </Panel>

      <div className="grid gap-6 md:grid-cols-3">
        <MatchupList title="Unggul lawan" rows={best} heroes={heroes} q={filterQuery(f)} />
        <MatchupList
          title="Kesulitan lawan"
          rows={worst}
          heroes={heroes}
          q={filterQuery(f)}
          footer={
            <Link href={counterLink} className="mt-3 block rounded-md bg-brass/15 px-3 py-2 text-center text-sm font-medium text-brass hover:bg-brass/25">
              Counter build vs mereka →
            </Link>
          }
        />
        <MatchupList title="Sinergi tim" rows={syn} heroes={heroes} q={filterQuery(f)} />
      </div>
    </div>
  );
}

function BuildRow({ b, items }: { b: RankedBuild; items: Map<number, Item> }) {
  const cats = b.build.details.mod_categories.filter((c) => c.mods?.length);
  return (
    <li className="rounded-lg border border-line bg-panel-2/40 p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="min-w-0 flex-1 truncate font-medium">{b.build.name}</span>
        <span className="text-xs text-muted num">ID {b.build.hero_build_id}</span>
        <span className="text-sm">
          <Pct value={b.winrate} /> <span className="text-xs text-muted num">· {b.matches.toLocaleString("id-ID")} match</span>
        </span>
        <CopyButton text={String(b.build.hero_build_id)} label="Copy ID" />
      </div>
      <div className="mt-2 space-y-1.5">
        {cats.slice(0, 4).map((c, ci) => (
          <div key={`${ci}-${c.name}`} className="flex items-center gap-2">
            <span className="w-24 shrink-0 truncate text-[11px] uppercase tracking-wide text-muted" title={c.name}>
              {c.name || `Grup ${ci + 1}`}
            </span>
            <div className="flex flex-wrap gap-1">
              {c.mods!.slice(0, 12).map((m, i) => (
                <ItemIcon key={`${m.ability_id}-${i}`} item={items.get(m.ability_id)} size={26} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </li>
  );
}

function MatchupList({
  title,
  rows,
  heroes,
  q,
  footer,
}: {
  title: string;
  rows: Matchup[];
  heroes: Awaited<ReturnType<typeof getHeroMap>>;
  q: string;
  footer?: React.ReactNode;
}) {
  return (
    <Panel title={title}>
      {rows.length === 0 ? (
        <EmptyState>Data kurang.</EmptyState>
      ) : (
        <ul className="space-y-2">
          {rows.map((m) => (
            <li key={m.heroId}>
              <Link href={`/heroes/${m.heroId}${q}`} className="flex items-center gap-3 text-sm">
                <HeroIcon hero={heroes.get(m.heroId)} size={30} />
                <span className="min-w-0 flex-1 truncate">{heroes.get(m.heroId)?.name}</span>
                <span className="text-xs text-muted num">{m.matches.toLocaleString("id-ID")}</span>
                <span className="w-14 text-right">
                  <Delta value={m.delta} />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {footer}
    </Panel>
  );
}
