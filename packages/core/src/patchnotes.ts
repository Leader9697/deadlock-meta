/**
 * Patch notes: turn the forum/Steam feed into plain-text lines, find which heroes and
 * items each line touches, and classify it as buff / nerf / change.
 *
 * Output is plain text only (no HTML is ever rendered), so the feed content can't
 * inject markup into the site.
 */

import type { PatchNote } from "./api";

export type ChangeKind = "buff" | "nerf" | "change";

export interface PatchLine {
  text: string;
  kind: ChangeKind;
  heroIds: number[];
  itemIds: number[];
}

export interface ParsedPatch {
  id: string;
  title: string;
  date: string;
  link: string;
  source: "forum" | "steam";
  lines: PatchLine[];
  /** hero id → its lines */
  heroes: Map<number, PatchLine[]>;
  items: Map<number, PatchLine[]>;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

export function htmlToLines(html: string): string[] {
  const text = html
    .replace(/<\s*(br|\/p|\/li|\/div|\/h\d|li|p)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e: string) => {
      if (e.startsWith("#x")) return String.fromCodePoint(parseInt(e.slice(2), 16));
      if (e.startsWith("#")) return String.fromCodePoint(Number(e.slice(1)));
      return ENTITIES[e.toLowerCase()] ?? m;
    });
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim().replace(/^[-•*]\s*/, ""))
    .filter((l) => l.length > 2);
}

// lower is better for these stats
const LOWER_BETTER = /cooldown|cost|price|reload time|cast delay|cast time|charge time|channel time|spin.?up|recovery|wind.?up|respawn|delay/i;

export function classify(line: string): ChangeKind {
  const m = line.match(/from\s+(-?[\d.]+)\s*%?[a-z]*\s+to\s+(-?[\d.]+)/i);
  const lowerBetter = LOWER_BETTER.test(line);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (Number.isFinite(a) && Number.isFinite(b) && a !== b) return (b > a) !== lowerBetter ? "buff" : "nerf";
  }
  if (/\b(increased|increase|raised|improved|buffed|now also|added)\b/i.test(line)) return lowerBetter ? "nerf" : "buff";
  if (/\b(reduced|decreased|lowered|reduce|decrease|nerfed|no longer|removed)\b/i.test(line)) return lowerBetter ? "buff" : "nerf";
  return "change";
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function parsePatch(
  p: PatchNote,
  heroes: { id: number; name: string }[],
  items: { id: number; name: string }[],
): ParsedPatch {
  const lines = htmlToLines(p.content_encoded ?? p.content ?? "");
  const heroRe = heroes.filter((h) => h.name.length >= 3).map((h) => ({ id: h.id, re: new RegExp(`(^|[^\\w])${esc(h.name)}(?![\\w])`, "i") }));
  const itemRe = items.filter((i) => i.name.length >= 4).map((i) => ({ id: i.id, re: new RegExp(`(^|[^\\w])${esc(i.name)}(?![\\w])`, "i") }));
  const parsed: PatchLine[] = [];
  // Valve often writes a hero name as a header line followed by its changes
  let currentHero: number | null = null;
  for (const text of lines) {
    const hs = heroRe.filter((h) => h.re.test(text)).map((h) => h.id);
    const is = itemRe.filter((i) => i.re.test(text)).map((i) => i.id);
    const header = hs.length === 1 && text.length <= 30 && !/\d/.test(text);
    if (header) {
      currentHero = hs[0];
      continue;
    }
    if (hs.length) currentHero = text.length <= 30 ? hs[0] : currentHero;
    const heroIds = hs.length ? hs : currentHero != null && !is.length ? [currentHero] : [];
    parsed.push({ text, kind: classify(text), heroIds, itemIds: is });
    if (!hs.length && is.length) currentHero = null;
  }
  const heroesMap = new Map<number, PatchLine[]>();
  const itemsMap = new Map<number, PatchLine[]>();
  for (const l of parsed) {
    for (const h of l.heroIds) heroesMap.set(h, [...(heroesMap.get(h) ?? []), l]);
    for (const i of l.itemIds) itemsMap.set(i, [...(itemsMap.get(i) ?? []), l]);
  }
  return {
    id: p.guid?.text ?? p.link,
    title: p.title,
    date: p.pub_date,
    link: p.link,
    source: p.source,
    lines: parsed,
    heroes: heroesMap,
    items: itemsMap,
  };
}

export function summarizeKinds(lines: PatchLine[]): { buff: number; nerf: number; change: number } {
  const r = { buff: 0, nerf: 0, change: 0 };
  for (const l of lines) r[l.kind]++;
  return r;
}
