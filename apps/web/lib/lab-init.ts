export interface LabInit {
  hero?: number;
  souls?: number;
  a?: number[];
  b?: number[];
}

/** Parsed on the server from ?hero=&souls=&a=&b= so SSR and hydration render the same build. */
export function parseLabInit(p: Record<string, string | string[] | undefined>): LabInit {
  const one = (k: string) => (Array.isArray(p[k]) ? p[k]![0] : (p[k] as string | undefined)) ?? "";
  const ids = (k: string) => one(k).split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0);
  return { hero: Number(one("hero")) || undefined, souls: Number(one("souls")) || undefined, a: ids("a"), b: ids("b") };
}
