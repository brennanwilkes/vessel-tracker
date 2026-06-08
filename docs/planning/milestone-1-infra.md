# Salish Sea Vessel Tracker — Build Plan & Infrastructure

> **This document is the single source of truth.** It replaces the original
> `salish-sea-tracker-plan.md` (being deleted). It carries the full product vision plus the
> initial infrastructure plan, the repo conventions, and the decisions made with the owner. A
> fresh model should be able to build Milestone 1 from this document alone.

---

## 0. Context — what this is and why

A **personal, public, read-only, mobile-first PWA** that shows the boats currently visible
from a specific apartment window overlooking the Salish Sea (Strait of Juan de Fuca / Haro
Strait / Gulf Islands, south of Victoria BC). It pulls live AIS vessel positions, shows them
on a map and a distance-sorted list, and — in later milestones — overlays vessel labels on a
live camera feed (AR) and uses a small vision model to point the camera at a boat and identify
which AIS contact it is.

It is built for **one location** (the owner's apartment; possibly a rooftop view later), has
**no user accounts and no login**, and is served for free. Visitors (e.g. houseguests) can
just open the URL. It must stay on **free tiers** (GitHub Pages + Cloudflare Workers free
plan + aisstream.io free feed).

This plan covers **Milestone 1 (live map/list, deployed) + scaffolding and data model for the
later milestones**, so M2–M4 slot in without rework. M2–M4 are specified at a high level here
and detailed in their own planning docs when we reach them.

---

## 1. Decisions already made (do not re-litigate)

These were settled with the owner and override anything implied by older notes:

1. **Single repo (monorepo)** containing frontend, worker, and the ML model pipeline.
2. **aisstream.io is WebSocket-only** — there is no REST endpoint to query on page load.
   Cloudflare Workers are request-scoped and cannot hold a socket between requests; Durable
   Objects (the only "persistent socket" option) require the **paid** plan. Therefore
   ingestion is a **scheduled (cron) Worker** that briefly connects to aisstream, drains
   messages, writes state, and disconnects. Fully free-tier; doubles as the data-collection
   pipeline for later milestones.
3. **No auth, ever.** Public read-only. Any per-device preferences (viewshed polygon, km/nm
   units) live in browser `localStorage`. Config is shaped to support **multiple named
   viewsheds** (apartment now, rooftop maybe later) with zero backend accounts.
4. **No bundler / no framework** (matches `~/spirit-tracker`): raw ES6 modules + CDN libraries.
   Leaflet, OpenCV.js, and onnxruntime-web all ship CDN/UMD builds that we lazy-load only on
   the tabs that need them. Revisit (add Vite) *only* if M3/M4 dependency management becomes
   painful — not pre-emptively.
5. **Frontend → GitHub Pages.** Worker → `*.workers.dev`. CORS configured on the Worker (same
   pattern as `~/spirit-tracker-api`). Custom domain added later; until then the github.io URL
   is fine and CORS can be permissive.
6. **The M4 vision model is a DETECTOR, not a classifier.** Its only job is "where is the boat
   in this camera frame" → bounding box → pixel position → bearing → match to the nearest AIS
   contact at that bearing. **Identity comes from AIS, never from visually recognizing a named
   vessel.** Owner-supplied empty-view background photos help it learn the static scene.
   Training is run **manually/locally**, rarely, and then forgotten. `/model` is scaffolded
   now; no ML code or ML CI in M1.
7. **Persist sightings + movement history from day one** (it cannot be backfilled). There is
   **no free API for vessel voyage/port-call history** (that is paid MarineTraffic/VesselFinder
   data), and aisstream only streams vessels *inside our bounding box* — once a ship leaves our
   view we stop seeing it. So we build our own record:
   - a **frequent cron** logs a lightweight per-vessel "sightings" row for every boat we see;
   - a **slow cron** (daily) re-queries our known MMSIs over a wide area to record where they
     are now, so over months/years we learn where past visitors went. Best-effort and subject
     to aisstream coverage — documented as a known limitation, not a guarantee.

---

## 2. Repository layout

Single repo at `/home/brennan/vessel-tracker`. **Three top-level code areas** (`frontend/`,
`worker/`, `model/`) plus **docs and planning** directories.

```
vessel-tracker/
  README.md                       # one-screen overview + how to deploy + links into docs/
  CLAUDE.md                       # ROOT project memory (see §8 for the CLAUDE.md convention)

  docs/                           # durable PROJECT INFORMATION (committed, human-facing)
    architecture.md               # the system diagram + data flow, kept current
    ais-reference.md              # aisstream message shapes, vessel-type codes, bounding box
    decisions.md                  # running log of architectural decisions (this §1, expanded)
    milestones/
      MILESTONE_1.md              # written when M1 ships: what changed + gotchas
      ...                         # MILESTONE_2.md etc. as each milestone lands
    planning/                     # design docs / plans for upcoming work
      milestone-1-infra.md        # = this plan (copy it here on save)
      milestone-2-viewshed.md     # added when we start M2
      ...

  frontend/                       # GitHub Pages artifact root — NO build step, deployed verbatim
    CLAUDE.md                     # frontend-specific conventions (no-bundler rules, CDN libs)
    index.html
    style.css
    config.js                     # VIEWSHEDS[], WORKER_URL, POLL_INTERVAL_MS (all consts at top)
    app/
      main.js                     # entry: hash routing + bottom tab bar
      api.js                      # fetch wrapper for the Worker endpoints
      store.js                    # shared vessel state + 30s polling loop (pub/sub)
      geo.js                      # haversine distance + bearing math
      map_page.js                 # Leaflet map + rotated vessel icons + detail sheet
      list_page.js                # distance-sorted list view
      camera_page.js              # M3 placeholder tab
    assets/
      ship-cargo.svg  ship-ferry.svg  ship-passenger.svg  ship-unknown.svg

  worker/                         # Cloudflare Worker (TypeScript) — the data backend
    CLAUDE.md                     # worker-specific conventions (cron model, KV/D1 keys)
    wrangler.toml
    tsconfig.json
    package.json
    schema.sql                    # D1 schema (vessels, vessel_pings)
    .dev.vars.example             # local secret template (AISSTREAM_API_KEY=...)
    scripts/
      ensure-bindings.mjs         # idempotently create KV + D1, patch wrangler.toml IDs in CI
    src/
      index.ts                    # exports fetch (HTTP API) + scheduled (cron) handlers
      ingest.ts                   # aisstream WS: connect, subscribe, drain, parse, merge
      ais.ts                      # AIS message parsing + vessel-type code → category mapping
      storage.ts                  # KV snapshot read/write + D1 sightings/pings access
      cors.ts                     # origin-checked CORS headers + handleOptions
      http.ts                     # json() / errorJson() response helpers
      types.ts                    # Env, Vessel, Sighting, Ping interfaces
      constants.ts                # bounding box, stale threshold, drain window, etc.

  model/                          # M4 ML scaffold ONLY in this milestone — no code/CI yet
    CLAUDE.md                     # ML conventions (detector not classifier; manual training)
    README.md                     # how to train + export ONNX (filled in at M4)
    requirements.txt              # torch, torchvision, onnx, onnxruntime (pinned at M4)
    dataset/
      images/                     # captured camera frames (NOT committed; see §7)
      background/                 # owner's empty-view reference photos
      labels.json                 # annotations
    scripts/
      prepare_dataset.py  train.py  export_onnx.py  evaluate.py
    model/
      base/  checkpoints/  export/   # pretrained weights / training ckpts / final .onnx

  .github/workflows/
    deploy-worker.yml             # push to main touching worker/**  → wrangler deploy
    deploy-pages.yml              # push to main touching frontend/** → GitHub Pages
    pr-check.yml                  # PR → typecheck + wrangler dry-run (no deploy)
```

**Note:** `/model` is created as directories + README + CLAUDE.md only. Do not write training
code in M1.

---

## 3. Reference repos — copy these patterns (don't reinvent)

Two existing repos on this machine already solve the CF Worker + Pages + Actions problems.
Read and adapt, don't redesign:

- **Worker deploy workflow** (Node 24, `wrangler deploy`, per-secret `wrangler secret put`):
  `~/spirit-tracker-api/.github/workflows/deploy.yml`
- **`wrangler.toml` shape** and the **idempotent binding-ensure script** invoked in CI:
  `~/spirit-tracker-api/wrangler.toml`, `~/spirit-tracker-api/scripts/ensure-kv-and-patch.mjs`,
  and its `npm run kv:ensure` script in `~/spirit-tracker-api/package.json`. Our
  `ensure-bindings.mjs` extends this to also create the D1 database.
- **CORS helper** (origin check → headers, `handleOptions` for preflight):
  `~/spirit-tracker-api/src/cors.ts`
- **HTTP/JSON response helpers:** `~/spirit-tracker-api/src/http.ts`
- **Pages deploy** via `actions/upload-pages-artifact@v3` + `actions/deploy-pages@v4`:
  `~/spirit-tracker/.github/workflows/pages.yaml`
- **No-bundler ES6 SPA structure** (`index.html` + `app/*.js` modules, hash routing, CDN libs):
  `~/spirit-tracker/viz/` and `~/spirit-tracker/viz/app/`

Our worker differs from spirit-tracker-api in two important ways: it has a **`scheduled`
(cron) handler** (spirit-tracker-api has none), and it uses **D1 in addition to KV**
(spirit-tracker-api is KV-only). Everything else (TS setup, deploy flow, CORS, response
helpers) transfers directly.

---

## 4. The Worker — ingestion + API (Milestone 1 core)

### 4.1 Ingestion (the `scheduled` handler)

Two cron schedules in `wrangler.toml` `[triggers]`, both handled in the `scheduled` export
(branch on `event.cron`):

**Frequent cron `*/1 * * * *` — live snapshot + sightings:**
1. Open WS to `wss://stream.aisstream.io/v0/stream`.
2. Send the subscribe frame: `{ APIKey, BoundingBoxes: [[[47.5,-122.8],[49.0,-123.5]]],
   FilterMessageTypes: ["PositionReport","ShipStaticData"] }` (bounding box from the product
   vision: SW `47.5°N,122.8°W` → NE `49.0°N,123.5°W`).
3. Drain messages for a bounded window (target ~45–55s of wall-clock I/O wait; JSON parse is
   light CPU and fits the free-tier CPU budget). Keep the latest `PositionReport` per MMSI and
   merge in `ShipStaticData` (name, type, length, destination).
4. Close the WS. Build the snapshot and write **KV** `snapshot:current` =
   `{ updated:<epoch_ms>, vessels:[ { mmsi, name, lat, lon, speed, heading, vesselType,
   length, destination, updated } ] }`.
5. UPSERT each seen vessel into **D1** `vessels`.

**Slow cron `0 9 * * *` — movement enrichment (daily; tune cadence later):**
- Read distinct MMSIs from D1 `vessels`. Open a WS subscribing with `FiltersShipMMSI` = those
  MMSIs over a wide bounding box, drain briefly, append any heard positions to D1
  `vessel_pings`. Over time this records where past visitors went after leaving our view.
  Best-effort only (a vessel must be transmitting within aisstream coverage to be heard).

> **Risk + fallback (document in code comments):** If free-tier scheduled-Worker duration is
> too tight to drain a useful window, shorten the window and accept sparser snapshots. The
> only true persistent-socket alternative (a Durable Object with WebSocket hibernation)
> requires the **paid** Workers plan and is explicitly out of scope.

### 4.2 HTTP API (the `fetch` handler) — CORS-guarded

- `GET /vessels` → current KV snapshot, dropping vessels with `updated` older than 5 minutes.
- `GET /vessel/:mmsi` → the D1 `vessels` sightings row (`times_seen`, `first_seen`,
  `last_seen`, `last_destination`) plus recent `vessel_pings` for the track-history feature.
- `OPTIONS *` → `handleOptions` (adapt `~/spirit-tracker-api/src/cors.ts`).
- All responses go through `http.ts` `json()`/`errorJson()` and include CORS headers.
- `ALLOWED_ORIGIN` is a `wrangler.toml` `[vars]` value; `"*"` while on the github.io URL,
  tightened to the Pages/custom-domain origin later.

### 4.3 Storage bindings

- **KV `SNAPSHOT_KV`** — the live snapshot only (fast, cheap, read by every visitor).
- **D1 `VESSELS_DB`** — `worker/schema.sql`:
  - `vessels(mmsi INTEGER PRIMARY KEY, name TEXT, vessel_type INTEGER, first_seen INTEGER,
    last_seen INTEGER, times_seen INTEGER, closest_nm REAL, last_destination TEXT)`
  - `vessel_pings(id INTEGER PK AUTOINCREMENT, mmsi INTEGER, lat REAL, lon REAL, ts INTEGER,
    source TEXT)` — `source` ∈ `'live' | 'enrichment'`.
  - Schema applied by `ensure-bindings.mjs` (`wrangler d1 execute --file schema.sql`).

### 4.4 `wrangler.toml` (shape, modeled on spirit-tracker-api)

```toml
name = "vessel-tracker-api"
main = "src/index.ts"
compatibility_date = "2026-02-15"
workers_dev = true
minify = true

[vars]
ALLOWED_ORIGIN = "*"          # tighten to Pages/custom domain later

[triggers]
crons = ["*/1 * * * *", "0 9 * * *"]

[[kv_namespaces]]
binding = "SNAPSHOT_KV"
id = "__KV_ID__"              # patched by ensure-bindings.mjs in CI

[[d1_databases]]
binding = "VESSELS_DB"
database_name = "vessel-tracker"
database_id = "__D1_ID__"     # patched by ensure-bindings.mjs in CI
```

### 4.5 Secrets

- `AISSTREAM_API_KEY` — set via `wrangler secret put` in the deploy workflow (sourced from a
  GitHub repo secret), exactly like spirit-tracker-api sets its secrets.

---

## 5. CI/CD — GitHub Actions (path-filtered monorepo)

- **`deploy-worker.yml`** — `on: { push: { branches: [main], paths: ['worker/**'] },
  workflow_dispatch: {} }`. Steps mirror `~/spirit-tracker-api/.github/workflows/deploy.yml`:
  checkout → `actions/setup-node@v4` (node 24, npm cache) → `npm ci` (in `worker/`) →
  `npm run ensure:bindings` (create KV+D1 if missing, apply schema, patch wrangler.toml) →
  `npx wrangler deploy` → `echo "$AISSTREAM_API_KEY" | npx wrangler secret put
  AISSTREAM_API_KEY`. **Secrets:** `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
  `AISSTREAM_API_KEY`.
- **`deploy-pages.yml`** — `on: { push: { branches: [main], paths: ['frontend/**'] } }`,
  `permissions: { pages: write, id-token: write, contents: read }`. Mirrors
  `~/spirit-tracker/.github/workflows/pages.yaml`: `actions/configure-pages@v4` →
  `actions/upload-pages-artifact@v3` with `path: frontend` → `actions/deploy-pages@v4`. **No
  build step.** (Deploy from `main` directly — we do NOT need spirit-tracker's `data`-branch
  split, because runtime state lives in KV/D1, not in git.)
- **`pr-check.yml`** — `on: { pull_request: {} }`. In `worker/`: `npx tsc --noEmit` and
  `npx wrangler deploy --dry-run` (no secrets, no deploy). Cheap guard against broken merges.

---

## 6. Frontend scaffold (Milestone 1 deliverable)

- **`index.html`** — `<div id="app">` + `<script type="module" src="./app/main.js">`. Leaflet
  CSS/JS via CDN. CartoDB Dark Matter tile layer (free, no API key).
- **`config.js`** — per the global view-file convention, ALL config as top-of-file consts:
  ```js
  export const VIEWSHEDS = [
    { id: 'apartment', label: 'Apartment', home: { lat: <LAT>, lon: <LON> },
      fovDegrees: 120, centerBearing: null, maxDistanceNm: 15 },
    // future: { id: 'rooftop', ... }
  ];
  export const WORKER_URL = 'https://vessel-tracker-api.<acct>.workers.dev';
  export const POLL_INTERVAL_MS = 30000;
  ```
- **`store.js`** — polls `GET /vessels` every `POLL_INTERVAL_MS`, holds the vessel array,
  notifies subscribed views (simple pub/sub).
- **`map_page.js`** — Leaflet map centered on the active viewshed; type-coded rotated SVG
  icons (heading from AIS); "you are here" marker at `home`; faint bounding-box overlay; tap a
  vessel → bottom sheet (name, type, speed, heading, destination, last updated).
- **`list_page.js`** — distance-sorted (closest first) via `geo.js` haversine; row shows type
  icon, name, distance (km/nm toggle in localStorage), speed (kn), destination; pull-to-refresh.
- **`camera_page.js`** — placeholder for M3.
- **Bottom tab bar:** Map | List | Camera.

**Apply the owner's global conventions (from `~/.claude/CLAUDE.md`):**
- View/template files: all logic and assignments at the top; the render section is pure output.
- No silent fallbacks (`?? 0`) on AIS data — let bad/missing data surface (throw/skip loudly)
  rather than injecting fake values.
- MMSI / IDs can be `0` — use `!== null` / `isset`-style checks, never falsy checks.
- Comments only where genuinely non-obvious or non-standard. No premature helper extraction
  (helper only when confidently reused ≥2× for big logic, ≥4× for small).

---

## 7. Milestones 2–4 — high-level scope (build later, scaffolded now)

Captured here so the data model and directories don't have to change later. Each gets its own
detailed `docs/planning/milestone-N-*.md` when we start it.

- **M2 — Viewshed calibration.** Restrict shown vessels to those actually visible from the
  window. (a) Manual polygon drawn on the map, saved to localStorage, point-in-polygon filter
  (`@turf/boolean-point-in-polygon` via CDN). (b) Landmark-based field-of-view: tap landmarks
  in a photo + their map locations, solve for the visible bearing arc; filter vessels whose
  bearing falls in the arc. Optional max-distance + coastline occlusion (Natural Earth GeoJSON).
- **M3 — AR camera overlay.** `getUserMedia` video + canvas overlay. Project vessel labels
  using `DeviceOrientationEvent` (compass/pitch) + bearing math; iOS needs
  `requestPermission()` on a user gesture. Periodic (every 2–3s) **OpenCV.js** ORB
  feature-match against the calibration reference photo to correct compass drift; graceful
  fallback to sensors-only when matching fails (fog/night).
- **M4 — "What's this ship?" detector.** Small ONNX **object detector** ("where is the boat in
  this frame"), run in-browser via `onnxruntime-web` (lazy-loaded). Map the detected box to a
  bearing and cross-reference the live AIS contacts to name it. Dataset collected via a
  `/collect` page; **images stored outside git** (Cloudflare R2 free tier via a small worker
  endpoint, or owner's local machine) — `labels.json` + scripts in git, raw images not. Owner
  supplies empty-view background photos. Training run manually/locally, then frozen.

---

## 8. Conventions for docs, planning, and CLAUDE.md (so a fresh model knows where things go)

- **`docs/`** holds durable, human-facing **project information** that stays true over time:
  `architecture.md` (system diagram + data flow), `ais-reference.md` (aisstream message
  shapes, AIS vessel-type code table, the bounding box), `decisions.md` (the running
  architectural-decision log — start it by expanding §1 of this plan).
- **`docs/planning/`** holds **forward-looking design docs / plans** — one per milestone or
  major feature (`milestone-1-infra.md`, `milestone-2-viewshed.md`, …). On save, copy this
  document to `docs/planning/milestone-1-infra.md`.
- **`docs/milestones/MILESTONE_N.md`** is the **post-ship notes** for each milestone (what
  changed, gotchas), written when that milestone lands — per the product build-order convention.
- **CLAUDE.md placement** (project memory; never deleted, only added to per the owner's
  standing orders):
  - **root `CLAUDE.md`** — repo-wide overview, the monorepo layout, cross-cutting conventions,
    deploy story, pointers into `docs/`.
  - **`frontend/CLAUDE.md`** — no-bundler rules, which libs come from CDN and when, hash-routing
    structure, the view-file top-of-file-logic convention.
  - **`worker/CLAUDE.md`** — the cron-ingestion model and its free-tier constraints, the KV key
    + D1 schema layout, secrets, the aisstream subscribe shapes.
  - **`model/CLAUDE.md`** — detector-not-classifier framing, manual/local training, image
    storage decision, where the background photos go.
  Keep each CLAUDE.md concise and factual; subsystem files cover only their directory.

---

## 9. Prerequisites the owner does once (outside this build)

- aisstream.io account → API key → GitHub repo secret `AISSTREAM_API_KEY`.
- Cloudflare API token (Workers + KV + D1 edit scope) + account ID → repo secrets
  `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` (same scope used by spirit-tracker-api).
- Enable GitHub Pages on the repo with **source = GitHub Actions**.
- Provide the apartment latitude/longitude for `frontend/config.js`.

---

## 10. Verification (end-to-end, before calling M1 done)

1. **Worker ingestion (local):** `cd worker && npm run dev`; trigger the scheduled handler
   (`wrangler dev` scheduled UI, or `curl "http://localhost:8787/__scheduled?cron=*/1+*+*+*+*"`).
   Confirm the WS opens, messages parse, and the snapshot is written.
2. **API (local):** `GET http://localhost:8787/vessels` returns a non-empty, <5-min-fresh
   vessel list with the documented fields and CORS headers.
3. **D1 (local):** after a scheduled run,
   `wrangler d1 execute vessel-tracker --command "select count(*) from vessels"` is non-zero;
   `select * from vessels limit 5` shows real sightings.
4. **Deploy:** push to `main`; confirm `deploy-worker.yml` deploys + sets the secret, and
   `deploy-pages.yml` publishes. Hit the live `*.workers.dev/vessels` and verify CORS.
5. **Frontend (real device):** open the Pages URL on a phone — map shows real vessels with
   correct headings, "you are here" marker is placed, list sorts by distance, tapping a vessel
   opens the detail sheet, and the view refreshes on the 30s poll.
6. **PR gate:** open a throwaway PR touching `worker/`; confirm `pr-check.yml` typechecks and
   dry-runs without deploying.
7. Write `docs/milestones/MILESTONE_1.md` (what shipped + gotchas) and update the relevant
   CLAUDE.md files per §8.
```
