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
- On first push to main touching `worker/`, CI auto-creates the KV namespace + D1 database and applies all pending migrations. Nothing in the Cloudflare dashboard needs to be touched manually.

## Milestones

- **M1 (current):** Live map + vessel list, deployed. Sightings recorded from day one.
- **M2:** Viewshed calibration — restrict shown vessels to those actually visible from the window.
- **M3:** AR camera overlay — project vessel labels using device orientation.
- **M4:** ONNX boat detector — "where is the boat in this frame" → match to AIS contact.

## Cross-cutting conventions

- No bundler, no framework. CDN libs only (Leaflet, later OpenCV.js + onnxruntime-web).
- No auth ever. Any per-device prefs in `localStorage`.
- IDs (including MMSI) can be `0` — always use `!== null`, never falsy checks.
- No silent fallbacks (`?? 0`). Throw/surface bad data explicitly.
- View/template files: all logic at top, pure rendering at bottom.
- Comments only for non-obvious WHY, never for WHAT.
- Helpers only when used ≥2× (big) or ≥4× (small).

## Key reference docs

- `docs/ais-reference.md` — aisstream message shapes, AIS vessel-type codes, bounding box
- `docs/architecture.md` — data flow diagram, KV/D1 usage, cron model
- `docs/decisions.md` — architectural decisions (why cron not Durable Objects, etc.)
