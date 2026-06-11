# Worker — CLAUDE.md

Cloudflare Worker (TypeScript). Two handlers: `fetch` (HTTP API) and `scheduled` (cron ingestion).

## Cron model

Three cron schedules in `wrangler.toml [triggers]`, all handled in `scheduled` (branch on `event.cron`):

- `* * * * *` — direct scan every 1 min: drain DIRECT box (apartment view, ≤45s), write every vessel as of_interest=1.
- `*/5 * * * *` — local scan every 5 min: drain LOCAL box (~90s), write only large vessels (≥50m / cargo / tanker) or already-of-interest vessels.
- `0 * * * *` — global scan hourly: drain global box filtered to of-interest MMSIs in retrying batches, with stale vessels prioritized first, widen max_extent.

**Why cron not Durable Objects:** Durable Objects require the paid Workers plan. Scheduled Workers are free-tier and sufficient. See `docs/decisions.md`.

## File structure

```
src/
  index.ts       — exports fetch + scheduled handlers, routes only
  ingest.ts      — three scan functions: runDirectScan, runLocalScan, runGlobalScan
  aisstream.ts   — promise-based AIS stream client (all WS wiring hidden here)
  ais.ts         — pure AIS parsing + vessel-type codes + pointInBox + isLargeVessel
  storage.ts     — D1-only: loadVesselStates, commitScan, getCurrentVessels, getTrack
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
  db-raw <sql>        — run arbitrary SQL (read-only guard; --write to bypass)
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

## Event-based position storage

A `positions` row is only inserted when the vessel has moved past the tier-specific threshold:
- direct: 0.05 nm (~90m)
- local: 0.5 nm
- global: 5.0 nm

Stationary vessels update `last_seen` heartbeat every ≥10 min but emit no position row.

## Adding a migration

Drop a new `NNN_my_change.sql` file in `worker/migrations/`. On next push to main touching `worker/**`, CI calls `ensure-bindings.mjs` which detects the pending migration and applies it before deploying.

## Bounding boxes (in constants.ts)

- `DIRECT_BOUNDING_BOX` — apartment window view: `[[48.070,-123.70],[48.524,-123.02]]`
- `LOCAL_BOUNDING_BOX` — Vancouver Island + waterways + Puget Sound to Seattle: `[[47.4,-128.7],[51.2,-122.0]]`
- `GLOBAL_BOUNDING_BOX` — near-global, paired with FiltersShipMMSI for daily scan

## HTTP API

- `GET /current` → of-interest vessels within tier TTLs: direct/local 6h, global 72h. `max_extent` reflects the strongest extent actually observed in D1.
- `GET /vessel/:mmsi/track?tier=direct,local` → movement event positions, `Cache-Control: public, max-age=60`
- `OPTIONS *` → CORS preflight

## Secrets

- `AISSTREAM_API_KEY` — set via `wrangler secret put` in deploy workflow. Template in `.dev.vars.example`.

## Coastline data generation (`frontend/app/coastline.js`)

The frontend's land-avoidance router needs land polygons. `coastline.js` is generated from
**OpenStreetMap `natural=coastline`** (high-resolution: resolves harbours, breakwaters, narrow
passes like Deception Pass, and every Gulf Island). NOT Natural Earth — its "10m" is 1:10,000,000
*scale* (coarsest tier), which drops sub-km features and was the cause of routes cutting unmapped
islands. OSM coastline ways are sub-100 m.

### Pipeline
- `scripts/lib-osm-coastline.mjs` — `stitchCoastline` (joins directed coastline ways into chains by
  shared node id; a join pass merges fragments) and `closeOpenChains` (clips chains to the bbox and
  closes mainland masses along the boundary keeping land-on-left, `ccw=true`).
- `scripts/build-coastline.mjs` — fetches nothing itself; reads an Overpass dump, assembles, then
  **distance-weighted Douglas-Peucker**: fine (~25 m) within ~60 km of the viewshed, ~120 m to
  160 km, ~600 m beyond — and drops tiny islands by the same tiers. Emits `[lat,lon]` polygons.

### Regenerate (run from `worker/`)
```bash
# 1. Fetch OSM coastline for the region (bbox = south,west,north,east):
curl -sS -H "User-Agent: vessel-tracker/1.0" \
  "https://overpass-api.de/api/interpreter" \
  --data-urlencode 'data=[out:json][timeout:170];(way["natural"="coastline"](46.9,-128.8,51.3,-121.9););out body geom;' \
  -o /tmp/osm_coast.json
# 2. Assemble + simplify + emit frontend/app/coastline.js:
node --max-old-space-size=2048 scripts/build-coastline.mjs /tmp/osm_coast.json
# 3. Validate routing against the new data:
node ../tests/trail.test.mjs
```
The build prints polygon/vertex counts and final KB. Current region ≈ 500 KB (gzips small).

### Rivers & harbours OSM tags (important)
`natural=coastline` follows the sea coast up to a river's tidal limit, then OSM
switches to `natural=water` / `waterway=riverbank` polygons. So the **lower**
Fraser is in our coastline source (just simplified — fixed via `FINE_ZONES`),
but the **upper** Fraser (New Westminster) has **zero** coastline nodes — it's
water polygons. To route rivers/harbours fully (Fraser, Portland), add a
**second layer**: fetch `natural=water`+`waterway=riverbank` for the fine zones,
assemble (these are already closed polygons/multipolygons — no boundary-closing
needed), ship as `WATER_POLYGONS`, and make `pointOnLand = inLand && !inWater`
in `geo.js`. Until then such upper-river transits degrade gracefully (the real
track is drawn through the missing-river "land" — see frontend trust-the-boat).

### Planned (DEFERRED until the coastline dataset is stable): server-side inferred-positions precompute
**Do NOT build this yet.** Precomputed inferred points are derived from the
coastline; while we're still expanding the dataset (water layer, more fine zones),
every dataset change would invalidate and churn the stored points. The client Web
Worker (`trail_worker.js`) handles the load cost acceptably for now. Build this
once the coastline is stable — `generator_version` (below) then handles the rarer
intentional regenerations. Worst-first client ordering (`gapEnrichmentScore`)
already makes the most-wrong trails self-correct first in the meantime.

When we do build it — to get the client A* off the main thread entirely — precompute
the inferred waypoints **off the client** and serve them as data. Design notes:
- **Run in a GitHub Actions cron, NOT a CF Worker** — free Workers are CPU-capped
  (~10 ms); our A* is 0.1–2 s. The Action runs Node and **reuses the geometry
  pipeline module** (extract it from `map_page.js` first), reads recent trails,
  writes results to D1.
- **D1 write frugality (hard requirement — free tier write cap):** only store
  points where geometry matters — i.e. only the **land-crossing gaps** that
  `routeWater` actually routes (open-water/straight gaps get nothing; the client
  draws them straight). Store only the **sparse string-pulled waypoints** (~3–12
  per gap), not the dense spline. **Write-once + dedup:** key each gap's points
  by a content hash of its real endpoints + a `generator_version`; the hourly
  cron writes only new/changed gaps and skips unchanged ones, so it does not
  re-write hundreds of rows every run as coverage grows. Bump `generator_version`
  to force regeneration after a routing bug; provide a clear/regenerate script.
- Schema: `inferred_positions(mmsi, lat, lon, t, gap_hash, generator_version)`,
  returned unioned with real points (flagged `fake=1` → client dashes them).
- Keep the client straight-bridge fallback for gaps the cron hasn't reached yet.

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
