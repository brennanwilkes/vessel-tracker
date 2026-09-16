# Session handoff — 2026-08-07

State of the world at the end of the ocean-routing session, and the open work with
enough context to restart cold. Companion to `docs/known-issues.md` (defects) and
`docs/ocean-routing-study.md` (the measurement behind the ocean spine).

---

## Where things stand

**Shipped and verified this session** (commit `b56eb68`, worker + frontend deployed):

- `OCEAN_ROUTE.maxLatDeg` 50°N — composite great-circle cap (`geo.compositeGreatCirclePoints`)
- `OCEAN_ROUTE.blendHoldKm`/`blendKm` — course blend onto the vessel's real COG (`geo.blendCourse`)
- `OCEAN_ROUTE.shapeMinKm` 3000 — scopes both to genuine crossings (see the regression below)
- `tests/ocean-shape.test.mjs` — 14 pure-geometry assertions, runs in ms
- `tests/audit-prod.mjs` — audits LIVE trails for land crossings (new, see below)
- Full trail regenerate to `GENERATOR_VERSION = 3`

**All 11 test suites green.** `ocean-shape, coverage, compress, regions, coarse-global,
harbour-route, trail, trail-precompute, ocean-trails, region-trails, scenario`.

**Production data:** every vessel regenerated to v3 — **678 vessels, 96,262 waypoints,
`unroutable = 0`**, zero v1/v2 rows left. Ran 01:01→12:49 UTC (~11.8 h) in 5 batches
of 150 via `scratchpad/regen-driver2.sh`.

**Confirmed working in prod:** COSCO SANTOS (477319300) was the reference defect —
its inferred track ran the Aleutians at **57.7°N**; after v3 it peaks at exactly
**50.00°N**. MIRACULOUS ACE likewise dropped 54.0°N → 50.00°N.

**Ingestion is DOWN and was down all session** — aisstream service-wide outage since
2026-08-05 13:31 UTC; newest fix ~37 h stale at last check. The Worker, crons, D1 and
API are all healthy. Nothing to fix on our side; it just needs watching (task #10).
Useful side effect: no new data meant the long regenerate could run uncontended.

---

## Open tasks

### #9 — Verify prod trails (land-crossing audit)
Globe-wrap half is DONE (zero stored lons outside ±180, zero unwrapped spans >360°
across all vessels — the COSCO SANTOS marker fix is live).

Remaining: sweep every vessel with the new tool and triage what surfaces.

```
node tests/audit-prod.mjs --all --top 30      # worst offenders
node tests/audit-prod.mjs 636023060           # one vessel, with span detail
```

Read `awayFromReal` (genuine defects) not the raw count; `fine` vs `coarse` says
whether the router had good data where it crossed. **Read the header comment in that
file before trusting any number** — it encodes the trap described in §4 below.

### #10 — Watch for aisstream recovery
Purely a watch. `worker/scripts/db-diagnose`, or freshness straight off the API:
```
curl -s https://vessel-tracker-api.brennan-a53.workers.dev/current | python3 -c \
 "import sys,json,time;v=json.load(sys.stdin)['vessels'];print(round((time.time()*1000-max(x['last_seen'] for x in v))/3600000,1),'h')"
```

### #14 — Long-gap trails render a HOLE instead of a dashed bridge
**Deferred by explicit decision.** Two fixes were implemented, measured *worse* than
baseline, and reverted. Full write-up with the numbers: `docs/known-issues.md` §1.
The likely real fix is a server→client break marker, not another sever heuristic.

### #19 — North-coast BC trails (GSL ALEXANDRA, MANZANILLO BRIDGE)
Reported as "cutting over much of BC"; **measured as zero land defects** with correct
land data. It is a journey sever at the Prince Rupert berth, i.e. another instance of
#14, not a routing bug. `docs/known-issues.md` §4 — read it before touching this, it
documents a wrong turn worth not repeating. Next step is visual confirmation of what
is actually on screen, not code.

---

## Two mistakes from this session worth not repeating

Both cost hours, and both were caught only by measuring.

**1. Measure against a clean `HEAD` baseline, not against expectations.**
Half an afternoon went into "fixing" harbour defects on the maunawili fixture that a
`git worktree add /tmp/baseline HEAD` comparison showed I had *caused* — HEAD had 1
defect cluster, my tree had 3. Later, the same technique correctly proved the
`shapeMinKm` regression was real when I had argued from first principles that it
could not be. `tests/README.md` §8.

**2. A test harness's land data is NOT production's land data.**
`tests/lib.mjs` loads only the home-bbox coastline plus the ~2 km coarse layer;
`region_coast` regions load **lazily** and answer "coarse" until
`ensureRegionsForExtent` is called. Auditing north-coast BC with it produced 36 land
defects at 3 km penetration and a confident, wrong root cause ("no fine coverage above
54°N"). With regions loaded: **zero defects**, coverage fine. `tests/audit-prod.mjs`
now loads regions itself; any new probe must too.

The generalised lesson: when a measurement supports a dramatic conclusion, verify the
*instrument* before acting on it.

---

## Operational notes

**Driving a batched `--regenerate`.** Full detail in `worker/CLAUDE.md`. The traps:

- The Worker dispatches precompute on **global-scan completion, every ~20–40 min** —
  not hourly, and not at `:59`. Measured 2026-08-06: 20:25, 20:58, 21:17, 21:43.
- GitHub keeps ONE pending run per concurrency group, so a batch dispatched into a
  busy group is evicted by the next dispatch. It shows as run conclusion `failure`
  with **job** conclusion `cancelled` and no failed steps — that signature means
  eviction, not a code failure.
- `cancel-in-progress: false` means a run is only vulnerable **while pending**. So
  wait for an idle group, then dispatch; once `in_progress` it is safe.
- Record the newest run id BEFORE dispatching and wait for a *different* id, or the
  driver latches onto the Worker's run and reports its result as the batch's.
- Confirm a batch landed with `worker/scripts/db-trails` — the `generator_version`
  rollover is the proof, never the driver's own log.

Pace, measured: **~1.5 min/vessel**, ~3.7 h per 150-vessel batch, ~12 h for the fleet.
Batches of 150 are sized to fit the 6 h GitHub job cap. Resumable —
`regen-driver2.sh <offset>`, where offset is the v3 vessel count rounded down to a
batch boundary.

**Bumping `GENERATOR_VERSION`** (in `worker/scripts/precompute-trails.mjs`) invalidates
every stored segment via `seg_hash`, but existing rows are only rebuilt with
`--regenerate`; ordinary cron runs skip them. So a version bump without a regenerate
leaves stale geometry in prod indefinitely.

**Cloudflare:** this project is `brennan@codexwilkes.com` / `a53d0d3cb40662b52e001ffd082d2f1f`
ONLY. Never change auth — if `whoami` shows another account or you hit
`Authentication error [code: 10000]`, stop and ask Brennan.

---

## Scratch tooling that was NOT kept

Session-local under `/tmp/.../scratchpad/`, gone with the session. Rebuild only if
needed; the durable replacement is `tests/audit-prod.mjs`.

| script | what it did | still needed? |
|---|---|---|
| `diag-prod-vessel.mjs` | per-vessel prod land audit | **promoted** to `tests/audit-prod.mjs` |
| `diag-segcmp2.mjs` | time-ordered segment dump per repo root, with real anchors + gap km; `diff -y` two roots | rebuild if a spine change needs per-gap comparison — this is what found the `shapeMinKm` regression |
| `diag-gap-repro.mjs` | route one gap in isolation, print which path it takes and whether A\* succeeds | useful, ~30 lines |
| `regen-driver2.sh` | batched regenerate driver | re-derive from the operational notes above |
| `sever-dwell-attempt.patch` | the reverted #14 work | described in `known-issues.md` §1 |
| `baseline/` | `git worktree` at HEAD for A/B measurement | one command: `git worktree add /tmp/baseline HEAD` |
