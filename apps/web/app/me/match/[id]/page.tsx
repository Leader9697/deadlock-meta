import Link from "next/link";
import { notFound } from "next/navigation";
import { flowPhasePlan, parseMatchMetadata, reviewMatch } from "@deadlock/core";
import { Delta, EmptyState, HeroIcon, Panel } from "@/components/ui";
import { getHeroItemStats, getHeroMap, getItemFlow, getItemMap, getMatchMeta, ITEM_PHASE_S } from "@/lib/data";
import { AUTO } from "@/lib/filters";
import { getMatchLog } from "@/lib/store";

export const dynamic = "force-dynamic";

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const k = (n: number) => `${(n / 1000).toFixed(1)}k`;

export default async function MatchReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const matchId = Number((await params).id);
  const account = Number((await searchParams).account);
  if (!matchId) notFound();
  const [raw, heroes, items, log] = await Promise.all([getMatchMeta(matchId).catch(() => null), getHeroMap(), getItemMap(), getMatchLog(matchId)]);
  const parsed = raw ? parseMatchMetadata(raw) : null;
  const me = parsed?.players.find((p) => p.accountId === account) ?? null;

  if (!parsed || !me) {
    return (
      <div className="space-y-4">
        <Link href={`/me?account=${account}`} className="text-xs text-muted hover:text-brass">
          ← Profil
        </Link>
        <h1 className="font-display text-3xl font-bold">Review match #{matchId}</h1>
        <Panel>
          <EmptyState>
            {!parsed ? "Data match belum tersedia di deadlock-api (biasanya muncul beberapa menit sampai jam setelah match selesai)." : "Akun ini tidak ada di match tersebut."}
          </EmptyState>
        </Panel>
      </div>
    );
  }

  // benchmarks for this hero at the match's rank (one tier band)
  const badge = parsed.averageBadge ? Math.max(0, Math.floor(parsed.averageBadge / 10) * 10 - 10) : 0;
  const [heroItems, flow] = await Promise.all([getHeroItemStats(me.heroId, AUTO, badge).catch(() => []), getItemFlow(me.heroId, AUTO, badge).catch(() => null)]);
  const plan = flow ? flowPhasePlan(flow, ITEM_PHASE_S, items) : null;
  const rv = reviewMatch(parsed, {
    accountId: account,
    items,
    heroName: (id) => heroes.get(id)?.name ?? `#${id}`,
    avgBuyTime: new Map(heroItems.map((r) => [r.item_id, r.avg_buy_time_s])),
    netWorthBench: plan ? { 600: plan.netWorthByPhase.early, 1200: plan.netWorthByPhase.mid, 1800: plan.netWorthByPhase.late } : null,
  })!;
  const hero = heroes.get(rv.heroId);

  return (
    <div className="space-y-6">
      <Link href={`/me?account=${account}`} className="text-xs text-muted hover:text-brass">
        ← Profil
      </Link>
      <div className="flex flex-wrap items-center gap-4">
        <HeroIcon hero={hero} size={56} />
        <div>
          <h1 className="font-display text-3xl font-bold">
            {hero?.name} · <span className={rv.won ? "text-win" : "text-loss"}>{rv.won == null ? "?" : rv.won ? "MENANG" : "KALAH"}</span>
          </h1>
          <p className="text-sm text-muted">
            Match #{rv.matchId} · {clock(rv.durationS)} · KDA {rv.kda} · {k(rv.netWorth)} souls ({Math.round(rv.soulsPerMin)}/menit)
          </p>
        </div>
      </div>

      <Panel title="Yang paling perlu diperbaiki">
        {rv.fixes.length ? (
          <ol className="list-decimal space-y-1 pl-5 text-sm">
            {rv.fixes.map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ol>
        ) : (
          <EmptyState>Tidak ada kelemahan menonjol dibanding patokan hero ini. Bagus.</EmptyState>
        )}
      </Panel>

      <div className="grid items-start gap-6 lg:grid-cols-2">
        <Panel title="Ekonomi vs patokan">
          <table className="w-full text-sm">
            <thead className="text-xs text-muted">
              <tr>
                <th className="pb-1 text-left font-medium">Menit</th>
                <th className="pb-1 text-right font-medium">Kamu</th>
                <th className="pb-1 text-right font-medium">Rata-rata hero</th>
                <th className="pb-1 text-right font-medium">Lawan lane</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line/60">
              {rv.checkpoints.map((c) => (
                <tr key={c.t}>
                  <td className="py-1 num">{c.t / 60}</td>
                  <td className="py-1 text-right num">{k(c.mine)}</td>
                  <td className="py-1 text-right num">
                    {c.bench ? (
                      <>
                        {k(c.bench)} <Delta value={c.mine / c.bench - 1} />
                      </>
                    ) : (
                      "–"
                    )}
                  </td>
                  <td className="py-1 text-right num">{c.laneOpp != null ? k(c.laneOpp) : "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rv.farm.length ? (
            <>
              <h3 className="mb-1 mt-4 text-xs font-semibold uppercase text-muted">Sumber souls vs rata-rata tim</h3>
              {rv.farm.map((f) => (
                <div key={f.source} className="flex justify-between text-sm">
                  <span>{f.source}</span>
                  <span className={`num ${f.teamAvg && f.mine < f.teamAvg * 0.7 ? "text-loss" : ""}`}>
                    {k(f.mine)} <span className="text-muted">/ {k(f.teamAvg)}</span>
                  </span>
                </div>
              ))}
            </>
          ) : null}
        </Panel>

        <Panel title="Kematian" right={<span className="text-xs text-muted">total mati {clock(rv.deadSeconds)}</span>}>
          {rv.deaths.length ? (
            <ul className="space-y-1 text-sm">
              {rv.deaths.map((d, i) => (
                <li key={i} className="flex justify-between">
                  <span className="num">{clock(d.t)}</span>
                  <span>{d.killer ?? "?"}</span>
                  <span className="text-xs text-muted num">{Math.round(d.durationS)}s</span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState>Tidak mati sama sekali.</EmptyState>
          )}
          {rv.lateItems.length ? (
            <>
              <h3 className="mb-1 mt-4 text-xs font-semibold uppercase text-muted">Item yang telat dibanding rata-rata</h3>
              {rv.lateItems.map((it) => (
                <div key={it.itemId} className="flex justify-between text-sm">
                  <span>{it.name}</span>
                  <span className="num text-muted">
                    {clock(it.boughtS)} vs {clock(it.avgS)} <span className="text-loss">+{clock(it.deltaS)}</span>
                  </span>
                </div>
              ))}
            </>
          ) : null}
        </Panel>
      </div>

      {log ? (
        <Panel title="Apa yang dikatakan overlay saat itu">
          <ul className="space-y-1 text-sm">
            {log.snapshots
              .filter((s, i, a) => i === 0 || s.tips[0]?.title !== a[i - 1].tips[0]?.title)
              .slice(0, 40)
              .map((s, i) => (
                <li key={i} className="flex gap-3">
                  <span className="w-12 text-muted num">{clock(s.t)}</span>
                  <span className="w-12 text-right text-xs text-muted num">{s.winP != null ? `${Math.round(s.winP * 100)}%` : ""}</span>
                  <span>{s.tips[0]?.title ?? "–"}</span>
                </li>
              ))}
          </ul>
        </Panel>
      ) : null}
    </div>
  );
}
