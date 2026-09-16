# RCA: far vessels with a dot but no connecting trail (2026-09-14)

Three vessels on `/current` (`max_extent: global`, `first_direct_at` set — they visited
the apartment-window box) show a live dot thousands of nm from Victoria with NO trail
connecting them to home:

| vessel | MMSI | where now | updated |
|---|---|---|---|
| BATTLEWAGON | 368374930 | Florida (26.06, −80.14) | 13 h |
| GREENSEA ARACENA | 311001913 | South Africa (−30.17, 31.09) | 69 h |
| TITUS | 249011000 | Japan (34.16, +134.94) | 38 h |

Reported as "I see no trail connecting it to Victoria" (BATTLEWAGON, GREENSEA) and
"not only has no trail but is showing up as a dot on the wrong side of the world —
the wrapped Japan instead of the centred-around-the-Pacific Japan" (TITUS).

## Conclusion up front — TWO distinct defects, only one is a code bug

- **Defect A (a straight-up client bug):** TITUS's dot renders in the **west world
  copy** (−225° lon) while tapping it **centers the map on the raw position**
  (+134.94°). The map lands on empty ocean; the boat/trail are a full world-copy
  away. Root cause is one line: `map_page.js` highlight-centering uses the raw
  `/current` lon, ignoring `marker._lonTurn` (the fixed "follow the trail" copy).
- **Defect B (BY DESIGN, not a bug):** BATTLEWAGON + GREENSEA **parked** (reported
  `speed ≤ 0.5 kn`) at their last Victoria-area fix, so `splitJourneys` severed the
  journey; their far position is a lone 1-point journey with no bridge. This is the
  *documented, deferred* hole — `known-issues.md` §1 (two fixes attempted, measured
  worse, reverted). Not a rendering defect; a sever-heuristic tradeoff.

Everything below is evidence, so a fresh session can reopen this and re-derive
nothing.

---

## Evidence (from the live API, 2026-09-14)

`/track` is fetched newest-first; reverse, then run
`dedup → splitJourneys → catmullRom → runsBySynthetic` (the exact client pipeline).

| vessel | raw pts | journeys | far-position journey | fake pts |
|---|---|---|---|---|
| battlewagon | 153 | **7** | J6 = **1 pt** (Florida, global) | 66 total, 0 on J6 |
| greensea | 86 | **3** | J2 = **1 pt** (South Africa, global) | 0 |
| titus | 162 | **2** | J1 = 126 pts, BC→Japan, **105 fakes**, lon −122.4→**−225.1**, span 103° | 105 |

Key boundary points (prove the Defect B severs):

```
battlewagon  i=151 (prev) t=2026-07-18  lat 50.03 lon −125.24  spd=0   tier local
             i=152 (next) t=2026-09-11  lat 26.06 lon  −80.14  spd=0   tier global   (55-day gap)
greensea     i=84  (prev) t=2026-06-21  lat 48.13 lon −123.44  spd=0.4 tier direct   (parking outside Victoria)
             i=85  (next) t=2026-09-12  lat −30.17 lon +31.09  spd=15.6 tier global  (83-day gap)
```

Both trips were clearly SAILED (greensea resurfaces at 15.6 kn; battlewagon bogus
`spd 0` is the stale-AIS-speed §1 trap). `splitJourneys`:
`realPair && gap > sever && parked` — both fire the sever, so nothing bridges.

TITUS: the journey is **one continuous moving curve** (never parks) — BC Aug 30 →
Japan Sep 13. Its stored `/track` lons are RAW (server wraps on write): the dateline
crossing shows as −172.48 → +179.20 → … → +134.94. The CLIENT re-unwraps in `dedup`,
→ −172.48 → −180.80 → … → **−225.06**. `drawTrail` then correctly sets
`marker._lonTurn = round((−225.06 − 134.94)/360) = −1` and puts the dot at −225.06 —
the trail tip's copy. That dot-follows-trail behaviour is correct (its predecessor
was the COSCO SANTOS "follow the line and the boat isn't there" bug).

## Defect A root cause (the fixable bug)

`frontend/app/map_page.js` `subscribeHighlight` handler — the only place the map
navigates on highlight:

```js
map.setView([v.lat, v.lon], map.getZoom(), { animate: true })   // v = raw /current
```

Uses the RAW lon. For a dateline crossing the marker sits at `raw + turn*360`
(−225.06). So tapping TITUS centers the view on main-world Japan (+134.94) while dot
and trail render in the adjacent west copy — a full screen-width off-screen. The user
pans and finds them "on the wrong side of the world".

Nothing else is wrong for this class of vessel: the trail exists, is routed (105
fakes), the marker follows it, culling (runInView) handles ±360, and the trail
signature/redraw are view-independent.

## Defect A fix (COMMITTED, DEPLOYED, VERIFIED 2026-09-15)

Landed in `78fc517` ("fix: Reduced quotas"); frontend Pages deploy + worker deploy
both green on that SHA. Confirmed live against prod:

```js
const m = markers.get(mmsi);
const center = m !== undefined ? m.getLatLng() : [v.lat, v.lon];
map.setView(center, map.getZoom(), { animate: true });   // map_page.js:770-772
```

- Deployed bundle (`https://brennanwilkes.github.io/vessel-tracker/app/map_page.js`)
  contains the fix (lines 765-771).
- Fresh `/vessel/249011000/track` still unwraps to the same trail tip (lon −225.1,
  span 103°, 105 fakes) → `turn = round((−225.06 − +134.94)/360) = −1` → the marker
  and now the centred view land on the west copy where the boat actually renders.
- Raw-centring is gone: only `map_page.js:770-772` navigates on highlight, and both
  highlight entrances (list-card tap with pan, marker click with pan=false) route
  through it.

Centring on the marker lands on the boat wherever its trail put it. Fallback to raw
if the marker isn't drawn yet (first paint / not-yet-fetched trail → `_lonTurn` 0 anyway).

### Verify
1. Load live: highlight TITUS (249011000) → map must centre so the dot is on-screen
   with the dashed BC→Japan trail leading off toward Victoria (dateline-centered view),
   NOT empty ocean at +134.94.
2. Re-run the pipeline probe:
   `node /tmp/analyze-trails.mjs` after refetching `/vessel/249011000/track` → J1
   still ends unwrapped ≈ −225.1 and `turn == −1`.
3. Regression: highlight a purely-local vessel → marker `_lonTurn` 0 → centre == raw
   → no behaviour change. Highlight COSCO SANTOS-style dateline vessel if one is live.
4. Mobile tap-through of list cards (the same `setHighlight` path) still centres
   correctly.

### Open nicety (decide, don't build yet)
For a dateline vessel, centring on the dot keeps the crossing trail off-screen (boat
visible, Victoria to the right beyond the seam). An alternative is `fitBounds` to the
journey's unwrapped run lons + the marker, which shows the WHOLE BC→Japan crossing
(dateline-centred) at the cost of zooming way out. Not needed to fix the report.

## Defect B — decision gate (do NOT code without one)

BATTLEWAGON/GREENSEA are `known-issues.md` §1 instances. Two options:

1. **Keep deferred (status quo).** The visible outcome ("boat parked → we lost it →
   lone dot") is defensible and the two prior fixes were measured worse
   (see §1 table: any stricter rule re-introduced MOUNT-ASO-style false severs or
   berth-to-berth land chords).
2. **Server→client break marker** (§1 "Where a real fix probably lives"): have the
   precompute own the sever decision and ship it to the client (`dashed = 2`
   sentinel rides `/track` without a migration) so the client stops treating "two
   reals with no fakes" as "cron hasn't routed it yet". That only *repairs rendering
   intent*, it does not draw a bridge over a sailed gap where none is stored.

If the user wants a connecting LINE for BATTLEWAGON's sailed 55-day gap, that is the
same unroutable-through-Panama family as `known-issues.md` §3 (isthmus closed in all
land layers) — any drawn line is fabricated inference. Surface this tradeoff before
spending time.

## Resume pointers (after context compaction)

- `frontend/app/map_page.js:760-772` — the Defect A fix (committed `78fc517`, deployed, verified).
- `frontend/app/trail_spline.js:27-48,61-74` — `unwrapTrack` (anchors frame on FIRST
  point) + `splitJourneys` (the Defect B sever; `TRAIL_GAP_SEVER_MS` in
  `frontend/config.js:51`).
- Live data still in `/tmp/battlewagon.json`, `/tmp/greensea.json`, `/tmp/titus.json`
  and probe `/tmp/analyze-trails.mjs` (session-local; refetch if gone).
- Root `CLAUDE.md` → "Longitude is UNWRAPPED" and "Trail severing"; `worker/CLAUDE.md`
  "Server-side inferred-positions precompute".