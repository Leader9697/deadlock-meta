/* eslint-disable @next/next/no-img-element */
import Link from "next/link";
import { redirect } from "next/navigation";
import { toAccountId } from "@deadlock/core";
import { EmptyState, Panel, RankLabel } from "@/components/ui";
import { api, getRanks } from "@/lib/data";

export const dynamic = "force-dynamic";

export default async function PlayersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const q = (Array.isArray(sp.q) ? sp.q[0] : sp.q)?.trim() ?? "";

  const direct = q ? toAccountId(q) : null;
  if (direct) redirect(`/players/${direct}`);

  const [results, ranks] = await Promise.all([
    q ? api.steamSearch(q, { next: { revalidate: 300 } }).catch(() => []) : Promise.resolve([]),
    getRanks(),
  ]);

  const input = "w-full rounded-md border border-line bg-panel-2 px-3 py-2 text-sm outline-none focus:border-brass";

  return (
    <div className="space-y-6">
      <h1 className="font-display text-3xl font-bold">Cari Pemain</h1>

      <div className="grid gap-6 md:grid-cols-2">
        <Panel title="Cari pemain">
          <form className="flex gap-2">
            <input name="q" defaultValue={q} placeholder="Nama Steam, SteamID64, [U:1:…] atau URL profil" className={input} />
            <button className="rounded-md bg-brass px-4 text-sm font-semibold text-ink">Cari</button>
          </form>
          <p className="mt-2 text-xs text-muted">Nama Steam dicari di database deadlock-api (hanya akun yang aktif main 30 hari terakhir).</p>
        </Panel>

        <Panel title="Scout lobby (manual)">
          <form action="/scout" className="space-y-2">
            <textarea
              name="ids"
              rows={2}
              placeholder="Account ID dipisah koma, max 12. Format id:hero juga bisa, mis. 12345:6,67890:13"
              className={input}
            />
            <button className="rounded-md bg-panel-2 px-4 py-2 text-sm font-semibold text-fg ring-1 ring-line hover:ring-brass">
              Scout
            </button>
          </form>
          <p className="mt-2 text-xs text-muted">Halaman ini yang nanti dipakai overlay desktop saat match mulai.</p>
        </Panel>
      </div>

      {q ? (
        <Panel title={`Hasil untuk “${q}”`}>
          {results.length === 0 ? (
            <EmptyState>Tidak ketemu. Coba pakai SteamID64 atau URL profil.</EmptyState>
          ) : (
            <ul className="divide-y divide-line">
              {results.map((p) => (
                <li key={p.account_id}>
                  <Link href={`/players/${p.account_id}`} className="flex items-center gap-3 py-2 hover:bg-panel-2/60">
                    <img src={p.avatarmedium} alt="" width={36} height={36} className="rounded" />
                    <span className="flex-1 truncate font-medium">{p.personaname}</span>
                    <span className="text-xs text-muted">{p.matches_played_last_30d} match/30h</span>
                    <span className="w-32 text-right text-sm">
                      <RankLabel badge={p.last_team_avg_badge ?? 0} ranks={ranks} />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      ) : null}
    </div>
  );
}
