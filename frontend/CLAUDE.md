# Frontend — CLAUDE.md

GitHub Pages SPA. No bundler, no framework. Raw ES6 modules + CDN libs loaded in `index.html`.

## File structure

```
index.html          — CDN libs (Leaflet), stylesheet links, <div id="app">, module entry
config.js           — ALL runtime config: VIEWSHEDS, WORKER_URL, POLL_INTERVAL_MS, MOVING_SPEED_KN, TIER_STYLE, etc.
styles/
  base.css          — CSS custom properties (design tokens), reset, typography
  layout.css        — #app shell, #page-root, tab bar
  map.css           — Leaflet container, overrides, vessel markers (dot + arrow), trails, home pulse, status chip
  sheet.css         — vessel detail bottom sheet
  list.css          — list page, vessel cards
  camera.css        — camera placeholder
  states.css        — error / empty states
  settings.css      — settings page, toggle switches
app/
  main.js           — hash router (#map / #list / #camera / #settings), 4-tab bar, startPolling()
  api.js            — fetchVessels (→ /current), fetchVessel, fetchTrack (→ /vessel/:mmsi/track)
  store.js          — 30s polling loop, pub/sub (subscribe returns an unsubscribe fn)
  settings_store.js — extent + trail filter state, localStorage persistence, passesExtentFilter()
  geo.js            — haversineNm, haversineKm, bearingDeg, pointInPolygon, pointOnLand, segmentCrossesLand, routeWater (A* water router)
  trail_geometry.js — PURE, DOM-free trail pipeline (dedup → splitJourneys → buildControlPoints → repairOffLand → catmullRom → runsBySynthetic → computeRuns). Shared by map_page + the Web Worker + (future) the precompute cron. Imports only geo/coastline/config.
  trail_worker.js   — module Web Worker: runs computeRuns(…, true) (A* + repair) off the main thread
  map_page.js       — Leaflet map, dot/arrow markers, trail drawing (quick straight-bridge first paint → Worker fills in routed curves), caching, extent filter, settings subscription
  list_page.js      — distance-sorted vessel list, extent filter, unit toggle (nm/km in localStorage)
  trails.js         — lazy trail fetch + in-memory cache (TTL + tier-union widening)
  settings_page.js  — settings page: extent bucket toggles + trail tier toggles
  camera_page.js    — placeholder, renders in M3
```

## No-bundler rules

- Import paths must include `.js` extension.
- CDN libs (Leaflet, later OpenCV.js, onnxruntime-web) are loaded as `<script>` tags in `index.html` before the module entry — never imported as ES modules.
- `L` (Leaflet) is a global. Access it directly; do not import it.
- New CDN libs: add `<script>` to `index.html` only when the tab that needs them is first activated (lazy load via dynamic `import()` or appending a `<script>` tag).

## Routing

Hash-based: `#map`, `#list`, `#camera`. Each page module exports `mount(container)` and `unmount()`. `main.js` calls unmount on the previous page and mount on the new one.

## Store contract

`subscribe(fn)` calls `fn(vessels, error)` immediately and on every poll. Returns an unsubscribe function. Pages must call unsubscribe in their `unmount()`.

## Design tokens

All in `styles/base.css`. Key vars: `--accent`, `--green`, `--font-ui` (Syne), `--font-data` (Space Mono). Dark nautical theme.

## View-file convention (from global CLAUDE.md)

All logic and variable assignments at the top of each page module. The render section at the bottom is pure output. No inline logic mid-HTML string.

## Home coordinates

`48.429861°N, -123.362194°W` (48°25'47.5"N 123°21'43.9"W). Set in `config.js VIEWSHEDS[0].home`.

## Trail rendering & land avoidance

**Core principle — trust the boat.** Two sources of truth can disagree: real AIS
fixes (the boat floated there → it *is* navigable water) and our coastline
polygons (a *model*, accurate in the 25 m fine zone near home, coarse/wrong far
away — e.g. the Fraser River simplified shut). Land-avoidance (routing + repair)
applies **only to inference** — the gaps where we're guessing the path. Real
tracking is drawn as-is, even across what our coastline calls land; we never
route/repair the real track to match a possibly-wrong coastline (that fighting
caused the Fraser-delta zigzags). This is also the graceful-degradation rule:
where our data is poor the algorithm stops fighting and just draws the real line.
To make far areas *accurate* (not just degrade gracefully), expand the fine
simplification zone for them in `build-coastline.mjs` (see `worker/CLAUDE.md`).

Trails are one continuous, smooth (C¹) curve per **journey**. A journey breaks only
when the vessel was parked (speed ≈ 0) through a long gap and resurfaces later —
a moving vessel that merely lost signal stays one journey, and the gap is bridged
continuously. The pipeline (`map_page.js`, all functions exported for testing):

1. `dedup` — drop consecutive fixes < 20 m apart. **Critical**: duplicate AIS
   reports make centripetal Catmull-Rom divide by ~0 and spike. (`DEDUP_KM`)
2. `splitJourneys` — break only at a parked stop: `speed ≤ MOVING_SPEED_KN` AND
   gap > `TRAIL_GAP_SEVER_MS[tier]`. (Displacement across the gap is irrelevant —
   the vessel may resurface far away.)
3. `buildControlPoints` — cos-weighted Laplacian `denoise` of real fixes (a point
   that would move onto land keeps its original position), then for **every**
   consecutive pair whose straight line crosses land, splice the `routeWater`
   waypoints inline. With accurate coastline a crossing means the vessel really
   went around, so we route it regardless of gap size; the detour is marked
   `inferred` (dashed) **only** when it also spans a data gap
   (`LAND_AVOIDANCE.gapMinMs`/`gapMinKm`) — routing that fills dense tracking
   around an island is confident movement, drawn solid. Final dedup collapses
   near-duplicate spliced points. (Pass `route=false` for the instant first paint
   — see Performance.)
4. `repairOffLand` — re-splines and, for each output run on land, looks at the
   bracketing control points: **skip if either is itself on our "land"** (a real
   fix our coastline wrongly calls land — trust the boat, don't fight); else if
   their chord crosses land **route** the bracket via `routeWater` (genuine
   archipelago crossing); else **nudge** a nearest-water control in (a pure
   spline bulge across a clear chord). Bounded passes, **monotonic** — keeps the
   pass with the fewest land samples and never returns worse (repair can diverge
   in very tight harbours like Victoria's). This one mechanism handles Gulf
   Island crossings and dense-tracking bulges without routing every segment.
5. `catmullRom` — ONE centripetal Catmull-Rom (α=0.5) over the whole journey's
   control points. One spline ⇒ continuous derivative everywhere, including
   real→inferred transitions. No pre-smoothing here (control points are already
   clean). Each output sample carries an interpolated time and an `inferred`
   flag (either control endpoint synthetic) for styling.
6. `runsBySynthetic` — split samples into solid (real) / dashed-faint (inferred)
   runs; `makeFadePolylines` renders each, fading by sample age.

### `routeWater` (the water router, `geo.js`)

Replaced the old perimeter-walker entirely. Builds a **local land/water grid**
over the gap's bbox (lazily — only cells the search touches are tested), runs
**A\*** for the shortest WATER-ONLY path, then **string-pulls** it into sparse
any-angle waypoints. Because the search only steps through water cells, the path
**structurally cannot cross land** — there is no "push seaward" heuristic to get
wrong, no apex/centroid/edge-normal bugs, no archipelago recursion, no
snap-to-water net.

- **Obstacle inflation** (`clearanceCells`, default 1) keeps waypoints off the
  coast so the smoothing spline has slack to cut corners without clipping land.
  If inflation closes the only passage (channel narrower than clearance, or an
  endpoint in a cove), the search retries with zero clearance.
- **Coast-proximity cost** (`proximityKm` 4 km, `proximityWeight` 2): edge cost
  is scaled up near land so the route bows into open water (wider, more natural
  detours around the Olympic Peninsula) and holds channel-centers between
  islands instead of hugging. Soft cost — narrow channels with no open-water
  option still route. It only changes cost, never passability, so water-tightness
  is unaffected. The ring search is depth-capped (`maxProxCells` ≤ 8) so it
  doesn't dominate runtime at fine cell sizes.
- **Adaptive cell size** (`cellKm`, 0.2–1 km by gap length) and **margin**
  (`marginKm`, 12–90 km). The 0.2 km floor lets it thread Gulf Island channels
  and harbour mouths now that the coastline is high-resolution.
- Out of coverage (the coastline data is clipped to `[46.9,-128.8]→[51.3,-121.9]`):
  `routeWater` returns `null` and the gap is bridged with a straight spline
  segment — still C¹ since it's just more control points.

### Performance: cached geometry + off-thread routing

The spline + A* work depends only on the trail points, not on highlight/fade
state, so it's cached per vessel in `trailGeom` keyed on a trail signature
(`length|firstT|lastT|lastLatLon`) and recomputed only when the trail changes;
re-styling on every redraw (poll / highlight / settings) is cheap (`drawRuns`).
Without this, every highlight toggle re-ran A* for all vessels — jank.

First paint stays slick: on a cache miss `drawTrail` paints instant straight
bridges (`computeRuns(allPoints, false)` — no A*) immediately, then queues the full
routed compute for a **Web Worker** (`trail_worker.js`, off the main thread — A*
is 0.1–2 s/vessel and would freeze the map inline). The Worker posts back styled
runs; `applyRoutedRuns` caches them and redraws the vessel if still on screen.
Pending trails are a priority queue (`pendingRoute`) processed one at a time
**worst-first**: `gapEnrichmentScore` (cheap — land-crossing gap km, no A*) ranks
them so the most-wrong trails get their real curves first. If the Worker can't
start (old browser / `file://`), the same queue runs inline via `setTimeout`
(brief jank, no freeze). **Note:** the Worker path can't run under Node — verify
it in a real browser. Per-vessel A* is still ~0.1–2 s, so cold loads with many
gapped vessels stream in over a few seconds (see Future work for the durable fix).

In-memory cache only — **a reload recomputes everything.** The durable fix is the
server-side precompute (Future work).

### Coastline data (two layers)

Land avoidance uses **two** generated layers: `coastline.js` (`LAND_POLYGONS`, OSM
`natural=coastline`, sub-100 m — harbours, breakwaters, Deception Pass, every Gulf
Island) and `water.js` (`WATER_POLYGONS`, OSM `natural=water`/`riverbank` per fine
zone — rivers/harbour basins the coastline closes). `pointOnLand = inLand && !inWater`,
so the water layer re-opens narrow navigable features. See `worker/CLAUDE.md` →
"Coastline data generation" + "Water layer" for regenerate / expand-coverage steps. (Earlier it was Natural Earth 1:10,000,000 — "10m" = ten
*million*, the coarsest tier, NOT 10-metre — which dropped sub-km features and
caused routes to cut unmapped islands and mis-route Deception Pass. If a curve
crosses land that `pointInAnyLand` reports as water, it's a data-coverage gap,
not a router bug — see `tests/README.md` §1.)

### Validation

`tests/trail.test.mjs` runs the real `trail_geometry.js` pipeline over captured
trails in `tests/fixtures/*.json` (chasing-daylight, buena-ventura, mount-aso,
twr-8, glovis-star, venturosa, plus the Fraser cases luther + mv-harken-no-7) and
asserts: no spline point on land (beyond a 150 m graze tolerance, ignoring clips
that hug a real on/near-land fix) and bounded overshoot from the control polyline
(catches the old div-by-zero spike, which threw 50–200 km excursions; real sharp
turns and wide sparse-gap curve-bulges are fine). `KNOWN_DATA_LIMITED` is now empty
— glovis-star (upper Fraser) graduated to PASS once the water layer landed. Run:
`node tests/trail.test.mjs`. See `tests/README.md` for the A* troubleshooting
techniques and `docs/fraser-river-test-cases.md` for the river coverage criteria.

## Future work (perf + data coverage)

Both are designed and documented in `worker/CLAUDE.md`; current code degrades
gracefully until they land.

1. **Water-polygon layer (rivers/harbours) — DONE.** Shipped as `water.js`
   (`WATER_POLYGONS`), subtracted at runtime: `pointOnLand = inLand && !inWater`
   (`geo.js`). Fixed the upper-Fraser case (glovis-star/luther/mv-harken now PASS).
   Fetch the water layer **per fine-zone** (a combined query truncates) and rebuild
   with `worker/scripts/build-water.mjs`. See `worker/CLAUDE.md` → "Water layer —
   rivers & harbours" for the regenerate steps + the resolution policy. (Open follow-up:
   a regional spatial index before global coverage so `pointOnLand` stays local.)
2. **Server-side precompute cron — DEFERRED until the dataset is stable.** Moving
   A* to a GH-Actions cron (NOT a CF Worker — CPU-capped) storing sparse inferred
   waypoints in `inferred_positions` would fix cold-load + reload-recompute. But
   precomputed points are derived from the coastline, so while we're still
   expanding the dataset (item 1, more fine zones) every change would invalidate
   them — build it only once the data is stable. Interim: the Web Worker +
   worst-first ordering keep it usable. Full design (incl. D1 write-budget rules,
   `generator_version` for regeneration) in `worker/CLAUDE.md` → "Planned
   (DEFERRED …): server-side inferred-positions precompute".
