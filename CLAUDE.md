# Salish Sea Vessel Tracker — Root Project Memory

## What this is

A personal, public, read-only, mobile-first PWA showing live AIS vessel positions visible from one specific apartment window overlooking the Salish Sea (Strait of Juan de Fuca / Haro Strait, south of Victoria BC: `48°25'47.5"N 123°21'43.9"W`). No user accounts, no login, free-tier only.

## Monorepo layout

```
frontend/   GitHub Pages SPA — no bundler, raw ES6 modules
worker/     Cloudflare Worker (TypeScript) — ingestion cron + HTTP API
model/      M4 ML scaffold — ONNX boat detector, not a classifier
docs/       Reference docs for Claude (architecture, AIS field shapes, decisions)
```

See `frontend/CLAUDE.md`, `worker/CLAUDE.md`, `model/CLAUDE.md` for subsystem details.

## Deploy story

- **Frontend** → GitHub Pages (deploy-pages.yml, path-filtered to `frontend/**`)
- **Worker** → `*.workers.dev` (deploy-worker.yml, path-filtered to `worker/**`)
- No PR gate workflow — single engineer.
- Required GitHub secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `AISSTREAM_API_KEY`
- On first push to main touching `worker/`, CI auto-creates the D1 database and applies all pending migrations. Nothing in the Cloudflare dashboard needs to be touched manually.

### Cloudflare account — ONLY this one

This project lives **exclusively** in the personal account:

| | |
|---|---|
| Email | `brennan@codexwilkes.com` |
| Account ID | `a53d0d3cb40662b52e001ffd082d2f1f` |
| D1 database | `vessel-tracker` (`1fc3b1b8-b293-49fd-951e-5765f184e44b`) |

Other Cloudflare accounts are authed on this machine (`brennan@textgroove.com` / Text
Groove, `0dc0abc9…`) for **other** projects — never use them here.

**Claude must NEVER change Cloudflare auth.** If `wrangler` or a `db-*` script returns
`Authentication error [code: 10000]`, or `npx wrangler whoami` shows anything other than
`brennan@codexwilkes.com`, **stop immediately** and ask Brennan to re-auth. Do not run
`wrangler login`/`logout`, do not switch accounts, do not edit
`~/.wrangler/config/default.toml`. Wrong-account writes land in someone else's
production.

## Milestones

- **M1:** Live map + vessel list, deployed. Sightings recorded from day one.
- **M2 (current):** D1-only rebuild — three-tier tracking, event-based positions, trails, Settings tab.
- **M3:** Viewshed calibration — restrict shown vessels to those actually visible from the window.
- **M3:** AR camera overlay — project vessel labels using device orientation.
- **M4:** ONNX boat detector — "where is the boat in this frame" → match to AIS contact.

## Cross-cutting conventions

- No bundler, no framework. CDN libs only (Leaflet, later OpenCV.js + onnxruntime-web).
- No auth ever. Any per-device prefs in `localStorage`.
- IDs (including MMSI) can be `0` — always use `!== null`, never falsy checks.
- No silent fallbacks (`?? 0`). Throw/surface bad data explicitly.
- Coastline avoidance (rewritten — was a fragile perimeter-walker with a long tail of named bugs): a trail is ONE centripetal Catmull-Rom curve per **journey** (C¹ continuous everywhere, including real→inferred transitions). Across a data gap whose straight line crosses land, `routeWater` (`geo.js`) invents a water-only path via **A\* over a lazily-built local land/water grid + string-pull**, spliced inline as control points. A* steps only through water cells, so the path structurally **cannot** cross land — no seaward-push / apex / centroid / archipelago heuristics. Obstacle inflation (1 cell) keeps waypoints off the coast so the spline has slack; out of coverage it returns `null` and the gap is bridged with a straight spline segment. The raw A\* path is sparse + angular (shortest-path has no turning radius), so before splicing it's run through **`smoothRoute`** (`trail_geometry.js`): densify to ~uniform spacing, then land-rejecting Laplacian relaxation (endpoints pinned, a move is kept only if BOTH touched segments stay clear of land) — corners round out as much as the surrounding water allows and stay sharp ONLY where the channel forces the turn (a real boat can't turn on a dime). Config: `ROUTE_SMOOTHING`. Separately, A\* is given the boat's real **entry/exit heading** (COG just outside the gap, `entryBearing`/`exitBearing`) and biased to leave/arrive along it — without this the proximity cost could make it *backtrack against the boat's heading* to skirt a narrow exit, rendering as a sharp kink right at the real→inferred boundary (trust the boat: it leaves on the course it was actually steering, deviating only where land forces it). Pipeline in `map_page.js`: `dedup → splitJourneys → buildControlPoints (→ smoothRoute → cleanControls) → repairOffLand (→ cleanControls) → catmullRom → runsBySynthetic`. **`cleanControls` must run at BOTH assembly points** — `repairOffLand` splices its own mids in after `buildControlPoints` already cleaned, and that gap produced every observed harbour hairpin (10–40 m steps with ~170° reversals where consecutive routed segments join). It drops only SYNTHETIC points, and a reversal only when the bypass chord is verifiably clear of land. See `frontend/CLAUDE.md` for details. Config in `LAND_AVOIDANCE` (gapMinMs, gapMinKm, dashArray, fadeRatio). Land polygon data in `frontend/app/coastline.js` (clipped `[47,-128.7]→[51.2,-122]`, generated by `worker/scripts/build-coastline.mjs`).
- Two recurring root causes, both fixed by the rewrite: **duplicate AIS fixes** (centripetal Catmull-Rom divides by ~0 → spike — `dedup` at 20 m), and **routing dense real tracking** (a vessel maneuvering near shore is ground truth, not a gap — only route across `gapMinMs`/`gapMinKm` holes). `denoise` reverts any smoothed point that lands on land.
- Journey breaks happen ONLY at a parked stop (`speed ≤ MOVING_SPEED_KN` + gap > sever); a moving vessel that lost signal stays one continuous curve. Regression test: `node tests/trail.test.mjs` over real fixtures in `tests/fixtures/`.
- A* uses a **coast-proximity cost** (`proximityKm`/`proximityWeight` in `routeWater`) so routes bow into open water (wider/natural) and hold channel-centers rather than hugging the coast, plus a **`narrowWeight` quadratic narrow-channel penalty** so vessels prefer the main channel (Fraser) over a tributary shortcut — **scaled by vessel length** (`NARROW_WEIGHT` config, threaded `computeRuns(opts.vesselLength) → routeWater`): big ships (≥120 m) hold the main channel even when slower, small craft (≤20 m) are free to dart through tight Gulf Island passes, linear between. `repairOffLand` then nudges any spline bulge off land (chord-clear cases A* can't catch). Geometry is **cached per vessel** (`trailGeom`). **A\* now runs server-side**: a GitHub Actions cron (`worker/scripts/precompute-trails.mjs`) routes each land-crossing gap once and stores the sparse inferred waypoints in D1 (`inferred_positions`); the Worker serves them unioned into `/track` and the **browser loads no coastline and runs no A\***, just splining the combined real+inferred stream with `frontend/app/trail_spline.js` (the pure half, split out of `trail_geometry.js`). An un-routed gap bridges straight until the next cron run. Because A\* is server-side-only, `routeWater`'s `cellKm` is a **grid cell-count budget** (`max(0.2, (directKm+2·marginKm)/4000)`), NOT length-capped — it stays fine (0.2 km, threads the Columbia / Inside Passage) on long gaps too, only coarsening past ~800 km span (open ocean). The old length cap (≥0.68 km cells on long gaps) made the Columbia/Inside-Passage straight-bridge through land; the cost of the finer grid is ~10–60 s/long-gap in the precompute (acceptable; the `isLand` polygon scan dominates — spatial index is the deferred speedup). The **central-BC band (51.3–54°N)** is fine-covered by the `bc-central-{south,north}` island-land regions (coastline-only `CORRIDORS`). See `worker/CLAUDE.md` → "Server-side inferred-positions precompute — IMPLEMENTED" / "Central-BC coverage". Regression: `tests/region-trails.test.mjs`.
- **Coastline data is OpenStreetMap `natural=coastline`** (sub-100 m; resolves harbours, Deception Pass, every Gulf Island), generated by `worker/scripts/build-coastline.mjs` + `lib-osm-coastline.mjs`. See `worker/CLAUDE.md` → "Coastline data generation" to regenerate or **expand coverage** (Portland, Alaska, foreign ports). If a curve crosses land that `pointInAnyLand` calls water, it's a data-coverage gap, not a router bug (`tests/README.md` §1). ("10m" Natural Earth — the old source — was 1:10 *million* scale, NOT 10-metre; it dropped sub-km features.)
- **Three land layers** (concatenated/threaded in `trail_geometry.js`): (1) `coastline.js` fine OSM `natural=coastline`; (2) `water.js` (`WATER_POLYGONS`, OSM `natural=water`/`riverbank` per fine zone) subtracted — `pointOnLand = inLand && !inWater` — re-opens rivers/harbour basins the coastline closes (upper-Fraser fix; `build-water.mjs`); (3) `coast_coarse.js` (`COARSE_LAND_POLYGONS`, Natural Earth 1:50M, **whole world** minus the carved-out fine home bbox — NA-Pacific at ≈2 km, rest of world at ≈5 km, disjoint tiles) so long open-ocean routes bow around continents — NA *and* foreign/trans-Pacific (Asia/Oceania) — instead of cutting through (`build-coarse-coast.mjs`; ~100 KB gzip; regression `tests/coarse-global.test.mjs`). **Resolution policy** — resolution follows NAVIGATION, not geography: **never close a shipping waterway** vessels transit (Inside Passage, straits, river/port approaches); coarse is fine on sail-past open coast (a slight clip there is cosmetic). simplify tol ≤ ⅓ × narrowest channel to keep open, `routeWater` cellKm ≤ ½ × that; water always ~25 m, coarse ~2 km. Where a shipping waterway runs through coarse territory a fine region must override coarse (task: "High-res channel routability"). A regional spatial index (so a Singapore boat skips Vancouver polygons) is designed but deferred until disjoint foreign coverage ships. See `worker/CLAUDE.md` → "Water layer" / "Coarse continental layer" / "Coastline resolution policy".
- **Longitude is UNWRAPPED inside the trail pipeline** (`geo.js` → "Longitude frames"). Every stage is linear in lon (spline interpolation, the A\* grid's min/max span, Laplacian smoothing), so raw ±180 values made a BC→Asia leg interpolate the LONG way — 268° east across North America and Eurasia — and built a planet-spanning A\* grid (the cause of the 1–2.5 h precompute runs). The frame is established once in `trail_spline.unwrapTrack`, called from `dedup` (the entry point of every pipeline: client, precompute, tests), so each point sits within 180° of its predecessor and values MAY exceed ±180. Wrap back only at two boundaries: **polygon tests** (`geo.pointOnLand`/`pointInWater` AND `region_coast.isLand`/`isWater` — region_coast has its OWN polygon code and does not route through geo.js, easy to miss) and **storage** (`precompute-trails.mjs` wraps before the `inferred_positions` INSERT). Leaflet draws unwrapped lons as the adjacent world copy, so a dateline crossing renders continuously — never wrap before rendering. **The vessel MARKER must be moved into its trail's world copy too** (`marker._lonTurn`, set in `drawTrail`): the marker was placed at the raw API lon while its trail ran unwrapped past ±180, so a BC→Asia boat drew its track west across the Pacific but parked its icon a full 360° east — follow the line and the boat isn't there (observed on COSCO SANTOS). `syncMarkers` re-applies the turn on every poll, or the next refresh snaps it back. `haversineKm`/`bearingDeg` were always correct (sin/cos of dLon is periodic).
- **Ocean-scale gaps bi-segment** (`trail_geometry.routeOceanGap`, gaps > `LAND_AVOIDANCE.routeMaxKm` 800 km). Resolution follows the water, not the gap length: a great-circle spine (`geo.greatCirclePoints`, `spineStepKm` 100) is classified water/land span by span, and ONLY the land-crossing spans go to A\* — ocean stretches stay a clean curve, coastal ends get fine routing for free (they're the spans that hit land). A short bracket (≤`fineBracketMaxKm` 150 km) in fine coverage (`region_coast.hasFineLand`) uses the defaults; anything else gets a wide margin (`oceanMarginMinKm` 400 — the 90 km default strands a peninsula detour, A\* finds nothing and the spine drives straight over Kamchatka) with the cell COUNT capped (`oceanMaxCellsPerSide` 800, `coarseCellKm` 2 floor). Measured: trans-Pacific vessels went from hours to 15–18 s, water-tight. `routeMaxKm` is deliberately set ABOVE the longest gap any fixture depends on (623 km) so every proven coastal case keeps the single-grid path. Two traps: never `smoothRoute` an ocean spine (it densifies then land-checks every 100 m of an 8,000 km crossing), and guard `to <= from` when widening blocked runs (a swallowed run routes BACKWARDS → hairpin). Regression: `node tests/ocean-trails.test.mjs`.
- **The ocean spine's SHAPE is measured, not assumed** (`OCEAN_ROUTE`, shaped before land classification so A\* still routes around anything it pushes ashore; regression `node tests/ocean-shape.test.mjs`; evidence in `docs/ocean-routing-study.md`). A plain great circle Salish Sea→Japan peaks at **54°N**, runs the Aleutians and departs on 297°, but real Asia-bound vessels leave on **267–273°** (7 outbound legs, mirrored inbound) — a 25–35° kink at exactly the point where dashed inference takes over. Two fixes: (1) **composite great-circle sailing** caps the spine at `maxLatDeg` **50°N** (`geo.compositeGreatCirclePoints` — GC → limiting parallel → GC, both arcs TANGENT so course stays continuous), falling back to a plain GC when the cap can't apply (route never reaches it, an **endpoint is already poleward** — BC↔Alaska belongs up there and must not be dragged south — or the tangent points cross); (2) **`geo.blendCourse`** swings each end onto the boat's real COG, holding it for `blendHoldKm` 100 km then decaying by `blendKm` 500 km, rotating about the anchor so endpoints don't move and nothing is dragged toward land. Net: SALVIA ACE 297°/54.0°N → **271°/50.0°N** (real 271°). Both are scoped to gaps ≥ `shapeMinKm` **3,000 km** — the regime the study measured. `routeMaxKm` (800 km) also routes 1,000–1,200 km *coastal* runs through `routeOceanGap`, and shaping those BROKE them: `routeOceanGap` A\*-routes only spans that `crossesLand`, so Juan de Fuca→Oakland got its harbour threading solely because the plain great circle clipped the San Francisco peninsula. Blended, it cleared the peninsula → no blocked run → no A\* → the approach stored as bare 100 km spine vertices (50 waypoints → 12) and the client spline bulged 650 m into Oakland. **Fine harbour detail must never depend on the spine accidentally hitting land** — after any spine change, diff per-gap waypoint counts against a HEAD baseline, and treat "defect whose nearest control is a REAL fix km away" as *routing is missing*, not as *unrelated to routing* (`tests/README.md` §11). Beware the trap that made this look fine at first: binning fleet bearings by longitude shows them RISING west (288°→312°), which looks like vessels turning onto the GC — that's two fleets mixed, Alaska-bound (306–318°) against Asia-bound (265–275°). Split by destination before drawing conclusions. **The ocean middle can never be validated** — aisstream is shore-receiver fed, and across all 287 vessels there are ZERO real fixes in the open North Pacific (exactly one mid-ocean fix exists in the whole dataset), which is why inference renders dashed.
- **Bi-segmentation fails across a CONTINENT, so it falls back to one whole-gap A\*** (`routeWholeOceanGap`). Splitting the spine assumes each blocked span is bracketed by water the vessel can sail between — true for an island or cape, false when the great circle crosses a landmass, because the spine re-emerges in a DIFFERENT OCEAN. Columbia mouth → Panama asked A\* to sail Oregon → Gulf of Mexico; it correctly found nothing, and the "no route → keep the spine" fallback then drew a straight line across North America (observed in prod: MH BORGA 379 land defects Oregon→Colorado, MIRACULOUS ACE 325 across Mexico). Now any span that fails to route (including the `to <= from` and endpoint-on-land skips) sets `unrouted`, and the whole gap is re-routed on ONE coarse grid, which is free to go around the landmass: MH BORGA 379 → **0** defects, MIRACULOUS ACE 325 → **6** (worst 1.3 km, Baja graze on ~2 km coarse data). Costs ~5 s and only fires on failure, so ordinary ocean crossings keep the fast bi-segmented path. Like the spine, the result is NOT smoothed.
- **Canal transits (Panama, Suez) are unroutable by construction.** The isthmus is closed in every land layer (verified: zero open meridians across 7–10.5°N), so no Pacific↔Atlantic water path exists short of Cape Horn. In practice these legs are long port stops, so `splitJourneys` severs the journey and nothing is drawn — the correct outcome. A canal transit by a vessel that never stops would still bridge straight across Central America. Fixing it properly means carving canal channels into the land data, not changing the router.
- Trail/A* tests + troubleshooting techniques: `tests/README.md`; regression `node tests/trail.test.mjs` over `tests/fixtures/`. Both `trail.test.mjs` and `trail-precompute.test.mjs` **auto-discover** `tests/fixtures/*.json` — adding a fixture adds it to both suites.
- View/template files: all logic at top, pure rendering at bottom.
- Comments only for non-obvious WHY, never for WHAT.
- Helpers only when used ≥2× (big) or ≥4× (small).
- Vessel API returns MMSI as **number** — use `===` comparison with number literals, never string.
- View/template files: all logic at top, pure rendering at bottom.
- Comments only for non-obvious WHY, never for WHAT.
- Helpers only when used ≥2× (big) or ≥4× (small).
- Vessel API returns MMSI as **number** — use `===` comparison with number literals, never string.

## Write budget / maintenance mode (D1 free tier)

The binding limit is **rows written (100k/day)**, not storage or reads. **In D1 every
secondary-index entry counts as a row written**, so index choice is a write-rate decision,
not just a read-speed one. Measured budget before/after the 2026-09-03 reduction pass
(model + sampling scripts were throwaway; method below reproduces them):

| Source | Before | After |
|---|---|---|
| `vessels` heartbeat upserts (+ its index) | ~61,400 | ~6,800 |
| `positions` inserts (+ indexes + AUTOINCREMENT seq bump) | ~20,000 | ~11,300 |
| **Total** | **~81,500/day (81% of cap)** | **~18,000/day (18%)** |

What changed and why:
- **`HEARTBEAT_MS` 10 min → 60 min** (backoff 30/60 → 90/120). This was ~75% of ALL writes.
  A heartbeat's only job is keeping `last_seen` inside `LIVE_TTL_*` (6 h), so 10 min was 36×
  over-provisioned. The trap: `heartbeatIntervalMs` derives `parkedMs` from `last_pos_ts`, so
  a MOVING vessel never backs off — the shortest interval applied to exactly the vessels
  already writing positions rows. Keep every interval ≤ TTL/3 (survives two missed beats).
- **Dropped `positions_mmsi_tier_ts`** (migration 007). `/track` is
  `WHERE mmsi=? [AND tier IN (…)] ORDER BY ts DESC LIMIT n`, which `positions_mmsi_ts` already
  serves optimally (seek mmsi, walk ts DESC, filter tier inline, stop at LIMIT — no sort). The
  tier index only ever cost ~25% of each insert.
- **`vessels_of_interest` re-keyed (of_interest, last_seen) → (of_interest)**. `last_seen`
  changed on every heartbeat, so the index row was rewritten every heartbeat. Dropping it from
  the key means a heartbeat leaves the index untouched; the `ORDER BY last_seen` now sorts a
  few hundred rows, which is free at this table's size.
- **Repetitive traffic coarsened by TIER, not globally** (`compress.ts`). Passenger/ferry
  (60–69) is the highest-rate class measured (27.6 rows/vessel/day) and the most redundant —
  it re-sails an identical route daily. `COARSE_TYPE_GAP_FACTOR` (2) still applies to `direct`
  so the apartment-window view stays crisp; `COARSE_TYPE_GAP_FACTOR_FAR` (4) applies to
  local/global where a repeating hull's exact wiggle is noise. Turn/speed triggers are never
  scaled, so maneuvers survive at any factor.

**Measuring without Cloudflare auth.** The prod API is public and read-only —
`/current` (fleet + `max_extent`) and `/vessel/:mmsi/track` (real + inferred points) are enough
to derive per-type write rates, gap distributions and trail defects. Use this instead of the
`db-*` scripts when wrangler is authed to the wrong account; **never re-auth to measure**
(`npx wrangler whoami` showing `brennan@textgroove.com` is the abort condition, not a fix-it).
Caveat: `TRACK_LIMIT` caps real points at 500/vessel, so `pts` and span are truncated for busy
vessels — rate (points ÷ span of what returned) stays representative, absolute counts do not.

## Trail severing — why a gap-length ceiling does NOT work (attempted and reverted)

Reported defect: ASL GALAXY drew one curve across a 58-day / 12,856 km Salish Sea → Singapore
gap, rendering through Brunei. `splitJourneys` severs only when the vessel was PARKED at the
last fix (`speed ≤ MOVING_SPEED_KN`), so a vessel that vanished while under way stays ONE
journey however long the gap. The obvious fix — an absolute `TRAIL_GAP_HARD_SEVER_MS` ceiling
that severs regardless of speed — was implemented, measured, and **reverted. Do not retry it.**

**Why it fails: no gap-level statistic separates a bad trail from a good one.** A threshold of
21 days was picked from the live fleet (across 128 real >1,000 km gaps, median implied speed —
great-circle km ÷ duration — holds ~10 kn through the 14–21 day bucket then collapses to 5.0 kn
past 21 days). It looked well-founded and was still wrong: `tests/fixtures/cosco-santos.json`
is a legitimate 33.1-day BC → Hong Kong crossing and `cs-anthem.json` a 32.9-day BC → Singapore
one — the exact trans-Pacific behaviour `OCEAN_ROUTE` exists to draw. Implied speed does not
discriminate either: cosco-santos is **5.9 kn** over its 33 days, ASL GALAXY **5.0 kn** over its
58. Duration and implied speed are the same for both; only the *rendered result* differs.

**The real defect is un-ROUTED, not un-severed.** ASL GALAXY's gap had `inferredFilling=0` — no
A* waypoints were ever stored, so it straight-bridged through Brunei. cosco-santos has its
waypoints and bows around the Pacific correctly. So the fix is to get the gap ROUTED (see
"Precompute fairness" below — starvation is why it never was), never to cut the journey.

**The trap that made the mistake look safe: the fixtures went VACUOUS, not red.** With the
ceiling in, `trail`, `ocean-trails` and `ocean-shape` all still PASSED — because severing
deleted the trans-Pacific journey the assertions were measuring, leaving a small local one that
trivially satisfied them. `ocean-trails` reported cosco-santos `lonSpan=5°` where the real
fixture spans **124°**, and cs-anthem shattered 1 → 18 journeys. A green suite is not evidence
that a journey-splitting change is safe. **After ANY change to `splitJourneys` or gap handling,
diff per-fixture journey COUNT and max lonSpan against a HEAD baseline** — that is the only
check that catches an assertion which has stopped measuring anything:

```bash
node -e "const fs=require('fs');(async()=>{const {dedup,splitJourneys}=await import('./frontend/app/trail_spline.js');
for(const f of ['cosco-santos','cs-anthem']){const d=JSON.parse(fs.readFileSync('tests/fixtures/'+f+'.json','utf8'));
const p=(d.points||d.track).slice().sort((a,b)=>a.t-b.t);const j=splitJourneys(dedup(p));
console.log(f,j.length,'journeys, maxLonSpan',Math.max(...j.map(x=>{const l=x.map(q=>q.lon);return Math.max(...l)-Math.min(...l)})).toFixed(0))}})()"
# Expected baseline: cosco-santos 1 journey / 124°, cs-anthem 17 journeys / 134°
```

**Not every reported "missing trail" is a bug.** A vessel parked at the gap start (ZEN in
Honolulu at 0.0 kn, BEOWULF in San Francisco at 0.1 kn) is severed by design and renders as two
disconnected pieces — which reads to a user as "teleports without a route". BEOWULF's leg is
also a Panama transit, unroutable by construction. Confirm which gate fired (`realPair` /
`parked` / tier sever) before treating it as a routing defect.

## Precompute fairness — a bounded run must not order by `last_seen`

The candidate query is `ORDER BY last_seen DESC` (freshest first). That is fine unlimited, but
under a `--limit` it **starves exactly the vessels that need routing most**: a long-range ship
heard once a day sinks down the list, is never reached, and its ocean gap stays un-routed
(straight-bridging through land) indefinitely. A normal run now sorts `eligible` by precompute
staleness (`precompute_state.last_run_at`, never-examined first). `--regenerate` keeps the raw
`last_seen DESC` order because its `--offset` batching depends on one stable list.

**GitHub Actions saturation.** Runs averaged **160 min (max 230)** against an **hourly**
dispatch, so the concurrency group was busy ~100% of the time and **35 of every 60 runs were
cancelled while queued** — noise that also made hand-dispatched batches impossible to land.
Fixed by bounding the run (`timeout-minutes: 75`, default `--limit 80`) and throttling the
Worker's dispatch to every 6 h (`PRECOMPUTE_DISPATCH_EVERY_HOURS`, keyed off the cron's own
`scheduledTime`, not `Date.now()`). Rule: the dispatch interval must stay ≥ the typical run
time or the group never goes idle.

## Map tiles

CARTO's free basemaps now stamp **"API KEY REQUIRED"** onto every tile (they still return
HTTP 200 with distinct per-tile bytes, so only rendering one reveals it — a status check does
not). Replaced with **Esri Dark Gray Canvas**, keyless, same dark cartography, water darker
than land. It has no `{s}` subdomain shard and is native to z16, so the layer sets
`maxNativeZoom: 16` and lets Leaflet upscale to 18.

## Key reference docs

- `docs/handoff.md` — session state, open tasks, operational traps (regenerate batching, pace); **start here after a break**
- `docs/known-issues.md` — open defects with the evidence already gathered, so a session starts from measurements rather than re-deriving them
- `docs/ocean-routing-study.md` — do real ships follow great circles? (the measurement behind `OCEAN_ROUTE`)
- `docs/ais-reference.md` — aisstream message shapes, AIS vessel-type codes, bounding box
- `docs/architecture.md` — data flow diagram, KV/D1 usage, cron model
- `docs/decisions.md` — architectural decisions (why cron not Durable Objects, etc.)

## D1 inspection tools (`worker/scripts/db-*`)

Shell scripts wrapping `npx wrangler d1 execute` for inspecting the live (or local) D1
database. All output JSON by default (`--pretty` for human-readable tables). Run from
repo root: `worker/scripts/db-stats`.

| Command | What it returns |
|---------|----------------|
| `db-stats` | Vessel/position counts by category and tier |
| `db-list-ships` | All vessels with key fields, last_seen desc |
| `db-ship <mmsi>` | Full vessels row + per-tier position stats |
| `db-positions <mmsi>` | Movement-event timeline for one vessel (--tier, --limit) |
| `db-of-interest` | Vessels that entered the direct bounding box (map candidates) |
| `db-recent` | Most recently seen vessels with moving/stopped status |
| `db-timeline` | Recent position events across all vessels (--tier, --limit) |
| `db-stale [--hours N]` | Vessels not seen within N hours (default 24) |
| `db-by-extent` | Vessel count by max_extent (direct/local/global) |
| `db-by-type [--min N]` | Vessel count by AIS type code |
| `db-tiers` | Position stats per scan tier |
| `db-search <term>` | Search vessels by MMSI or name fragment |
| `db-diagnose` | Why has ingestion stopped? Freshness, AIS lock state, scan cursor, write probe |
**Auditing LIVE trails** (not fixtures): `node tests/audit-prod.mjs --all --top 30`, or
per-vessel with span detail. Fetches what the browser receives and splines it with the
client pipeline. **It loads `region_coast` regions explicitly** — `tests/lib.mjs` alone
loads only the home-bbox coastline + the ~2 km coarse layer, and regions load lazily, so
a naive probe reports fine-covered areas as coarse and invents land defects that do not
exist (this produced a confident wrong root cause once; `docs/known-issues.md` §4).

| `db-trails [--mmsi N]` | Inferred-trail precompute state: waypoints/segments by `generator_version`, unroutable count, last run. Use it to confirm a precompute run actually LANDED rather than being skipped by the freshness heuristic — `--regenerate` is required to rebuild existing segments, so a version rollover is the proof. |

Common flags: `--local` for local D1, `--db <name>` to change database, `--pretty` for
tables. MMSI and numeric args are validated before SQL interpolation; search terms are
single-quote-escaped. Use these anytime you need to see what's in the database.
