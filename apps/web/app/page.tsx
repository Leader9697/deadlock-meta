import Link from "next/link";
import { formatPct, type Tier } from "@deadlock/core";
import { FilterBar } from "@/components/FilterBar";
import { HeroIcon, Pct, TierBadge, WinBar } from "@/components/ui";
import { getHeroMap, getHeroMeta, getPhases, getRanks } from "@/lib/data";
import { filterQuery, parseFilters } from "@/lib/filters";

export const dynamic = "force-dynamic";

const TIERS: Tier[] = ["S", "A", "B", "C", "D"];

export default async function TierListPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const f = parseFilters(await searchParams);
  const [meta, heroes, ranks, phases] = await Promise.all([getHeroMeta(f.days, f.badge), getHeroMap(), getRanks(), getPhases(f.days, f.badge)]);
  const rows = meta.filter((r) => heroes.has(r.heroId));
  const totalMatches = Math.round(rows.reduce((s, r) => s + r.matches, 0) / 12);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-bold">Hero Terkuat</h1>
          <p className="mt-1 text-sm text-muted">
            {totalMatches.toLocaleString("id-ID")} match · tier dari Wilson lower bound win rate (sampel kecil dihukum)
          </p>
        </div>
        <FilterBar ranks={ranks} days={f.days} badge={f.badge} />
      </div>

      <details className="rounded-xl border border-brass/40 bg-brass/5 px-4 py-3 text-sm" open={!f.badge && f.days === -1}>
        <summary className="cursor-pointer font-semibold text-brass">Bingung mulai dari mana? Alur pakai website ini</summary>
        <ol className="mt-2 list-decimal space-y-1 pl-5">
          <li>
            <b>Pilih hero</b> dari halaman ini (tier S/A = paling kuat sekarang). Kalau sudah di layar pick dan tahu hero tim/lawan, pakai{" "}
            <Link href="/draft" className="text-brass">Draft</Link>.
          </li>
          <li>
            <b>Klik hero-nya</b>: lihat <i>Core build per fase</i> (urutan item early → very late) dan apa yang diubah patch terakhir.
          </li>
          <li>
            <b>Begitu tahu lawan</b>: buka <Link href="/counter" className="text-brass">Build vs Lawan</Link>, pilih hero kamu + hero lawan → build yang
            sudah disesuaikan (item FLEX).
          </li>
          <li>
            <b>Saat main</b>: overlay desktop yang menyesuaikan build dan memberi saran dari kondisi match.
          </li>
        </ol>
        <p className="mt-2 text-xs text-muted">
          <b className="text-fg">Filter:</b> biarkan Periode <i>Otomatis</i> (pakai data sejak patch terakhir kalau sudah cukup, jadi sesuai kondisi game
          sekarang). <b className="text-fg">Rank min.</b>: pilih rank kamu atau satu di bawahnya, supaya data dari pemain selevel. <i>Tren Meta</i> = siapa
          yang naik/turun dibanding periode sebelumnya; <i>Hero Terkuat</i> = siapa yang paling kuat sekarang.
        </p>
      </details>

      {/* Tier strip: quick visual overview */}
      <div className="grid gap-2">
        {TIERS.map((t) => {
          const hs = rows.filter((r) => r.tier === t);
          if (!hs.length) return null;
          return (
            <div key={t} className="flex items-center gap-3 rounded-xl border border-line bg-panel/70 p-2">
              <TierBadge tier={t} />
              <div className="flex flex-wrap gap-1.5">
                {hs.map((r) => (
                  <Link key={r.heroId} href={`/heroes/${r.heroId}${filterQuery(f)}`} title={`${heroes.get(r.heroId)?.name} · ${formatPct(r.winrate)}`}>
                    <HeroIcon hero={heroes.get(r.heroId)} size={44} className="transition hover:ring-brass" />
                  </Link>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <div className="overflow-hidden rounded-xl border border-line">
        <table className="w-full text-sm">
          <thead className="bg-panel-2 text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-3 py-2.5 font-medium">#</th>
              <th className="px-3 py-2.5 font-medium">Hero</th>
              <th className="px-3 py-2.5 font-medium">Win rate</th>
              <th className="hidden px-3 py-2.5 text-right font-medium sm:table-cell">Pick</th>
              <th className="hidden px-3 py-2.5 text-center font-medium lg:table-cell">Kuat di</th>
              <th className="hidden px-3 py-2.5 text-right font-medium md:table-cell">K / D / A</th>
              <th className="hidden px-3 py-2.5 text-right font-medium md:table-cell">Souls</th>
              <th className="px-3 py-2.5 text-right font-medium">Match</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line bg-panel/60">
            {rows.map((r, i) => {
              const h = heroes.get(r.heroId);
              return (
                <tr key={r.heroId} className="hover:bg-panel-2/70">
                  <td className="px-3 py-2 text-muted num">{i + 1}</td>
                  <td className="px-3 py-2">
                    <Link href={`/heroes/${r.heroId}${filterQuery(f)}`} className="flex items-center gap-3">
                      <HeroIcon hero={h} size={34} />
                      <span className="font-medium">{h?.name}</span>
                      <TierBadge tier={r.tier} />
                    </Link>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex w-36 flex-col gap-1">
                      <Pct value={r.winrate} />
                      <WinBar value={r.winrate} />
                    </div>
                  </td>
                  <td className="hidden px-3 py-2 text-right num sm:table-cell">{formatPct(r.pickRate)}</td>
                  <td className="hidden px-3 py-2 text-center text-xs lg:table-cell">
                    <PhaseTag peak={phases.get(r.heroId)?.peak ?? null} />
                  </td>
                  <td className="hidden px-3 py-2 text-right text-muted num md:table-cell">
                    {r.avgKills.toFixed(1)} / {r.avgDeaths.toFixed(1)} / {r.avgAssists.toFixed(1)}
                  </td>
                  <td className="hidden px-3 py-2 text-right text-muted num md:table-cell">{Math.round(r.avgNetWorth / 1000)}k</td>
                  <td className="px-3 py-2 text-right text-muted num">{r.matches.toLocaleString("id-ID")}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const PHASE_TAG = {
  early: { label: "EARLY", cls: "bg-weapon/15 text-weapon" },
  mid: { label: "MID", cls: "bg-tier-b/15 text-tier-b" },
  late: { label: "LATE", cls: "bg-spirit/15 text-spirit" },
} as const;

function PhaseTag({ peak }: { peak: keyof typeof PHASE_TAG | null }) {
  if (!peak) return <span className="text-muted">–</span>;
  const t = PHASE_TAG[peak];
  return <span className={`rounded px-1.5 py-0.5 font-semibold ${t.cls}`}>{t.label}</span>;
}
