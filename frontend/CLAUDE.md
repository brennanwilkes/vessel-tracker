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
  map_page.js       — Leaflet map, dot/arrow markers, trail pipeline (dedup → splitJourneys → buildControlPoints → catmullRom → runsBySynthetic), extent filter, settings subscription
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
4. `repairOffLand` — re-splines and, for any output run that lands on land,
   inserts a nearest-water control point to pull the curve off, then re-splines
   (bounded passes). Catches **spline bulges** across small islands where the
   straight chord between two control points is clear, so `routeWater` never
   fired — the dominant residual once the coastline is high-resolution.
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

### Performance: cached geometry + staggered routing

The spline + A* work depends only on the trail points, not on highlight/fade
state, so it's cached per vessel in `trailGeom` keyed on a trail signature
(`length|firstT|lastT|lastLatLon`) and recomputed only when the trail changes;
re-styling on every redraw (poll / highlight / settings) is cheap (`drawRuns`).
Without this, every highlight toggle re-ran A* for all vessels — jank.

First paint stays slick via **quick-first + staggered routing**: on a cache miss
`drawTrail` paints instant straight bridges (`computeRuns(allPoints, false)` — no
A*) immediately, then enqueues the full routed compute on `routeQueue`, pumped
**one vessel per macrotask** (`setTimeout`). The routed curves fill in
boat-by-boat without blocking; each is cached and the vessel redrawn if still on
screen. Queue is filtered to visible vessels and cleared on unmount.

### Coastline data

`coastline.js` is generated from **OpenStreetMap `natural=coastline`** (sub-100 m;
resolves harbours, breakwaters, Deception Pass, every Gulf Island). See
`worker/CLAUDE.md` → "Coastline data generation" for the regenerate / expand-
coverage steps. (Earlier it was Natural Earth 1:10,000,000 — "10m" = ten
*million*, the coarsest tier, NOT 10-metre — which dropped sub-km features and
caused routes to cut unmapped islands and mis-route Deception Pass. If a curve
crosses land that `pointInAnyLand` reports as water, it's a data-coverage gap,
not a router bug — see `tests/README.md` §1.)

### Validation

`tests/trail.test.mjs` runs the real production pipeline over captured trails in
`tests/fixtures/*.json` (CHASING DAYLIGHT, BUENA VENTURA, MOUNT ASO, TWR-8) and
asserts: no spline point on land (beyond a 60 m penetration tolerance, ignoring
clips that hug a real on/near-land fix) and bounded overshoot from the control
polyline (catches the old div-by-zero spike, which threw 50–200 km excursions;
real sharp turns and wide sparse-gap curve-bulges are fine). Run: `node
tests/trail.test.mjs`. Known edge: TWR-8 grazes ≤ 50 m into a narrow dead-end
inlet where the tug really went in and reversed during a gap — sub-pixel, real.
