import { heroAbilities, heroKit, isImbueItem, maxFirstShare, recommendImbue, type ImbueAdvice } from "@deadlock/core";
import { Panel } from "@/components/ui";
import { getAbilityOrders, getHeroMap, getImbueData, getItems } from "@/lib/data";
import type { Filters } from "@/lib/filters";
import { getLabData } from "@/lib/lab";

const pc = (x: number) => `${Math.round(x * 100)}%`;

/** Per imbue item: which ability to imbue, with the stat argument and the build data. */
export async function HeroImbuePanel({ heroId, f }: { heroId: number; f: Filters }) {
  const [lab, heroes, itemList, orderRows, data] = await Promise.all([
    getLabData(),
    getHeroMap(),
    getItems(),
    getAbilityOrders(heroId, f.days, f.badge).catch(() => []),
    getImbueData(heroId, f.days, f.badge).catch(() => null),
  ]);
  const hero = lab.heroes.find((h) => h.id === heroId);
  const heroFull = heroes.get(heroId);
  if (!hero || !heroFull) return null;
  const byClass = new Map(lab.items.map((i) => [i.class_name, i]));
  const kit = heroKit(hero.items, byClass);
  const ult = heroAbilities(heroFull, itemList).find((a) => a.slot === 4)?.id ?? null;
  const prio = maxFirstShare(orderRows, ult);

  const advice = lab.items
    .filter((it) => it.type === "upgrade" && it.shopable && !it.disabled && isImbueItem(it))
    .map((it) => recommendImbue(it, kit, { data, prio }))
    .filter((x): x is ImbueAdvice => !!x)
    .sort((a, b) => (b.data?.matches ?? 0) - (a.data?.matches ?? 0) || a.itemName.localeCompare(b.itemName));
  if (!advice.length) return null;
  const icon = new Map(lab.items.map((i) => [i.id, i.image]));

  return (
    <Panel
      title="Imbue ke skill mana"
      right={<span className="text-xs text-muted">stat ability resmi + {data ? `${data.builds} build (${data.matches.toLocaleString("id-ID")} match)` : "data build belum tersedia"}</span>}
    >
      <div className="grid gap-3 md:grid-cols-2">
        {advice.map((a) => (
          <div key={a.itemId} className="rounded-lg border border-line bg-panel-2/40 p-3">
            <div className="flex items-center gap-2">
              {icon.get(a.itemId) ? <img src={icon.get(a.itemId)!} alt="" className="h-7 w-7 rounded" /> : null}
              <div className="min-w-0">
                <div className="text-sm font-semibold">
                  {a.itemName} → <span className="text-brass">{a.target.name}</span>
                </div>
                <div className="text-xs text-muted">
                  {a.effect} ·{" "}
                  {a.source === "data+stat" ? (a.agree === false ? "data dan stat beda, lihat catatan" : "stat & data sepakat") : "dari stat saja"}
                </div>
              </div>
              {a.data ? (
                <div className="ml-auto text-right text-xs">
                  <div>{pc(a.data.share)} pemain</div>
                  {a.data.winrate != null ? <div className="text-muted">WR {pc(a.data.winrate)}</div> : null}
                </div>
              ) : null}
            </div>
            <ul className="mt-2 space-y-1 text-xs text-muted">
              {a.reasons.map((r, i) => (
                <li key={i}>• {r}</li>
              ))}
            </ul>
            {a.alternatives.length ? (
              <div className="mt-1 text-xs text-muted">
                Alternatif: {a.alternatives.map((x) => `${x.name}${x.share != null ? ` (${pc(x.share)})` : ""}`).join(", ")}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </Panel>
  );
}
