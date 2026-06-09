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
