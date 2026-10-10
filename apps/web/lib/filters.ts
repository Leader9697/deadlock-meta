export interface Filters {
  days: number;
  /** min_average_badge; 0 = all ranks */
  badge: number;
}

/** days = 0: since the last big patch. days = -1 (default): automatic, see windowStart(). */
export const SINCE_PATCH = 0;
export const AUTO = -1;
export const DAY_OPTIONS = [AUTO, SINCE_PATCH, 3, 7, 14, 30] as const;

type SP = Record<string, string | string[] | undefined>;

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export function parseFilters(sp: SP): Filters {
  const raw = first(sp.days);
  const d = raw === "patch" ? SINCE_PATCH : raw === "auto" ? AUTO : Number(raw);
  const b = Number(first(sp.badge));
  return {
    days: raw !== undefined && raw !== "" && (DAY_OPTIONS as readonly number[]).includes(d) ? d : AUTO,
    badge: Number.isInteger(b) && b >= 0 && b <= 116 ? b : 0,
  };
}

export function parseIdList(v: string | string[] | undefined, max = 6): number[] {
  const s = first(v);
  if (!s) return [];
  return [...new Set(s.split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, max);
}

export function filterQuery(f: Filters, extra: Record<string, string | number | undefined> = {}): string {
  const p = new URLSearchParams();
  if (f.days !== AUTO) p.set("days", f.days === SINCE_PATCH ? "patch" : String(f.days));
  if (f.badge) p.set("badge", String(f.badge));
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}
