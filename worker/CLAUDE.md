# Worker — CLAUDE.md

Cloudflare Worker (TypeScript). Two handlers: `fetch` (HTTP API) and `scheduled` (cron ingestion).

## Cron model

Three cron schedules in `wrangler.toml [triggers]`, all handled in `scheduled` (branch on `event.cron`):

- `* * * * *` — direct scan every 1 min: drain DIRECT box (apartment view, ≤45s), write every vessel as of_interest=1.
- `*/5 * * * *` — local scan every 5 min: drain LOCAL box (~90s), write only large vessels (≥50m / cargo / tanker) or already-of-interest vessels.
- `0 6 * * *` — global scan once/day: drain global box filtered to of-interest MMSIs (~30s), widen max_extent.

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
```

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

- `DIRECT_BOUNDING_BOX` — apartment window view: `[[48.0,-123.9],[48.54,-123.10]]`
- `LOCAL_BOUNDING_BOX` — Vancouver Island + waterways: `[[47.8,-128.7],[51.2,-122.5]]`
- `GLOBAL_BOUNDING_BOX` — near-global, paired with FiltersShipMMSI for daily scan

## HTTP API

- `GET /current` → of-interest vessels heard within last 90 min (snake_case fields from D1)
- `GET /vessel/:mmsi/track?tier=direct,local` → movement event positions, `Cache-Control: public, max-age=60`
- `OPTIONS *` → CORS preflight

## Secrets

- `AISSTREAM_API_KEY` — set via `wrangler secret put` in deploy workflow. Template in `.dev.vars.example`.
