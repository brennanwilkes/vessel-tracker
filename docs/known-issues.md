# Known issues

Open defects with everything already learned about them, so a future session
starts from the evidence rather than re-deriving it.

---

## 1. Long-gap trails render a HOLE instead of a dashed inferred bridge

**Status:** open, deferred. Two fixes implemented, measured WORSE, reverted.

**Symptom (from prod).** A vessel's trail simply stops and resumes elsewhere, with
nothing drawn across the gap — no solid line, no dashed inferred run. Reported on:

| vessel | MMSI | what happens |
|---|---|---|
| MOUNT ASO | 563303100 | breaks into 5 journeys across 264 / 700 / 2108 km gaps |
| MIRACULOUS ACE | 431082000 | breaks across a 3,530 km gap |

**Mechanism.** `splitJourneys` (`frontend/app/trail_spline.js`) starts a new
journey — and a new spline — whenever a long gap follows a fix reporting
`speed ≤ MOVING_SPEED_KN`. Separate journeys are separate curves, so nothing
bridges between them. That is correct for a vessel that genuinely parked and
correct-looking for one that didn't: **the AIS speed field is the LAST REPORTED
value**, which is ~0 for a ship that was merely slowing, riding at anchor, or
whose final fix before signal loss was stale. A vessel reporting 0.3 kn that
resurfaces 2,108 km away plainly sailed the gap, and that is exactly where the
dashed inferred bridge belongs.

### What was tried, and the numbers

Both attempts made severing *stricter*, on the theory that a stop is more than a
speed reading. Measured on the `maunawili` fixture (Oakland ↔ Honolulu, many
berth calls) by counting client-reconstruction spline samples that land on land:

| sever rule | land-defect clusters | worst penetration |
|---|---|---|
| `speed` only — **current, shipped** | **1** | 0.15 km (the documented berth residual) |
| `speed` + displacement across gap ≤ 50 km | 3 | **5.0 km** inland |
| `speed` + dwell ≥ 30 min within 1 km before gap | 3 | **5.0 km** inland |

Both are strictly worse than the rule they replace. Reverted in full; the diff is
kept at `scratchpad/sever-dwell-attempt.patch` (session-local, regenerate from
this doc if gone).

### Why both failed — the part worth keeping

The two failure modes are in **direct tension**, and no test applied to the last
fix before the gap can separate them:

- Loosen severing → false severs return (the MOUNT ASO holes).
- Tighten severing → **real berth stops stop severing**, and an un-severed berth
  is far worse than a hole. A moored vessel reports from alongside the wharf,
  which is land at 25 m coastline resolution, so the curve then runs from an
  on-land fix straight across the San Francisco peninsula to Honolulu — a 22–54 km
  chord with 25–45 % of its length over land.

Two facts defeat the obvious discriminators:

1. **Displacement can't work.** A real berth stop is *also* followed by a long
   voyage. Oakland → Honolulu is 3,865 km whether the vessel parked or not.
2. **Dwell can't work reliably.** Positions are stored as **movement events**, not
   periodic samples, so a genuinely parked vessel may emit only one or two fixes
   across an entire port call. Sustained-stationary evidence often does not exist
   in the data even when the stop was real.

### Where a real fix probably lives

Both need a signal the trail pipeline does not currently have:

- **Server → client break marker.** The precompute already decides that some gaps
  cannot or should not be bridged, but that decision **dies on the server**. The
  client sees two real fixes with no inferred waypoints between them, which is
  indistinguishable from "the cron hasn't routed this yet." Carrying an explicit
  break to the client (a `dashed = 2` sentinel row in `inferred_positions` needs no
  migration and rides the existing `/track` transport; a dedicated
  `inferred_breaks` table is cleaner) lets the server own the decision and the
  client honour it. This closes a genuine architectural gap regardless of which
  sever heuristic sits behind it.
- **Port-polygon dwell from the Worker.** Have ingestion accumulate time-inside-a-port
  on the vessel row, and sever on that instead of inferring a stop from trail
  geometry. Cleaner signal, but needs port polygons and only helps data collected
  after it ships — it cannot repair existing history.

### Rules for the next attempt

- **Measure against BOTH fixture families.** Every attempt so far passed the trails
  it was written for (`mount-aso`) and was never run against the ones it broke
  (`maunawili`). This is the trap `tests/README.md` §8 exists to warn about, and it
  was walked into twice in one session.
- Compare against a clean `HEAD` checkout (`git worktree add`), not against
  expectations. Both regressions were invisible until a baseline was measured — the
  defect counts *looked* like pre-existing berth noise.
- `node tests/trail-precompute.test.mjs` and `tests/README.md` §10 carry the short
  version of this.

---

## 2. Berth endpoints fall on land (`KNOWN_DATA_LIMITED`: maunawili)

**Status:** accepted limitation, documented in `frontend/CLAUDE.md`.

A vessel berthed at a container terminal reports from alongside the wharf, and a
wharf is land at 25 m coastline resolution. maunawili's moored fixes at
`37.7935, −122.2982` sit inside the mainland polygon with water resuming 165 m
south, so **no water route to that endpoint exists**: `routeWater`'s `snapToWater`
lands the goal in a channel that may be the wrong side of a pier. Residual: ~1
land-defect cluster at 0.15 km penetration.

Ruled out by testing: it is *not* coastline resolution (a 25 m SF Bay `FINE_ZONE`
did not help) and *not* a reversal inside a routed path (zero >100° turns within
any A\* output). A real fix needs land-locked endpoint handling — terminate the
route at the nearest water point and run the final leg straight to the berth.

---

## 3. Canal transits (Panama, Suez) cannot be routed

**Status:** accepted, by construction.

The isthmus is closed in every land layer (verified: zero open meridians across
7–10.5°N), so no Pacific↔Atlantic water path exists short of Cape Horn. In
practice these legs are long port stops, so `splitJourneys` severs and nothing is
drawn — the correct outcome. A canal transit by a vessel that never stops would
still bridge straight across Central America. Fixing it properly means carving
canal channels into the land data, not changing the router.

---

## 4. North-coast BC trails (Prince Rupert): reported as land-crossing, measured as HOLES

**Status:** open. Reported visually; **not reproducible as a land crossing** with
production land data. Almost certainly another instance of §1.

**Reported (prod UI, after the full v3 regenerate — so not stale data):**

| vessel | MMSI | dest | user report |
|---|---|---|---|
| GSL ALEXANDRA | 636023060 | CAVAN | "cutting over much of BC" |
| MANZANILLO BRIDGE | 636023028 | CAPRT | same shape of defect |

### What is actually true — and the tooling trap that hid it

A first audit reported **36 and 33 land defects at up to 3 km penetration, 100 %
on the coarse layer**, which looked like conclusive proof of a fine-coverage hole
north of 54°N. That conclusion was **wrong**, and the reason matters:

> `tests/lib.mjs` loads ONLY the home-bbox `coastline.js` (to 51.2°N) plus the ~2 km
> coarse layer. It does **not** load the lazily-fetched regional fine coastlines
> (`bc-central-*`, foreign zones) that the precompute and the browser actually use.
> Audited with it, every north-coast point falls back to coarse — whose 2 km
> polygons close the real shipping channels — so a perfectly good trail reports as
> deep inside land, and `hasFineLand` reports `false` for areas that ARE covered.

`region_coast` regions load **lazily**; a probe that does not call
`ensureRegionsForExtent` first sees no fine data and silently answers with coarse.
Both the "no coverage above 54°N" claim and an "endpoint is in water" reading came
from that mistake.

Re-measured against `region_coast` with regions explicitly loaded (which is what
`tests/audit-prod.mjs` now does):

```
636023060  awayFromReal=0  nearRealFix=0  fine=0  coarse=0   maxPen=0m
636023028  awayFromReal=0  nearRealFix=0  fine=0  coarse=0   maxPen=0m
```

**Zero land defects on both.** Fine coverage at Prince Rupert exists and is correct:
`hasFineLand(54.29, −130.36) = true`, and that point is `isLand = true` (a berth
alongside the terminal — the §2 berth artifact, not a coverage gap).

### So why does nothing render across the gap

GSL ALEXANDRA has a 576 km / 32.6 h span between two real fixes
(`54.29, −130.36 → 49.51, −127.12`) whose straight chord genuinely crosses land
(**12 of 41 samples**). Nothing is drawn over it because **`splitJourneys` severs
there**:

```
journeys=5
  j0 n=306  48.34,-123.36 -> 54.29,-130.36     (Victoria -> Prince Rupert)
  j1 n=2    54.29,-130.36 -> 54.29,-130.36     (berth stub)
  j2 n=53   49.51,-127.12 -> 48.34,-123.36
```

The vessel arrived at Prince Rupert, reported ~0 kn at the berth, and the next fix
is 576 km away — exactly the `speed ≤ MOVING_SPEED_KN` + long-gap sever rule. So
this is **§1 (hole, not bridge)**, reached by the berth path rather than the
mid-ocean path, and it is *correct* behaviour for the current heuristic: this really
was a port call. MANZANILLO BRIDGE shows the same shape (75 km and 52 km spans
between real fixes, no waypoints, zero land defects).

### What remains genuinely unexplained

The user observes something crossing BC on the map that this audit cannot
reproduce. Before writing code, **confirm what is actually on screen**: a hole
between two journeys, or a drawn line. Possibilities, cheapest first:

1. It IS the hole, described as "cutting over" — the eye connects the two ends.
2. The client renders a segment the audit does not (the audit splines the served
   `/track`; check `map_page.js` actually draws per journey and does not join them).
3. A different, shorter gap inside `j0` is crossing land somewhere less obvious.

Fixing the hole is §1, which is deferred by explicit decision.

**Do not** extend coastline coverage north of 54°N on the strength of the original
audit — that work is not needed, and the measurement that motivated it was an
artifact.

---

## 5. Ocean routes cannot be validated mid-crossing

**Status:** inherent to the data source. See `docs/ocean-routing-study.md`.

aisstream is fed by shore-based receivers. Across all 287 tracked vessels there
are **zero** real fixes in the open North Pacific and exactly one genuine
mid-ocean fix in the entire dataset. Any ocean-route shape we draw is a plausible
inference, never a verified track — which is why it renders dashed. Only the
departure and arrival courses are measurable, and those are what the routing is
tuned against.

---

## 7. Highlight centring ignores the marker's world copy (dateline vessels)

**Status:** Fixed — committed `78fc517`, deployed, verified against prod 2026-09-15.
Full writeup: `docs/rca-far-vessel-trails.md`.

**Symptom (TITUS 249011000):** a BC→Japan vessel renders its dot in the west world
copy (`_lonTurn = −1`, lon ≈ −225) because the unwrapped trail crosses the dateline,
but tapping it centres the map on the RAW `/current` lon (+134.94) — empty ocean,
boat/trail a full world-copy off-screen, then found by panning "on the wrong side of
the world". Fix: centre on `markers.get(mmsi).getLatLng()` (which follows the trail),
not `[v.lat, v.lon]`.

**Not a defect:** BATTLEWAGON 368374930 (Florida) and GREENSEA ARACENA 311001913
(South Africa) are §1 instances — parked-report severs, lone dots, no bridge (both
resurface moving after 55–83 day gaps).

## 6. Ocean spine clips northern Vancouver Island at the 50°N limiting parallel

**Status:** open, newly exposed 2026-09-04. Small (3 km) but systematic.

**Symptom.** HYUNDAI DUBAI (MMSI 538004415), after a clean `--regenerate`, audits as
`maxPen=3000m` with the worst point at exactly **`50.000, -127.038`** — inland on northern
Vancouver Island (near Woss/Port Hardy).

```
538004415  pts=269 fake=179  awayFromReal=423  fine=80 coarse=343  maxPen=3000m  peak=50.0N
    span 7464 km  48.48,-126.50 -> 34.51,139.76   (Juan de Fuca -> Tokyo)
```

**Why the coordinate is the whole clue.** The latitude is *exactly* `50.000`, which is
`OCEAN_ROUTE.maxLatDeg` — the composite-great-circle limiting parallel (`geo.compositeGreatCirclePoints`).
So this is a **spine vertex sitting on land**, not a Catmull-Rom bulge between control points
(a bulge would land on an arbitrary latitude). The JdF→Tokyo great circle is capped at 50°N and
the resulting parallel-following arc runs straight over the north end of the island.

**Why A\* doesn't rescue it.** `routeOceanGap` only sends a span to A\* if that span
`crossesLand`. Worth checking first whether this span is classified as clear (so A\* never runs)
or whether it routes and fails — `routeWholeOceanGap`'s endpoint-on-land skip sets `unrouted`,
and the fallback keeps the raw spine. `awayFromReal=423` confirms the defects are in inferred
territory, not near real fixes.

**Do NOT "fix" this by shortening journeys.** A gap-length ceiling on `splitJourneys` was tried
on 2026-09-04 and reverted — see root `CLAUDE.md` → "Trail severing — why a gap-length ceiling
does NOT work". It gutted the trans-Pacific fixtures while all three suites still passed
vacuously.

**Likely direction.** Either shape the spine so a capped arc is pushed offshore before land
classification (the cap is applied *before* classification by design, so this is in-contract),
or lower `maxLatDeg` slightly / make the cap latitude-aware near known coastlines. Any change
must be checked against `tests/ocean-shape.test.mjs` (SALVIA ACE 271°/50.0°N) AND the fixture
journey-count/lonSpan baseline (cosco-santos 1/124°, cs-anthem 17/134°).

