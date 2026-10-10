import Link from "next/link";
import { evaluateDraft, suggestBans, suggestPicks } from "@deadlock/core";
import { DraftPicker } from "@/components/DraftPicker";
import { FilterBar } from "@/components/FilterBar";
import { Delta, EmptyState, heroImg, HeroIcon, Panel } from "@/components/ui";
import { getDraftContext, getHeroes, getRanks } from "@/lib/data";
import { filterQuery, parseFilters, parseIdList } from "@/lib/filters";

export const dynamic = "force-dynamic";

export default async function DraftPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const f = parseFilters(sp);
  const [heroes, ranks, ctx] = await Promise.all([getHeroes(), getRanks(), getDraftContext(f.days, f.badge)]);
  const heroMap = new Map(heroes.map((h) => [h.id, h]));
  const a = parseIdList(sp.a).filter((id) => heroMap.has(id));
  const b = parseIdList(sp.b).filter((id) => heroMap.has(id) && !a.includes(id));
  const pool = heroes.map((h) => h.id);

  const evalAB = a.length || b.length ? evaluateDraft(ctx, a, b) : null;
  const picks = a.length < 6 ? suggestPicks(ctx, a, b, pool, 8) : [];
  const bans = suggestBans(ctx, a, b, pool, 6);
  const p = evalAB?.winProbability ?? 0.5;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-bold">Draft</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Estimasi aditif dari data nyata: kekuatan hero + sinergi pasangan satu tim + matchup antar hero (semua di-shrink untuk sampel
            kecil). Bukan model terlatih, tapi setiap angka bisa ditelusuri.
          </p>
        </div>
        <FilterBar ranks={ranks} days={f.days} badge={f.badge} />
      </div>

      <DraftPicker heroes={heroes.map((h) => ({ id: h.id, name: h.name, img: heroImg(h) }))} a={a} b={b} />

      {evalAB ? (
        <Panel title="Estimasi draft">
          <div className="flex flex-wrap items-center gap-6">
            <div>
              <div className={`font-display text-5xl font-bold ${p >= 0.5 ? "text-win" : "text-loss"}`}>{Math.round(p * 100)}%</div>
              <div className="text-xs text-muted">peluang menang tim kamu</div>
            </div>
            <div className="grid flex-1 grid-cols-3 gap-3 text-center">
              {(
                [
                  ["Kekuatan hero", evalAB.strength],
                  ["Sinergi tim", evalAB.synergy],
                  ["Matchup", evalAB.counter],
                ] as const
              ).map(([l, v]) => (
                <div key={l} className="rounded-lg bg-panel-2/70 p-2">
                  <div className="text-lg font-semibold">
                    <Delta value={v} digits={2} />
                  </div>
                  <div className="text-[11px] uppercase tracking-wide text-muted">{l}</div>
                </div>
              ))}
            </div>
          </div>
          {a.length < 6 || b.length < 6 ? <p className="mt-3 text-xs text-muted">Draft belum lengkap, angka berubah setiap pick.</p> : null}
        </Panel>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Pick berikutnya untuk tim kamu" right={<span className="text-xs text-muted">urut dari kenaikan peluang</span>}>
          {picks.length === 0 ? (
            <EmptyState>Tim kamu sudah lengkap.</EmptyState>
          ) : (
            <ul className="divide-y divide-line">
              {picks.map((s) => (
                <li key={s.heroId} className="flex items-center gap-3 py-2 text-sm">
                  <Link href={`/heroes/${s.heroId}${filterQuery(f)}`}>
                    <HeroIcon hero={heroMap.get(s.heroId)} size={36} />
                  </Link>
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">{heroMap.get(s.heroId)?.name}</div>
                    <div className="text-xs text-muted">
                      sinergi <Delta value={s.synergyWithAllies} /> · vs lawan <Delta value={s.vsEnemies} />
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-semibold">
                      <Delta value={s.gain} />
                    </div>
                    <div className="text-[10px] text-muted">→ {Math.round(s.after.winProbability * 100)}%</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Saran ban" right={<span className="text-xs text-muted">hero yang paling menguntungkan lawan</span>}>
          <ul className="divide-y divide-line">
            {bans.map((s) => (
              <li key={s.heroId} className="flex items-center gap-3 py-2 text-sm">
                <HeroIcon hero={heroMap.get(s.heroId)} size={36} />
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{heroMap.get(s.heroId)?.name}</div>
                  <div className="text-xs text-muted">
                    vs tim kamu <Delta value={s.vsUs} />
                  </div>
                </div>
                <div className="text-right font-semibold text-loss">
                  <Delta value={-s.enemyGain} />
                </div>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </div>
  );
}
