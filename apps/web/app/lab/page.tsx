import { BuildLab } from "@/components/BuildLab";
import { parseLabInit } from "@/lib/lab-init";
import { getLabData } from "@/lib/lab";

export const dynamic = "force-dynamic";

export default async function LabPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [data, sp] = await Promise.all([getLabData(), searchParams]);
  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-display text-3xl font-bold">Kalkulator Build</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          Hitung DPS, EHP, dan spirit power dari angka resmi hero dan item (deadlock-api assets). Rumus DPS divalidasi terhadap DPS resmi tiap senjata
          (burst cocok persis, sustained dalam 1% untuk 38/40 hero). Bandingkan dua build, dan lihat item mana yang paling menambah DPS atau EHP per
          1.000 souls.
        </p>
      </div>
      <BuildLab heroes={data.heroes} items={data.items} init={parseLabInit(sp)} />
    </div>
  );
}
