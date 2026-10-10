const STEAM64_BASE = 76561197960265728n;

/**
 * Accepts SteamID64, SteamID3 ("[U:1:12345]" or "12345"), or a steamcommunity
 * /profiles/ URL and returns the 32-bit account id deadlock-api uses.
 * Vanity URLs (/id/name) cannot be resolved offline → returns null.
 */
export function toAccountId(input: string): number | null {
  const s = input.trim();
  const profile = s.match(/steamcommunity\.com\/profiles\/(\d{17})/);
  if (profile) return Number(BigInt(profile[1]) - STEAM64_BASE);
  const id3 = s.match(/^\[?U:1:(\d+)\]?$/i);
  if (id3) return Number(id3[1]);
  if (/^\d{17}$/.test(s)) return Number(BigInt(s) - STEAM64_BASE);
  if (/^\d{1,10}$/.test(s)) {
    const n = Number(s);
    return n > 0 && n < 2 ** 32 ? n : null;
  }
  return null;
}

export function toSteam64(accountId: number): string {
  return (BigInt(accountId) + STEAM64_BASE).toString();
}
