# Deadlock Meta — project notes for Claude

Owner: Faris. Talk to him in informal Bahasa Indonesia, direct and practical. He plays Deadlock and
uses the **HUD widgets** in game; he rarely opens the main panel. Keep the HUD compact.

## What this is
- **Website** (Next.js 16, `apps/web`): meta / counters / builds / patch notes / profile, all from
  deadlock-api (community API over Valve data). Also the **analysis server** for the overlay
  (`/api/live`, `/api/me/*`).
- **Windows overlay** (Tauri 2, `apps/desktop`): reads the live match from Valve's spectator
  broadcast (via deadlock-api live demo SQL, `crates/deadlock-live`), posts state to `/api/live`,
  shows advice. The installed app bundles the website as a standalone Next server + node sidecar
  (`scripts/bundle-web.mjs`, `apps/desktop/src-tauri/src/webserver.rs`), started in the background.
- **Shared logic** in `packages/core/src` (TypeScript, used by web and overlay).

## Hard rules
- Never read game memory, inject DLLs or use info hidden in game (VAC risk + fairness). Only the
  public broadcast, console.log (`-condebug`) and Steam files.
- The broadcast is **~60–90 s late** (measured live as `lagSeconds()` in the overlay). Anything
  "do X now" from deaths/positions is stale → removed. Time-bound advice is written as the
  **in-game clock** ("sampai 13:45"), never "±40 dtk".
- Late game never recommends cheap tiers: `TIER_FLOOR` (adaptive.ts) early T1+, mid T2+,
  late/vlate T3+, enforced in adaptivePath, pickForNeed, coach.buildPath and a final guard in
  `/api/live`.
- Slots: 4 per category (weapon/vitality/spirit) + up to 4 flex. Sell advice is per category
  (`sellAdvice`, `slotUsage`), never sells to fund a same/lower-tier item.
- Win probability shown is smoothed (EMA τ≈150 s, `smoothWin` in main.ts); server macro uses the
  smoothed value sent back as `winPSmooth`. Calibration (`calibrateProb`) is applied to the raw
  server value, so the reliability table is built from the logged raw value (`LogSnapshot.winRaw`),
  never from the shown one (that would make it correct its own corrections).
- Match win/loss from history = `match_result === player_team` (`player_match_outcome` is not
  reliable). A log whose broadcast ended before the game-over row gets its result from the match
  history (`backfillOutcomes`, in `/api/me/summary` and `/me`); the post-match card shows "hasil
  belum ada" until then, never a guessed KALAH.
- The overlay never guesses who "me" is: account id (or the hero picked pre-game) or an honest
  "akun tidak ada di match ini" — no first-player fallback.
- Street Brawl: the game rules row decides; the player count only counts after 2:00 (players
  arrive one by one, so a short list early is not 4v4). Same rule in `detectMode` (core) and the
  Rust aggregator.

## Overlay map (names used with Faris)
- **Panel utama** (Ctrl+Shift+D): full window, tabs Sekarang/Lawan/Item/Mati/Hero, Status koneksi.
- **HUD widgets** (click-through, appear during a match): HUD Coach (top), HUD Situasi
  (`win` widget: win %, economy, spike, game plan, lanes, team line), HUD Beli (`buy`),
  HUD Lawan (`enemies`; Ctrl+Shift+T shows Tim for 10 s).
- Hotkeys (all Ctrl+Shift): D panel, F click-through, E edit HUD positions, B "sudah beli" #1,
  H focus mode (only Coach + Beli), T team view.
- Version label in the header comes from the app version (tauri.conf.json).
- **Tray icon** (v0.3.2): left click shows/hides the panel, right click menu (Tampilkan panel, klik-tembus,
  atur HUD, Keluar). ✕ / Alt+F4 only hide to the tray; "Keluar" quits for real (stops the bundled site).
- HUD Coach must never render empty (a blank transparent widget looks like it vanished): with no
  tips it shows the calm "Farm & ikuti build" line (`coachCard` in main.ts).
- Form controls are not re-rendered while focused (open dropdown closes at once): `isGuarded` in
  main.ts covers every text input / select / textarea automatically; `GUARDED` ids only for others.
- CSP is on (tauri.conf.json): no inline scripts or `on*=""` handlers in rendered HTML — use
  delegated listeners (see the hero-icon `error` listener). A `site_base` on a LAN IP over plain
  http needs that host added to `connect-src`.

## Key modules (packages/core/src)
adaptive.ts (build path, needs, sell, tiers) · coach.ts (tips) · gameplan.ts (delay-proof plan from
lineup strength per phase) · macro.ts (lane objective states; its farm/push calls are no longer
shown) · imbue.ts (which ability to imbue + why, stat + build data) · spikes.ts · playbook.ts ·
combo.ts · deathreview.ts · postmatch.ts · matchlog.ts (calibration) · habits.ts (cross-match
habits: deaths before 10:00, souls at 10:00 vs hero average, items always bought late) · phaseplan.ts · patchnotes.ts

## Build / run
- Dev: `npm install`, `npm run dev` (web :3000) + `npm run desktop` (overlay, tauri dev).
- Local installer: `npm run desktop:build` → `target/release/bundle/nsis/*-setup.exe`.
- Typecheck: `npx tsc --noEmit -p packages/core`, `-p apps/web`, `-p apps/desktop`;
  Rust: `cargo check -p deadlock-meta-desktop`, `cargo test -p deadlock-live`.
- Bundled site not reachable ("Server data ✗" in Status koneksi): the overlay shows why
  (`web_status` command in lib.rs → `WebNote` from `webserver::start`: port taken, server.js/node.exe
  missing, spawn blocked, or exit code + tail of `web-server.log` in the app log dir). It retries
  forever (every 5 s), so a slow first start recovers by itself.
- Office PC needs a proxy: `[web_env] HTTPS_PROXY=...` in `%APPDATA%/id.faris.deadlockmeta/deadlock-live.toml`.
- Offline: every deadlock-api answer is also saved to `DLM_DATA_DIR/api-cache` (`lib/disk-cache.ts`,
  `ClientOptions.fallback`); when the API / proxy is down the last good copy is served
  (never for `/v1/matches/active`, never on a 4xx).
- Private routes (`/api/me/log`, habits + calibration in `/api/me/summary`) need `x-dlm-token` =
  `DLM_INTERNAL_TOKEN`. The app creates the token once (`web-token.txt` in the config dir), gives
  it to the bundled site and to the overlay (`settings().apiToken`). Remote site: set
  `[web_env] DLM_INTERNAL_TOKEN=...` to the server's value. Without a token only `npm run dev` is open.
- Live streams: a connection that closes without the server's end event is reconnected (proxy
  timeouts); 20 consecutive failures, 3 empty closes or 40 clean closes end a query. After the
  game-over row the live task stops after 20 s. Spectate quota (6/h) is kept in
  `spectate-calls.txt` so a restart does not forget it.
- Tests: `npm test` (core + web, incl. a `/api/live` route test with a stubbed data layer),
  `cargo test --workspace`.

## Release / auto-update
1. `node scripts/bump.mjs 0.3.0` (tauri.conf.json, Cargo.toml, apps/desktop/package.json).
2. `git commit -am "release v0.3.0" && git tag v0.3.0 && git push --follow-tags`.
3. `.github/workflows/release.yml` builds on windows-latest with tauri-action, signs with secrets
   `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, publishes the release with
   `latest.json`. Installed apps check `plugins.updater.endpoints` at start and every 30 min and
   offer "Update sekarang" in the panel.
- The updater must be able to download release files without auth (public releases).

## Not verified on real data yet
Objective mask lane mapping (now counted only on lanes players are assigned to,
`activeLaneIndexes`), game_mode value 4 = Street Brawl, whether the live query server sends an
`end` event, DeathReplayDataEvent presence, base slot count/refund 50%,
lane-matchup endpoint stability, imbue target data from builds, console.log end-of-match line
(would let the HUD hide instantly). Ask Faris for screenshots / console.log when touching these.

## Ideas queued (Faris agreed on direction)
1. ~~Cross-match habits summary~~ — **done (v0.3.0)**: `habits.ts` over the logs in `DLM_DATA_DIR`,
   1–2 lines in HUD Situasi before the match (`HudExtra.habits`, from `/api/me/summary`) and the
   full breakdown in the "Kebiasaan lintas match" panel on web `/me` (`apps/web/lib/habits.ts`).
   Souls at 10:00 needs `LogSnapshot.nw`, recorded from v0.3.0 on, so older logs show "–".
2. ~~Laning souls target per minute as one HUD number~~ — **done** (`computeSoulsPacing`, HUD Situasi).
3. Draft help in the overlay during hero pick — partly: draft odds show once the lineup is in the
   broadcast; nothing yet during the pick phase itself (console.log does not list other players).
4. Calibrate weights after ~20 real matches (`/me` calibration).
