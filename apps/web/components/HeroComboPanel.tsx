import { heroCombo, heroKit } from "@deadlock/core";
import { Panel } from "@/components/ui";
import { getLabData } from "@/lib/lab";

const ROLE: Record<string, { label: string; cls: string }> = {
  buka: { label: "BUKA", cls: "bg-brass/20 text-brass" },
  item: { label: "ITEM", cls: "bg-spirit/20 text-spirit" },
  shred: { label: "SHRED", cls: "bg-weapon/20 text-weapon" },
  damage: { label: "DAMAGE", cls: "bg-weapon/20 text-weapon" },
  tutup: { label: "TUTUP", cls: "bg-loss/20 text-loss" },
  kabur: { label: "KABUR", cls: "bg-panel-2 text-muted" },
};

/** The hero's combo from its ability numbers (same logic the overlay uses in-game). */
export async function HeroComboPanel({ heroId }: { heroId: number }) {
  const lab = await getLabData();
  const hero = lab.heroes.find((h) => h.id === heroId);
  if (!hero) return null;
  const byClass = new Map(lab.items.map((i) => [i.class_name, i]));
  const combo = heroCombo(heroKit(hero.items, byClass));
  if (!combo.steps.length) return null;
  return (
    <Panel title="Combo ability" right={<span className="text-xs text-muted">dari angka ability resmi · overlay menambahkan item CC yang kamu punya</span>}>
      <ol className="space-y-1.5">
        {combo.steps.map((s, i) => (
          <li key={s.id} className="flex items-start gap-2 text-sm">
            <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-brass text-[11px] font-bold text-ink">{i + 1}</span>
            <span className={`mt-0.5 shrink-0 rounded px-1.5 text-[10px] font-bold ${ROLE[s.role].cls}`}>{ROLE[s.role].label}</span>
            <span>
              <b>{s.name}</b> <span className="text-muted">{s.note}</span>
            </span>
          </li>
        ))}
      </ol>
      {combo.notes.length ? (
        <div className="mt-2 space-y-0.5 text-xs text-muted">
          {combo.notes.map((n, i) => (
            <p key={i}>{n}</p>
          ))}
        </div>
      ) : null}
    </Panel>
  );
}
