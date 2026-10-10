import Link from "next/link";
import { notFound } from "next/navigation";
import { analyzeItemFlow, formatPct, phaseLabel } from "@deadlock/core";
import { FilterBar } from "@/components/FilterBar";
import { EmptyState, HeroIcon, ItemIcon, Panel, Pct } from "@/components/ui";
import { getHeroMap, getItemFlow, getItemMap, getRanks, ITEM_PHASE_S } from "@/lib/data";
import { filterQuery, parseFilters } from "@/lib/filters";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/** cell colour: adjusted WR vs the hero's baseline, ±6 pts = full intensity */
function cellStyle(d: number) {
  const a = Math.min(1, Math.abs(d) / 0.06) * 0.55;
  return { background: d >= 0 ? `rgb(103 194 127 / ${a})` : `rgb(226 103 92 / ${a})` };
}

export default async function ItemTimingPage({ params, searchParams }: Props) {
  const heroId = Number((await params).id);
  const f = parseFilters(await searchParams);
  const heroes = await getHeroMap();
  const hero = heroes.get(heroId);
  if (!hero) notFound();

  const [flow, items, ranks] = await Promise.all([getItemFlow(heroId, f.days, f.badge), getItemMap(), getRanks()]);
  const a = analyzeItemFlow(flow, ITEM_PHASE_S, { maxItems: 40 });
  const cols = Array.from({ length: a.columns }, (_, i) => i);
  const shop = a.items.filter((t) => {
    const it = items.get(t.itemId);
    return it && it.type === "upgrade";
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex items-center gap-4">
          <HeroIcon hero={hero} size={56} />
          <div>
            <Link href={`/heroes/${heroId}${filterQuery(f)}`} className="text-xs text-muted hover:text-brass">
              ← {hero.name}
            </Link>
            <h1 className="font-display text-3xl font-bold">Timing & alur item</h1>
            <p className="text-sm text-muted">
              {a.matches.toLocaleString("id-ID")} match · WR dasar <Pct value={a.baselineWr} /> · durasi rata-rata{" "}
              {Math.round(a.avgDurationS / 60)} mnt
            </p>
          </div>
        </div>
        <FilterBar ranks={ranks} days={f.days} badge={f.badge} />
      </div>

      <Panel
        title="WR per waktu beli"
        right={<span className="text-xs text-muted">WR disesuaikan net worth saat beli · kotak emas = waktu terbaik</span>}
      >
        {shop.length === 0 ? (
          <EmptyState>Data kurang untuk filter ini.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-xs">
              <thead className="text-left text-muted">
                <tr>
                  <th className="pb-2 font-medium">Item</th>
                  {cols.map((c) => (
                    <th key={c} className="pb-2 text-center font-medium">
                      {phaseLabel(c, a.phaseSeconds, a.columns)}
                    </th>
                  ))}
                  <th className="pb-2 font-medium">Beli sebelum</th>
                  <th className="pb-2 font-medium">Biasanya lanjut ke</th>
                </tr>
              </thead>
              <tbody>
                {shop.map((t) => {
                  const it = items.get(t.itemId);
                  const cell = new Map(t.cells.map((c) => [c.column, c]));
                  return (
                    <tr key={t.itemId} className="border-t border-line">
                      <td className="py-1.5 pr-2">
                        <div className="flex items-center gap-2">
                          <ItemIcon item={it} size={26} />
                          <span className="max-w-[140px] truncate">{it?.name}</span>
                        </div>
                      </td>
                      {cols.map((c) => {
                        const x = cell.get(c);
                        if (!x || x.matches < 20) return <td key={c} className="px-0.5 text-center text-muted/40">·</td>;
                        const best = t.bestColumn === c;
                        return (
                          <td key={c} className="px-0.5 py-1">
                            <div
                              className={`rounded px-1 py-1 text-center ${best ? "ring-2 ring-brass" : ""}`}
                              style={cellStyle(x.adjustedWr - a.baselineWr)}
                              title={`${x.matches} match · WR mentah ${formatPct(x.rawWr)} · NW saat beli ${Math.round(x.avgNetWorthAtBuy / 1000)}k`}
                            >
                              <div className="num font-semibold">{formatPct(x.adjustedWr, 0)}</div>
                              <div className="num text-[10px] text-fg/60">{formatPct(x.pickShare, 0)}</div>
                            </div>
                          </td>
                        );
                      })}
                      <td className="px-2 text-muted">
                        {t.lastGoodColumn == null ? (
                          "tidak dianjurkan"
                        ) : t.lastGoodColumn === a.columns - 1 ? (
                          <span className="text-fg">kapan saja</span>
                        ) : (
                          <span className="text-fg">{Math.round(((t.lastGoodColumn + 1) * a.phaseSeconds) / 60)} mnt</span>
                        )}
                      </td>
                      <td className="px-2">
                        <div className="flex gap-1.5">
                          {t.next.map((n) => (
                            <span key={n.itemId} className="flex items-center gap-1" title={`${items.get(n.itemId)?.name} · ${n.matches} match`}>
                              <ItemIcon item={items.get(n.itemId)} size={20} />
                              <Pct value={n.winrate} digits={0} />
                            </span>
                          ))}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-xs text-muted">
          Angka atas: WR yang sudah dikoreksi deadlock-api supaya efek &quot;pembeli lebih kaya memang lebih sering menang&quot;
          hilang. Angka bawah: persentase pemain yang membeli item itu di fase tersebut. &quot;Beli sebelum&quot; = fase terakhir di mana
          item masih di atas WR dasar hero.
        </p>
      </Panel>
    </div>
  );
}
