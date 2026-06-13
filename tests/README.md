# Trail / water-router tests & troubleshooting

The trail-rendering pipeline (`frontend/app/geo.js` `routeWater` + `frontend/app/map_page.js`
`dedup → splitJourneys → buildControlPoints → repairOffLand → catmullRom → runsBySynthetic`)
turns sparse AIS fixes into one smooth, water-tight curve per journey. This directory holds the
regression test and the captured fixtures, plus the techniques below for diagnosing the A* water
router and the spline when something looks wrong on the map.

## Running

```
node tests/trail.test.mjs            # spline water-tightness over real fixtures (tests/fixtures/*.json)
node tests/trail-precompute.test.mjs # server precompute: harvested fakes reproduce the curve, minimal, deterministic
node tests/coverage.test.mjs         # coastline COVERAGE guard — known landmasses read as land (no silent island/coast drops)
node tests/scenario.test.mjs         # multi-leg corridor: Fraser→Tacoma→Columbia/Portland approach→SF→LA routes water-tight
node tests/harbour-route.test.mjs    # routeWater coastal legs go around land
node tests/coarse-global.test.mjs    # worldwide coarse classification (home preserved, foreign land avoided)
node tests/regions.test.mjs          # all lazy coast/<id>.js regions valid
node tests/compress.test.mjs         # worker movement-compression unit checks
```

`coverage.test.mjs` exists because a landmass missing from `coastline.js` reads as open water, so a
trail crosses it and neither the router nor `trail.test` notices (they share the data) — it asserts a
fixed set of known land/water points so a coastline **regeneration** can't silently drop coverage.
`scenario.test.mjs` documents the canonical long-voyage test: each inter-port leg is a gap the
precompute must route AROUND the coast. `trail-precompute.test.mjs` guards the server-side harvest
(`harvestInferredSegments`) that the GH-Actions cron stores in D1.

Asserts, per fixture: **no spline sample on land** (beyond a 60 m penetration tolerance, ignoring
clips that hug a real on/near-land fix); **bounded overshoot** from the control polyline
(catches the div-by-near-zero "spike", which historically threw 50–200 km excursions; genuine sharp
turns and the wide curve-bulge of sparse long-gap detours are fine); and **no inferred kink** — a
spline turn >60° more than 2 km from any real fix (the old sparse-string-pull mid-channel dogleg,
68–168°; a real boat can't turn on a dime, and `smoothRoute` rounds open-water doglegs out — genuine
sharp turns happen AT a real fix or where the channel forces them, and are exempt).

`tests/lib.mjs` provides `pointInAnyLand`, `POLYGON_BBOXES`, `loadTrail` (reads a wrangler
`db-positions` dump). The test imports the **real production functions** from `map_page.js` (with
DOM/Leaflet stubs) so it can never drift from what ships.

## Fixtures

`tests/fixtures/*.json` are real captured trails (API-shaped, newest-first) for the vessels
that used to break, each exercising a different regime:

| Fixture | Regime it stresses |
|---|---|
| `mount-aso` / `buena-ventura` | long (~190 km) gaps routed **around the Olympic Peninsula** |
| `twr-8` | **archipelago + harbour** threading (Gulf Islands, Bremerton dead-end inlet) |
| `chasing-daylight` | gap running **out of the coastline-coverage zone** (graceful straight bridge) |
| `pacific-grace` | **inferred-path smoothness** — Haro Strait gaps whose raw A\* doglegged mid-channel (68–98°) and kinked at the real→A\* boundary; `smoothRoute` + tangent anchors round them out (a lone fix between two ~21 h gaps stays a sharp but honest corner) |

Refresh / add fixtures from the live DB:

```
worker/scripts/db-positions <mmsi> --limit 500 > /tmp/trail_<mmsi>.json
# then reshape to {mmsi,name,points:[{lat,lon,speed,t,tier}, …newest-first]} in tests/fixtures/
```

## Troubleshooting techniques

These are the diagnostics used to build and tune the router. Re-run them when a trail looks wrong.

### 1. Is it a routing bug or a coastline-data bug?
First check whether the offending point is land **in our data**:
```js
import { pointInAnyLand } from './tests/lib.mjs';
pointInAnyLand([lat, lon]); // >=0 → on a land polygon; -1 → water (per our coastline.js)
```
If the curve visually crosses land that `pointInAnyLand` says is **water**, the coastline data is
missing/shrinking that feature — a **data** problem (regenerate `coastline.js`, see
`worker/CLAUDE.md`), not a router bug. This is how Deception Pass and the shrunk Gulf Islands were
diagnosed under the old Natural Earth 1:10M data.

### 2. Water-tightness of a single route
`routeWater` returns waypoints; sample the whole polyline densely and count land hits:
```js
const r = routeWater(a, b, LAND_POLYGONS, POLYGON_BBOXES);
// walk each consecutive pair at ~0.3 km steps, call pointInAnyLand on each sample
```
Waypoints all in water but the **spline** clips land → it's a spline bulge (see #4), not the route.

### 3. Spike / overshoot detection (smoothness)
A centripetal Catmull-Rom blows up (divides by ~0) on **duplicate/near-duplicate control points**.
Symptoms: a 180° bearing reversal or a sample far from the control polyline. Measure overshoot =
max distance from any spline sample to the nearest control-polyline segment. Real sharp turns stay
near the controls (sub-km); a spike is tens–hundreds of km. The `dedup` (20 m) + the final-list
dedup in `buildControlPoints` exist to prevent this — if spikes return, check dedup first.

### 4. Spline bulge across land (chord clear, curve not)
When two control points straddle a small island with a clear straight chord, `routeWater` never
fires but the smooth curve can bulge across the island. `repairOffLand` catches this: it re-splines,
finds on-land sample runs, and inserts a nearest-water control point to pull the curve off. If land
clips persist, log how many `repairOffLand` passes ran and whether `nearestWaterBeyond` returned
null (no water within 3 km → check the data).

### 5. Routes too tight / not weaving (qualitative)
Shortest-path hugs the coast and threads archipelagos in long straight runs. The **coast-proximity
cost** (`proximityKm`/`proximityWeight` in `routeWater`) bows routes into open water and centers
channels. To tune, route a known gap with different `{proximityKm, proximityWeight}` and inspect
waypoint count, total length, and **max waypoint hop** (a long hop = a straight cut; should shrink
as weaving increases). Watch the trade-off: too much proximity pushes archipelago routes *out* into
open water (then straight across). `proximityKm ≈ 4`, `weight ≈ 2` is the current balance.

### 6. Grid resolution vs. timing
`routeWater`'s `cellKm` (0.2–1.0 km, scales with gap length) sets how narrow a channel it can
thread; finer = more clips fixed but bigger grids and slower A*. `maxProxCells` is capped (8) so the
proximity ring search doesn't dominate runtime at fine cell sizes. Time a route with
`process.hrtime` and watch grid `rows*cols`. Geometry is cached per vessel and computed
boat-by-boat off the main thread (`routeQueue` in `map_page.js`), so per-route cost matters for
first-paint smoothness, not steady state.

### 7. Jagged inferred path / sharp corners at the real→A\* boundary
A\*+string-pull is a shortest water path with no turning radius, so spliced raw its sparse, angular
waypoints kink — both mid-channel (open-water doglegs from the coast-proximity bow) and right where
the dashed inferred run meets the solid real track. Diagnose by simulating one vessel: capture its
trail (`db-positions <mmsi>` → fixture), run the real pipeline, and at every spline sample measure
the **turn angle** (`bearingDeg` of the two adjacent segments) plus its **distance to the nearest
real control point**. A turn >60° more than ~2 km from any real fix is a physically-impossible
artifact; a turn AT a real fix (dock wiggle, a lone fix between long gaps) or in a tight channel is
genuine. `smoothRoute` (densify + land-rejecting Laplacian relax, pinned endpoints) rounds the
artifacts out; tangent anchors fix the boundary. If corners return, check `ROUTE_SMOOTHING`
(`passes`/`factor`/`targetPoints`) and whether `moveClear` is rejecting too aggressively (land too
close on both sides → it can't relax there, which is correct). The regression's `inferredKinks`
column tracks this.

### 8. Visualize on a map
Emit GeoJSON (land polygons + real trail + routed waypoints + spline + land-clip points) and open it
at <https://geojson.io>. Seeing the failure beats reading coordinates.

## Known limitations / follow-ups

- **Narrow-channel penalty** (`narrowWeight`, default 3, in `routeWater`): a
  quadratic `nearness²` cost term so routes prefer the main channel over a narrow
  tributary shortcut (the Fraser case — ACE/`316009841`). Tune up if a vessel
  still takes a tributary; watch the regression for over-detours.
- **Deep single clips on long inferred archipelago routes.** `repairOffLand` is
  *monotonic* (keeps the pass with the fewest land samples, never returns worse),
  so it can leave one deep clip if removing it would add several shallow ones —
  e.g. ACE's 67 km Haro→Fraser gap leaves a ~540 m bulge in the Gulf Islands
  (Active Pass, on the dashed/inferred portion). Proposed fix: let repair also
  accept a locally-worse pass when it strictly reduces **max penetration** (not
  just count), to target deep single clips. Re-run the full regression after.
