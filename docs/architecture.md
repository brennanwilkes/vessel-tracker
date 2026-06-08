# Architecture

## Data flow

```
aisstream.io WebSocket
        │
        ▼ (every 5 min, ~40s drain)
CF Scheduled Worker (ingest.ts)
        │
        ├─► KV: snapshot:current  ← read by every GET /vessels
        └─► D1: vessels (upsert)
             D1: vessel_pings (insert, source='live')

CF Scheduled Worker (weekly enrichment)
        │ reads known MMSIs from D1 vessels
        ▼
aisstream.io WebSocket (global bounding box + FiltersShipMMSI)
        │
        └─► D1: vessel_pings (insert, source='enrichment')

Browser
  └─► GET /vessels (every 30s poll)
        │
        ▼
CF Worker fetch handler
  └─► KV snapshot:current → filter stale → return JSON

Browser
  └─► GET /vessel/:mmsi
        │
        ▼
CF Worker fetch handler
  └─► D1 vessels row + recent vessel_pings → return JSON
```

## Why KV for the live snapshot

KV reads are fast and free at scale. Every page load reads the same single key (`snapshot:current`). D1 would work but adds unnecessary SQL overhead on the hot read path.

## Why D1 for history

Vessel sightings and pings need relational queries (by MMSI, by time range). KV has no query capability.

## Free-tier constraints

- No Durable Objects (requires paid plan) → cron ingestion instead of persistent socket.
- CF Workers free tier: 100k requests/day, 10ms CPU/invocation, 15min wall-clock for scheduled triggers. Our cron uses ~40s wall-clock (mostly I/O) and well under 10ms CPU.
- aisstream.io free tier: WebSocket only, no REST.

## Deployment

- Frontend: GitHub Pages, deployed verbatim from `frontend/` with no build step.
- Worker: `*.workers.dev`, deployed via `wrangler deploy`. Bindings (KV + D1) auto-created by `ensure-bindings.mjs` on each deploy; migrations applied in order.
