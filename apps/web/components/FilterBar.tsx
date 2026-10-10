import { describeWindow } from "@/lib/data";
import { FilterBarClient, type RankOption } from "./FilterBarClient";

/** Period + rank filter, with a line saying exactly which data is being shown. */
export async function FilterBar({ ranks, days, badge }: { ranks: RankOption[]; days: number; badge: number }) {
  const note = await describeWindow(days).catch(() => undefined);
  return <FilterBarClient ranks={ranks} days={days} badge={badge} note={note} />;
}
