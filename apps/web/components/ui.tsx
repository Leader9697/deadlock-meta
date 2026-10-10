/* eslint-disable @next/next/no-img-element */
import type { Hero, Item, ItemSlotType, Rank, Tier } from "@deadlock/core";
import { badgeSubrank, badgeTier, formatDelta, formatPct } from "@deadlock/core";
import type { ReactNode } from "react";

export const SLOT_LABEL: Record<ItemSlotType, string> = {
  weapon: "Weapon",
  vitality: "Vitality",
  spirit: "Spirit",
};

export const SLOT_TEXT: Record<ItemSlotType, string> = {
  weapon: "text-weapon",
  vitality: "text-vitality",
  spirit: "text-spirit",
};

const SLOT_RING: Record<ItemSlotType, string> = {
  weapon: "ring-weapon/60",
  vitality: "ring-vitality/60",
  spirit: "ring-spirit/60",
};

const SLOT_BG: Record<ItemSlotType, string> = {
  weapon: "bg-weapon/15",
  vitality: "bg-vitality/15",
  spirit: "bg-spirit/15",
};

export function heroImg(h: Hero | undefined) {
  return h?.images.icon_image_small_webp ?? h?.images.icon_image_small ?? h?.images.icon_hero_card_webp ?? undefined;
}

export function HeroIcon({ hero, size = 40, className = "" }: { hero?: Hero; size?: number; className?: string }) {
  const src = heroImg(hero);
  return (
    <span
      className={`inline-block shrink-0 overflow-hidden rounded-md bg-panel-2 ring-1 ring-line ${className}`}
      style={{ width: size, height: size }}
      title={hero?.name}
    >
      {src ? <img src={src} alt={hero?.name ?? ""} width={size} height={size} className="h-full w-full object-cover" /> : null}
    </span>
  );
}

export function ItemIcon({ item, size = 40 }: { item?: Item; size?: number }) {
  const src = item?.shop_image_small_webp ?? item?.shop_image_small ?? item?.image_webp ?? item?.image ?? undefined;
  const slot = item?.item_slot_type ?? "weapon";
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-md ring-1 ${SLOT_RING[slot]} ${SLOT_BG[slot]}`}
      style={{ width: size, height: size }}
      title={item?.name}
    >
      {src ? <img src={src} alt={item?.name ?? ""} className="h-[78%] w-[78%] object-contain" /> : null}
    </span>
  );
}

export function wrColor(wr: number) {
  if (wr >= 0.53) return "text-win";
  if (wr <= 0.47) return "text-loss";
  return "text-fg";
}

export function Pct({ value, color = true, digits = 1 }: { value: number; color?: boolean; digits?: number }) {
  return <span className={`num ${color ? wrColor(value) : ""}`}>{formatPct(value, digits)}</span>;
}

export function Delta({ value, digits = 1 }: { value: number; digits?: number }) {
  const cls = value > 0.002 ? "text-win" : value < -0.002 ? "text-loss" : "text-muted";
  return <span className={`num ${cls}`}>{formatDelta(value, digits)}</span>;
}

const TIER_CLS: Record<Tier, string> = {
  S: "bg-tier-s text-ink",
  A: "bg-tier-a text-ink",
  B: "bg-tier-b text-ink",
  C: "bg-tier-c text-ink",
  D: "bg-tier-d text-ink",
};

export function TierBadge({ tier }: { tier: Tier }) {
  return (
    <span className={`font-display inline-flex h-7 w-7 items-center justify-center rounded text-lg font-bold ${TIER_CLS[tier]}`}>
      {tier}
    </span>
  );
}

export function WinBar({ value, max = 0.6, min = 0.4 }: { value: number; max?: number; min?: number }) {
  const pct = Math.max(0, Math.min(1, (value - min) / (max - min))) * 100;
  return (
    <span className="relative block h-1.5 w-full overflow-hidden rounded-full bg-line">
      <span className="absolute inset-y-0 left-1/2 w-px bg-muted/50" />
      <span
        className={`absolute inset-y-0 left-0 rounded-full ${value >= 0.5 ? "bg-win" : "bg-loss"}`}
        style={{ width: `${pct}%` }}
      />
    </span>
  );
}

export function RankLabel({ badge, ranks }: { badge: number; ranks: Rank[] }) {
  if (!badge) return <span className="text-muted">Unranked</span>;
  const r = ranks.find((x) => x.tier === badgeTier(badge));
  const sub = badgeSubrank(badge);
  const img = r?.images[`small_subrank${sub}_webp`] ?? r?.images.small_webp ?? undefined;
  return (
    <span className="inline-flex items-center gap-1.5">
      {img ? <img src={img} alt="" width={20} height={20} /> : null}
      <span style={{ color: r?.color }}>
        {r?.name ?? `Tier ${badgeTier(badge)}`} {sub || ""}
      </span>
    </span>
  );
}

export function Panel({ title, right, children, className = "" }: { title?: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border border-line bg-panel/80 ${className}`}>
      {title ? (
        <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
          <h2 className="font-display text-lg font-bold text-fg">{title}</h2>
          {right}
        </header>
      ) : null}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-sm text-muted">{children}</p>;
}
