/* eslint-disable @next/next/no-img-element */
import Link from "next/link";
import type { Hero, PlayerScout, Rank } from "@deadlock/core";
import { HeroIcon, Pct, RankLabel } from "./ui";

const FLAG: Record<string, { label: string; cls: string }> = {
  main: { label: "MAIN", cls: "bg-loss/20 text-loss" },
  hot: { label: "ON FIRE", cls: "bg-weapon/20 text-weapon" },
  tilted: { label: "TILT", cls: "bg-win/20 text-win" },
  "new-on-hero": { label: "BARU DI HERO INI", cls: "bg-win/20 text-win" },
  "low-sample": { label: "DATA SEDIKIT", cls: "bg-panel-2 text-muted" },
};

export function ScoutCard({ p, heroes, ranks, currentHeroId }: { p: PlayerScout; heroes: Map<number, Hero>; ranks: Rank[]; currentHeroId?: number }) {
  const streak = p.recent.streak;
  return (
    <div className="rounded-xl border border-line bg-panel/80 p-3">
      <div className="flex items-center gap-3">
        {currentHeroId ? <HeroIcon hero={heroes.get(currentHeroId)} size={44} /> : null}
        {p.avatar ? <img src={p.avatar} alt="" width={currentHeroId ? 28 : 44} height={currentHeroId ? 28 : 44} className="rounded" /> : null}
        <div className="min-w-0 flex-1">
          <Link href={`/players/${p.accountId}`} className="block truncate font-medium hover:text-brass">
            {p.name ?? `#${p.accountId}`}
          </Link>
          <div className="text-xs">
            <RankLabel badge={p.badge} ranks={ranks} />
          </div>
        </div>
        <div className="flex flex-wrap justify-end gap-1">
          {p.flags.map((f) => (
            <span key={f} className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${FLAG[f]?.cls ?? "bg-panel-2"}`}>
              {FLAG[f]?.label ?? f}
            </span>
          ))}
        </div>
      </div>

      <dl className="mt-3 grid grid-cols-4 gap-2 text-center">
        <Stat label="WR total">
          <Pct value={p.overallWinrate} />
        </Stat>
        <Stat label={`WR ${p.recent.matches} terakhir`}>
          <Pct value={p.recent.winrate} />
        </Stat>
        <Stat label="KDA recent">
          <span className="num">{p.recent.kda.toFixed(2)}</span>
        </Stat>
        <Stat label="Streak">
          <span className={`num ${streak > 0 ? "text-win" : streak < 0 ? "text-loss" : ""}`}>
            {streak > 0 ? `W${streak}` : streak < 0 ? `L${-streak}` : "–"}
          </span>
        </Stat>
      </dl>

      {p.currentHero ? (
        <p className="mt-2 rounded-md bg-panel-2 px-2 py-1 text-xs">
          Di hero ini: <span className="num">{p.currentHero.matches}</span> match · WR <Pct value={p.currentHero.winrate} /> · KDA{" "}
          <span className="num">{p.currentHero.kda.toFixed(2)}</span>
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        {p.heroPool.map((h) => (
          <span key={h.heroId} className="inline-flex items-center gap-1.5 text-xs" title={heroes.get(h.heroId)?.name}>
            <HeroIcon hero={heroes.get(h.heroId)} size={22} />
            <span className="num text-muted">{h.matches}</span>
            <Pct value={h.winrate} digits={0} />
          </span>
        ))}
      </div>
      {p.error ? <p className="mt-2 text-[11px] text-muted">Match history gagal: {p.error.slice(0, 80)}</p> : null}
      {p.totalMatches === 0 && !p.error ? (
        <p className="mt-2 text-[11px] text-muted">Belum ada match tercatat di deadlock-api.</p>
      ) : null}
    </div>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md bg-panel-2/70 px-1 py-1.5">
      <dd className="text-sm font-semibold">{children}</dd>
      <dt className="mt-0.5 text-[10px] uppercase tracking-wide text-muted">{label}</dt>
    </div>
  );
}
