import { BuildLab } from "@/components/BuildLab";
import { parseLabInit } from "@/lib/lab-init";
import { getLabData } from "@/lib/lab";

export const dynamic = "force-dynamic";

export default async function LabPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [data, sp] = await Promise.all([getLabData(), searchParams]);
  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-display text-3xl font-bold">Lab Build</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          Pilih hero, build lengkap langsung dihitung untuk tiap kondisi (standar, unggul, tertinggal, lawan senjata / spirit / heal / CC / tank) dengan perkiraan
          WR dan alasan tiap item. Di bawahnya kalkulator manual: DPS, EHP dan spirit power dari angka resmi hero dan item, bandingkan dua build.
        </p>
      </div>
      <BuildLab heroes={data.heroes} items={data.items} init={parseLabInit(sp)} />
    </div>
  );
}
