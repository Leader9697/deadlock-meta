import Link from "next/link";
import { flowPhasePlan, GAME_PHASES, phaseRange, planToText, winrate, type PatchLine } from "@deadlock/core";
import { CopyButton } from "@/components/CopyButton";
import { Delta, ItemIcon, Panel, Pct } from "@/components/ui";
import { getItemFlow, getItemMap, getMetaWindows, getParsedPatches, ITEM_PHASE_S } from "@/lib/data";
import { filterQuery, type Filters } from "@/lib/filters";

const KIND_CLS: Record<PatchLine["kind"], string> = { buff: "text-win", nerf: "text-loss", change: "text-muted" };
const KIND_SIGN: Record<PatchLine["kind"], string> = { buff: "+", nerf: "−", change: "~" };

/** Patch changes for this hero + WR since vs before the last patch, and the core build per phase. */
export async function HeroPatchCore({ heroId, heroName, f, counterLink }: { heroId: number; heroName: string; f: Filters; counterLink: string }) {
  const [patches, win, flow, items] = await Promise.all([
    getParsedPatches(),
    getMetaWindows(0, f.badge).catch(() => null),
    getItemFlow(heroId, f.days, f.badge).catch(() => null),
    getItemMap(),
  ]);
  const touched = patches.filter((p) => p.heroes.has(heroId)).slice(0, 3);
  const nowRow = win?.now.find((r) => r.hero_id === heroId);
  const prevRow = win?.prev.find((r) => r.hero_id === heroId);
  const wrNow = nowRow ? winrate(nowRow.wins, nowRow.matches) : null;
  const wrPrev = prevRow ? winrate(prevRow.wins, prevRow.matches) : null;
  const core = flow ? flowPhasePlan(flow, ITEM_PHASE_S, items) : null;
  const hasCore = !!core?.plan.some((p) => p.steps.length);

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
      <Panel
        title="Patch & meta"
        right={
          <Link href="/patches" className="text-xs text-brass">
            Semua patch →
          </Link>
        }
      >
        {wrNow != null && wrPrev != null ? (
          <p className="mb-3 text-sm">
            WR sejak patch besar terakhir <Pct value={wrNow} /> vs sebelumnya <Pct value={wrPrev} color={false} /> (
            <Delta value={wrNow - wrPrev} />, {nowRow!.matches.toLocaleString("id-ID")} match)
          </p>
        ) : null}
        {touched.length ? (
          <div className="space-y-3">
            {touched.map((p) => (
              <div key={p.id}>
                <Link href={`/patches?p=${encodeURIComponent(p.id)}`} className="text-xs font-semibold text-brass">
                  {p.title} · {new Date(p.date).toLocaleDateString("id-ID", { dateStyle: "medium" })}
                </Link>
                <ul className="mt-1 space-y-0.5 text-sm">
                  {p.heroes
                    .get(heroId)!
                    .slice(0, 12)
                    .map((l, i) => (
                      <li key={i} className="flex gap-1.5">
                        <span className={`w-3 shrink-0 font-bold ${KIND_CLS[l.kind]}`}>{KIND_SIGN[l.kind]}</span>
                        <span>{l.text}</span>
                      </li>
                    ))}
                </ul>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted">{heroName} tidak disebut di patch notes terbaru.</p>
        )}
      </Panel>

      <Panel
        title="Core build per fase"
        right={
          hasCore ? (
            <span className="flex gap-2">
              <CopyButton text={planToText(core!.plan, (id) => items.get(id)?.name ?? String(id))} label="Copy" />
              <Link href={counterLink} className="rounded-md bg-brass/15 px-2.5 py-1 text-xs font-semibold text-brass">
                Sesuaikan ke lawan →
              </Link>
            </span>
          ) : null
        }
      >
        {hasCore ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {core!.plan.map((p) => (
              <div key={p.phase.key}>
                <div className="mb-1 flex items-baseline justify-between text-xs">
                  <span className="font-semibold">{p.phase.label}</span>
                  <span className="text-muted">
                    {phaseRange(p.phase)} · ~{core!.netWorthByPhase[p.phase.key].toLocaleString("id-ID")} souls
                  </span>
                </div>
                <ol className="space-y-1">
                  {p.steps.map((s) => {
                    const fi = core!.items[s.itemId];
                    return (
                      <li key={s.itemId} className="flex items-center gap-2 text-sm">
                        <span className="w-4 text-right text-xs text-muted num">{s.order}</span>
                        <ItemIcon item={items.get(s.itemId)} size={24} />
                        <span className="min-w-0 flex-1 truncate">{items.get(s.itemId)?.name}</span>
                        {fi ? (
                          <span className="text-[11px] text-muted num">
                            {(fi.pickShare * 100).toFixed(0)}% · <Delta value={fi.adjustedWr - core!.baselineWr} />
                          </span>
                        ) : null}
                      </li>
                    );
                  })}
                  {!p.steps.length ? <li className="text-xs text-muted">–</li> : null}
                </ol>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted">Data timing item belum cukup untuk periode ini.</p>
        )}
        <p className="mt-3 text-[11px] text-muted">
          Item ditaruh di fase saat paling sering dibeli (persentase = pemain yang membelinya), diurutkan dari popularitas + WR disesuaikan net worth.
          Untuk versi yang menyesuaikan lawan, pakai tombol “Sesuaikan ke lawan” atau overlay saat main. {GAME_PHASES.length} fase.
        </p>
      </Panel>
    </div>
  );
}
