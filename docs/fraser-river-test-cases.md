# Fraser River / Vancouver harbour — coverage test cases

**Problem:** our coastline (`frontend/app/coastline.js`) is OSM `natural=coastline`
only, which stops at a river's tidal limit. The **upper Fraser** (New Westminster
area) is OSM `natural=water`/`waterway=riverbank` — absent from our data — so
vessels transiting it read as *on land*. Fix = add a water-polygon layer and make
`pointOnLand = inLand && !inWater` (see `worker/CLAUDE.md` → "Rivers & harbours
OSM tags"). Until then the frontend degrades gracefully (trust-the-boat).

## Points that MUST become water once fixed
`tests/lib.mjs` → `pointInAnyLand([lat, lon])` should return **-1** for all of these
(currently returns a land polygon index). All are in the Fraser, vessels moving 1–8 kn:

```
49.1117,-123.1106   49.1340,-123.0585   49.1474,-123.0371   49.1512,-123.0183
49.1552,-122.9997   49.1561,-122.9613   49.1732,-122.9262   49.1847,-122.9206   (311000459 GLOVIS STAR)
49.1179,-123.1892   49.1119,-123.1709   49.1092,-123.1564   49.1303,-123.0613   (316023605)
49.1198,-123.1936   49.1495,-123.0248   49.1550,-123.0022                       (368045710)
```
Also confirm open water STAYS water (no false water polygons): `48.4299,-123.3622`
is the home **apartment = land**; `49.30,-123.60` (Strait of Georgia) = water.

## Real trails to test against
Fetch with: `worker/scripts/db-positions <mmsi> --limit 500 > /tmp/trail_<mmsi>.json`
- `311000459` GLOVIS STAR — Pacific → Vancouver, up the Fraser (10 on-land pts)
- `316023605` — Fraser transit (22 on-land pts, the worst case)
- `368045710` — Fraser transit (4 on-land pts)

Reshape to `tests/fixtures/<name>.json` = `{mmsi,name,points:[{lat,lon,speed,t,tier}…newest-first]}`.

## Acceptance
1. Every coordinate above → `pointInAnyLand` returns `-1` (water).
2. `node tests/trail.test.mjs` stays green; **`glovis-star` moves from `KNOWN` to
   `PASS`** (landDefects → 0, maxPenetration small). Then remove `glovis-star`
   from `KNOWN_DATA_LIMITED` in `tests/trail.test.mjs`.
3. Add `316023605` + `368045710` as fixtures; both PASS.
4. Routing through the river is smooth and stays in the (now-open) channel — no
   zigzags, no clips. Spot-check at https://geojson.io (see `tests/README.md` §7).

## Don't break
- The 4 existing PASS fixtures (`buena-ventura`, `chasing-daylight`, `mount-aso`,
  `twr-8`) and `venturosa` (Victoria harbour) must stay water-tight + smooth.
- Keep `coastline.js` reasonable in size (currently ~560 KB); simplify the water
  layer per the fine-zone tolerance (`build-coastline.mjs`).
- Don't regress the "trust-the-boat" rule (`repairOffLand` skips clips at real
  on-land fixes) — it's the graceful fallback where data is still missing.
