import Link from "next/link";
import { calibrate, personalHeroes, tiltCheck } from "@deadlock/core";
import { RememberAccount } from "@/components/RememberAccount";
import { Delta, EmptyState, HeroIcon, Panel, Pct } from "@/components/ui";
import { getHeroMap, getHeroMeta, getMatchHistory, getPlayerHeroes } from "@/lib/data";
import { AUTO } from "@/lib/filters";
import { listMatchLogs } from "@/lib/store";

export const dynamic = "force-dynamic";

const STEAM64_BASE = 76561197960265728n;
function parseAccount(v: string | string[] | undefined): number | null {
  const s = (Array.isArray(v) ? v[0] : v)?.trim();
  if (!s || !/^\d+$/.test(s)) return null;
  const n = BigInt(s);
  const acc = n > STEAM64_BASE ? n - STEAM64_BASE : n;
  return acc > 0n && acc < 2n ** 32n ? Number(acc) : null;
}

const TIP_LABEL: Record<string, string> = {
  push: "Push",
  retreat: "Mundur/jaga",
  objective: "Objektif",
  buy: "Belanja",
  tempo: "Tempo",
  threat: "Ancaman",
  momentum: "Momentum",
  farm: "Farm",
  death: "Kenapa mati",
};
const NEED_LABEL: Record<string, string> = {
  anti_heal: "Anti-heal",
  bullet_resist: "Resist peluru",
  spirit_resist: "Resist spirit",
  cc_resist: "Anti-CC",
  lockdown: "Slow/stun",
  shred: "Penembus armor",
};

export default async function MePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const account = parseAccount((await searchParams).account);

  if (!account) {
    return (
      <div className="space-y-6">
        <RememberAccount account={null} path="/me" />
        <h1 className="font-display text-3xl font-bold">Profil Saya</h1>
        <Panel>
          <form className="flex flex-wrap items-center gap-2" action="/me">
            <label className="text-sm text-muted" htmlFor="account">
              Steam ID (angka dari profil Steam / overlay):
            </label>
            <input id="account" name="account" inputMode="numeric" className="rounded-md border border-line bg-panel-2 px-3 py-1.5 text-sm" placeholder="mis. 52079950 atau 7656119…" />
            <button className="rounded-md bg-brass px-3 py-1.5 text-sm font-semibold text-ink">Buka</button>
          </form>
          <p className="mt-2 text-xs text-muted">Overlay desktop menampilkan Steam ID kamu dan link langsung ke halaman ini.</p>
        </Panel>
      </div>
    );
  }

  const [hist, mine, meta, heroes, logs] = await Promise.all([
    getMatchHistory(account),
    getPlayerHeroes(account),
    getHeroMeta(AUTO, 0),
    getHeroMap(),
    listMatchLogs(account),
  ]);
  const recent = [...hist].sort((a, b) => b.start_time - a.start_time);
  const tilt = tiltCheck(recent.map((m) => m.match_result === m.player_team));
  const globalWr = new Map(meta.map((m) => [m.heroId, m.winrate]));
  const ph = personalHeroes(
    mine.map((r) => ({ hero_id: r.hero_id, matches: r.matches_played, wins: r.wins })),
    globalWr,
  ).filter((h) => heroes.has(h.heroId));
  const cal = calibrate(logs);

  return (
    <div className="space-y-6">
      <RememberAccount account={account} path="/me" />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-bold">Profil Saya</h1>
          <p className="mt-1 text-sm text-muted">
            Akun {account} · {recent.length} match tercatat di deadlock-api · {logs.length} match dengan log overlay
          </p>
        </div>
        <Link href="/me" className="text-xs text-muted hover:text-brass" prefetch={false}>
          ganti akun
        </Link>
      </div>

      <details className="rounded-xl border border-line bg-panel/70 px-4 py-2.5 text-sm" open={recent.length < 30}>
        <summary className="cursor-pointer text-muted">
          Kenapa match saya tidak lengkap? ({recent.length} match ditemukan)
        </summary>
        <div className="mt-2 space-y-1.5 text-xs text-muted">
          <p>
            Valve tidak punya API publik. deadlock-api hanya punya match yang pernah dikumpulkan komunitas, jadi untuk sebagian besar akun riwayatnya
            bolong. Riwayat lengkap dari Valve hanya diberikan kalau akun kamu berteman dengan bot deadlock-api (fitur Patreon mereka).
          </p>
          <p>
            <b className="text-fg">Cara melengkapi (gratis):</b> app desktop Deadlock Meta sekarang otomatis mengirim match kamu ke deadlock-api dari
            cache Steam (sama seperti tool resmi mereka, hanya membaca cache, tidak menyentuh game). Buka app desktop, lalu di Deadlock buka{" "}
            <i>Match History</i> dan klik match-match lama kamu satu per satu: tiap match yang dibuka ikut terkirim. Match baru otomatis terkirim
            setelah selesai. Data muncul di sini beberapa menit sampai jam kemudian.
          </p>
          <p>Hero terbaik dan review dihitung hanya dari match yang tersedia, jadi makin lengkap riwayatnya makin akurat.</p>
        </div>
      </details>

      {tilt.warning ? <div className="rounded-xl border border-loss/50 bg-loss/10 px-4 py-3 text-sm">⚠ {tilt.warning}</div> : null}

      <div className="grid items-start gap-6 lg:grid-cols-2">
        <Panel title="Hero terbaik untuk kamu" right={<span className="text-xs text-muted">WR kamu vs WR hero itu secara umum</span>}>
          {ph.length ? (
            <ul className="space-y-2">
              {ph.slice(0, 8).map((h) => (
                <li key={h.heroId} className="flex items-center gap-3 text-sm">
                  <HeroIcon hero={heroes.get(h.heroId)} size={30} />
                  <Link href={`/heroes/${h.heroId}`} className="min-w-0 flex-1 truncate hover:text-brass">
                    {heroes.get(h.heroId)?.name}
                  </Link>
                  <span className="text-xs text-muted num">{h.matches} match</span>
                  <span className="w-14 text-right">
                    <Pct value={h.winrate} />
                  </span>
                  <span className="w-14 text-right text-xs" title="Keunggulan kamu di hero ini dibanding rata-rata semua pemain (sudah dikoreksi sampel kecil)">
                    <Delta value={h.edge} />
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState>Belum ada data hero untuk akun ini.</EmptyState>
          )}
          {ph.length > 3 ? (
            <p className="mt-3 text-xs text-muted">
              Paling buruk: {ph.slice(-3).reverse().map((h) => `${heroes.get(h.heroId)?.name} (${Math.round(h.edge * 1000) / 10})`).join(", ")}. Hindari di ranked sampai
              latihan.
            </p>
          ) : null}
        </Panel>

        <Panel title="Match terakhir" right={<span className="text-xs text-muted">klik untuk review</span>}>
          {recent.length ? (
            <ul className="divide-y divide-line">
              {recent.slice(0, 30).map((m) => (
                <li key={m.match_id}>
                  <Link href={`/me/match/${m.match_id}?account=${account}`} className="flex items-center gap-3 py-1.5 text-sm hover:bg-panel-2/50">
                    <span className={`w-1.5 self-stretch rounded ${m.match_result === m.player_team ? "bg-win" : "bg-loss"}`} />
                    <HeroIcon hero={heroes.get(m.hero_id)} size={26} />
                    <span className="flex-1 truncate">{heroes.get(m.hero_id)?.name}</span>
                    <span className="text-xs text-muted num">
                      {m.player_kills}/{m.player_deaths}/{m.player_assists}
                    </span>
                    <span className="w-16 text-right text-xs text-muted num">{(m.net_worth / 1000).toFixed(1)}k</span>
                    <span className="w-24 text-right text-[11px] text-muted">{new Date(m.start_time * 1000).toLocaleDateString("id-ID", { day: "numeric", month: "short" })}</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState>Riwayat match tidak ditemukan.</EmptyState>
          )}
          {tilt.last10.games ? (
            <p className="mt-2 text-xs text-muted">
              10 terakhir: {tilt.last10.wins}/{tilt.last10.games} menang · streak {tilt.streak} {tilt.streakKind === "win" ? "menang" : "kalah"}
            </p>
          ) : null}
        </Panel>
      </div>

      <Panel title="Kalibrasi overlay" right={<span className="text-xs text-muted">dari log overlay di PC ini</span>}>
        {cal.finished === 0 ? (
          <EmptyState>Belum ada match selesai yang dicatat overlay. Main dengan overlay aktif; tiap match otomatis tersimpan.</EmptyState>
        ) : (
          <div className="grid gap-6 lg:grid-cols-3">
            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase text-muted">Peluang menang: prediksi vs kenyataan</h3>
              <table className="w-full text-sm">
                <tbody className="divide-y divide-line/60">
                  {cal.reliability.map((r) => (
                    <tr key={r.from}>
                      <td className="py-1 text-muted num">
                        {Math.round(r.from * 100)}–{Math.round(r.to * 100)}%
                      </td>
                      <td className="py-1 text-right num">prediksi {Math.round(r.predicted * 100)}%</td>
                      <td className="py-1 text-right num">nyata {Math.round(r.actual * 100)}%</td>
                      <td className="py-1 text-right text-xs text-muted num">n={r.n}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase text-muted">Saran item</h3>
              <p className="text-sm">
                Diikuti: {cal.follow.followedRate != null ? `${Math.round(cal.follow.followedRate * 100)}%` : "–"}
                <br />
                WR saat banyak diikuti: {cal.follow.winFollowed != null ? `${Math.round(cal.follow.winFollowed * 100)}%` : "–"}
                <br />
                WR saat jarang diikuti: {cal.follow.winIgnored != null ? `${Math.round(cal.follow.winIgnored * 100)}%` : "–"}
              </p>
              {cal.ignoredNeeds.length ? (
                <>
                  <h3 className="mb-1 mt-3 text-xs font-semibold uppercase text-muted">Kebutuhan yang dibiarkan &gt;5 menit</h3>
                  {cal.ignoredNeeds.map((n) => (
                    <div key={n.kind} className="text-sm">
                      {NEED_LABEL[n.kind] ?? n.kind}: {n.matches} match, WR {Math.round(n.winrate * 100)}%
                    </div>
                  ))}
                </>
              ) : null}
            </div>
            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase text-muted">Tip utama yang muncul</h3>
              {cal.tipKinds.map((t) => (
                <div key={t.kind} className="flex justify-between text-sm">
                  <span>{TIP_LABEL[t.kind] ?? t.kind}</span>
                  <span className="text-muted num">
                    {t.matches} match · WR {Math.round(t.winrate * 100)}%
                  </span>
                </div>
              ))}
            </div>
            <div className="lg:col-span-3 space-y-1 text-xs text-muted">
              {cal.notes.map((n, i) => (
                <p key={i}>{n}</p>
              ))}
              <p>
                {cal.finished} match selesai · {cal.wins} menang
                {cal.brier != null ? ` · Brier ${cal.brier.toFixed(3)}` : ""}
              </p>
            </div>
          </div>
        )}
      </Panel>
    </div>
  );
}
