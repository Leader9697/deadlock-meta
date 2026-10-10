# Deadlock Meta

Website meta Deadlock (tier list, item per hero, counter build, scouting pemain) + fondasi untuk app desktop Tauri.
Data dari [deadlock-api.com](https://api.deadlock-api.com/docs) — gratis, tanpa key.

## Struktur

```
packages/core   TypeScript murni: API client, statistik, algoritma counter, scouting.
                Dipakai website sekarang, dan dipakai ulang oleh UI Tauri nanti.
apps/web        Next.js 16 (App Router) + Tailwind 4
```

## Jalankan

```bash
npm install
npm run dev          # http://localhost:3000
npm run build && npm start
```

`.env.local` (opsional, lihat `apps/web/.env.example`):

| Var | Fungsi |
| --- | --- |
| `DEADLOCK_API_KEY` | Naikkan limit analytics 200 → 400 req/menit |
| `DEADLOCK_API_BASE` | Override base URL (mis. mock server untuk testing) |
| `API_CORS_ORIGIN` | Kunci CORS `/api/*` ke origin app Tauri (default `*`) |

Deploy paling gampang: Vercel (set root directory `apps/web`) atau `npm start` di VPS.

## Halaman

| Route | Isi |
| --- | --- |
| `/` | Tier list hero. Filter periode (3/7/14/30 hari) & rank minimum |
| `/heroes/[id]` | Item terbaik per tier (Δ vs item satu tier), matchup unggul/kalah, sinergi |
| `/counter?hero=&enemies=` | Counter build vs lineup musuh (max 6) per slot Weapon/Vitality/Spirit + item yang dihindari |
| `/meta` | Meta Detector: skor komposit (WR uplift + tren WR + tren pick + porsi ban), label META/NAIK/SLEEPER/OVERRATED/TURUN |
| `/draft?a=&b=` | Draft Analyzer: peluang menang draft, rekomendasi pick & ban |
| `/heroes/[id]/items` | Timing & alur item: adjusted WR per fase beli (5 menit), batas waktu beli, item lanjutan |
| `/lab?hero=&souls=&a=&b=` | Build Lab: DPS/EHP/spirit power dari angka resmi, bandingkan build A vs B, item berikutnya per 1.000 souls |
| `/players` | Cari pemain (nama Steam / SteamID64 / `[U:1:x]` / URL profil) |
| `/players/[accountId]` | Kartu scouting + 30 match terakhir |
| `/scout?ids=acc:hero:team,...` | Scout lobby 12 pemain — tampilan yang nanti jadi overlay |

## API untuk app desktop

Semua JSON, CORS aktif.

```
GET /api/meta?days=7&badge=61
GET /api/counter?hero=6&enemies=1,13,25&days=7&badge=61
GET /api/scout?ids=12345:6:0,67890:13:1      # account_id[:hero_id[:team]], max 12
```

## Cara kerja angka

- **Tier list**: z-score dari Wilson lower bound win rate (+ sedikit bobot pick rate). Hero dengan sampel kecil tidak bisa "nyelonong" ke S tier.
- **Item per hero**: Δ dibanding rata-rata WR item di *tier yang sama* — menghilangkan bias "item mahal selalu kelihatan bagus karena hanya dibeli pemain yang menang".
- **Counter build**: untuk tiap musuh, `WR(item | musuh ada) − WR(item | baseline)`, dikurangi drift rata-rata vs musuh itu (seberapa berat match-nya secara umum), lalu di-shrink untuk sampel kecil dan dirata-rata berbobot √n antar musuh. Hasil = "item ini performanya naik X poin WR melawan lineup ini dibanding biasanya". Chip per musuh menunjukkan kontribusinya.
- **Scout**: rank, WR total, WR & KDA 20 match terakhir, streak, hero pool, statistik di hero yang sedang dipakai. Flag: `MAIN` (≥100 match di hero itu), `ON FIRE` (≥65% recent), `TILT` (kalah ≥4 beruntun), `BARU DI HERO INI` (<5 match).

Cache: assets 24 jam, analytics 10 menit, data pemain 2 menit. Analytics di deadlock-api sendiri di-cache 6 jam per query, jadi refresh lebih sering tidak berguna.

## Build Lab: rumus

Sumber: `/v1/assets/heroes` dan `/v1/assets/items`. Server mengirim versi ringkas (`/api/lab/data`, ±0,5 MB).

- **Stat diri** hanya dari properti item di section `innate` tanpa `conditional`. Properti `passive`/`active` adalah efek (proc, aura, debuff ke musuh seperti anti-heal), jadi tidak ditambahkan ke stat sendiri.
- **Level** = level tertinggi dengan `required_gold` ≤ souls. Tiap level `use_standard_upgrade` menambah `standard_level_up_upgrades` (damage peluru, HP, spirit power).
- **Bonus investasi** per slot = langkah terakhir `cost_bonuses[slot]` yang ambangnya sudah dilewati souls di slot itu. Weapon → % weapon damage, vitality → % HP dasar, spirit → spirit power.
- **DPS burst** = dmg/peluru × (1 + weapon dmg%) × peluru/tembakan × tembakan/detik × (1 + fire rate%). Cocok persis dengan `weapon_info.damage_per_second` untuk 40/40 hero.
- **DPS sustained** = damage 1 magazin / (waktu magazin + reload + 0,25 s − jeda intra-burst). Cocok dalam 1% untuk 38/40 hero (Seven & Lash ±2,4%).
- **Resist** bertumpuk multiplikatif: 1 − Π(1 − rᵢ). **EHP** = HP / (1 − resist).
- **Skala spirit** ability/item = nilai + `stat_scale` × spirit power.
- **Item berikutnya** = selisih DPS/EHP kalau item ditambahkan (net worth tetap, jadi level tetap), dibagi harga per 1.000 souls. Item yang melewati ambang bonus investasi diberi tanda.

## Fase 2: app desktop (Tauri) + overlay

```
crates/deadlock-live   Engine Rust: deteksi proses, akun Steam lokal, tail console.log, stream broadcast live
apps/desktop           Tauri 2 shell (src-tauri) + UI overlay (Vite/TS) yang memanggil /api website
```

### Build di Windows

Prasyarat: Rust (rustup), Node 20+, WebView2 (sudah ada di Windows 10/11), Visual Studio Build Tools (C++).

```bash
npm install
npm run dev                         # CMD 1: website di :3000 (overlay butuh /api dari sini)
npm run desktop                     # CMD 2: overlay (tauri dev), bisa dari root
npm run desktop:build               # installer .exe di target/release/bundle/nsis
```

Set Deadlock ke **Borderless Windowed** dan tambahkan `-condebug` di Launch Options Steam.

Hotkey: `Ctrl+Shift+D` tampil/sembunyi panel utama, `Ctrl+Shift+F` klik-tembus panel utama, `Ctrl+Shift+E` atur posisi widget HUD.

### Alur data

1. Proses `deadlock.exe` terdeteksi → mulai tail `console.log` (path dicari dari `libraryfolders.vdf`).
2. Akun kamu dibaca dari `Steam/config/loginusers.vdf` (`MostRecent`).
3. Match ID didapat dari console.log, atau fallback Watch tab (hanya top-200 match), atau input manual di overlay.
4. `GET /v1/matches/{id}/live/url` sekali (limit 6/jam per IP) → stream SSE `GET /v1/matches/demo/live/query?broadcast_url=…` (20/menit) dengan SQL di config.
5. Tiap update: `LiveState` → `POST /api/live` website → summary ekonomi + ancaman + "beli berikutnya".

Rekomendasi live = counter score yang **dibobot net worth musuh** (musuh yang feeding mendominasi), item yang sudah kamu punya dibuang, dan tier dibatasi sesuai souls (≤6k: T1–2, ≤16k: T1–3, sisanya T1–4).

Broadcast Valve **telat ±60–90 detik** dari game asli. Ini batas dari Valve, bukan dari app.

Semuanya pasif: daftar proses, file config Steam, log game sendiri, dan broadcast spectator publik. Tidak ada baca memory, inject, atau otomasi input.

### Coach (overlay)

`POST /api/live` mengembalikan instruksi, bukan hanya angka:

- **Coach banner** (maks. 3 instruksi, urut prioritas). Semua timer dikoreksi delay broadcast (default 75 dtk):
  - **PUSH** saat ≥2 musuh mati dan unggul jumlah ≥2, lengkap dengan sisa waktu respawn.
  - **MUNDUR** saat posisinya terbalik.
  - **Mid boss**: datang lebih awal atau jangan contest, tergantung peluang menang dan jumlah pemain hidup.
  - **Belanja**: saat souls nganggur cukup untuk item berikutnya. Prioritas naik kalau kamu sedang mati.
  - **Tempo**: tutup game cepat atau main lambat, dari peluang menang dan perbandingan scaling lineup.
  - **Momentum**: perubahan lead dalam 3 menit.
  - **Ancaman utama**: musuh paling kaya, plus item counter terbaiknya.
- **Peluang menang** = σ(k(t) · lead/total). k di-fit per jendela menit dari ±400 match nyata 3 hari terakhir (`/v1/matches/metadata` + net worth per waktu), lalu di-cache 12 jam. Ditambah tabel empiris, misalnya "tim yang unggul 6–10k di menit 15–22 menang 60%". Cek di `GET /api/winmodel`.
- **Build path**: urutan item dari build ber-WR tertinggi, item yang sudah dimiliki dibuang, souls dihitung kumulatif ("BISA BELI" / "kurang X"), dan alasan per item (counter siapa, berapa %).
- **Lawan**: per musuh ada vonis DUEL/HINDARI/SEIMBANG/MATI. Dasarnya matchup hero-vs-hero dan selisih net worth, ditambah item terbaru mereka, item counter terbaik, dan profil pemain.

### HUD widgets

Selain panel utama, ada 4 widget kecil (jendela transparan, klik-tembus, always-on-top) yang ditempel di sekitar HUD Deadlock:

| Widget | Default | Isi |
|---|---|---|
| `coach` | tengah atas, di bawah bar hero | instruksi utama + 2 instruksi tambahan |
| `win` | kiri, 25% tinggi layar | peluang menang, tren, perbandingan fase lineup |
| `enemies` | kiri, 52% | vonis per musuh, respawn, counter terbaik |
| `buy` | kanan, 30% | 4 item berikutnya, BISA/kurang souls, alasan |

- Posisi disimpan sebagai pecahan ukuran monitor + anchor (kiri/tengah/kanan), jadi tetap pas di resolusi berapa pun.
- **Ctrl+Shift+E** = mode edit: widget bisa diseret. Tekan lagi untuk menyimpan ke `%APPDATA%/id.faris.deadlockmeta/hud-layout.json`.
- Di file itu: `monitor` (indeks monitor game, default monitor utama), `scale` (0.5–2.5), dan per widget `enabled`, `w`, `h`.
- Hanya panel utama yang memanggil `/api/live`. Hasilnya disiarkan ke widget lewat event `overlay-data`.

### Config: `%APPDATA%/id.faris.deadlockmeta/deadlock-live.toml`

Dibuat otomatis saat pertama jalan. Default sudah dicocokkan dengan data asli:

- **`[log]`** (dicek dengan console.log build 6763):
  - Match ID diambil dari baris `Received Steam datagram ticket … match_id=N` dan `Lobby … for Match N created`.
  - Akun sendiri diambil dari `AuthStatus (steamid:…): OK`.
  - Log **tidak** mencatat pemain lain. Lobby lawan diisi dari stream live.
- **`[live] queries`** (dicek dengan `/v1/matches/demo/schema`, kolom memakai `__`). Ada 4 stream SSE:
  - `players`: `CCitadelPlayerController` → steam ID, slot, tim, hero, net worth, souls, K/D/A, level.
  - `clock`: `CCitadelGameRulesProxy.m_pGameRules__m_flMatchClockAtLastUpdate`.
  - `purchases`: `ItemPurchaseNotificationEvent` (beli/jual per slot). Item yang dibeli sebelum stream tersambung tidak tercatat.
  - `game_over`: `GameOverEvent.winning_team`.

Asumsi yang masih perlu dicek saat match asli: `userid` di event pembelian = slot pemain (`entity_index − 1` controller), dan Street Brawl punya broadcast live seperti mode normal.

Field lain: `site_base` (URL website, default `http://localhost:3000`), `account_id` (override), `api_key`.

### Test

```bash
cargo test -p deadlock-live        # VDF parser, log tail + baris log asli, SSE parser, aggregator, end-to-end engine (4 stream) vs mock API
```


## Urutan build per fase (Counter + Build Lab)

Fase: Early 0–10m, Mid 10–20m, Late 20–30m, Very Late 30m+ (`GAME_PHASES` di `packages/core/src/phaseplan.ts`).

- **Counter Build**: skor counter dihitung terpisah per fase pakai `item-stats` dengan `min_bought_at_s`/`max_bought_at_s`, jadi item dinilai dari pembelian di waktu itu saja. Hasilnya urutan beli bernomor (1..16) dengan total souls kumulatif, plus alternatif dan daftar "hindari". Biaya: 4 × (1 + jumlah lawan) request, maksimal 8 jalan bersamaan, cache 10 menit.
- **Build Lab**: urutan build hero dari `item-flow-stats`. Item ditaruh di fase saat paling sering dibeli, ranking = `0.06·√pick + (adjWR − baseWR)·n/(n+200)`. "Lihat stat di akhir fase" mengisi Build A sampai fase itu dan menggeser souls ke net worth khas fase tersebut. Rekomendasi "item berikutnya" bisa dibatasi ke item yang biasa dibeli sampai fase dari slider souls.


## Di belakang proxy kantor

Buat `apps/web/.env.local`:

```
HTTPS_PROXY=http://proxy.kantor.co.id:8080
```

`apps/web/instrumentation.ts` membaca HTTP(S)_PROXY / NO_PROXY saat server start dan mengarahkan semua fetch server (deadlock-api) lewat proxy itu (undici `EnvHttpProxyAgent`, tunnel CONNECT). Log start menampilkan `[deadlock-meta] outgoing requests via proxy ...`.


## Coach adaptif (overlay)

`/api/live` sekarang memakai semua analisa web:

- **Core + flex** (`packages/core/src/adaptive.ts`): urutan core dari item-flow hero kamu (sama dengan Build Lab), lalu maksimal 1/2/3 slot flex (early/mid/late) untuk menjawab lawan. Item core yang tertinggal lebih dari satu fase dilewati.
- **Profil lawan** dari item live (souls per slot + tag fungsi) dan stat broadcast (heal, damage): arketipe SUSTAIN / TANK / LINCAH / CC, item penting, dan perkiraan porsi damage peluru vs spirit (prior dari tipe hero, makin condong ke item seiring investasi).
- **Kebutuhan**: anti-heal, resist peluru/spirit (hanya resist ≥12% yang dihitung), anti-CC, slow/stun, penembus armor. Item jawaban dipilih dari skor counter fase sekarang + WR item di hero kamu.
- **Counter per fase**: skor counter diambil dari pembelian di fase game saat ini (fetch di-memo 10 menit per lineup, bobot ancaman dihitung ulang tiap panggilan).
- **Lane** (10 menit pertama): lawan lane dari `m_nAssignedLane`, tip tekan/aman dari matchup + selisih souls.
- Asset besar (items 8 MB, heroes 2.4 MB) di-cache di memori 6 jam; sebelumnya diunduh ulang tiap request.

Live query v6 menambah `lane`, `hero_damage`, `hero_healing`, `self_healing` (config lama dimigrasi otomatis).


## Playbook item & rencana makro (overlay)

- **Playbook** (`packages/core/src/playbook.ts`): fitur ability/item dibaca dari properti asset (durasi stun/hold/sleep/silence, slow % + durasi, dash reduction, anti-heal, shred, DoT/area, execute threshold, charge/aim, channel, mobilitas, cooldown). Untuk tiap item yang disarankan (3 teratas) dan tiap item aktif yang kamu punya: target (lawan dengan escape untuk slow/stun, ult paling berbahaya untuk silence, carry peluru untuk disarm, sustain untuk anti-heal, CC terberat untuk cleanse), kapan dipakai, dan combo dengan ability kamu (chain CC berurutan, CC sebelum skillshot/ult area, shred sebelum burst, execute sebagai penutup, interupsi channel lawan).
- **Rencana makro** (`packages/core/src/macro.ts`): status tiap lane dari objective mask (Guardian/Walker/Base per tim), siapa mati dan berapa lama (dikoreksi delay broadcast), souls kamu vs tim/lawan lane, peluang menang, scaling. Output: push lane X, jaga lane X, farm aman (lane mana), kejar souls, tetap di lane, gabung tim, atau tutup game. Menggantikan tip tempo generik.
- Asumsi yang belum diverifikasi: bit objective = masih berdiri (ada fallback kalau terbalik di 3 menit pertama), warna lane 1/3/4/6 = lane objective 1–4.


## Kenapa mati (overlay tab "Mati")

- Engine (live query v7) menangkap killfeed (`HeroKilledEvent`: killer, assist, ability) dan death recap bawaan game (`DeathReplayDataEvent`: damage per sumber termasuk crit/headshot dan killing blow, debuff/CC yang kena kamu, durasi, souls hilang), plus situasi saat itu (teman/lawan hidup, net worth, item kamu). Pawn entity → akun lewat `m_hHeroPawn & 32767`.
- `packages/core/src/deathreview.ts` menilai penyebab (dikeroyok, burst dari satu ability, CC berantai, ditembak/headshot, kalah 1v1 karena matchup/selisih souls, tower, heal dipotong) dan memberi perbaikan dari angka ability lawan (cast range, cooldown, durasi CC) serta item toko yang menjawabnya. Pola lintas kematian: pembunuh berulang, penyebab berulang, mati di early, mati saat kalah jumlah.
- Belum diverifikasi: apakah `DeathReplayDataEvent` ikut di broadcast spectator (di game itu dikirim ke korban). Kalau tidak ada, analisa jatuh ke killfeed + situasi saja.


## Installer Windows (tanpa CMD)

```
npm install
npm run desktop:build
```

Hasil: `target\release\bundle\nsis\Deadlock Meta_0.1.0_x64-setup.exe`. Install sekali (per user, tanpa admin), lalu buka dari Start Menu.

- `scripts/bundle-web.mjs` mem-build website sebagai server standalone (`output: "standalone"`) dan menyalin `node.exe` yang dipakai saat build sebagai sidecar, jadi PC tujuan tidak perlu Node.js.
- Saat app dibuka dan `site_base` = `http://localhost:3000` belum dipakai, app menjalankan server itu di background (tanpa jendela), log di `%LOCALAPPDATA%\id.faris.deadlockmeta\logs\web-server.log`. Server mati saat app ditutup (dan watchdog mematikannya kalau app crash).
- Kalau `npm run dev` sedang jalan di port 3000, app memakai itu dan tidak menjalankan servernya sendiri.
- Proxy / API key untuk server bawaan: di `deadlock-live.toml`
  ```
  [web_env]
  HTTPS_PROXY = "http://proxy.kantor:8080"
  ```
  (`api_key` di config juga diteruskan sebagai `DEADLOCK_API_KEY`). `.env.local` tidak ikut ke installer.
- `npm run desktop` (mode developer) tetap seperti sebelumnya.


## Patch, hero baru, core build per hero

- **Patch notes** (`/patches`): otomatis dari `/v2/patches` deadlock-api (changelog forum + berita Steam), dicek tiap 15 menit. Tiap baris ditandai hero/item yang disebut dan BUFF/NERF/UBAH (`packages/core/src/patchnotes.ts`, hanya teks, HTML feed tidak pernah dirender).
- **Sejak patch**: pilihan periode "Sejak patch" (`?days=patch`) memakai tanggal patch besar terakhir (`/v1/patches/big-days`). Meta Detector lalu membandingkan sesudah vs sebelum patch, dengan kolom Patch (baris patch yang menyentuh hero itu).
- **Hero page**: panel "Patch & meta" (WR sejak patch vs sebelumnya + baris patch hero itu) dan "Core build per fase" (early → very late).
- **Counter Build** dengan hero dipilih: "Build <hero> vs lineup ini" = core per fase dengan slot FLEX yang diganti counter (`adaptCoreToLineup`).
- **Hero baru otomatis**: hero dengan flag `in_development` dari Valve tetap ditampilkan begitu muncul di ≥50 match dalam 7 hari terakhir. Asset hero/item dicek ulang tiap jam.


## Profil, review pasca-match, kalibrasi (`/me`)

- **Log overlay**: tiap match, overlay menyimpan snapshot per ±20 dtk (peluang menang, tip utama, rencana, saran item, kebutuhan, item kamu) ke `/api/me/log` → file JSON di `DLM_DATA_DIR` (app terinstal: folder data app; dev: `apps/web/.data`).
- **Kalibrasi** (`packages/core/src/matchlog.ts`): prediksi peluang menang vs hasil nyata per rentang + Brier score, berapa sering saran item diikuti (≤4 menit) dan WR saat diikuti vs tidak, tip yang muncul, kebutuhan yang dibiarkan >5 menit.
- **Review pasca-match** (`/me/match/<id>?account=<id>`, `postmatch.ts`): dari metadata Valve. Souls menit 10/20/30 vs rata-rata hero ini di rank match itu, vs lawan lane; sumber souls vs tim; item yang telat vs rata-rata; semua kematian + total waktu mati; daftar perbaikan prioritas.
- **Profil** (`/me?account=<id>`): hero terbaik untuk kamu (WR kamu vs WR global, dikoreksi sampel kecil), 15 match terakhir, peringatan tilt (kalah beruntun / WR 10 terakhir).
- **Overlay**: kartu "Sebelum main" (tilt + hero terbaikmu), urutan ability (max priority + urutan poin, WR), data lane nyata (`lane-matchup-stats`: selisih souls duo kamu vs duo lawan di menit 10) dalam tip laning, suara untuk tip penting (🔊 di header, pakai suara Windows bahasa Indonesia kalau terpasang), link profil & review match.


## Match kamu ke deadlock-api (ingest)

deadlock-api hanya punya sebagian match tiap akun (riwayat lengkap hanya untuk akun yang berteman dengan bot mereka / Patreon). App desktop menjalankan `crates/deadlock-live/src/ingest.rs`: membaca 512 byte pertama file di `Steam/appcache/httpcache`, mengambil `match_id` + salt dari URL `replayN.valve.net/1422450/<match>_<salt>.(meta|dem).bz2`, dan mengirimnya ke `POST /v1/matches/salts` (sama seperti tool resmi `deadlock-api-ingest`). Scan penuh saat start lalu tiap 2 menit; yang sudah terkirim dicatat di `ingested-matches.txt`. Matikan dengan `ingest_matches = false` di `deadlock-live.toml`.


## Power spike, combo, partner (overlay + halaman hero)

- **Power spike** (`spikes.ts`): engine mencatat waktu beli tiap item (`itemTimes`). Item T3/T4 dalam 3 menit terakhir (dikoreksi delay broadcast) diberi bobot (T3 = 1, T4 = 2, makin lama makin kecil, × porsi net worth pembeli). Selisih ≥ 1,6 → "cari fight" / "tahan fight" dengan sisa window; mengalahkan rencana ekonomi generik (bukan push/defend karena jumlah pemain).
- **Combo hero** (`combo.ts`): buka dengan CC terkuat → item CC milikmu tepat saat CC pertama habis → shred → damage area/DoT → execute/ult → simpan escape. Dari angka ability resmi; tampil di halaman hero dan overlay.
- **Main bareng**: sekutu dengan sinergi duo tertinggi (data hero-synergy, ≥100 match), dengan alasan dari kit-nya (CC sekutu mengunci target untuk finisher kamu).


## Target beli dikunci, harga upgrade, saran jual

- **Dikunci**: item #1 yang sudah ditampilkan overlay dikirim balik (`commit`) dan tetap #1 sampai terbeli. Hanya diganti kalau: kebutuhan yang dijawabnya sudah terpenuhi/hilang, item sudah terlalu murah untuk fase ini, atau muncul kebutuhan sangat mendesak (urgency ≥ 0,8) sementara target adalah item core. Penggantian selalu ditampilkan dengan alasannya.
- **Upgrade dari komponen**: kalau kamu punya komponen (`component_items`), harga yang ditampilkan dan dihitung untuk "bisa beli" = harga − komponen.
- **Jual**: kalau slot penuh (12 + flex slot yang terbuka, dari `FlexSlotUnlockedEvent`; angka 12 adalah asumsi), pilih item untuk dijual: tier rendah, WR jelek di hero kamu, tidak menjawab ancaman lawan, bukan komponen item berikutnya, bukan item CC di combo kamu. Refund diasumsikan 50%.

## Imbue: item ke skill mana (overlay + halaman hero)

`imbue.ts`. Item imbue dikenali dari field `imbue` di asset item (`imbue_modifier_value`, `imbue_active`, `imbue_active_non_ult` = tidak boleh ke ult).

- **Argumen stat**: efek item dibaca dari propertinya (cooldown −%, durasi +%, range/radius +%, charge, damage echo, lifesteal, atau "terpicu tiap cast") lalu diterapkan ke angka tiap skill: misalnya stun 1,5 → 1,83 dtk, cooldown 24 → 19,7 dtk (+X cast per 5 menit). Bobot skill = CC, damage, skala spirit, DoT, ult, plus seberapa sering pemain max-kan skill itu duluan (`ability-order-stats`).
- **Argumen data**: build hero yang paling banyak dimainkan (`hero-build-stats`, dari analisa demo) + build favorit minggu ini (`/v1/builds`) menyimpan `imbue_target_ability_id`. Dihitung porsi pemakaian per skill (bobot jumlah match) dan WR per pilihan. Catatan: `hero_build_id` adalah build yang dipilih di awal match, jadi ini perkiraan pilihan imbue sebenarnya.
- **Gabungan**: 55% data + 45% stat + koreksi WR (shrinkage). Kalau data dan stat beda skill, saran menyebutkan keduanya dan alasannya. Data kurang (< 150 match dan < 4 build) → murni stat, ditandai.
- Overlay: baris "✨ Imbue → skill" di kartu Beli berikutnya dan di tab Item (item yang sudah dimiliki). Web: panel "Imbue ke skill mana" di halaman hero.
