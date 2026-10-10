import { NextResponse, type NextRequest } from "next/server";
import {
  TIER_FLOOR,
  formatClock,
  gamePlan,
  adaptivePath,
  buildAudit,
  sellAdvice,
  analyzeAbilityOrders,
  heroAbilities,
  coach,
  compareTeamPhases,
  deathPatterns,
  features,
  heroCombo,
  isImbueItem,
  maxFirstShare,
  recommendImbue,
  powerSpikes,
  reviewDeath,
  type Tip,
  heroKit,
  itemPlaybook,
  macroPlan,
  type PlayEnemy,
  damageProfile,
  empiricalFor,
  findNeeds,
  flowPhasePlan,
  nextBuys,
  phaseAt,
  profileEnemies,
  summarize,
  winProbability,
  type CounterItem,
  type CounterResult,
  type ItemSlotType,
  type LabItem,
  type LiveState,
} from "@deadlock/core";
import {
  getAbilityOrders,
  getBuilds,
  getCounterMatrix,
  getItems,
  getLaneMatchup,
  getSynergy,
  getHeroItemStats,
  getImbueData,
  getHeroMap,
  getHeroMeta,
  getItemFlow,
  getItemMap,
  getPhaseCounter,
  getPhases,
  ITEM_PHASE_S,
} from "@/lib/data";
import { parseFilters } from "@/lib/filters";
import { heroItemsByTier, matchupsFor, synergiesFor } from "@/lib/hero-analysis";
import { getLabData, getLabItemMap } from "@/lib/lab";
import { getWinModel } from "@/lib/winmodel";

type Body = LiveState & {
  /** [gameTimeS, lead (my view)] samples kept by the overlay */
  leadHistory?: [number, number][];
  broadcastDelayS?: number;
  /** items the player marked "sudah beli" that the (delayed) broadcast does not show yet */
  pendingBuys?: { itemId: number; cost: number }[];
  /** overlay's time-smoothed win probability (null on the first call of a match) */
  winPSmooth?: number | null;
  /** item the overlay has been showing as the #1 buy (kept until bought) */
  commit?: { itemId: number; sinceS: number } | null;
};

/**
 * Live coaching. The desktop app POSTs its LiveState every ~10–15 s.
 * Analytics fetches are cached (per lineup / per hero), so each call is mostly scoring.
 *
 * POST /api/live?days=7&badge=61
 */
export async function POST(req: NextRequest) {
  const f = parseFilters(Object.fromEntries(req.nextUrl.searchParams));
  let state: Body;
  try {
    state = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!Array.isArray(state?.players) || !state.myAccountId) {
    return NextResponse.json({ error: "players dan myAccountId wajib ada" }, { status: 400 });
  }

  // the broadcast runs 60 s+ behind: count items the player already marked as bought
  if (Array.isArray(state.pendingBuys) && state.pendingBuys.length) {
    const mine = state.players.find((p) => p.accountId === state.myAccountId);
    if (mine) {
      for (const b of state.pendingBuys.slice(0, 6)) {
        if (!b || typeof b.itemId !== "number" || mine.itemIds.includes(b.itemId)) continue;
        mine.itemIds = [...mine.itemIds, b.itemId];
        // souls in hand lag too: take off what the overlay showed as the price (upgrade discount included)
        mine.souls = Math.max(0, (mine.souls ?? 0) - Math.max(0, Number(b.cost) || 0));
      }
    }
  }
  const summary = summarize(state);
  if (!summary) {
    return NextResponse.json(
      { error: `akun ${state.myAccountId} tidak ada di ${state.players.length} pemain match ini` },
      { status: 409 },
    );
  }
  const me = state.players.find((p) => p.accountId === state.myAccountId)!;
  const enemyHeroes = summary.threats.map((t) => t.player.heroId);

  const [items, heroes, phaseCounter, phases, builds, matrix, meta, model, lab, flow, heroItems] = await Promise.all([
    getItemMap(),
    getHeroMap(),
    getPhaseCounter(me.heroId, enemyHeroes, f, summary.enemyWeights),
    getPhases(f.days, f.badge),
    getBuilds(me.heroId, f.days, f.badge).catch(() => []),
    getCounterMatrix(f.days, f.badge),
    getHeroMeta(f.days, f.badge),
    getWinModel(),
    getLabItemMap(),
    getItemFlow(me.heroId, f.days, f.badge).catch(() => null),
    getHeroItemStats(me.heroId, f.days, f.badge).catch(() => []),
  ]);

  // counter scores for purchases made in the *current* phase; whole-game merge as fallback
  const phase = phaseAt(state.gameTimeS);
  const merged = [...phaseCounter.bySlot.weapon, ...phaseCounter.bySlot.vitality, ...phaseCounter.bySlot.spirit].sort((a, b) => b.score - a.score);
  const nowList = phaseCounter.byPhase.get(phase)?.length ? phaseCounter.byPhase.get(phase)! : merged;
  const bySlot: Record<ItemSlotType, CounterItem[]> = { weapon: [], vitality: [], spirit: [] };
  for (const c of nowList) {
    const sl = items.get(c.itemId)?.item_slot_type;
    if (sl) bySlot[sl].push(c);
  }
  const counter: CounterResult = { items: nowList, bySlot, coveredEnemies: phaseCounter.coveredEnemies };

  const total = summary.teamNetWorth[0] + summary.teamNetWorth[1];
  const winRaw = winProbability(model, state.gameTimeS, summary.netWorthLead, total);
  // the overlay sends its smoothed value: macro plan and tips follow the trend, not every pick-off
  const winP = typeof state.winPSmooth === "number" && Number.isFinite(state.winPSmooth) ? Math.min(0.99, Math.max(0.01, state.winPSmooth)) : winRaw;
  const empirical = empiricalFor(model, state.gameTimeS, summary.netWorthLead);

  // momentum: lead now vs ~3 min ago (from the overlay's history)
  let trend: { seconds: number; leadDelta: number } | null = null;
  const hist = (state.leadHistory ?? []).filter((h) => Array.isArray(h) && h.length === 2);
  if (hist.length >= 2) {
    const target = state.gameTimeS - 180;
    const past = hist.reduce((best, h) => (Math.abs(h[0] - target) < Math.abs(best[0] - target) ? h : best), hist[0]);
    if (state.gameTimeS - past[0] >= 60) trend = { seconds: state.gameTimeS - past[0], leadDelta: summary.netWorthLead - past[1] };
  }

  const myWr = meta.find((m) => m.heroId === me.heroId)?.winrate ?? 0.5;
  const mus = new Map(matchupsFor(me.heroId, matrix, myWr).map((m) => [m.heroId, m.delta]));
  const heroName = (id: number) => heroes.get(id)?.name ?? `#${id}`;

  // ---- adaptive layer: enemy profiles → needs → core + flex build path ----
  const profiles = profileEnemies(
    summary.threats.map((t) => ({ player: t.player, weight: t.weight })),
    lab,
    (id) => heroes.get(id)?.hero_type,
    state.gameTimeS,
  );
  const damage = damageProfile(profiles);
  const myLab = me.itemIds.map((id) => lab.get(id)).filter((x): x is LabItem => !!x);
  const needs = findNeeds(profiles, damage, myLab, heroName);
  const core = flow ? flowPhasePlan(flow, ITEM_PHASE_S, items) : null;
  const tierRows = heroItemsByTier(heroItems, items, meta.find((m) => m.heroId === me.heroId)?.matches ?? 0);
  const heroDelta = new Map<number, number>();
  for (const rows of tierRows.values()) for (const r of rows) heroDelta.set(r.item.id, r.delta);
  const adaptive = adaptivePath({
    me,
    gameTimeS: state.gameTimeS,
    lab,
    items,
    core: core && core.plan.some((p) => p.steps.length) ? core : null,
    phaseCounter: nowList,
    heroItemDelta: (id) => heroDelta.get(id) ?? null,
    needs,
    heroName,
    commit: state.commit ?? null,
  });

  // ---- lane data, ability order, tilt ----
  const laneOpps = me.lane != null ? state.players.filter((p) => p.team !== me.team && p.lane === me.lane).map((p) => p.heroId) : [];
  const [laneStats, orderRows, itemList, imbueData] = await Promise.all([
    state.gameTimeS < 900 && laneOpps.length ? getLaneMatchup(me.heroId, laneOpps, f).catch(() => null) : null,
    getAbilityOrders(me.heroId, f.days, f.badge).catch(() => []),
    getItems(),
    getImbueData(me.heroId, f.days, f.badge).catch(() => null),
  ]);
  const heroObj = heroes.get(me.heroId);
  const abilities = heroObj ? heroAbilities(heroObj, itemList) : [];
  const ord = analyzeAbilityOrders(orderRows, abilities.find((a) => a.slot === 4)?.id ?? null);
  const abName = (id: number) => abilities.find((a) => a.id === id)?.name ?? `#${id}`;
  const abSlot = (id: number) => abilities.find((a) => a.id === id)?.slot ?? 0;
  const abilityOrder = ord.topOrders[0] || ord.maxPriorities[0]
    ? {
        max: ord.maxPriorities[0] ? ord.maxPriorities[0].order.map((id) => ({ slot: abSlot(id), name: abName(id) })) : [],
        maxWinrate: ord.maxPriorities[0]?.winrate ?? null,
        sequence: ord.topOrders[0] ? ord.topOrders[0].sequence.map(abSlot) : [],
        sequenceWinrate: ord.topOrders[0]?.winrate ?? null,
        ultAt: ord.bestUltPosition,
      }
    : null;

  // ---- macro plan + item playbooks ----
  const delayS = state.broadcastDelayS ?? 75;
  const teamPhases = compareTeamPhases(
    phases,
    state.players.filter((p) => p.team === me.team).map((p) => p.heroId),
    state.players.filter((p) => p.team !== me.team).map((p) => p.heroId),
  );
  // delay-proof game plan (lineup strength per phase on the in-game clock)
  const plan = teamPhases
    ? gamePlan({ mine: teamPhases.mine, enemy: teamPhases.enemy, clockS: state.gameTimeS + delayS, winP })
    : null;
  const macro = macroPlan({ state, me, netWorthLead: summary.netWorthLead, winP, scalingDiff: teamPhases?.scalingDiff ?? 0, delayS, heroName });
  const labData = await getLabData();
  const byClass = new Map(labData.items.map((i) => [i.class_name, i]));
  const kitOf = new Map(labData.heroes.map((h) => [h.id, heroKit(h.items, byClass)]));
  const myKit = kitOf.get(me.heroId) ?? [];
  const playEnemies: PlayEnemy[] = profiles.map((pr) => {
    const pl = state.players.find((x) => x.accountId === pr.accountId);
    return {
      profile: pr,
      name: heroName(pr.heroId),
      dead: !!pl?.dead && (pl.respawnInS ?? 0) - delayS > 5,
      abilities: kitOf.get(pr.heroId) ?? [],
    };
  });
  const play = (id: number) => {
    const it = lab.get(id);
    return it ? itemPlaybook(it, myKit, playEnemies) : null;
  };
  // ---- imbue: which of my abilities gets each imbue item (planned + owned) ----
  const prio = maxFirstShare(orderRows, abilities.find((a) => a.slot === 4)?.id ?? null);
  const imbue: Record<number, ReturnType<typeof recommendImbue>> = {};
  for (const id of [...adaptive.steps.slice(0, 6).map((st) => st.itemId), ...me.itemIds]) {
    const it = lab.get(id);
    if (!it || !isImbueItem(it) || imbue[id]) continue;
    const adv = recommendImbue(it, myKit, { data: imbueData, prio });
    if (adv) imbue[id] = adv;
  }
  const nextPlays = adaptive.steps.slice(0, 3).map((st) => play(st.itemId)).filter((x) => x != null);
  const ownedPlays = me.itemIds
    .map((id) => lab.get(id))
    .filter((it) => it && (it.is_active_item || isImbueItem(it)))
    .map((it) => play(it!.id))
    .filter((x) => x != null);

  const out = coach({
    state,
    me,
    summary,
    winP,
    trend,
    phases,
    counter,
    items,
    heroName,
    topBuild: builds[0]?.build ?? null,
    matchupDelta: (id) => mus.get(id) ?? null,
    broadcastDelayS: state.broadcastDelayS,
    path: adaptive.steps.length ? adaptive.steps : undefined,
    needs,
    profiles,
    damage,
    gamePlan: plan ?? undefined,
    laneStats,
  });

  // ---- why did I die ----
  const deaths = (state.myDeaths ?? []).slice(-8);
  const reviews = deaths.map((d) =>
    reviewDeath(d, {
      me,
      players: state.players,
      lab,
      heroName,
      myKit,
      kitOf: (id) => kitOf.get(id) ?? [],
      matchupDelta: (id) => mus.get(id) ?? null,
    }),
  );
  const patterns = deathPatterns(reviews, deaths, heroName, state.players);
  const last = reviews[reviews.length - 1];
  if (last && state.gameTimeS - last.gameTimeS <= 150) {
    const tip: Tip = {
      kind: "death",
      priority: me.dead ? 92 : 62,
      title: `Kenapa mati: ${last.causes[0].title}`,
      detail: [last.causes[0].detail, ...last.fixes.slice(0, 2)].join(" "),
    };
    out.tips = [...out.tips, tip].sort((a, b) => b.priority - a.priority).slice(0, 3);
  }


  // ---- power spikes, my combo, who to play with ----
  const spikes = powerSpikes(state.players, me, state.gameTimeS, items, delayS);
  const list = (xs: typeof spikes.myItems) =>
    xs
      .slice(0, 3)
      .map((x) => `${heroName(x.heroId)}: ${x.name}`)
      .join(", ");
  const spikeTips: Tip[] = [];
  // windows are written as in-game clock times: the overlay data is 1+ minute late
  const spikeUntil = formatClock(state.gameTimeS + delayS + spikes.windowLeft);
  if (state.winningTeam === undefined && state.gameTimeS >= 480) {
    if (spikes.verdict === "fight")
      spikeTips.push({ kind: "push", priority: 68, title: `Spike tim kamu: fight sampai ${spikeUntil}`, detail: `Baru beli ${list(spikes.myItems)}; lawan belum menjawab. Paksa fight/objektif sampai jam game ${spikeUntil}.` });
    else if (spikes.verdict === "avoid")
      spikeTips.push({ kind: "retreat", priority: 66, title: `Spike lawan: tahan sampai ${spikeUntil}`, detail: `Lawan baru beli ${list(spikes.enemyItems)}. Hindari fight sampai jam game ${spikeUntil}, farm dan tunggu item kamu.` });
    else if (spikes.self && spikes.self.tier >= 4 && spikes.self.age <= 90)
      spikeTips.push({ kind: "push", priority: 50, title: `Kamu baru spike: ${spikes.self.name}`, detail: "Item besar baru: ini waktunya cari pick-off atau bantu objektif, sebelum lawan menyamakan." });
  }
  const ownedFeats = me.itemIds.map((id) => lab.get(id)).filter((x): x is LabItem => !!x && x.type === "upgrade").map((x) => features(x));
  const combo = heroCombo(myKit, ownedFeats);
  const synergy = await getSynergy(f.days, f.badge).catch(() => []);
  const allyIds = new Set(state.players.filter((p) => p.team === me.team && p.accountId !== me.accountId).map((p) => p.heroId));
  const bestAlly = synergiesFor(me.heroId, synergy, myWr)
    .filter((x) => allyIds.has(x.heroId) && x.matches >= 100)
    .sort((a, b) => b.delta - a.delta)[0];
  let partner: { heroId: number; name: string; delta: number; why: string } | null = null;
  if (bestAlly && bestAlly.delta >= 0.01) {
    const allyKit = kitOf.get(bestAlly.heroId) ?? [];
    const allyCC = allyKit.filter((a) => a.stun || a.sleep || a.hold).sort((a, b) => (b.stun ?? b.sleep ?? b.hold ?? 0) - (a.stun ?? a.sleep ?? a.hold ?? 0))[0];
    const finisher = combo.steps.find((st) => st.role === "tutup");
    partner = {
      heroId: bestAlly.heroId,
      name: heroName(bestAlly.heroId),
      delta: bestAlly.delta,
      why: allyCC && finisher ? `${allyCC.name}-nya mengunci target untuk ${finisher.name} kamu` : allyCC ? `${allyCC.name}-nya membuka fight untuk kamu` : "duo ini menang lebih sering dari rata-rata",
    };
    if (state.gameTimeS >= 600 && state.winningTeam === undefined)
      spikeTips.push({ kind: "objective", priority: 36, title: `Main bareng ${partner.name}`, detail: `Sinergi ${partner.delta >= 0 ? "+" : ""}${(partner.delta * 100).toFixed(1)}%: ${partner.why}.` });
  }
  // a clear spike window overrides the generic economy plan (not the numbers-based push/defend)
  if (spikes.verdict !== "even" && !macro.why.some((w) => /musuh mati|teman mati/.test(w))) {
    const conflict = spikes.verdict === "fight" ? ["farm", "tempo", "retreat"] : ["push"];
    out.tips = out.tips.filter((t) => !(t.title === macro.title && conflict.includes(t.kind)));
  }
  // ---- sell advice when slots are full ----
  const sell = sellAdvice({
    me,
    lab,
    next: adaptive.steps,
    needs,
    flexUnlocked: state.flexSlots?.[me.team] ?? 0,
    heroItemDelta: (id) => heroDelta.get(id) ?? null,
    keepIds: new Set(combo.steps.filter((st) => st.isItem).map((st) => st.id)),
    coreIds: new Set(core?.plan.flatMap((p) => p.steps.map((st) => st.itemId)) ?? []),
    gameTimeS: state.gameTimeS,
  });
  if (sell && state.winningTeam === undefined) {
    const target = adaptive.steps.find((st) => st.itemId === sell.forId);
    const canAfford = target ? (me.souls ?? 0) + sell.refund >= target.cost : false;
    // "souls idle: buy X" is wrong while the slots are full
    out.tips = out.tips.filter((t) => !(t.kind === "buy" && t.title.includes("nganggur")));
    if (canAfford) spikeTips.push({ kind: "buy", priority: me.dead ? 91 : 63, title: `Jual ${sell.sellName} → beli ${sell.forName}`, detail: sell.reason });
  }
  if (adaptive.switched && state.winningTeam === undefined) {
    spikeTips.push({ kind: "buy", priority: 57, title: "Target beli diganti", detail: adaptive.switched });
  }
  // ---- full-build audit: nothing left to buy (or every slot taken) → is an owned item worth swapping? ----
  const auditRaw = buildAudit({
    me,
    lab,
    gameTimeS: state.gameTimeS,
    counter: nowList,
    heroItemDelta: (id) => heroDelta.get(id) ?? null,
    needs,
    flexUnlocked: state.flexSlots?.[me.team] ?? 0,
    next: adaptive.steps,
    keepIds: new Set(combo.steps.filter((st) => st.isItem).map((st) => st.id)),
    coreIds: new Set(core?.plan.flatMap((p) => p.steps.map((st) => st.itemId)) ?? []),
  });
  const auditShown = state.winningTeam === undefined && phase !== "early" && !sell && (auditRaw.full || adaptive.steps.length === 0) && auditRaw.swaps.length > 0;
  const audit = auditShown ? auditRaw : null;
  if (audit) {
    const top = audit.swaps[0];
    if (top.affordable) spikeTips.push({ kind: "buy", priority: me.dead ? 70 : 52, title: `Ganti ${top.sellName} → ${top.buyName}`, detail: top.reason });
  }

  if (spikeTips.length) out.tips = [...out.tips, ...spikeTips].sort((a, b) => b.priority - a.priority).slice(0, 3);

  // ---- final consistency guard: whatever path produced the list, no out-of-phase cheap
  // items, and no "sell for X" unless X is actually on the buy list
  {
    const floor = TIER_FLOOR[phaseAt(state.gameTimeS)];
    out.buildPath = out.buildPath.filter((st) => (st.tier ?? 0) >= floor || (st as { upgradeFrom?: number }).upgradeFrom != null);
  }
  const sellOk = !!sell && out.buildPath.some((st) => st.itemId === sell.forId) && !out.buildPath.some((st) => st.itemId === sell.sellId);
  if (sell && !sellOk) out.tips = out.tips.filter((t) => !t.title.startsWith(`Jual ${sell.sellName}`));
  const buys = nextBuys(counter, items, me);
  const slim = (xs: typeof buys.all) =>
    xs.map((b) => {
      const top = b.counter.perEnemy[0];
      return {
        id: b.item.id,
        name: b.item.name,
        tier: b.item.item_tier,
        cost: b.item.cost,
        slot: b.item.item_slot_type,
        score: b.counter.score,
        affordable: b.affordable,
        reason: top && top.delta > 0.005 ? `vs ${heroName(top.enemyHeroId)} ${top.delta >= 0 ? "+" : ""}${(top.delta * 100).toFixed(1)}%` : "",
      };
    });

  return NextResponse.json({
    gameTimeS: state.gameTimeS,
    teamNetWorth: summary.teamNetWorth,
    netWorthLead: summary.netWorthLead,
    winProbability: winRaw,
    winModel: model ? { matches: model.matches, samples: model.samples } : null,
    empirical,
    trend,
    tips: out.tips,
    phase,
    adaptive: { phase: adaptive.phase, flexUsed: adaptive.flexUsed, flexMax: adaptive.flexMax, source: adaptive.steps.length && core ? "core+flex" : "build" },
    needs: needs.map((n) => ({ kind: n.kind, urgency: n.urgency, reason: n.reason, satisfied: n.satisfied })),
    damage,
    macro,
    gamePlan: plan,
    playbook: { next: nextPlays, owned: ownedPlays },
    deaths: { reviews: [...reviews].reverse().slice(0, 5), patterns },
    abilityOrder,
    imbue: Object.values(imbue).filter((x) => x != null),
    laneStats,
    spikes: { verdict: spikes.verdict, mine: spikes.mine, enemy: spikes.enemy, windowLeft: spikes.windowLeft, untilClock: spikeUntil, myItems: spikes.myItems.slice(0, 4), enemyItems: spikes.enemyItems.slice(0, 4) },
    combo,
    partner,
    sell: sellOk ? sell : null,
    audit,
    switched: adaptive.switched,
    teamPhases: out.teamPhases,
    buildPath: out.buildPath,
    build: builds[0] ? { id: builds[0].build.hero_build_id, name: builds[0].build.name, winrate: builds[0].winrate, matches: builds[0].matches } : null,
    matchups: out.matchups,
    threats: summary.threats.map((t) => ({ accountId: t.player.accountId, heroId: t.player.heroId, netWorth: t.player.netWorth, nwShare: t.nwShare, weight: t.weight })),
    nextBuys: { all: slim(buys.all), weapon: slim(buys.weapon), vitality: slim(buys.vitality), spirit: slim(buys.spirit) },
  });
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204 });
}
