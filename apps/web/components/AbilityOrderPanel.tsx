/* eslint-disable @next/next/no-img-element */
import type { AbilityOrderAnalysis, HeroAbility } from "@deadlock/core";
import { formatPct } from "@deadlock/core";
import { EmptyState, Panel, Pct } from "./ui";

const SLOT_KEY = ["", "1", "2", "3", "4"];

function AbilityChip({ a, size = 26, n }: { a?: HeroAbility; size?: number; n?: number }) {
  return (
    <span className="relative inline-flex flex-col items-center" title={a?.name}>
      <span
        className={`inline-flex items-center justify-center overflow-hidden rounded-md bg-panel-2 ring-1 ${a?.slot === 4 ? "ring-brass" : "ring-line"}`}
        style={{ width: size, height: size }}
      >
        {a?.image ? <img src={a.image} alt={a.name} className="h-[85%] w-[85%] object-contain" /> : <span className="text-[11px] font-semibold">{a?.slot ?? "?"}</span>}
      </span>
      {n !== undefined ? <span className="mt-0.5 text-[9px] text-muted num">{n}</span> : null}
    </span>
  );
}

export function AbilityOrderPanel({ analysis, abilities }: { analysis: AbilityOrderAnalysis; abilities: HeroAbility[] }) {
  const byId = new Map(abilities.map((a) => [a.id, a]));
  const opening = analysis.openings[0];
  const max = analysis.maxPriorities[0];
  const best = analysis.topOrders[0];
  const ultMax = Math.max(0.0001, ...analysis.ultTiming.map((u) => u.matches));

  if (!opening && !max && !best) {
    return (
      <Panel title="Urutan ability">
        <EmptyState>Data urutan ability belum cukup untuk filter ini.</EmptyState>
      </Panel>
    );
  }

  return (
    <Panel title="Urutan ability" right={<span className="text-xs text-muted">{analysis.totalMatches.toLocaleString("id-ID")} match</span>}>
      <div className="grid gap-5 lg:grid-cols-3">
        <div>
          <h3 className="font-display mb-2 text-sm font-bold text-brass">Prioritas max</h3>
          {analysis.maxPriorities.slice(0, 3).map((m, i) => (
            <div key={i} className="mb-2 flex items-center gap-2">
              {m.order.map((id, j) => (
                <span key={j} className="flex items-center gap-1">
                  <AbilityChip a={byId.get(id)} />
                  {j < m.order.length - 1 ? <span className="text-muted">›</span> : null}
                </span>
              ))}
              <span className="ml-auto text-right text-sm">
                <Pct value={m.winrate} />
                <span className="block text-[10px] text-muted num">{m.matches.toLocaleString("id-ID")}</span>
              </span>
            </div>
          ))}
          <p className="text-xs text-muted">Urutan ability yang lebih dulu mencapai level penuh.</p>
        </div>

        <div>
          <h3 className="font-display mb-2 text-sm font-bold text-brass">Pembukaan terbaik ({opening?.sequence.length ?? 5} poin)</h3>
          {analysis.openings.slice(0, 3).map((o, i) => (
            <div key={i} className="mb-2 flex items-center gap-1.5">
              {o.sequence.map((id, j) => (
                <AbilityChip key={j} a={byId.get(id)} size={24} n={j + 1} />
              ))}
              <span className="ml-auto text-right text-sm">
                <Pct value={o.winrate} />
                <span className="block text-[10px] text-muted num">{o.matches.toLocaleString("id-ID")}</span>
              </span>
            </div>
          ))}
        </div>

        <div>
          <h3 className="font-display mb-2 text-sm font-bold text-brass">Kapan ambil ultimate</h3>
          {analysis.ultTiming.length ? (
            <div className="space-y-1">
              {analysis.ultTiming.slice(0, 8).map((u) => (
                <div key={u.position} className="flex items-center gap-2 text-xs">
                  <span className={`w-14 num ${u.position === analysis.bestUltPosition ? "font-semibold text-brass" : "text-muted"}`}>poin #{u.position}</span>
                  <span className="relative h-2 flex-1 overflow-hidden rounded bg-line">
                    <span className="absolute inset-y-0 left-0 rounded bg-panel-2 ring-1 ring-muted/40" style={{ width: `${(u.matches / ultMax) * 100}%` }} />
                  </span>
                  <span className="w-12 text-right">
                    <Pct value={u.winrate} />
                  </span>
                </div>
              ))}
              {analysis.bestUltPosition ? (
                <p className="pt-1 text-xs text-muted">
                  Terbaik: ambil ultimate di poin ke-<b className="text-fg">{analysis.bestUltPosition}</b>.
                </p>
              ) : null}
            </div>
          ) : (
            <EmptyState>Data kurang.</EmptyState>
          )}
        </div>
      </div>

      {best ? (
        <div className="mt-4 border-t border-line pt-3">
          <div className="mb-2 flex items-center justify-between text-xs text-muted">
            <span>Urutan lengkap ber-WR tertinggi</span>
            <span>
              WR {formatPct(best.winrate)} · {best.matches.toLocaleString("id-ID")} match · KDA {best.kda.toFixed(2)}
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {best.sequence.map((id, j) => (
              <AbilityChip key={j} a={byId.get(id)} size={24} n={j + 1} />
            ))}
          </div>
          <p className="mt-2 text-[11px] text-muted">
            Tombol in-game: {abilities.map((a) => `${a.name} = ${SLOT_KEY[a.slot]}`).join(" · ")}
          </p>
        </div>
      ) : null}
    </Panel>
  );
}
