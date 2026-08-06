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
  trail_spline.js   — PURE, coastline-free spline half (dedup → splitJourneys → catmullRom → runsBySynthetic + simplifyForSpline). The ONLY trail module the BROWSER imports — imports geo math + config, NO coastline. Shared with the precompute.
  trail_geometry.js — LAND-AWARE half (denoise, smoothRoute, buildControlPoints, repairOffLand, computeControlPoints, harvestInferredSegments, computeRuns). Imports region-aware coastline → NODE (precompute cron) + tests only; never the browser. Re-exports trail_spline's pure pieces for existing callers/tests.
  map_page.js       — Leaflet map, dot/arrow markers, trail drawing: splines the combined real+inferred /track stream with trail_spline (pure, no A*/coastline), per-vessel render cache, extent filter, settings subscription
  (trail_worker.js — REMOVED: in-browser A* is gone; the precompute cron does it server-side)
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
   around an island is confident movement, drawn solid. Each routed gap is given
   the boat's real **entry/exit heading** (COG just outside the gap) to bias A\*
   (see `routeWater` below), and its raw waypoints are run through **`smoothRoute`**
   (densify + land-rejecting Laplacian relaxation — see below), so the inferred
   path leaves/rejoins the real track along the boat's actual course and can't kink
   where they meet. Final dedup collapses near-duplicate spliced points. (Pass
   `route=false` for the instant first paint — see Performance.)
   - **`smoothRoute`** — A\*+string-pull is a shortest water path with no notion of
     a turning radius, so spliced raw it produces sharp corners. `smoothRoute`
     densifies the path to ~uniform spacing (`ROUTE_SMOOTHING.minStepKm`/`targetPoints`),
     then relaxes each interior point toward its neighbour-midpoint (`passes`/`factor`)
     with the **endpoints pinned** and a move accepted **only if BOTH touched
     segments stay clear of land** (a point-only check would let the curve bulge
     ashore as relaxation erodes A\*'s clearance). Result: open-water doglegs round
     out, channel-forced turns stay — the inferred curve never shows a turn a boat
     couldn't make, yet stays water-tight. (The real→A\* *boundary* kink is fixed
     upstream by `routeWater`'s heading bias, not here.)
4. `repairOffLand` — re-splines and, for each output run on land, looks at the
   bracketing control points: **skip if either is itself on our "land"** (a real
   fix our coastline wrongly calls land — trust the boat, don't fight); else if
   their chord crosses land **route** the bracket via `routeWater` (genuine
   archipelago crossing); else **nudge** a nearest-water control in (a pure
   spline bulge across a clear chord). Bounded passes, **monotonic** — keeps the
   pass with the fewest land samples and never returns worse (repair can diverge
   in very tight harbours like Victoria's). This one mechanism handles Gulf
   Island crossings and dense-tracking bulges without routing every segment.
4b. `cleanControls` — post-splice cleanup, run at the END of **both**
   `buildControlPoints` **and** `repairOffLand`. Splicing a routed path in beside
   existing controls leaves two artifacts: **near-duplicates** (centripetal
   Catmull-Rom divides by ~0 → spike) and **reversals** where consecutive routed
   segments join — 10–40 m steps with ~170° hairpins. Only SYNTHETIC points are
   dropped (a real fix is ground truth) and a reversal only when the bypass chord
   is itself clear of land, so it can never cut a corner across a headland.
   **The `repairOffLand` call site is the load-bearing one:** `buildControlPoints`
   always collapsed near-duplicates, but `repairOffLand` runs AFTER it and splices
   its own mids in without re-cleaning — that gap was the source of every observed
   harbour hairpin (maunawili went 12 kinks → 5, and its land defects → 0).
   Config: `ROUTE_SMOOTHING.backtrackDeg` (100°) / `backtrackPasses`.
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
- **Narrow-channel penalty** (`narrowWeight`, default 3): a *quadratic* term on
  `nearness` (`+ narrowWeight·nearness²`) so cost/km is disproportionately higher
  in a narrow waterway (land close on both sides → high nearness throughout) than
  mid-channel in a wide one. Nudges the route onto the main channel (the Fraser)
  instead of a shortcut up a small tributary. Vanishes in open water
  (nearness→0), so it's mild — a big-enough real shortcut still wins. **Scaled by
  vessel length** (`NARROW_WEIGHT` config in `config.js`, threaded
  `computeRuns(opts.vesselLength) → buildControlPoints/repairOffLand → routeWater`):
  big ships (≥`maxLenM` 120 m → `large` 7) hold the main channel even when slower;
  small craft (≤`minLenM` 20 m → `small` 0.5) dart through tight Gulf Island passes;
  linear between; null/unknown length → `default` 3. Tune up if a vessel still
  takes a tributary (watch the regression for over-detours).
- **Heading bias** (`entryBearing`/`exitBearing`, `headingWeight` 5, `headingKm` 4):
  near the endpoints we KNOW the vessel's real course — the COG into the start and
  out of the goal (threaded from `buildControlPoints`: `real[i-2]→a` and
  `b→real[i+1]`). Early moves opposing the entry heading (and late moves opposing
  the exit heading) are penalized, decaying to 0 over `headingKm`. Without it the
  proximity cost could make A\* **leave the start by reversing the boat's heading**
  — backtracking to skirt a narrow exit — which rendered as a sharp ~150° kink
  right at the real→inferred boundary (the South Pender case: boat steaming WNW
  into Swanson Channel, A\* backtracked SE 5 km before turning). Trust the boat: it
  leaves on the course it was actually steering; the open-water middle is still
  shaped by proximity. Soft cost (changes cost, not passability → water-tight).
  Omitted at journey ends (no neighbour → no bias).
- **Cell size = a grid CELL-COUNT BUDGET, not gap length** (`cellKm`, 0.2 km floor;
  `MAX_CELLS_PER_SIDE` 4000) and **margin** (`marginKm`, 12–90 km). Stay as fine as
  possible (0.2 km threads Gulf Island channels, harbour mouths, the ~1 km Columbia,
  Inside Passage narrows) while capping the grid's larger side so A* stays tractable:
  `cellKm = max(0.2, (directKm + 2·marginKm) / 4000)`. Any gap whose span ≤ ~800 km
  threads at the floor; longer (trans-Pacific, open ocean — no narrow channel) coarsens.
  **A* runs server-side ONLY** (the precompute cron; the browser never calls
  `routeWater`), so the budget is generous — the OLD length-based cap (≥0.68 km cells on
  >170 km gaps) was sized for the browser's CPU limit and made long gaps straight-bridge
  through the Columbia / Inside Passage. Tradeoff: a long-gap route at the floor builds a
  multi-million-cell grid → ~10–60 s/gap in the precompute (bounded; the `isLand`
  per-cell polygon scan dominates — a spatial index is the deferred speedup).
- Out of coverage: `routeWater` returns `null` and the gap is bridged with a
  straight spline segment (still C¹ — just more control points). The fine OSM clip
  is `[46.9,-128.8]→[51.3,-121.9]`, but the **coarse continental layer**
  (`coast_coarse.js`) now extends usable coverage along the whole NA Pacific coast,
  so Vancouver↔California/Mexico routes bow around the continent instead of bridging
  straight through it. The **central-BC band (51.3–54°N)** — Inside-Passage-south,
  where coarse 2 km merges the inner channels shut — is now fine-covered by the
  `bc-central-south`/`bc-central-north` island-land regions, so Prince Rupert↔Vancouver
  Island routes thread the channels. Truly-uncovered = open Pacific / other oceans.
  Regression: `tests/region-trails.test.mjs` (real long-gap vessels through the Columbia
  and the BC Inside Passage, water-tight, region-aware).

### `routeOceanGap` (ocean-scale gaps, `trail_geometry.js`)

Gaps longer than `LAND_AVOIDANCE.routeMaxKm` (800 km) do NOT use a single A\*
grid. One grid over a trans-Pacific gap is the wrong tool twice: it spans a third
of the planet (millions of cells, each a full `isLand` polygon scan — this is
what put the precompute cron at 1–2.5 h/run) and spends all of it on open water
where there is nothing to route around. A plain bridge is wrong too — it cuts
through whatever island or peninsula lies between.

So the gap is **bi-segmented**: a great-circle spine (`geo.greatCirclePoints`,
`spineStepKm` 100 km — a ship's real course, and it curves) is classified span by
span, and only the **land-crossing** spans go to A\*. The coastal ends of a long
gap fall out for free: they are the spans that hit land, so they get fine
treatment while the ocean middle stays a clean curve.

Resolution follows the data AND the scale of the detour:
- Short bracket (≤`fineBracketMaxKm` 150 km) inside fine coverage
  (`region_coast.hasFineLand`) → the defaults. Identical to a short coastal gap.
- Everything else → wide margin (`oceanMarginMinKm` 400 km, or the bracket
  length) with the cell COUNT capped (`oceanMaxCellsPerSide` 800) and a
  `coarseCellKm` (2 km) floor. The default 90 km margin **strands** a
  peninsula detour — A\* finds nothing and the spine is left driving straight
  over Kamchatka, which is worse than a coarse route. Heading bias reaches
  `oceanHeadingCells` (6) cells, since the 4 km default is sub-cell on a coarse grid.

Two traps, both found by regression:
- **Never `smoothRoute` an ocean spine.** It densifies to ~uniform spacing then
  land-checks every 100 m — over an 8,000 km crossing it never returns.
  `buildControlPoints` uses `ocean ? raw : smoothRoute(raw)`; the short detours
  are smoothed inside `routeOceanGap`.
- **Widening a blocked run can swallow the next.** Backing `to` out of a long
  landmass advances the cursor past a later obstacle; routing that covered run
  emits points going BACKWARDS along the spine → a hairpin. Guarded by
  `if (to <= from) continue`.

#### Whole-gap fallback — bi-segmentation cannot cross a continent

Bi-segmentation assumes each blocked span is bracketed by water the vessel can
actually sail **between**. That holds for an island, a cape, a strait. It fails
completely when the great circle crosses a **continent**, because the spine
re-emerges in a *different ocean*: Columbia mouth → Panama asked A\* to sail from
Oregon to the Gulf of Mexico. A\* correctly found nothing — and the "no route →
keep the spine" degradation then drew a straight line across North America.

This was live in prod: MH BORGA showed **379** land defects marching Oregon →
Colorado, MIRACULOUS ACE **325** across Mexico — both pegged at the probe's
depth ceiling, the signature of a straight bridge rather than a bad route.

So any span that fails to route — including the `to <= from` and
endpoint-on-land skips — sets `unrouted`, and the whole gap is re-routed on ONE
coarse grid by `routeWholeOceanGap`, which is free to go around the landmass
entirely. Results: MH BORGA 379 → **0**, MIRACULOUS ACE 325 → **6** (worst
1.3 km, a Baja graze that is at the limit of ~2 km coarse data). It costs ~5 s
and fires only on failure, so ordinary ocean crossings keep the fast path. Like
the spine, its output is **not** smoothed.

**Canal transits stay unroutable.** The Panama isthmus is closed in every land
layer (verified: zero open meridians across 7–10.5°N), so no Pacific↔Atlantic
path exists short of Cape Horn. In practice such legs are long port stops, so
`splitJourneys` severs the journey and nothing is drawn — the right outcome. A
non-stop canal transit would still bridge straight. The fix is carving canal
channels into the land data, not changing the router.

`routeMaxKm` is deliberately set above the longest gap any fixture depends on
(623 km chasing-daylight, 553 km bc-inside-passage) so every proven coastal case
keeps the single-grid path. Regression: `node tests/ocean-trails.test.mjs`.

### Markers must follow their trail's world copy (`marker._lonTurn`)

The trail pipeline emits **unwrapped** longitudes, and Leaflet draws a value past
±180 in the adjacent world copy — that is what makes a dateline crossing render
continuously. The vessel marker, however, was placed at the raw `/current`
longitude. So a BC→Asia vessel drew its track *west* across the Pacific while its
icon sat a full 360° *east*: scroll along the line and the boat isn't at the end
of it (observed on COSCO SANTOS, which appeared in a copy of Asia off the right
edge of the map).

`drawTrail` derives the turn from its own geometry — `Math.round((tipLon -
vessel.lon) / 360)` against the newest spline sample — stores it on
`marker._lonTurn`, and repositions. `syncMarkers` must re-apply it on every poll
(`vessel.lon + existing._lonTurn * 360`), otherwise the next refresh snaps the
marker back to the raw value. Markers for vessels with no trail keep turn 0.

### Performance: A* is server-side; the client only splines

A* no longer runs in the browser. The land-crossing gaps are routed by the
**server-side precompute cron** and the inferred waypoints arrive inline in
`/track` (flagged `fake`/`dashed`). `drawTrail` just splines the combined
real+inferred stream with the PURE pipeline (`clientRuns` → `trail_spline`): no
A*, no `repairOffLand`, no coastline data loaded in the browser at all. So a
reload is instant and there's no jank to hide. See `worker/CLAUDE.md` →
"Server-side inferred-positions precompute — IMPLEMENTED".

**Render load is bounded by layer COUNT, not point count.** The map is
`preferCanvas: true`, and the canvas renderer re-strokes every polyline on each
pan/zoom — so what matters is how many `L.polyline` layers exist.
`makeFadePolylines` used to emit one per 8 spline samples (~750 layers for one
long trail, ~75k across a busy map: the source of the client lag). Three bounds
now apply, all in `map_page.js`:
- **`FADE_STEPS` (14)** — the fade is quantized into that many opacity bands and
  consecutive samples of equal band share one polyline, so a trail costs ~14
  layers regardless of length. (The fade still can't be one CanvasGradient — that
  bands visibly on a curved trail.)
- **`MIN_SAMPLE_PX` (2)** — `decimateForZoom` drops samples closer than that on
  screen via `map.project`. Screen space, not distance: an ocean trail collapses
  at zoom 8, a harbour trail keeps every point at zoom 14.
- **`runInView`** — per-run viewport culling against a padded box. A trail can
  span an ocean while a few hundred km is visible. Tests the run one turn either
  side of the viewport, because trail lons are unwrapped (may exceed ±180).

Measured across all fixtures: layers 3069→304 at zoom 8 (10.1×), →377 at zoom 14
(8.1×) with 1.0× point loss, i.e. zoomed-in detail untouched. Because all three
depend on the view, `redrawTrailsForView` rebuilds layers on `zoomend` (always)
and `moveend` (only once the view leaves the box it was culled against),
debounced 150 ms — from cached geometry, so it never re-splines.

The pure spline still depends only on the points (not highlight/fade), so it's
cached per vessel in `trailGeom` keyed on the trail signature
(`length|firstT|lastT|lastLatLon`); re-styling on poll/highlight/settings stays
cheap (`drawRuns`). A cache miss recomputes inline — cheap now.

**Fallback:** a gap the cron hasn't routed yet has no fakes, so it simply bridges
straight (may cross land briefly) until the next precompute run fills it. The
global scan triggers that run on completion, so the window is minutes. This is the
best achievable without shipping coastline to the browser (a deliberate trade).

### Coastline data (two layers)

Land avoidance uses **three** generated layers, all concatenated/threaded in
`trail_geometry.js`:
1. `coastline.js` (`LAND_POLYGONS`, OSM `natural=coastline`, sub-100 m — harbours,
   Deception Pass, every Gulf Island) — the fine Salish Sea region.
2. `water.js` (`WATER_POLYGONS`, OSM `natural=water`/`riverbank` per fine zone) —
   subtracted: `pointOnLand = inLand && !inWater`, re-opening rivers/harbour basins
   the coastline closes (the Fraser fix).
3. `coast_coarse.js` (`COARSE_LAND_POLYGONS`, Natural Earth 1:50M, lat strips OUTSIDE
   the fine band) — a tiny coarse NA-west-coast landmass so long open-ocean routes
   bend around the continent (don't cut through Oregon/California).
4. **Lazy per-region** `coast/<id>.js` (foreign harbour/river ports) — loaded ON DEMAND.

`region_coast.js` owns the combined geometry: base = layers 1–3 (always present), plus
any region from `coast/manifest.js` appended by `ensureRegionsForExtent(bbox)` when a
trail reaches it. `trail_geometry.js` reads it via `getLand()/getWater()` getters (live).
The routed-compute paths `await ensureRegionsForExtent(extentOf(allPoints))` before
`computeRuns` — `trail_worker.js` (primary) + the inline fallback in `map_page.js` — so
a Portland-bound trail loads the `columbia` region first (first paint, `route=false`,
needs none). All 39 foreign regions are built; lazy so only the viewed vessel's region
loads. See `worker/CLAUDE.md` →
"Coastline data generation" / "Water layer" / "Coarse continental layer" / "Lazy
per-region geometry". (Earlier it was Natural Earth 1:10,000,000 — "10m" = ten
*million*, the coarsest tier, NOT 10-metre — which dropped sub-km features and
caused routes to cut unmapped islands and mis-route Deception Pass. If a curve
crosses land that `pointInAnyLand` reports as water, it's a data-coverage gap,
not a router bug — see `tests/README.md` §1.)

### Validation

`tests/trail.test.mjs` runs the real `trail_geometry.js` pipeline over captured
trails in `tests/fixtures/*.json` (chasing-daylight, buena-ventura, mount-aso,
twr-8, glovis-star, venturosa, pacific-grace, plus the Fraser cases luther +
mv-harken-no-7) and asserts: no spline point on land (beyond a 150 m graze
tolerance, ignoring clips that hug a real on/near-land fix); bounded overshoot
from the control polyline (catches the old div-by-zero spike, which threw 50–200
km excursions; real sharp turns and wide sparse-gap curve-bulges are fine); and
**no inferred kink** — a spline turn >60° more than 2 km from any real fix (the
old sparse-string-pull mid-channel dogleg, 68–168° — a turn no boat could make).
Genuine sharp turns sit AT a real fix (dock wiggle, a lone fix between long gaps)
or where the channel forces them, and are exempt. Run:
`node tests/trail.test.mjs`. See `tests/README.md` for the A* troubleshooting
techniques and `docs/fraser-river-test-cases.md` for the river coverage criteria.

#### Berth endpoints on land (`KNOWN_DATA_LIMITED`: maunawili)

glovis-star (upper Fraser) graduated to PASS once the water layer landed; **maunawili**
replaced it for a different, non-fixable reason. A vessel BERTHED at a container terminal
reports from alongside the wharf, and a wharf is land at 25 m coastline resolution — its
three moored fixes at `37.7935,−122.2982` are inside the mainland polygon, with water
resuming only 165 m south. **No water route to that endpoint exists**, so `routeWater`'s
`snapToWater` lands the goal in a channel that may be the wrong side of a pier, and
`repairOffLand` oscillates across the SF waterfront (~5 residual hairpins between the
Golden Gate and the estuary). Accepted behaviour: draw by water for as long as water
exists, then degrade at the berth — land-tightness is unaffected (`landDefects=0`).

Two things this is NOT, both tested and ruled out: it is not coastline resolution (a
25 m SF Bay `FINE_ZONE` was added and did not help), and it is not a reversal inside a
routed path (instrumenting found zero >100° turns within any A* output — they only appear
at splice joints, which is what `cleanControls` addresses). A real fix needs land-locked
endpoint handling: terminate the route at the nearest water point and run the final leg
straight to the berth, rather than trying to route all the way in.

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
2. **Server-side precompute cron — DONE.** A* moved to a GitHub Actions cron
   (`worker/scripts/precompute-trails.mjs`); sparse inferred waypoints stored in
   `inferred_positions`, served unioned into `/track`, re-splined client-side with
   `trail_spline.js`. The browser no longer loads coastline or runs A*. See
   `worker/CLAUDE.md` → "Server-side inferred-positions precompute — IMPLEMENTED"
   and the Performance section above. (Open follow-up from item 1 still stands: a
   regional spatial index before global coverage so `isLand` stays local.)
