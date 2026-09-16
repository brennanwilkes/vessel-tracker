# Does great-circle routing match how ships actually cross the Pacific?

Study prompted by an observation from the map: inferred trans-Pacific trails leave
the Salish Sea by turning sharply northwest toward the Aleutians, at an angle that
visibly disagrees with the real AIS track they attach to.

Data: all 287 vessels in `/current`, full `/track` history, real (non-`fake`) fixes
only. Measured 2026-08-06.

## 1. We cannot observe the ocean course at all

aisstream is fed by shore-based receivers, so our coverage ends a few hundred km
offshore. Filtering every real fix in the North Pacific band (lat 25–62°N, west of
140°W or east of 140°E) returns **zero** rows.

Widening to "west of 129°W" returns only shore clusters — Prince Rupert (54°N,
130°W), SE Alaska, Honolulu (21°N, 158°W), Tokyo Bay — plus exactly **one** genuine
mid-ocean fix in the entire dataset:

| vessel | fix | context |
|---|---|---|
| MIRACULOUS ACE | 31.02°N, 130.91°W | outbound Yokohama; a great circle on that leg arcs far north |

So the mid-ocean shape of a route is, and will remain, unobservable to us without
satellite AIS. Any ocean model we pick is an assumption. What we *can* measure is
the course at both ends, where the inferred path joins real tracking — and that is
also where the visible defect lives.

## 2. The departure angle really is wrong — but only for the Asia-bound

Binning every westbound real segment off BC/WA (>8 kn) by longitude shows the
median bearing rising 288° → 312° going west, which looks at first like vessels
turning onto the great circle. That is an artifact of mixing two fleets. Split by
destination, they separate cleanly:

| population | bearing at 127°W | examples |
|---|---|---|
| Alaska / Prince Rupert bound | **306–318°** | EURODAM (US JNU), MIDNIGHT SUN (US ANC), CARNIVAL SPIRIT, MATSON KODIAK, ALASKA TITAN |
| Asia bound | **265–275°** | ATHENS HIGHWAY (JPTHS), CAPTAIN MARKOS (KRYO), TAI HERALD, GSL ALEXANDRA, SALVIA ACE |

The great circle to Yokohama departs at **297°** — i.e. closer to the *Alaska*
fleet than to the Asia fleet it is actually being drawn for. That is precisely why
the inferred trail reads as "immediately turning north toward the Aleutians."

SALVIA ACE (the reference datapoint) holds **272° for the last 100 km of real
tracking** at 16–17 kn, dead steady, out to 126.7°W. The great-circle tangent
there is 297°: a **25° discontinuity** at the exact point where the dashed
inference begins.

This is not the traffic separation scheme. The TSS lanes end near 125°W; the
Asia-bound vessels are still holding 270° out to 127–127.5°W, well beyond it.

Aggregated over every trans-ocean gap >3000 km, the same ~27° offset appears at
both ends and in both directions:

| leg | real course | great-circle tangent | error |
|---|---|---|---|
| CS ANTHEM, outbound | 268° | 303° | −34° |
| PRESTIGE ACE, outbound | 267° | 302° | −35° |
| COSCO SANTOS, outbound | 273° | 306° | −33° |
| NADI CHIEF, outbound | 272° | 303° | −31° |
| MIRACULOUS ACE, outbound | 268° | 297° | −30° |
| SALVIA ACE, outbound | 271° | 297° | −27° |
| YM MANDATE, outbound | 271° | 297° | −26° |
| HMM VANCOUVER, **inbound** | 92° | 119° | −28° |
| NADI CHIEF, **inbound** | 92° | 117° | −25° |

The inbound figures matter: they are an independent mirror of the outbound ones.
A vessel arriving off Juan de Fuca from Asia comes in on ~092° (due east), where a
great circle would deliver it on ~117°.

## 3. What model fits

Composite great-circle sailing — the standard practice of following a great circle
but capping it at a limiting parallel, then running along that parallel — is
parameterised by the cap. Initial course from 48.5°N:

| limiting latitude | initial course | error vs observed 270° |
|---|---|---|
| 48.5° | 270° | 0° |
| 49° | 278° | +8° |
| 50° | 284° | +14° |
| 51° | 288° | +18° |
| 52° | 292° | +22° |
| 54° (uncapped GC — current model) | 297° | +27° |

The observed data fits a cap at essentially the departure latitude. Caveat worth
keeping in view: our westernmost Asia-bound observation is 127°W, ~180 km
offshore, so this fits the *departure* leg, not the crossing. A vessel could still
climb north beyond where we lose it. Real-world practice also varies seasonally —
North Pacific routes run flatter in winter to avoid Gulf of Alaska weather.

## 4. Conclusions — both implemented

Shipped as `OCEAN_ROUTE` in `frontend/config.js`, applied in
`trail_geometry.routeOceanGap` **before** land classification so the A\* pass still
routes around anything the shaping pushes ashore. Regression:
`node tests/ocean-shape.test.mjs`.

**Scoped to gaps ≥ `shapeMinKm` (3,000 km)** — everything measured above is a
trans-Pacific leg, and applying the cap and blend outside that regime did real
damage. `routeMaxKm` (800 km) routes any longer gap through `routeOceanGap`, which
swept in coastal runs like Juan de Fuca → Oakland (1,189 km). Those are not
great-circle crossings: both endpoints sit in fine coverage and the real COG already
parallels the shore. Worse, the blend *removed* routing there — the unshaped spine
clipped the San Francisco peninsula, which is what forced the fine A\* bracket that
threaded the Golden Gate; blended, it cleared the peninsula, no land-crossing run was
detected, and the harbour approach was stored as bare 100 km spine vertices (50
waypoints → 12, a 650 m spline bulge into Oakland). Below `shapeMinKm` the spine
stays a plain great circle. See `tests/README.md` §11.

| leg | plain GC | + cap 50°N | + blend | real course |
|---|---|---|---|---|
| SALVIA ACE → Yokohama | 297°, peak 54.0°N | 284°, peak 50.0°N | **271°** | 271° |
| CS ANTHEM → Singapore | 303°, peak 56.0°N | 284°, peak 50.0°N | **268°** | 268° |
| JdF → Juneau | 337°, peak 58.3°N | *cap does not bind* | 310° | 310° |


1. **The visible defect is a tangent discontinuity, fixable without settling the
   mid-ocean question.** Whatever ocean model is used, the inferred path should
   leave and arrive along the vessel's actual course, blending into the ocean route
   over some distance. `routeWater` already did this for coastal gaps via
   `entryBearing`/`exitBearing` ("trust the boat"); the ocean spine was generated
   from endpoints alone and ignored COG entirely. → `geo.blendCourse`, holding the
   observed course for 100 km then decaying onto the ocean route by 500 km.
2. **A latitude cap is supported as far as our data can see**, and it is standard
   marine practice. → `geo.compositeGreatCirclePoints` at **50°N**. Chosen over the
   48.5°N that fits the departures exactly, because our westernmost Asia-bound
   observation is only ~180 km offshore — a tighter cap would extrapolate past the
   evidence. Endpoints already poleward of the cap fall back to a plain great
   circle, so BC↔Alaska legs are not dragged south.
3. **We can never validate the middle.** The ocean spine is a plausible drawing,
   not a claim, and stays visually distinct (dashed).

### The analysis trap worth remembering

Binning every westbound real segment off BC/WA by longitude shows the median
bearing RISING going west (288° → 312°), which reads as "vessels are turning onto
the great circle, our routing is right." That conclusion is wrong: the bins mix two
fleets with opposite behaviour, and the Alaska-bound one dominates the tail because
it is the only one our receivers still see that far out. Always split by
destination before concluding anything from aggregate course statistics.
