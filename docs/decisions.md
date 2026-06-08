# Architectural Decisions

## Cron ingestion, not persistent socket

aisstream.io is WebSocket-only. CF Workers are request-scoped and can't hold a socket between requests. Durable Objects can (via WebSocket hibernation) but require the paid plan. Scheduled Workers drain a WebSocket for ~40 seconds per run, which fits entirely within the free-tier wall-clock limit (15 min) and CPU budget (the drain is ~95% I/O wait).

## Every 5 minutes, not every 1 minute

Ships move ~0.25 nm/minute at 15 kn. 5-minute resolution is visually indistinguishable on a map and cuts invocations from 60/hr to 12/hr.

## Weekly enrichment, not daily

The enrichment cron re-queries known MMSIs globally to record where past visitors went. Weekly cadence is sufficient — a ship's position on Sunday vs Monday provides the "where did it go" story without burning extra invocations.

## KV for live snapshot, D1 for history

The live snapshot is one key read on every page load. KV is optimal for this. Historical sightings and pings need relational queries by MMSI and time, so D1 (SQLite).

## Numbered migrations over single schema.sql

Adding columns or tables in a running system requires tracked, ordered migrations. A single `schema.sql` can't be re-applied to a live database. `migrations/NNN_*.sql` + `schema_migrations` tracking table + auto-apply in CI (via `ensure-bindings.mjs`) means: add a file, push, done.

## No bundler

Matches the owner's existing pattern (`~/spirit-tracker`). Leaflet, OpenCV.js, and onnxruntime-web all ship CDN builds. Avoiding a bundler keeps the deployment trivial (GitHub Pages serves `frontend/` verbatim) and eliminates an entire class of build failures.

## GitHub Pages + workers.dev CORS with ALLOWED_ORIGIN = "*"

Until a custom domain exists, the frontend is on `*.github.io` and the worker is on `*.workers.dev`. CORS is permissive (`*`) for now. When a custom domain is added to the frontend, tighten `ALLOWED_ORIGIN` in `wrangler.toml` to that domain and redeploy.

## M4 is a detector, not a classifier

The vision model's only job is "where is the boat in this frame" (bounding box). Identity always comes from AIS cross-referencing bearing. Vessel-specific visual recognition would require a large labelled dataset per vessel class; a generic detector needs only "boat vs background" labels which are easy to collect.
