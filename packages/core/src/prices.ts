/**
 * Item prices — one source of truth.
 *
 * Deadlock prices every shop item purely by its tier: all tier-1 items cost the same, all
 * tier-2 items cost the same, and so on. deadlock-api's `/v1/assets/items` `cost` field
 * comes from Valve's asset dump and has been seen lagging a balance patch (it reported 500
 * for tier 1 while the in-game shop charged 800), so the tier table below wins over it and
 * the API `cost` is only a fallback for items with no tier.
 *
 * Confirmed in game: tier 1 = 800 (Faris, shop screenshot). Tiers 2–4 follow Valve's
 * doubling scheme and are listed in "Not verified on real data yet" in CLAUDE.md — override
 * them without a release via `DLM_TIER_PRICES` (see `tierPricesFromEnv`).
 */

/** Price per item tier, in souls. */
export type TierPrices = Record<number, number>;

export const DEFAULT_TIER_PRICES: TierPrices = { 1: 800, 2: 1600, 3: 3200, 4: 6400 };

/**
 * The asset dump uses 9999 as a placeholder cost for items that are not really in the shop
 * (ability upgrades, dev items). Anything at or above this is not a price.
 */
export const COST_SENTINEL = 9999;

let TIER_PRICES: TierPrices = { ...DEFAULT_TIER_PRICES };

/** Replace the tier table (e.g. from `DLM_TIER_PRICES` after a balance patch). */
export function configureTierPrices(prices: TierPrices | null | undefined): void {
  TIER_PRICES = prices && Object.keys(prices).length ? { ...prices } : { ...DEFAULT_TIER_PRICES };
}

export function tierPrices(): TierPrices {
  return TIER_PRICES;
}

/**
 * Parses `DLM_TIER_PRICES`. Accepts "800,1600,3200,6400" (tier 1..n in order) or
 * "1=800,2=1600". Returns null when unset or unusable, so the caller keeps the defaults.
 */
export function tierPricesFromEnv(raw: string | undefined | null): TierPrices | null {
  if (!raw || !raw.trim()) return null;
  const out: TierPrices = {};
  let i = 0;
  for (const part of raw.split(",")) {
    const s = part.trim();
    if (!s) continue;
    i += 1;
    const [a, b] = s.includes("=") ? s.split("=", 2) : [String(i), s];
    const tier = Number(a);
    const price = Number(b);
    if (!Number.isInteger(tier) || tier < 1 || tier > 10) return null;
    if (!Number.isFinite(price) || price <= 0 || price >= COST_SENTINEL) return null;
    out[tier] = Math.round(price);
  }
  return Object.keys(out).length ? out : null;
}

export interface PricedItem {
  item_tier?: number | null;
  cost?: number | null;
}

/**
 * What the shop actually charges, in souls. 0 means "not a shop item": callers filter those
 * out instead of showing a bogus price (that is what the 9999 placeholder used to leak).
 */
export function itemCost(it: PricedItem | null | undefined): number {
  if (!it) return 0;
  const tier = it.item_tier ?? 0;
  const byTier = TIER_PRICES[tier];
  if (byTier) return byTier;
  const raw = it.cost ?? 0;
  if (!Number.isFinite(raw) || raw <= 0 || raw >= COST_SENTINEL) return 0;
  return Math.round(raw);
}

/** True when the item has a real shop price. */
export const isPriced = (it: PricedItem | null | undefined): boolean => itemCost(it) > 0;

/**
 * Rewrites an item's `cost` to the real shop price. Used once, where the asset list is
 * loaded, so every consumer (web pages, /api/live, the overlay) sees corrected prices.
 */
export function withItemCost<T extends PricedItem>(it: T): T {
  return { ...it, cost: itemCost(it) || it.cost };
}

/**
 * Souls as the shop writes them: exact, grouped with "." (id-ID). Item prices, refunds and
 * souls in hand use this — `k()` rounds to 100 souls, which turns 1.250 into "1.3k" and
 * made the HUD disagree with the shop.
 */
export const souls = (n: number): string => Math.round(n).toLocaleString("id-ID");
