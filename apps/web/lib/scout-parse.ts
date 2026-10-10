export interface LobbyEntry {
  accountId: number;
  heroId?: number;
  team?: number;
}

/** Parses "acc[:hero[:team]],acc2…" — the format the desktop app sends. Max 12. */
export function parseLobby(raw: string | string[] | undefined): LobbyEntry[] {
  const s = Array.isArray(raw) ? raw.join(",") : raw ?? "";
  const out: LobbyEntry[] = [];
  for (const part of s.split(/[\s,]+/)) {
    const [a, h, t] = part.split(":").map((x) => Number(x));
    if (!Number.isInteger(a) || a <= 0) continue;
    if (out.some((o) => o.accountId === a)) continue;
    out.push({
      accountId: a,
      heroId: Number.isInteger(h) && h > 0 ? h : undefined,
      team: t === 0 || t === 1 ? t : undefined,
    });
    if (out.length === 12) break;
  }
  return out;
}
