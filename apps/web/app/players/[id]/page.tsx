import Link from "next/link";
import { notFound } from "next/navigation";
import { formatClock, isWin } from "@deadlock/core";
import { ScoutCard } from "@/components/ScoutCard";
import { EmptyState, HeroIcon, Panel } from "@/components/ui";
import { api, getHeroMap, getRanks, getScout } from "@/lib/data";

export const dynamic = "force-dynamic";

export default async function PlayerPage({ params }: { params: Promise<{ id: string }> }) {
  const accountId = Number((await params).id);
  if (!Number.isInteger(accountId) || accountId <= 0) notFound();

  const [[scout], history, heroes, ranks] = await Promise.all([
    getScout([{ accountId }]),
    api.matchHistory(accountId, { next: { revalidate: 120 } }).catch(() => []),
    getHeroMap(),
    getRanks(),
  ]);
  const recent = [...history].sort((a, b) => b.start_time - a.start_time).slice(0, 30);

  return (
    <div className="space-y-6">
      <h1 className="font-display text-3xl font-bold">{scout?.name ?? `Pemain #${accountId}`}</h1>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,380px)_1fr]">
        <div>{scout ? <ScoutCard p={scout} heroes={heroes} ranks={ranks} /> : null}</div>

        <Panel title="Match terakhir">
          {recent.length === 0 ? (
            <EmptyState>Tidak ada match history. Profil mungkin private atau belum pernah di-fetch deadlock-api.</EmptyState>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase text-muted">
                  <tr>
                    <th className="pb-2 font-medium">Hero</th>
                    <th className="pb-2 font-medium">Hasil</th>
                    <th className="pb-2 text-right font-medium">K/D/A</th>
                    <th className="pb-2 text-right font-medium">Souls</th>
                    <th className="pb-2 text-right font-medium">Durasi</th>
                    <th className="pb-2 text-right font-medium">Kapan</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {recent.map((m) => {
                    const win = isWin(m);
                    return (
                      <tr key={m.match_id}>
                        <td className="py-1.5">
                          <Link href={`/heroes/${m.hero_id}`} className="flex items-center gap-2">
                            <HeroIcon hero={heroes.get(m.hero_id)} size={26} />
                            <span className="hidden sm:inline">{heroes.get(m.hero_id)?.name}</span>
                          </Link>
                        </td>
                        <td className={`py-1.5 font-semibold ${win ? "text-win" : "text-loss"}`}>{win ? "WIN" : "LOSS"}</td>
                        <td className="py-1.5 text-right num">
                          {m.player_kills}/{m.player_deaths}/{m.player_assists}
                        </td>
                        <td className="py-1.5 text-right text-muted num">{(m.net_worth / 1000).toFixed(1)}k</td>
                        <td className="py-1.5 text-right text-muted num">{formatClock(m.match_duration_s)}</td>
                        <td className="py-1.5 text-right text-xs text-muted">{timeAgo(m.start_time)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}

function timeAgo(unix: number) {
  const s = Date.now() / 1000 - unix;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} mnt`;
  if (s < 86400) return `${Math.round(s / 3600)} jam`;
  return `${Math.round(s / 86400)} hari`;
}
