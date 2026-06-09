# Architecture

## Data flow

```
aisstream.io WebSocket
        │
        ▼ (every 1 min, ≤45s drain — DIRECT zone)
CF Scheduled Worker runDirectScan
        │
        └─► D1: vessels (upsert, of_interest=1)
             D1: positions (insert, tier='direct', only if moved)

aisstream.io WebSocket
        │
        ▼ (every 5 min, ~90s drain — LOCAL zone, large vessels only)
CF Scheduled Worker runLocalScan
        │
        └─► D1: vessels (upsert, of_interest if in direct box)
             D1: positions (insert, tier='direct'|'local', only if moved)

aisstream.io WebSocket
        │
        ▼ (daily 06:00 UTC — GLOBAL zone, of-interest MMSIs only)
CF Scheduled Worker runGlobalScan
        │
        └─► D1: vessels (upsert, max_extent widened)
             D1: positions (insert, tier='global', only if moved)

Browser
  └─► GET /current (every 30s poll)
        │
        ▼
CF Worker fetch handler
  └─► D1 vessels WHERE of_interest=1 AND last_seen is inside tier TTL → return JSON
      Stale local vessels inside the global window are returned as distant/global rows.

Browser
  └─► GET /vessel/:mmsi/track?tier=direct,local (lazy trail fetch)
        │
        ▼
CF Worker fetch handler
  └─► D1 positions WHERE mmsi=? [AND tier IN (?)] ORDER BY ts DESC → return JSON
```

## Three-tier scan model

| Tier | Cron | Drain | Box | Filter | Position threshold |
|------|------|-------|-----|--------|--------------------|
| Direct | `* * * * *` | 45s | Apartment window view | None — everything | 0.05 nm (~90m) |
| Local | `*/5 * * * *` | 90s | All of Vancouver Island + Pacific | Large vessels (≥50m or cargo/tanker) OR already-of-interest | 0.5 nm |
| Global | `0 6 * * *` | 30s | Global | Of-interest MMSIs via FiltersShipMMSI | 5.0 nm |

## Event-based position storage

Position rows are *movement events*, not time samples. A new `positions` row is only inserted when the vessel has moved past the tier-specific threshold since its last stored point. Stationary/anchored vessels emit ~0 rows after their first. The `vessels` row denormalizes the current position for fast `/current` reads without JOIN.

A liveness heartbeat updates `last_seen` at most every 10 min for vessels present but not moving, so they don't drop off the live map.

## Of-interest definition

A vessel is `of_interest=1` once it has entered the DIRECT bounding box at least once. Only of-interest vessels are returned by `/current` and targeted by the global scan. Large local vessels that have not yet entered the direct view still get a `vessels` row (pre-entry approach track) but are not rendered.

The daily global scan queries of-interest MMSIs in batches and retries misses for several rounds. A missed global ping does not remove the vessel from global visibility; `/current` can still render its last known local/global position until the global TTL expires. Direct/local rows remain visible for 6h to tolerate missed short-interval scans.

## Why D1-only (no KV)

KV was used in M1 as a fast snapshot cache. D1 free tier limits are far higher (100k row writes/day, 5M reads/day, 5GB) and with denormalized current position on the `vessels` row, the `/current` query is a single indexed scan with no JOIN — comparable latency to KV at this scale.

## Free-tier constraints

- No Durable Objects (requires paid plan) → cron ingestion instead of persistent socket.
- CF Workers free tier: 100k requests/day, 10ms CPU/invocation, 15min wall-clock for scheduled triggers.
- D1 free tier: 100k row writes/day, 5M reads/day, 5GB storage. Estimated usage: ~10k–15k writes/day.

## Deployment

- Frontend: GitHub Pages, deployed verbatim from `frontend/` with no build step.
- Worker: `*.workers.dev`, deployed via `wrangler deploy`. D1 auto-created by `ensure-bindings.mjs` on each deploy; migrations applied in order.
