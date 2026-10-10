import { ScoutCard } from "@/components/ScoutCard";
import { EmptyState, Panel } from "@/components/ui";
import { getHeroMap, getRanks, getScout } from "@/lib/data";
import { parseLobby } from "@/lib/scout-parse";

export const dynamic = "force-dynamic";

export default async function ScoutPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const lobby = parseLobby((await searchParams).ids);
  if (!lobby.length) {
    return (
      <Panel title="Scout lobby">
        <EmptyState>Tambahkan ?ids=account_id[:hero_id[:team]],… di URL, atau isi form di halaman Pemain.</EmptyState>
      </Panel>
    );
  }

  const [scouts, heroes, ranks] = await Promise.all([
    getScout(lobby.map((l) => ({ accountId: l.accountId, heroId: l.heroId }))),
    getHeroMap(),
    getRanks(),
  ]);
  const byId = new Map(scouts.map((s) => [s.accountId, s]));
  const hasTeams = lobby.some((l) => l.team !== undefined);
  const groups = hasTeams
    ? [0, 1].map((t) => ({ title: t === 0 ? "Amber Hand" : "Sapphire Flame", rows: lobby.filter((l) => l.team === t) }))
    : [{ title: "Lobby", rows: lobby }];

  return (
    <div className="space-y-6">
      <h1 className="font-display text-3xl font-bold">Scout Lobby</h1>
      <div className={`grid gap-6 ${hasTeams ? "lg:grid-cols-2" : ""}`}>
        {groups.map((g) => (
          <section key={g.title} className="space-y-3">
            <h2 className="font-display text-lg font-bold text-brass">{g.title}</h2>
            <div className={`grid gap-3 ${hasTeams ? "" : "md:grid-cols-2 xl:grid-cols-3"}`}>
              {g.rows.map((l) => {
                const s = byId.get(l.accountId);
                return s ? <ScoutCard key={l.accountId} p={s} heroes={heroes} ranks={ranks} currentHeroId={l.heroId} /> : null;
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
