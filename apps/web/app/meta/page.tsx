import Link from "next/link";
import { detectMeta, formatPct, summarizeKinds, type MetaStatus, type PatchLine } from "@deadlock/core";
import { FilterBar } from "@/components/FilterBar";
import { HeroIcon, Panel, Pct } from "@/components/ui";
import { getHeroMap, getLatestPatchTs, getMetaWindows, getParsedPatches, getRanks, windowStart } from "@/lib/data";
import { filterQuery, parseFilters } from "@/lib/filters";

export const dynamic = "force-dynamic";

const STATUS: Record<MetaStatus, { label: string; cls: string; desc: string }> = {
  confirmed: { label: "META", cls: "bg-tier-s text-ink", desc: "WR tinggi dan banyak dipick" },
  rising: { label: "NAIK", cls: "bg-win/20 text-win", desc: "WR atau pick naik dibanding periode sebelumnya" },
  sleeper: { label: "SLEEPER", cls: "bg-spirit/20 text-spirit", desc: "WR tinggi tapi jarang dipick, peluang sebelum ramai" },
  overrated: { label: "OVERRATED", cls: "bg-loss/20 text-loss", desc: "Populer tapi WR di bawah 50%" },
  falling: { label: "TURUN", cls: "bg-loss/15 text-loss", desc: "WR turun dibanding periode sebelumnya" },
  stable: { label: "STABIL", cls: "bg-panel-2 text-muted", desc: "Tidak ada perubahan berarti" },
};

function Trend({ v, pts = true }: { v: number | null; pts?: boolean }) {
  if (v == null) return <span className="text-muted">–</span>;
  const cls = v > 0.002 ? "text-win" : v < -0.002 ? "text-loss" : "text-muted";
  return (
    <span className={`num ${cls}`}>
      {v >= 0 ? "▲" : "▼"} {pts ? `${Math.abs(v * 100).toFixed(1)}` : `${Math.abs(v * 100).toFixed(0)}%`}
    </span>
  );
}

export default async function MetaPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const f = parseFilters(await searchParams);
  const [{ now, prev, bans }, heroes, ranks, patches, start, bigTs] = await Promise.all([
    getMetaWindows(f.days, f.badge),
    getHeroMap(),
    getRanks(),
    getParsedPatches(),
    windowStart(f.days),
    getLatestPatchTs(),
  ]);
  // patch lines inside the analysed window (+ the day before, patches land before stats move)
  const inWindow = patches.filter((p) => Date.parse(p.date) / 1000 >= start - 86400);
  const heroLines = new Map<number, PatchLine[]>();
  for (const p of inWindow) for (const [h, ls] of p.heroes) heroLines.set(h, [...(heroLines.get(h) ?? []), ...ls]);
  const latest = patches[0];
  const period = f.days === 0 ? "sejak patch besar terakhir" : f.days === -1 ? "otomatis (lihat keterangan di bawah filter)" : `${f.days} hari`;
  const rows = detectMeta(now, prev, bans).filter((r) => heroes.has(r.heroId));
  const groups = (["confirmed", "rising", "sleeper", "overrated", "falling"] as MetaStatus[]).map((s) => ({ s, rows: rows.filter((r) => r.status === s) }));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-bold">Tren Meta</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Skor komposit = 45% WR uplift (shrinkage 500 match) + 20% tren WR + 20% tren pick + 15% porsi ban. Periode {period} dibanding
            rentang yang sama sebelumnya. Kolom Patch = baris patch notes yang menyentuh hero itu di periode ini.
          </p>
        </div>
        <FilterBar ranks={ranks} days={f.days} badge={f.badge} />
      </div>

      {latest ? (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-brass/40 bg-brass/5 px-4 py-2.5 text-sm">
          <span className="font-semibold text-brass">Patch terbaru:</span>
          <Link href={`/patches?p=${encodeURIComponent(latest.id)}`} className="hover:text-brass">
            {latest.title}
          </Link>
          <span className="text-xs text-muted">{new Date(latest.date).toLocaleDateString("id-ID", { dateStyle: "medium" })}</span>
          {bigTs && f.days !== 0 ? (
            <Link href={`/meta${filterQuery({ ...f, days: 0 })}`} className="ml-auto text-xs text-brass">
              Lihat meta sejak patch →
            </Link>
          ) : null}
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {groups.map(({ s, rows }) => (
          <div key={s} className="rounded-xl border border-line bg-panel/70 p-3">
            <div className="flex items-center justify-between">
              <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${STATUS[s].cls}`}>{STATUS[s].label}</span>
              <span className="text-xs text-muted">{rows.length}</span>
            </div>
            <p className="mt-1 text-[11px] text-muted">{STATUS[s].desc}</p>
            <div className="mt-2 flex flex-wrap gap-1">
              {rows.slice(0, 10).map((r) => (
                <Link key={r.heroId} href={`/heroes/${r.heroId}${filterQuery(f)}`} title={heroes.get(r.heroId)?.name}>
                  <HeroIcon hero={heroes.get(r.heroId)} size={34} />
                </Link>
              ))}
            </div>
          </div>
        ))}
      </div>

      <Panel title="Peringkat skor meta">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="text-left text-xs uppercase text-muted">
              <tr>
                <th className="pb-2 font-medium">#</th>
                <th className="pb-2 font-medium">Hero</th>
                <th className="pb-2 font-medium">Status</th>
                <th className="pb-2 text-right font-medium">Skor</th>
                <th className="pb-2 text-right font-medium">WR (adj)</th>
                <th className="pb-2 text-right font-medium">Tren WR</th>
                <th className="pb-2 text-right font-medium">Pick</th>
                <th className="pb-2 text-right font-medium">Tren pick</th>
                <th className="pb-2 text-right font-medium">Ban</th>
                <th className="pb-2 text-right font-medium">Patch</th>
                <th className="pb-2 pl-3 font-medium">Alasan</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((r, i) => (
                <tr key={r.heroId}>
                  <td className="py-1.5 text-muted num">{i + 1}</td>
                  <td className="py-1.5">
                    <Link href={`/heroes/${r.heroId}${filterQuery(f)}`} className="flex items-center gap-2">
                      <HeroIcon hero={heroes.get(r.heroId)} size={28} />
                      {heroes.get(r.heroId)?.name}
                    </Link>
                  </td>
                  <td className="py-1.5">
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${STATUS[r.status].cls}`}>{STATUS[r.status].label}</span>
                  </td>
                  <td className="py-1.5 text-right num">{r.score.toFixed(2)}</td>
                  <td className="py-1.5 text-right">
                    <Pct value={r.adjWr} />
                  </td>
                  <td className="py-1.5 text-right">
                    <Trend v={r.wrTrend} />
                  </td>
                  <td className="py-1.5 text-right num">{formatPct(r.pickRate)}</td>
                  <td className="py-1.5 text-right">
                    <Trend v={r.pickTrend} pts={false} />
                  </td>
                  <td className="py-1.5 text-right num text-muted">{formatPct(r.banShare)}</td>
                  <td className="py-1.5 text-right text-xs num">
                    <PatchCell lines={heroLines.get(r.heroId)} />
                  </td>
                  <td className="py-1.5 pl-3 text-xs text-muted">{r.reasons.join(" · ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}

function PatchCell({ lines }: { lines?: PatchLine[] }) {
  if (!lines?.length) return <span className="text-muted">–</span>;
  const k = summarizeKinds(lines);
  return (
    <Link href="/patches" title={lines.map((l) => `${l.kind === "buff" ? "+" : l.kind === "nerf" ? "−" : "~"} ${l.text}`).join("\n")}>
      {k.buff ? <span className="text-win">+{k.buff} </span> : null}
      {k.nerf ? <span className="text-loss">−{k.nerf} </span> : null}
      {k.change ? <span className="text-muted">~{k.change}</span> : null}
    </Link>
  );
}
