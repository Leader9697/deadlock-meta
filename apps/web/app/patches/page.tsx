import Link from "next/link";
import { summarizeKinds, type ParsedPatch, type PatchLine } from "@deadlock/core";
import { EmptyState, HeroIcon, ItemIcon, Panel } from "@/components/ui";
import { getHeroMap, getItemMap, getLatestPatchTs, getParsedPatches } from "@/lib/data";

export const dynamic = "force-dynamic";

const KIND: Record<PatchLine["kind"], { label: string; cls: string }> = {
  buff: { label: "BUFF", cls: "bg-win/20 text-win" },
  nerf: { label: "NERF", cls: "bg-loss/20 text-loss" },
  change: { label: "UBAH", cls: "bg-panel-2 text-muted" },
};

const fmtDate = (d: string) => new Date(d).toLocaleString("id-ID", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Jakarta" });

export default async function PatchesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const open = typeof sp.p === "string" ? sp.p : null;
  const [patches, heroes, items, bigTs] = await Promise.all([getParsedPatches(), getHeroMap(), getItemMap(), getLatestPatchTs()]);
  const list = patches.slice(0, 20);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-3xl font-bold">Patch Notes</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          Otomatis dari changelog forum resmi dan berita Steam (dicek tiap 15 menit). Tiap baris ditandai hero/item yang disentuh dan arah
          perubahannya.{bigTs ? ` Patch besar terakhir: ${fmtDate(new Date(bigTs * 1000).toISOString())}.` : ""} Pilih periode “Sejak patch” di halaman
          lain untuk statistik setelah patch itu saja.
        </p>
      </div>
      {!list.length ? (
        <Panel>
          <EmptyState>Feed patch tidak bisa diambil saat ini.</EmptyState>
        </Panel>
      ) : (
        list.map((p, i) => <PatchCard key={p.id} p={p} expanded={open === p.id || (!open && i === 0)} heroes={heroes} items={items} />)
      )}
    </div>
  );
}

function PatchCard({
  p,
  expanded,
  heroes,
  items,
}: {
  p: ParsedPatch;
  expanded: boolean;
  heroes: Awaited<ReturnType<typeof getHeroMap>>;
  items: Awaited<ReturnType<typeof getItemMap>>;
}) {
  const heroRows = [...p.heroes.entries()].map(([id, lines]) => ({ id, k: summarizeKinds(lines) }));
  return (
    <Panel
      title={
        <span className="flex flex-wrap items-baseline gap-2">
          <a href={p.link} target="_blank" rel="noreferrer" className="hover:text-brass">
            {p.title}
          </a>
          <span className="text-xs font-normal text-muted">
            {fmtDate(p.date)} · {p.source === "forum" ? "Forum" : "Steam"}
          </span>
        </span>
      }
      right={
        expanded ? null : (
          <Link href={`/patches?p=${encodeURIComponent(p.id)}`} className="text-xs text-brass">
            Buka
          </Link>
        )
      }
    >
      {heroRows.length ? (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {heroRows.map(({ id, k }) => (
            <Link key={id} href={`/heroes/${id}`} className="inline-flex items-center gap-1 rounded bg-panel-2 py-0.5 pl-0.5 pr-1.5 text-[11px]">
              <HeroIcon hero={heroes.get(id)} size={18} className="rounded-sm" />
              {k.buff ? <span className="text-win">+{k.buff}</span> : null}
              {k.nerf ? <span className="text-loss">−{k.nerf}</span> : null}
              {k.change ? <span className="text-muted">~{k.change}</span> : null}
            </Link>
          ))}
        </div>
      ) : null}
      {expanded ? (
        <ul className="space-y-1 text-sm">
          {p.lines.slice(0, 400).map((l, i) => (
            <li key={i} className="flex gap-2">
              <span className={`mt-0.5 h-fit shrink-0 rounded px-1 text-[9px] font-bold ${KIND[l.kind].cls}`}>{KIND[l.kind].label}</span>
              {l.itemIds[0] ? <ItemIcon item={items.get(l.itemIds[0])} size={18} /> : l.heroIds[0] ? <HeroIcon hero={heroes.get(l.heroIds[0])} size={18} className="rounded-sm" /> : null}
              <span>{l.text}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">{p.lines.length} baris perubahan.</p>
      )}
    </Panel>
  );
}
