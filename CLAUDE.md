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
  smoothed value sent back as `winPSmooth`.
- Match win/loss from history = `match_result === player_team` (`player_match_outcome` is not
  reliable).

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
- Form controls that must not be re-rendered while focused (open dropdown closes at once): add the id
  to `GUARDED` in main.ts (`matchInput`, `heroSel`).

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

## Release / auto-update
1. `node scripts/bump.mjs 0.3.0` (tauri.conf.json, Cargo.toml, apps/desktop/package.json).
2. `git commit -am "release v0.3.0" && git tag v0.3.0 && git push --follow-tags`.
3. `.github/workflows/release.yml` builds on windows-latest with tauri-action, signs with secrets
   `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, publishes the release with
   `latest.json`. Installed apps check `plugins.updater.endpoints` at start and every 30 min and
   offer "Update sekarang" in the panel.
- The updater must be able to download release files without auth (public releases).

## Not verified on real data yet
Objective mask lane mapping, DeathReplayDataEvent presence, base slot count/refund 50%,
lane-matchup endpoint stability, imbue target data from builds, console.log end-of-match line
(would let the HUD hide instantly). Ask Faris for screenshots / console.log when touching these.

## Ideas queued (Faris agreed on direction)
1. ~~Cross-match habits summary~~ — **done (v0.3.0)**: `habits.ts` over the logs in `DLM_DATA_DIR`,
   1–2 lines in HUD Situasi before the match (`HudExtra.habits`, from `/api/me/summary`) and the
   full breakdown in the "Kebiasaan lintas match" panel on web `/me` (`apps/web/lib/habits.ts`).
   Souls at 10:00 needs `LogSnapshot.nw`, recorded from v0.3.0 on, so older logs show "–".
2. Laning souls target per minute as one HUD number.
3. Draft help in the overlay during hero pick.
4. Calibrate weights after ~20 real matches (`/me` calibration).
