# Worker — CLAUDE.md

Cloudflare Worker (TypeScript). Two handlers: `fetch` (HTTP API) and `scheduled` (cron ingestion).

## Cron model

Two cron schedules in `wrangler.toml [triggers]`, both handled in `scheduled` (branch on `event.cron`):

- `*/5 * * * *` — live ingest every 5 min: open WS to aisstream, drain ~40s, write KV snapshot + D1 upsert + ping rows. Ships move ~0.25 nm/min so 5-min resolution is indistinguishable on a map.
- `0 0 * * 1` — weekly enrichment (Monday midnight UTC): re-query all known MMSIs over a near-global bounding box to record where past visitors are now. Best-effort (vessel must be transmitting within aisstream coverage).

**Why cron not Durable Objects:** Durable Objects require the paid Workers plan. Scheduled Workers are free-tier and sufficient. See `docs/decisions.md`.

## File structure

```
src/
  index.ts       — exports fetch + scheduled handlers, routes only
  ingest.ts      — orchestration: calls aisstream, calls storage
  aisstream.ts   — promise-based AIS stream client (all WS wiring hidden here)
  ais.ts         — pure AIS message parsing + vessel-type code → category
  storage.ts     — KV snapshot read/write + D1 vessels/pings access
  cors.ts        — CORS headers (reads ALLOWED_ORIGIN from env)
  http.ts        — json() / errorJson() response helpers
  types.ts       — Env, Vessel, Snapshot, VesselRow, PingRow interfaces
  constants.ts   — bounding boxes, thresholds, drain windows, KV key
migrations/
  001_initial.sql — first migration (schema_migrations tracking table + core tables)
  NNN_*.sql       — add new files here; CI applies pending ones automatically
scripts/
  ensure-bindings.mjs — idempotent: creates KV + D1, patches wrangler.toml, applies migrations
```

## KV layout

- `snapshot:current` → `{ updated: <epoch_ms>, vessels: [...] }` — the live snapshot read by every page load.

## D1 schema (see migrations/001_initial.sql)

- `schema_migrations(id, applied_at)` — migration tracking, bootstrapped before any migration runs.
- `vessels(mmsi PK, name, vessel_type, first_seen, last_seen, times_seen, closest_nm, last_destination)`
- `vessel_pings(id AUTOINCREMENT, mmsi, lat, lon, ts, source)` — `source ∈ {live, enrichment}`

## Adding a migration

Drop a new `NNN_my_change.sql` file in `worker/migrations/` (e.g. `002_add_column.sql`). On next push to main touching `worker/**`, CI calls `ensure-bindings.mjs` which detects the pending migration and applies it before deploying.

## Bounding boxes

Defined in `src/constants.ts`:
- `LOCAL_BOUNDING_BOX` — Strait of Juan de Fuca + Haro Strait south/east of Victoria BC.
- `GLOBAL_BOUNDING_BOX` — near-global box paired with `FiltersShipMMSI` for enrichment. TODO: verify aisstream accepts `[-90/-180, 90/180]`; tighten to documented max if not.

## Secrets

- `AISSTREAM_API_KEY` — set via `wrangler secret put` in deploy workflow. Template in `.dev.vars.example`.

## HTTP API

- `GET /vessels` → fresh vessels from KV (drops entries older than 5 min)
- `GET /vessel/:mmsi` → D1 vessel row + recent pings
- `OPTIONS *` → CORS preflight

`ALLOWED_ORIGIN = "*"` while on github.io. Tighten to custom domain when it exists.
