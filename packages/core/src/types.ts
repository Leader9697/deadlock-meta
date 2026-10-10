// Subset of the deadlock-api.com schemas that this project uses.
// Full spec: https://api.deadlock-api.com/openapi.json

export type ItemSlotType = "weapon" | "spirit" | "vitality";
export type HeroType = "assassin" | "brawler" | "marksman" | "mystic";

export interface Hero {
  id: number;
  name: string;
  class_name: string;
  hero_type?: HeroType | null;
  player_selectable: boolean;
  disabled: boolean;
  in_development: boolean;
  images: {
    icon_image_small?: string | null;
    icon_image_small_webp?: string | null;
    icon_hero_card?: string | null;
    icon_hero_card_webp?: string | null;
    minimap_image_webp?: string | null;
  };
  colors?: { ui?: number[]; glow_enemy?: number[] } & Record<string, unknown>;
  /** slot → item class name, e.g. signature1..signature4 (4 = ultimate), weapon_primary */
  items?: Record<string, string>;
}

export interface Item {
  id: number;
  name: string;
  class_name: string;
  type: "ability" | "weapon" | "upgrade";
  item_slot_type?: ItemSlotType;
  item_tier?: number;
  cost?: number | null;
  shopable?: boolean;
  disabled?: boolean | null;
  is_active_item?: boolean;
  image?: string | null;
  image_webp?: string | null;
  shop_image_small?: string | null;
  shop_image_small_webp?: string | null;
}

export interface Rank {
  tier: number;
  name: string;
  color: string;
  images: { small?: string | null; small_webp?: string | null } & Record<string, string | null | undefined>;
}

export interface AnalyticsHeroStats {
  hero_id: number;
  bucket: number;
  wins: number;
  losses: number;
  matches: number;
  matches_per_bucket: number;
  total_kills: number;
  total_deaths: number;
  total_assists: number;
  total_net_worth: number;
  total_player_damage: number;
  total_last_hits: number;
}

export interface ItemStats {
  item_id: number;
  bucket: number;
  wins: number;
  losses: number;
  matches: number;
  players: number;
  avg_buy_time_s: number;
  avg_buy_time_relative: number;
  avg_sell_time_s: number;
}

export interface HeroCounterStats {
  hero_id: number;
  enemy_hero_id: number;
  wins: number;
  matches_played: number;
  kills: number;
  deaths: number;
  assists: number;
  networth: number;
  enemy_networth: number;
}

export interface HeroSynergyStats {
  hero_id1: number;
  hero_id2: number;
  wins: number;
  matches_played: number;
}

export interface AccountRank {
  account_id: number;
  badge: number;
  rank: number;
  subrank: number;
}

export interface SteamProfile {
  account_id: number;
  personaname: string;
  avatar: string;
  avatarmedium: string;
  avatarfull: string;
  profileurl: string;
  countrycode?: string | null;
  matches_played_last_30d: number;
  last_team_avg_badge?: number | null;
}

export interface PlayerHeroStats {
  account_id: number;
  hero_id: number;
  matches_played: number;
  wins: number;
  kills: number;
  deaths: number;
  assists: number;
  last_played: number;
  time_played: number;
  networth_per_min: number;
  damage_per_min: number;
  accuracy: number;
}

export interface MatchHistoryEntry {
  account_id: number;
  match_id: number;
  hero_id: number;
  hero_level: number;
  start_time: number;
  game_mode: number;
  match_mode: number;
  match_duration_s: number;
  player_team: number;
  player_kills: number;
  player_deaths: number;
  player_assists: number;
  net_worth: number;
  last_hits: number;
  denies: number;
  match_result: number;
  /** not reliably sent by the API: use match_result === player_team */
  player_match_outcome?: number;
}

export interface ActiveMatchPlayer {
  account_id?: number | null;
  hero_id?: number | null;
  team?: number | null;
}

export interface ActiveMatch {
  match_id?: number | null;
  lobby_id?: number | null;
  start_time?: number | null;
  duration_s?: number | null;
  match_mode?: number | null;
  net_worth_team_0?: number | null;
  net_worth_team_1?: number | null;
  players: ActiveMatchPlayer[];
}

export interface HeroBuildStats {
  hero_build_id: number;
  hero_id: number;
  wins: number;
  losses: number;
  matches: number;
  players: number;
}

export interface BuildMod {
  ability_id: number;
  annotation?: string | null;
  sell_priority?: number | null;
  /** for imbue items: the ability the author imbues it into */
  imbue_target_ability_id?: number | null;
}

export interface BuildCategory {
  name: string;
  description?: string | null;
  optional?: boolean | null;
  mods?: BuildMod[] | null;
}

export interface HeroBuild {
  hero_build_id: number;
  hero_id: number;
  author_account_id: number;
  name: string;
  description?: string | null;
  version: number;
  last_updated_timestamp?: number | null;
  details: { mod_categories: BuildCategory[] };
}

export interface Build {
  hero_build: HeroBuild;
  num_favorites?: number | null;
  num_weekly_favorites?: number | null;
}

export interface AbilityOrderStats {
  abilities: number[];
  wins: number;
  losses: number;
  matches: number;
  players: number;
  total_kills: number;
  total_deaths: number;
  total_assists: number;
}

export interface ItemFlowNode {
  column: number;
  item_id: number;
  wins: number;
  losses: number;
  matches: number;
  players: number;
  adjusted_win_rate: number;
  avg_net_worth_at_buy: number;
}

export interface ItemFlowEdge {
  from_column: number;
  from_item_id: number;
  to_item_id: number;
  wins: number;
  losses: number;
  matches: number;
}

export interface ItemFlowSummary {
  wins: number;
  losses: number;
  matches: number;
  players: number;
  avg_net_worth: number;
  avg_duration_s: number;
}

export interface ItemFlowStats {
  nodes: ItemFlowNode[];
  edges: ItemFlowEdge[];
  summary: ItemFlowSummary;
  baseline: ItemFlowSummary;
  reached_per_column: number[];
}

export interface HeroBanStats {
  hero_id: number;
  bucket: number;
  bans: number;
}

export interface HeroCombStats {
  hero_ids: number[];
  wins: number;
  losses: number;
  matches: number;
}

export interface ItemPermutationStats {
  item_ids: number[];
  wins: number;
  losses: number;
  matches: number;
}
