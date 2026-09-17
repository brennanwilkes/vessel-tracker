# Session handoff — 2026-09-16

State of the world at the end of the far-transit/berth routing session, and the open
work (Panama Canal water gap) with enough context to restart cold. Companion to
`docs/known-issues.md` (defects), `docs/rca-far-vessel-trails.md` (the far-trail RCA).

---

## Where things stand

**Pushed and deployed (frontend Pages + harmless worker rebuild):** commit `d355d7f`
"feat: Improvements to trails". Three changes shipped together:

1. **`replayTrack`** (`frontend/app/trail_spline.js` + all 4 client-mirroring test
   files) — the maunawili root-cause fix. The server routes over `dedup(reals)` of
   RAW real fixes; the browser splines the merged real+fake stream. A fake
   interpolated between a real pair < `DEDUP_KM` apart made the naive union dedup
   keep BOTH reals, shifting Catmull-Rom tangents until the spline bulged into
   land. `replayTrack` dedups reals first, merges fakes, dedups the union. No-op
   when no fakes.
2. **Local-only berth sever** (`splitJourneys`) — sever only when parked
   (`speed ≤ MOVING_SPEED_KN`) AND gap > `TRAIL_GAP_SEVER_MS[tier]` AND BOTH
   bracketing real fixes are inside `LOCAL_BOUNDING_BOX` `{sw:[47.0,-128.7],
   ne:[51.2,-122.0]}`. Expected far transits (Victoria→Asia, Salish Sea→Atlantic,
   a far berth whose vessel resurfaced across an ocean) stay ONE journey and the
   A*-routed dashed bridge draws the gap; ambiguous Tacoma↔Victoria still severs.
3. **Berth-handling in `buildControlPoints`** (`nearestWaterBeyond`) — route
   land-locked berth endpoints by splicing to a di is used for the raw A* path.
4. `worker/scripts/precompute-trails.mjs`: `curveIsLandFree` now mirrors the
   browser via `replayTrack` (was naive `dedup` — server and client share one
   reconstruction), and `GENERATOR_VERSION` bumped **3 → 4**.

**Locally verified (all green before push):** `trail.test.mjs` (≈25 min; maunawili
stays `KNOWN` — 37 km overshoot / 3 kinks are pre-existing data-limited artifacts
at a wharf berth, not regressions), `trail-precompute.test.mjs` (all 12 fixtures,
maunawili 27→**0** land defects, maxPen 150 m), `ocean-trails`, `ocean-shape`,
`scenario`, `region-trails`, `regions`, `harbour-route`, `coarse-global` all PASS.

**NOT yet verified in prod — the FIRST TWO regenerate runs FAILED on the D1 write cap.**
Dispatches `35126182994` (2026-09-16 17:07Z, `regenerate=true`, no limit) and its retry
`35136907482` both died on `Cloudflare API error (400): … exceeded D1's free tier daily
row write limit` (100k rows/day, UTC day). Run-log evidence before the failure:
`1029 candidate(s) to examine of 1029 eligible` / `examined 25/1029 (routed 2650
segments so far)` — the fleet is ~1029 vessels (the old ~734 estimate was stale), and a
bare regenerate extrapolates to **~1–3M rows ≈ 10–30 full daily budgets**. A flat-out
regenerate keeps tripping the cap every day until the budget system below is deployed.
The 25 vessels' v4 segments flushed mid-run DID commit — `db-trails` should show a v4
rollover for exactly those. **Do not trust any prod trail verdict until a budgeted
regenerate has run fleet-wide and `db-trails` shows the v4 rollover.**

**Write-budget system (implemented this session) — how the v4 rebuild gets rationed:**
- **Shared daily ledger in `scan_meta`** (the D1 free-tier day = UTC). The Worker meters
  every real D1 `meta.rows_written` (all write paths in `storage.ts`: `commitScan`,
  `enrichStaticData`, `commitZoneVisits`, `setScanCursor`, AIS lock acquire/release) and
  flushes the day's total after each scheduled scan to `ingest_rows_written_<date>`
  (`flushIngestLedger`, wired via `.finally()` in `index.ts` so it runs on error paths
  too). `precompute-trails.mjs` reads the ledger at start, bumps `pc_rows_written_<date>`
  after every flush (so a killed run still accounts for itself), and stops — exiting 0
  with a `WRITE BUDGET STOP` log — when it hits its own `--write-budget` (default
  `PRECOMPUTE_DAILY_BUDGET` 50k rows/day) or the shared `ACCOUNT_SAFETY_CEILING` (90k),
  whichever comes first.
- **`--regenerate` now CONVERGES, not churns:** a fleet regenerate skips any vessel whose
  stored segments already carry `GENERATOR_VERSION` AND still keep the curve off land
  (`skipped_version` in the log). So a budgeted rebuild that stops at noon resumes on the
  next dispatch/day where it left off — upgraded vessels are never redone, and the budget
  is never re-burned on done work. `--mmsi` bypasses the skip (still a forced rebuild).
- The workflow gained a `budget` input (rows per run, default 50000). New v4-catch-up
  cadence: dispatch `regenerate=true`; the run self-limits; check spend via
  `worker/scripts/db-ledger` (`ingest_rows_written_today` + `pc_rows_written_today`);
  resume next UTC day. Manual `limit`/`offset` batching is no longer required (kept as
  fine control).

---

## Verification steps for the pushed fix

```bash
# 1. Regenerate must land (dispatch regenerate=true; the run self-limits on the
#    shared write ledger — repeat across UTC days until the fleet stops showing
#    `skipped_version` gaps):
gh run list --workflow precompute-trails.yml --limit 5            # aim: success; watch for WRITE BUDGET STOP
worker/scripts/db-ledger                                         # ingest + pc rows written so far today (out of 100k cap)
# 2. Proof is the GENERATOR_VERSION rollover in D1:
worker/scripts/db-trails --pretty     # expect generator_version rows for v4 growing each budgeted run
# 3. Spot-check the merged far trails — a previously-severed vessel should now be ONE
#    journey with an A*-routed dashed bridge (e.g. a Victoria→Asia / Salish Sea→Atlantic
#    / Oakland→Honolulu hull). Until v4 lands, expect the OLD severed rendering.
```

NOTE: in this session `db-*` scripts returned exit 217 with no output — the local
`npx wrangler` invocation inside them was blocked by the environment's permission
layer (not an auth problem as far as we saw). If that persists, run db-trails
from a shell with `2>/dev/null` removed to see the real error, or check the
GitHub Actions log for the run (`gh run view <id> --log`): `candidates=… / skipped_heuristic=…`.

---

## OPEN TASK (priority): the Panama Canal water gap

**Reported/root-caused:** every Salish Sea → EU / East-North-Atlantic leg that
crosses the isthmus renders one of two wrong ways: if the vessel parked at a canal
port, `splitJourneys` severs (correct); if it transited without stopping (speed >
0.5 kn throughout), the route straight-bridges **through Central America** because
NO water path Pacific↔Atlantic exists in any land layer.

Evidence (2026-09-16): the isthmus is closed in every layer. `coast_coarse.js`
(`COARSE_LAND_POLYGONS`, Natural Earth 1:50M, whole world) has a contiguous
land band ~8.5–9.6°N with **zero open meridians** from -80.2 to -79.5; the fine
OSM corridor stops at 32°N so no fine coverage south of it; the only region near
here is `panama-pacific` (`frontend/app/coast/panama-pacific.js`), which is
**water-only** and only re-opens the *Pacific-side* approach (its bbox is
`[[8.65,-79.8],[9.18,-79.25]]`). No Atlantic-side / Cristobal region exists.

**The fix (data, not router):** carve the canal as a WATER channel through the coarse
land, exactly like Columbia / upper-Fraser / SF Bay. `pointOnLand = inLand && !inWater`
already subtracts water from ANY land layer, so a region carrying the canal trace will
re-open the cut the coarse 5 km landmass closes.

Concrete steps (in order):

1. **Add `waterway=canal` to the generic water query** in
   `worker/scripts/build-all-regions.mjs` `waterQuery` (currently only fetches
   `natural=water` + `waterway=riverbank`, way+relation). The canal channel is
   tagged `waterway=canal`; Gatun Lake is `natural=water`; together they form a
   connected Pacific→Caribbean path. Cheap addition — no effect on regions with
   no canals.
2. **Add a `panama-canal` CORRIDOR** entry in `build-all-regions.mjs` `CORRIDORS`:
   `{ id: 'panama-canal', bbox: {minLat: 8.6, minLon: -80.2, maxLat: 9.6, maxLon: -79.0} }`
   (covers Balboa → Gatun Lake → Cristobal with margin). `build-region.mjs` already
   emits water with `WATER_SIMPLIFY_KM` ~50 m and `WATER_DROP_SPAN_KM` 1 km — tune
   the drop if Gatun Lake / short channel segments are pruned as "ponds". Consider
   whether the canal needs fine LAND too (it doesn't need islands; water-only is
   right, matching the principle "coarse land + region water is correct").
3. **Build + validate:**
   ```bash
   cd worker
   node scripts/build-all-regions.mjs --only=panama-canal   # fetches OSM, writes frontend/app/coast/panama-canal.js, updates manifest
   node ../tests/region-trails.test.mjs                     # existing suite must stay green
   ```
   Then a probe: `routeWater` Balboa→Cristobal must succeed and stay water-tight.
4. **Add a trans-canal fixture + regression** under `tests/fixtures/` (e.g. a
   multi-day leg with a far-locked gap spanning the isthmus) so `trail-precompute`
   can't silently go back to straight-bridging.
5. **Bump `GENERATOR_VERSION` → 5** and dispatch `--regenerate` — the budget system
   self-limits it (no manual offset math); repeat across UTC days until `db-trails`
   shows v5 fleet-wide.

**Caveats / things to verify while doing this:**
- Verify the region build doesn't drop the canal to `WATER_DROP_SPAN_KM` (a ~180 m
  channel × 80 km trace — the drop is COUNT-of-polygons, not length, but a lake-only
  result would be a red flag).
- Resolution policy says simplify tol ≤ ⅓ × narrowest channel and `routeWater`
  `cellKm` ≤ ½ × that — the canal is ~180–300 m, so keep water ~50 m and rely on the
  existing 0.2 km `cellKm` floor (same regime as the Columbia at ~1 km; a 0.2 km cell
  is fine for 180 m threads? measure).
- `routeWholeOceanGap` irrevocably ties a whole-ocean gap to a coarse `cellKm` ≥ 2 km
  — the canal CANNOT resolve there; it must succeed at the bi-segmented per-span
  level (`routeOceanGap` → A* on the land-crossing span only). Once the region is
  loaded by `ensureRegionsForExtent`, `hasFineLand` inside the region bbox flips true
  and the span gets the fine default instead of coarse.
- Do NOT touch the router for this: carving the water is the whole fix. Canal
  transits (parked) remain severed by design.
- `docs/ocean-routing-study.md` and `tests/README.md` §11: after ANY spine/route
  change diff per-gap waypoint counts against a HEAD baseline; treat "defect whose
  nearest control is a real fix km away" as MISSING routing.

---

## Open tasks (carried / known)

### #14 — Long-gap trails render a HOLE instead of a dashed bridge
Deferred by explicit decision (full write-up `docs/known-issues.md` §1). Do not
re-derive; the likely real fix is a server→client break marker.

### #19 — North-coast BC trails (GSL ALEXANDRA, MANZANILLO BRIDGE)
Measured as ZERO land defects with correct land data; it is a journey sever at the
Prince Rupert berth (instance of #14). Read `docs/known-issues.md` §4 before
touching — it documents a wrong turn worth not repeating.

---

## Operational notes / traps

**Regenerate under the write budget** (supersedes the old limit/offset batching traps):
- A bare `--regenerate` used to be dangerous two ways: it bypassed the freshness
  heuristic (so `eligible` was the full list every run) AND it was only bounded by the
  300-min GitHub job cap. Both are gone — the run now stops on the shared daily write
  ledger (`pc_rows_written_<date>` vs `--write-budget`, or `ingest+pc` vs the 90k
  ceiling) before it can trip the 100k account cap. `limit`/`offset` remain as fine
  control but are no longer required to batch.
- The matching trap the budget system removes: `--regenerate` re-doing the same first-N
  each run. Version-converge (`skipped_version`) means resumed runs skip upgraded
  vessels, so a multi-day rebuild advances day over day. Confirm with `db-trails`
  (generator_version rollover is the proof, never the driver's log).
- A run whose budget was already spent that day exits fast with a `WRITE BUDGET STOP`
  at `examined=0` — that is the guard working, not a crash. Wait for a UTC-day rollover
  (budgets reset at 00:00 UTC) before dispatching again.
- Concurrency `cancel-in-progress: false`: a batch is only evictable while PENDING —
  wait for an idle group, dispatch; once `in_progress` it's safe. The Worker's own
  dispatch is keyed to `event.scheduledTime` every 6 h (lands ~:59 on hours divisible
  by 6), NOT hourly-`Date.now()`. Don't fight it — a batch parked in PENDING during a
  dispatch gets evicted.
- Budget bookkeeping is exactly as accurate as the ledger: the Worker bumps its key
  once per scan (a scan that dies between a write and its `.finally()` flush undercounts
  for the day — the 10k ceiling margin absorbs it), and the precompute bumps after every
  flush.

**Bumping `GENERATOR_VERSION`** invalidates every stored segment via `seg_hash`, but
existing rows are only rebuilt with `--regenerate`; ordinary cron runs skip vessels
with unchanged `last_pos_ts`. Version bump without a regenerate = stale geometry in
prod indefinitely.

**Cloudflare:** this project is `brennan@codexwilkes.com` / `a53d0d3cb40662b52e001ffd082d2f1f`
ONLY. Never change auth — if `whoami` shows another account or you hit
`Authentication error [code: 10000]`, stop and ask Brennan. (This session: no auth
changes were made; db-* blocked at the permission layer, not auth.)

**Git/CI:** single engineer, no PR gate. Push to `main` auto-deploys Pages on
`frontend/**` and Worker (deploy-worker) on `worker/**` — a worker REBUILD fires
even for scripts-only changes; harmless (no worker code changed in d355d7f).
Secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `AISSTREAM_API_KEY` already
set; nothing to touch in the dashboard manually.

**Date:** this handoff supersedes the 2026-08-07 one (all its task numbers are
either DONE, carried above, or documented in known-issues).