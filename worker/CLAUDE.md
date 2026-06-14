# Worker — CLAUDE.md

Cloudflare Worker (TypeScript). Two handlers: `fetch` (HTTP API) and `scheduled` (cron ingestion).

## Cron model

Four cron schedules in `wrangler.toml [triggers]`, all handled in `scheduled` (branch on `event.cron`). **The schedule is a COLLISION-FREE MINUTE PARTITION** (cron strings in `constants.ts` `*_SCAN_CRON`): every minute :00–:59 belongs to exactly one scan, and each drain is capped to fit inside its minute (≤50 s + ~10 s guard), so the four scans never share the aisstream socket. Nominally zero lock contention; cron jitter at slot edges is absorbed by the AIS lock as a brief SOFT wait (waits > one drain), never a hard skip. Layout: `:00–:49` evens→direct, odds split mod-4 → local/foreign; `:50–:59` reserved block → global.

- `0-48/2 * * * *` — direct scan, 25×/hr (every 2 min, :00–:48): drain DIRECT box (apartment view, ≤45s), write every vessel as of_interest=1. (Live `/current` dot refreshes every 2 min, except it pauses ~:48→:00 during the global block.)
- `1-49/4 * * * *` — local scan, 13×/hr (:01,:05,…,:49): drain LOCAL box (≤50s — shortened from 90s to fit its slot), write only large vessels (≥50m / cargo / tanker) or already-of-interest vessels.
- `50 * * * *` — global scan hourly, owns the **reserved :50–:59 block** (nothing else fires then, so it has the socket to itself): one invocation chaining ~15 drains of the global box filtered to of-interest MMSIs in retrying batches, stale vessels first, widen max_extent. `GLOBAL_SCAN_BUDGET_MS` (9 min) caps it to finish before :00 so it can't bleed into the next hour's slots. Trade-off of the block (vs a spread-refactor): the live direct view pauses ~:48→:00 (~10–12 min/hr).
- `3-49/4 * * * *` (`FOREIGN_SCAN_CRON`) — rotating **foreign scan**, 12×/hr (:03,:07,…,:47): drain a rotating SLICE of distant port boxes (`zones.ts` foreign zones — **41 of them**, 12/tick via the aisstream `BoundingBoxes` array, ≤50s → 144 zone-coverages/hr ≈ each zone ~every 17 min, NO MMSI filter) and pre-seed large, plausibly-inbound vessels. (Was `*/15` 4×/hr; the collision-free partition gave it more slots — 3× more foreign coverage.) The worldwide global scan above rarely hears its targets (a 30 s window over the planet seldom catches a specific MMSI); a dense port box hears everything there. **Write-frugal** (free-tier): functions like the local scan (skip confirmed-small new, keep an initial row for unknown types to enrich+reclassify later) but ingests only a relevant vessel (≥100 m anywhere on the Pacific rim, or ≥70 m bound for a NA-Pacific-NW port per AIS destination, or already-of-interest) as of-interest='global' + a `zone_visit` + a **sparse port-dwell track**: a position on first zone entry, then at most one more per `FOREIGN_POSITION_THROTTLE_MS` (30 min) while the vessel stays in the zone. **`last_pos_ts` is read from the latest `positions` row** (the heartbeat upsert path leaves `vessels.last_pos_ts` stale), so each write self-advances the throttle — `loadForeignStates` fetches it via a scalar subquery. **`FOREIGN_MAX_POSITIONS_PER_SCAN` (25) is the hard ceiling**: 96 scans/day × cap ⇒ ≤~2,400 foreign position rows/day, so a busy world port can't run away (LA/Long Beach + Singapore boxes are widened to include their offshore anchorages — many waiting ships — which the cap bounds). Full-resolution tracking begins only if the vessel reaches the home box (`first_direct_at` stays null → not on `/current` until then). Config + the relevance gate are in `constants.ts` "Rotating foreign scan" (`FOREIGN_*`); cursor persists in `scan_meta`. The `BoundingBoxes` cap is unprobed; per-port heard counts + per-scan `positions=` are logged so the write rate can be projected and the gate/throttle/cap retuned.

**Why cron not Durable Objects:** Durable Objects require the paid Workers plan. Scheduled Workers are free-tier and sufficient. See `docs/decisions.md`.

**AIS connection lock (single-key serialization).** aisstream **throttles concurrent connections per API key** — a second socket on the same key kills/rejects the other (WebSocket close `code 1006`). The four scans fire on independent cron triggers that collide at shared minutes (all four at `:00`), so the every-minute direct scan (45 s of every 60 s) was **starving the hourly global scan**: empirically its catches landed only at minute `:04–:08`, never `:00–:02` (the early drains 1006'd against direct/local/foreign). Fix: a single-key advisory lock in `scan_meta` (`acquireAisLock`/`releaseAisLock` in `storage.ts`; lock value = expiry epoch-ms, "free" = `value < now`, conditional UPDATE → SQLite single-writer makes check-and-set atomic; conditional release on the written token so an overran drain can't free a new holder). **Each DRAIN — not each scan run — acquires → drains → releases** (threaded via `DrainOptions.lock = {env, holder, maxWaitMs}` in `drainAisStream`), so direct's 45 s and global's 30 s drains **interleave on one connection** instead of colliding. A drain that can't get the lock within `maxWaitMs` is **skipped** (empty result — scans handle this) rather than forced; direct yields soonest (`AIS_LOCK_WAIT_*` in `constants.ts`), global waits per-drain but its 3-round/14-min budget gives many retries, and the global loop sleeps 2 s between drains so it can't instantly re-acquire and starve the others. Lock auto-expires (`drainMs + AIS_LOCK_TTL_BUFFER_MS`) so a crashed scan can't deadlock.

**Write frugality.** Each `acquire` and `release` is a D1 write. To keep this cheap, the **single-drain scans (direct/local/foreign) do NOT write a release** — they hold the lock once per run and let it expire via TTL (`release: false` in their `lock` opt). Only **global** explicitly releases, because it chains ~13 drains and must free the lock between them. Consequence: `AIS_LOCK_TTL_BUFFER_MS` must stay **below the direct cadence** (10 s now; drain 45 s + 10 s = 55 s ≪ the 120 s every-2-min period) or a direct run's un-released lock would still be held when the next fires. Net lock writes ≈ **1,700/day** (direct `*/2` acquire-only 720, local 144, foreign 96, global ~620) — ~1.7 % of the 100k/day free write cap. Staggering the crons does NOT reduce these (acquire/release fire regardless of timing); only cadence + the release-skip do.

NOTE: this is a single-key stopgap — a second aisstream key (direct on its own key, the rest on key 2) would remove even the interleave waits; deferred.

## File structure

```
src/
  index.ts       — exports fetch + scheduled handlers, routes only
  ingest.ts      — four scan functions: runDirectScan, runLocalScan, runGlobalScan, runForeignScan
  aisstream.ts   — promise-based AIS stream client (single box OR multi-box `boundingBoxes`)
  ais.ts         — pure AIS parsing + vessel-type codes + pointInBox + isLargeVessel
  storage.ts     — D1-only: loadVesselStates, commitScan, getCurrentVessels, getTrack;
                   foreign-scan helpers loadForeignStates / loadZoneVisitKeys / get|setScanCursor
  cors.ts        — CORS headers (reads ALLOWED_ORIGIN from env)
  http.ts        — json() / errorJson() response helpers
  types.ts       — Env (no KV), Vessel, VesselRow, PositionRow, Tier, MaxExtent
  constants.ts   — bounding boxes (direct/local/global), thresholds, drain windows
migrations/
  001_initial.sql — first migration (schema_migrations tracking table + old schema)
  002_rebuild_d1.sql — D1-only rebuild: event-based positions schema
scripts/
  ensure-bindings.mjs — idempotent: creates D1, patches wrangler.toml, applies migrations
  db-common           — shared lib (sourced by db-*): flag parsing, MMSI/numeric validation, d1_query()
  db-stats            — vessel/position counts by category and tier
  db-list-ships       — all vessels with key fields, sorted by last_seen
  db-ship <mmsi>      — full row + per-tier position stats for one vessel
  db-positions <mmsi> — movement-event timeline for a vessel (--tier, --limit)
  db-of-interest      — vessels that entered the direct bounding box (map candidates)
  db-recent           — most recently seen vessels with moving/stopped status
  db-timeline         — recent position events across all vessels (--tier, --limit)
  db-stale            — vessels not seen within N hours (--hours, default 24)
  db-by-extent        — vessel count by max_extent (direct/local/global)
  db-by-type          — vessel count by AIS type code (--min N)
  db-tiers            — position stats per scan tier (count, vessels, avg speed)
  db-search <term>    — search vessels by MMSI or name fragment
  db-zone-visits <mmsi> — visited destinations for one vessel
  db-zones            — per-zone rollup: distinct vessels + most recent visit
  README.md           — quick-reference for AI agents
```
All db-* scripts output JSON by default (--pretty for tables). Use with:
  ./scripts/db-stats --local        # local dev
  ./scripts/db-stats                 # remote (production)
  ./scripts/db-ship 316123456       # single vessel
See scripts/README.md for full reference.

## D1 schema (see migrations/002_rebuild_d1.sql)

- `schema_migrations(id, applied_at)` — migration tracking
- `vessels(mmsi PK, name, vessel_type, length, destination, last_lat, last_lon, last_speed, last_heading, last_pos_ts, last_seen, first_seen, of_interest, max_extent, first_direct_at, times_seen)` — one row per vessel with denormalized current position
- `positions(id, mmsi, lat, lon, speed, heading, ts, tier)` — movement events only; `tier ∈ {direct, local, global}`
- `zone_visits(id, mmsi, zone_id, first_ts, last_ts, lat, lon)` — "visited destinations", UNIQUE(mmsi,zone_id); see "Visited destinations" below (migration 005)
- `scan_meta(key, value)` — cron scratch (e.g. rotating foreign-scan cursor)

## Event-based position storage

A `positions` row is only inserted when the vessel has moved past the tier-specific threshold:
- direct: 0.05 nm (~90m)
- local: 0.5 nm
- global: 5.0 nm

Stationary vessels update `last_seen` heartbeat every ≥10 min but emit no position row.

Movement uses **trajectory compression** (`src/compress.ts` `isSignificantMove`): past a
jitter floor, a position row is written only on a turn / speed change / start-stop / a
bounded max gap (per-tier `MOVE_PROFILE`; direct stays gentle to keep the live dot
fresh, local/global compress hard). Low-value resident types (tug/pleasure/fishing) get
coarser gaps. Heartbeats back off as a vessel stays parked (10m→30m→1h). Unit-tested:
`node tests/compress.test.mjs`.

**Decoupled per-move `vessels` upsert (write reduction).** A move writes a `positions`
row but **no longer also upserts `vessels` every time** (that paired write was ~half of all
move-writes). The scan loops push a `vessels` upsert only when `vesselRowNeedsWrite` says so
— new vessel, a metadata change (`of_interest`/`max_extent`/`first_direct_at`/`direct_entry_count`),
a due heartbeat, or a phantom correction — so a steady mover with stable metadata writes
positions only. To make this safe, the **last-emitted fix is read back from the `positions`
table, not `vessels.last_*`**: `loadVesselStates` LEFT JOINs the latest `positions` row for
the compression/phantom reference (and keeps `vessel_last_speed` = `vessels.last_speed` purely
as the phantom "already-corrected-to-0" flag), and `getCurrentVessels` sources the live dot
from the latest `positions` row (COALESCE fallback to `vessels.last_*`). Liveness/TTL still
use `vessels.last_seen` (active vessels bump it ≥ every heartbeat interval). `commitScan` and
the upsert SQL are unchanged. **Nuances:** (1) the per-scan log now shows `writes < pos` when
movers skip the upsert — that gap *is* the saving; (2) the `db-*` inspection tools read
`vessels.last_*` directly, so they show a slightly stale position for an active mover (the API
is correct); (3) a phantom vessel's displayed speed is the last emitted speed (usually ≈0 from
the emitted stop) rather than a forced 0 — position is unaffected.

## Visited destinations (zones)

Named places (ports/rivers/chokepoints) a vessel has been — the data behind the
`/vessel/:mmsi/zones` map dots. `src/zones.ts` holds a **hardcoded** `ZONES` registry
(config-in-code, like the coastline fine-zones — NOT a DB table) and `zoneOf(lat,lon)`.
`zoneOf` runs in every scan, so **local/nearby** zones (Vancouver, Deltaport, Tacoma,
Seattle, …) are attributed **for free** from the direct/local boxes we already drain;
of-interest vessels heard worldwide by the global scan get foreign attribution for free
too. `commitZoneVisits` (`storage.ts`) is **saturating**: one row per `(mmsi, zone_id)`
— first sighting inserts, later sightings only bump `last_ts` once past
`ZONE_VISIT_THROTTLE_MS` (30 min), so a parked ship doesn't re-write every scan. Never
deleted; bounded by the vessel×zone matrix. **Distant ports are now covered by the
rotating foreign scan** (see Cron model → foreign scan): it drains the foreign `zones.ts`
boxes directly, so a vessel at Tokyo/Shanghai/Hawaii gets its foreign zone attributed even
though the worldwide global scan almost never hears it.

## Adding a migration

Drop a new `NNN_my_change.sql` file in `worker/migrations/`. On next push to main touching `worker/**`, CI calls `ensure-bindings.mjs` which detects the pending migration and applies it before deploying.

## Bounding boxes (in constants.ts)

- `DIRECT_BOUNDING_BOX` — apartment window view: `[[48.070,-123.70],[48.524,-123.02]]`
- `LOCAL_BOUNDING_BOX` — Vancouver Island + waterways + Puget Sound to Seattle: `[[47.4,-128.7],[51.2,-122.0]]`
- `GLOBAL_BOUNDING_BOX` — near-global, paired with FiltersShipMMSI for daily scan

## HTTP API

- `GET /current` → of-interest vessels within tier TTLs: direct/local 6h, global 72h. `max_extent` reflects the strongest extent actually observed in D1.
- `GET /vessel/:mmsi/track?tier=direct,local` → movement event positions, `Cache-Control: public, max-age=60`
- `GET /vessel/:mmsi/zones` → visited destinations `[{zone_id,name,kind,lat,lon,first_t,last_t}]` (zone_visits joined with code metadata), `Cache-Control: public, max-age=300`
- `OPTIONS *` → CORS preflight

## Secrets

- `AISSTREAM_API_KEY` — set via `wrangler secret put` in deploy workflow. Template in `.dev.vars.example`.

## Coastline data generation (`frontend/app/coastline.js`)

The land-avoidance router needs land polygons. `coastline.js` is generated from
**OpenStreetMap `natural=coastline`** (high-resolution: resolves harbours, breakwaters, narrow
passes like Deception Pass, and every Gulf Island). NOT Natural Earth — its "10m" is 1:10,000,000
*scale* (coarsest tier), which drops sub-km features and was the cause of routes cutting unmapped
islands. OSM coastline ways are sub-100 m.

**Clip = the whole NA-Pacific routing CORRIDOR, not just the Salish Sea.** `BB` in
`build-coastline.mjs` is `[32.0,-130.0]→[51.3,-116.0]` (SoCal → Salish Sea). Why: trails now
route SERVER-SIDE (the GH-Actions precompute) and the browser no longer loads coastline, so the
larger file is free — and a vessel last seen locally whose current position is off California must
route DOWN THE COAST, not across the 2 km coarse layer (which clipped routes ~2–3 km, e.g. up the
Columbia). The corridor coast is medium-res (≈300 m) — routable, not harbour-grade.

**Resolution tiers** (`TIERS`, km from HOME=Victoria): ≤60 km → 25 m (viewshed); ≤160 km → 120 m
(Salish Sea); ≤2600 km → 300 m (NA-Pacific corridor coast); beyond → 600 m. Plus `FINE_ZONES`
(explicit 25 m boxes: Vancouver/Fraser, Bellingham/Anacortes, Puget Sound). **Hard rule:** simplify
tol ≤ ⅓ × narrowest channel to keep open.

`build-coarse-coast.mjs`'s `HOME` carve-out **MUST stay in sync with `BB`** (same
`[32.0,-130.0]→[51.3,-116.0]`): the coarse 2 km layer is carved out of the corridor so its
seaward-bulging outline can't union into the fine routes. Coarse then only fills Baja (<32°),
BC/Alaska (>51.3°), the far-west ocean, and the inland interior.

### Pipeline
- `scripts/lib-osm-coastline.mjs` — `stitchCoastline` (joins directed coastline ways into chains by
  shared node id; a join pass merges fragments) and `closeOpenChains` (clips chains to the bbox and
  closes mainland masses along the boundary keeping land-on-left, `ccw=true`).
- `scripts/build-coastline.mjs` — reads **one or more** Overpass dumps (latitude tiles — the whole
  corridor truncates in a single Overpass call), **merges + dedupes ways by OSM id** (a way crossing
  a tile boundary appears in both, and a duplicate breaks the stitch walk), then distance-weighted
  Douglas-Peucker per the tiers above. Emits `[lat,lon]` polygons.

### Regenerate (run from `worker/`) — tiled fetch + merge
```bash
# 1. Fetch OSM coastline in latitude tiles (overlap ~0.6° so boundary ways are shared;
#    dedup handles the overlap). bbox order = south,west,north,east.
for t in "32.0 37.6 t1" "37.0 42.6 t2" "42.0 47.6 t3" "46.9 51.3 t4"; do set -- $t
  curl -sS -H "User-Agent: vessel-tracker/1.0" "https://overpass-api.de/api/interpreter" \
    --data-urlencode "data=[out:json][timeout:300];(way[\"natural\"=\"coastline\"]($1,-130.0,$2,-116.0););out body geom;" \
    -o /tmp/osm_coast_$3.json
done
# 2. Build (merges all dumps); bump --max-old-space-size for the corridor's size:
node --max-old-space-size=8192 scripts/build-coastline.mjs /tmp/osm_coast_t1.json /tmp/osm_coast_t2.json /tmp/osm_coast_t3.json /tmp/osm_coast_t4.json
# 3. Re-carve coarse to match BB, then validate:
node scripts/build-coarse-coast.mjs
node ../tests/coverage.test.mjs && node ../tests/trail.test.mjs && node ../tests/scenario.test.mjs
```
The build prints merged-way / polygon / vertex counts and KB. Current corridor ≈ 700 KB (server-side
only — not shipped to the browser). A dense tile that returns a `remark:"... timed out ..."` is
TRUNCATED — split it further by longitude and merge more dumps.

**Central-BC coverage (51.3–54°N) — RESOLVED via fine-land regions, not corridor extension.**
This band (Inside-Passage-south: Queen Charlotte/Johnstone Strait up Finlayson/Grenville/Princess
Royal channels to Prince Rupert) is NOT in the fine OSM corridor, and the coarse 2 km layer merged
the inner channels shut → vessels straight-bridged across the mainland (e.g. MMSI 316011773 Prince
Rupert→N. Vancouver Island). Fixed by adding **`bc-central-south` + `bc-central-north`** fine ISLAND-land
regions (`CORRIDORS` in `build-all-regions.mjs`), not by raising `BB.maxLat` — regions are lazy and
bbox-scoped (a build mistake can't regress the Salish Sea), and fine island land is exactly what
re-opens the inter-island passages coarse closes. Built **coastline-only** (`waterElements:[]`): the
channels are MARINE (defined by coastline; no `natural=water` polygons needed), and the water query
on these large bboxes always timed out. Simplify 0.05 km (channels are ~0.5 km → tol ≤ ⅓ width).
**Gotcha:** the coastline itself truncates on a single Overpass call for this dense −130→−127 band —
**fetch in longitude halves and merge ways by id** (dedupe the seam); a truncated dump silently builds
a region that still closes some channels. Validate with a forced full-transit `routeWater` (Queen
Charlotte Strait → Prince Rupert) — hand-picked "channel centerline" points are unreliable on ~500 m
channels. Regression: `tests/region-trails.test.mjs`. (To extend coverage further north — Haida Gwaii,
57°N+ — add more `CORRIDORS` the same way, or raise `BB.maxLat`+coarse `HOME.maxLat` for base fidelity.)

### Water layer — rivers & harbours (`frontend/app/water.js`) — IMPLEMENTED
`natural=coastline` follows the sea coast up to a river's tidal limit, then OSM
switches to `natural=water` / `waterway=riverbank` polygons. So the **lower** Fraser
is in the coastline source (just simplified — `FINE_ZONES`), but the **upper** Fraser
(New Westminster) has **zero** coastline nodes. The fix is a **second layer**,
subtracted at runtime: `pointOnLand = inLand && !inWater` (`geo.js`).

- `scripts/lib-osm-water.mjs` — `assembleWater`: closed `natural=water` ways → rings;
  `multipolygon` relations → stitch outer member arcs into rings + inner arcs into
  **holes** (mid-water islands like Annacis Is. → must read as LAND).
- `scripts/build-water.mjs` — reads one or more Overpass water dumps (one **per fine
  zone** — a combined/global query truncates), simplifies at the **fine ≈25 m** tol
  only (water exists solely to re-open features the coarse coastline closed — never
  coarsen it), drops sub-100 m ponds, emits `frontend/app/water.js` →
  `WATER_POLYGONS = [{ o:[[lat,lon]…], h?:[holeRing…] }]`.
- `geo.js` `pointInWater` is bbox-prefiltered and only runs for points already on land
  (cheap). `trail_geometry.js` builds `WATER_BBOXES` and threads the layer through
  `pointOnLand`/`segmentCrossesLand`/`routeWater` (via bound `isLand`/`crossesLand`/
  `routeAroundLand` wrappers). `tests/lib.mjs` `pointInAnyLand` subtracts water too.

**Regenerate / add a fine zone's water (run from `worker/`):**
```bash
# bbox = south,west,north,east. Fetch PER fine zone (combined truncates).
curl -sS -H "User-Agent: vessel-tracker/1.0" "https://overpass-api.de/api/interpreter" \
  --data-urlencode 'data=[out:json][timeout:180];(
    way["natural"="water"](49.00,-123.30,49.40,-122.70);
    relation["natural"="water"](49.00,-123.30,49.40,-122.70);
    way["waterway"="riverbank"](49.00,-123.30,49.40,-122.70);
    relation["waterway"="riverbank"](49.00,-123.30,49.40,-122.70);
  );out body geom;' -o /tmp/osm_water_fraser.json
node scripts/build-water.mjs /tmp/osm_water_fraser.json   # pass multiple dumps to merge zones
node ../tests/trail.test.mjs                              # glovis-star/luther/mv-harken PASS
```
Validated by `docs/fraser-river-test-cases.md` (all 15 river coords → `pointInAnyLand`
= -1; home stays land; Strait stays water). Current Vancouver/Fraser water ≈124 KB
(includes inland lakes — harmless, bbox-skipped at runtime; could filter to navigable
water later if size matters as more zones are added).

### Coarse continental layer (`frontend/app/coast_coarse.js`) — anti-cut-through
A third land layer: a low-res landmass of the **WHOLE WORLD** so long open-ocean inferred
routes bow around continents instead of cutting through them — both NA-Pacific
(Vancouver↔California/Mexico/Alaska) and now foreign/trans-Pacific (Asia, Oceania;
e.g. a route that would slice across Taiwan now goes around). **Natural Earth 1:50M**
(coarse is correct here — opposite of the local need). The build (`build-coarse-coast.mjs`)
tiles the world (Antarctica/high-Arctic dropped) into **disjoint** rects that carve out
the fine OSM **home bbox** [46.9,-128.8]→[51.3,-121.9] so coarse never coarsens the Salish
Sea channels; the NA-Pacific coast is kept at ≈2 km (shipped fidelity preserved), the rest
of the world at ≈5 km. Disjoint (not overlapping) so two simplifications of one coast can't
OR together into a seaward bulge. Loaded as the COARSE base layer in `region_coast.js`
(`isLand` ignores it inside any loaded **fine** region, so a port's channel stays open).
A foreign **fine** region (`coast/<id>.js`) overrides coarse in its bbox at runtime.
`routeWater` raises `cellKm` to ~5 km for >300 km gaps so the continental A* grid stays
tractable, and its `marginKm` caps detours at 90 km — a route that would have to circle a
whole peninsula correctly falls back to a straight bridge (graceful degradation). Regression:
`tests/coarse-global.test.mjs` (worldwide classification, home preserved, Taiwan avoided).
Regenerate (run from `worker/`):
```bash
curl -sS -o /tmp/ne_50m_land.geojson \
  https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_land.geojson
node scripts/build-coarse-coast.mjs /tmp/ne_50m_land.geojson   # ~271 KB / ~100 KB gzip, ~700 polys
```
Tune `NEAR_KM`/`FAR_KM`/`DROP_SPAN_KM`/the `HOME` carve-out in `build-coarse-coast.mjs`.
(Always-loaded base layer — watch the size; bump `FAR_KM` or `DROP_SPAN_KM` to trim.)

### Lazy per-region geometry (`frontend/app/coast/<id>.js` + `region_coast.js`)
Foreign regions are **separate files loaded ON DEMAND** (so base download stays small).
`region_coast.js` is **REGION-AWARE**: inside a loaded region's bbox its fine geometry
**overrides the coarse layer** (so shipping waterways coarse would close stay open);
elsewhere it's home+coarse land minus all loaded water.

Two region shapes (resolution follows navigation):
- **Open-coast ports → WATER-ONLY** (`land:[]`). Coarse already has the mainland/ocean
  correct; the region's job is just to open the bay/river basin (`water`). Fine land
  here would only re-introduce the closeOpenChains ocean-as-land bug for no benefit.
- **Archipelago/channel corridors → ISLAND fine-land + water.** `build-region` ships
  land from **closed coastline ways (islands) ONLY** — it DROPS the open-mainland
  `closeOpenChains` closure (the orientation-fragile step that filled ocean as land,
  e.g. Golden Gate). Islands are reliable closed loops, and they're exactly what opens
  the inter-island channels coarse's 2 km merges shut (Inside Passage). `CORRIDORS` in
  `build-all-regions.mjs` (e.g. `inside-passage`, ~150 m land per the resolution policy).

Caveat (the cell-size limit, mitigated by server A*): a single LONG gap into/through a
narrow channel uses coarse A* cells (≥0.68 km) that can't thread it → straight-bridge.
Real tracks (intermediate fixes → short gaps → fine cells) and the planned server-side
A* precompute thread it; verified Prince Rupert→Ketchikan threads at `cellKm 0.4`.
- `scripts/build-region.mjs <id>` — bbox from its `REGIONS` map; reads
  `/tmp/osm_coast_<id>.json` + `/tmp/osm_water_<id>.json`; emits
  `frontend/app/coast/<id>.js` = `{ id, bbox, land:[rings], water:[{o,h?}] }`. Land at
  ~40 m, water at ~50 m, and **water keeps only navigable bodies** (`WATER_DROP_SPAN_KM`
  ~1 km — drops the region's ponds/lakes that otherwise bloat the file). A river region
  re-opens its channel over the coarse continent because water subtraction applies to
  ANY land layer (`pointOnLand = inLand && !inWater`). Proven region: `columbia`
  (Astoria→Portland up the Columbia/Willamette), ~223 KB.
- `frontend/app/coast/manifest.js` — tiny upfront list `[{id, bbox, load:()=>import()}]`.
- `frontend/app/region_coast.js` — owns the combined land/water arrays (base = home
  coast + coarse + home water; regions appended on demand). `ensureRegionsForExtent(bbox)`
  dynamically imports + appends every region intersecting `bbox` (once, cached).
  `trail_geometry.js` reads geometry via its getters (live, so appends are picked up).
  Works in browser, module Worker, and Node (the future A* precompute).
- **Wired:** the routed-compute paths `await ensureRegionsForExtent(extentOf(allPoints))`
  before `computeRuns` — `trail_worker.js` (primary, off-thread) and the inline fallback
  in `map_page.js`. First paint (`route=false`) needs no regions. All 39 foreign regions
  are built (`build-all-regions.mjs`), manifest lists them, ~2.8 MB total but lazy so a
  client only fetches the region(s) for a vessel it's viewing.

### Coastline resolution policy (resolution follows NAVIGATION, not geography)
**Guiding principle (essential):** never close an important **shipping waterway** — a
channel/strait/passage/approach vessels actually transit (Inside Passage, Juan de Fuca,
river approaches to inland ports, port channels). It is fine to be coarse on **sail-past
coastline** vessels never enter (open outer coast) — a slight clip there is cosmetic;
a closed shipping lane breaks routing. So the tradeoff is always resolved in favour of
keeping navigable waterways open.

Concretely, resolution is chosen by a zone's **tightest navigable feature, not distance
from home**. Hard rule (prevents "closed chokepoints"): **simplify tol ≤ ⅓ × the
narrowest channel to keep open**, and **`routeWater` cellKm ≤ ½ × that width**. The
coarse continental layer (~2 km) is acceptable ONLY where it borders sail-past coast;
where a shipping waterway runs through coarse territory, a fine region must override it
(see task: "High-res channel routability — fine regions override coarse").

| Zone class | simplify tol | A* cellKm |
|---|---|---|
| river / narrow channel / chokepoint | ~25 m | ≤0.1–0.2 km |
| harbour / port approach | 25–50 m | ~0.2 km |
| broad bay / anchorage | 75–150 m | default |
| open coast / offshore | 300–600 m | default |

The water layer is always ~25 m (it only ever covers fine features). `FINE_ZONES` /
future per-zone build config should carry an **explicit** simplify tol per destination.

### Regional spatial index (runtime locality) — design, build when global coverage lands
Today `pointOnLand` bbox-prefilters a **flat** array — fine for the Salish-Sea dataset
but O(all polygons)/point, and A* calls it heavily. Before shipping disjoint foreign
regions, bucket polygon indices into a coarse grid (~0.5–1° cells) so `pointOnLand`
tests only the cell covering the point and `routeWater` selects candidates once from
the gap bbox — a Singapore boat then never tests Vancouver polygons.

### Server-side inferred-positions precompute — IMPLEMENTED
A* is off the client entirely: a GitHub Actions cron (`.github/workflows/precompute-trails.yml`,
NOT a CF Worker — free Workers are CPU-capped ~10 ms, our A* is 0.1–2 s) runs
`scripts/precompute-trails.mjs`, which reuses the frontend's land-aware pipeline
(`frontend/app/trail_geometry.js`) under Node, finds where each of-interest vessel's
rendered curve would cross land, and stores the FEWEST inferred waypoints that keep
it off land. The Worker serves them unioned with live `positions` at `/track`
(`getInferredTrack` in `storage.ts`); the **browser loads NO coastline** — it
re-splines the union with the pure pipeline (`frontend/app/trail_spline.js`).

- **What's stored (D1 frugality):** only the inferred (A*-routed / repair) waypoints —
  never real fixes (those live in `positions`). Per land-crossing **segment** (a run
  of fakes bracketed by two real fixes), reduced by `simplifyForSpline` to the minimum
  control points whose spline still keeps the curve off land (`TRAIL_SIMPLIFY.tolKm`,
  ~3–12/segment). A real fix that itself sits on land is left as-is (trust the boat).
- **Converge, don't churn (determinism):** the precompute is built over RAW reals
  (`computeControlPoints(..., {denoise:false})`) so the stored fakes and the client's
  re-splined curve agree exactly and stay water-tight (`tests/trail-precompute.test.mjs`).
  A vessel is skipped — no A*, no D1 write — when EITHER its newest position hasn't
  advanced since last run (`precompute_state.last_pos_ts_seen`) OR its already-stored
  fakes still keep the curve off land (cheap spline + region-aware `isLand`, no A*).
  Only a new land-crossing triggers a localized recompute; only changed segments are
  written. `seg_hash` = bracketing real timestamps + length + `GENERATOR_VERSION`
  (a script constant — bump it / pass `--regenerate` to force a full rebuild).
- **Schema** (migration `006_inferred_positions.sql`): `inferred_positions(mmsi,
  seg_hash, seq, lat, lon, t, tier, dashed, generator_version)` (fakes carry an
  inherited `tier` so the client tier filter works, and `dashed` for solid/dashed
  styling), plus `inferred_segments` (processed marker, present even at 0 points →
  out-of-coverage segments never retried) and `precompute_state` (the heuristic).
- **Trigger:** the hourly global scan fires the workflow on completion (most new gaps
  appear then) via `workflow_dispatch` (`triggerPrecompute` in `index.ts`, needs the
  `GITHUB_DISPATCH_TOKEN` Worker secret — optional); the workflow's own hourly cron is
  the fallback. Shrinks the straight-bridge window (an un-routed gap renders straight
  until filled) to minutes.
- **Run manually:** `node scripts/precompute-trails.mjs [--local] [--dry-run]
  [--regenerate] [--limit N] [--mmsi N]` (same wrangler D1 backend as `db-*`).

### Expanding coverage (Portland river, Alaska, foreign ports, …)
1. Edit `BB` in **both** `build-coastline.mjs` and the Overpass bbox in step 1 (and `HOME`/`TIERS`
   if the fine zone should move). Overpass bbox order is `south,west,north,east`.
2. Larger regions return more data — raise the Overpass `timeout`, and `--max-old-space-size`.
3. Add a representative fixture per new regime in `tests/fixtures/` and re-run the test (a
   river/port has narrow channels — verify `routeWater`'s `cellKm` floor is fine enough; see
   `tests/README.md` §6). Validate assembly with known land/water points before trusting it
   (`closeOpenChains` orientation is set by `ccw`; flip if water reads as land — see
   `tests/README.md` §1).
4. Keep the simplify tiers honest: distant coarse coverage keeps the shipped file small; only the
   viewshed needs harbour-grade detail.
