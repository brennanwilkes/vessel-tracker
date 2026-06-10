# Frontend — CLAUDE.md

GitHub Pages SPA. No bundler, no framework. Raw ES6 modules + CDN libs loaded in `index.html`.

## File structure

```
index.html          — CDN libs (Leaflet), stylesheet links, <div id="app">, module entry
config.js           — ALL runtime config: VIEWSHEDS, WORKER_URL, POLL_INTERVAL_MS, MOVING_SPEED_KN, TIER_STYLE, etc.
styles/
  base.css          — CSS custom properties (design tokens), reset, typography
  layout.css        — #app shell, #page-root, tab bar
  map.css           — Leaflet container, overrides, vessel markers (dot + arrow), trails, home pulse, status chip
  sheet.css         — vessel detail bottom sheet
  list.css          — list page, vessel cards
  camera.css        — camera placeholder
  states.css        — error / empty states
  settings.css      — settings page, toggle switches
app/
  main.js           — hash router (#map / #list / #camera / #settings), 4-tab bar, startPolling()
  api.js            — fetchVessels (→ /current), fetchVessel, fetchTrack (→ /vessel/:mmsi/track)
  store.js          — 30s polling loop, pub/sub (subscribe returns an unsubscribe fn)
  settings_store.js — extent + trail filter state, localStorage persistence, passesExtentFilter()
  geo.js            — haversineNm, haversineKm, bearingDeg, routeAroundLand, segmentsIntersect, intersectionPoint, walkPolygonPerimeter
  map_page.js       — Leaflet map, dot/arrow markers, trail polylines with coastline avoidance (augmentSegment, buildSubSegments), extent filter, settings subscription
  list_page.js      — distance-sorted vessel list, extent filter, unit toggle (nm/km in localStorage)
  trails.js         — lazy trail fetch + in-memory cache (TTL + tier-union widening)
  settings_page.js  — settings page: extent bucket toggles + trail tier toggles
  camera_page.js    — placeholder, renders in M3
```

## No-bundler rules

- Import paths must include `.js` extension.
- CDN libs (Leaflet, later OpenCV.js, onnxruntime-web) are loaded as `<script>` tags in `index.html` before the module entry — never imported as ES modules.
- `L` (Leaflet) is a global. Access it directly; do not import it.
- New CDN libs: add `<script>` to `index.html` only when the tab that needs them is first activated (lazy load via dynamic `import()` or appending a `<script>` tag).

## Routing

Hash-based: `#map`, `#list`, `#camera`. Each page module exports `mount(container)` and `unmount()`. `main.js` calls unmount on the previous page and mount on the new one.

## Store contract

`subscribe(fn)` calls `fn(vessels, error)` immediately and on every poll. Returns an unsubscribe function. Pages must call unsubscribe in their `unmount()`.

## Design tokens

All in `styles/base.css`. Key vars: `--accent`, `--green`, `--font-ui` (Syne), `--font-data` (Space Mono). Dark nautical theme.

## View-file convention (from global CLAUDE.md)

All logic and variable assignments at the top of each page module. The render section at the bottom is pure output. No inline logic mid-HTML string.

## Home coordinates

`48.429861°N, -123.362194°W` (48°25'47.5"N 123°21'43.9"W). Set in `config.js VIEWSHEDS[0].home`.

## Coastline avoidance

`routeAroundLand` in `geo.js` routes trail segments around land polygons using perimeter routing with Douglas-Peucker simplification. Tolerance is adaptive: `max(1, dist * 0.05)` — `dist` is the haversine km between the trail segment endpoints. Short gaps (a few km) get tight tolerances (~1 km); long gaps (entire peninsulas, 100+ km) get coarser tolerances (~5–6 km) producing a wider arc through open water.

- `LAND_AVOIDANCE.simplifyToleranceKm` is NOT used directly — the adaptive formula uses `Math.max(1, dist * 0.05)`. (Originally was `dist * 0.2` at commit 76a8c16, changed to `dist * 0.05` in bec9d28.)
- Coasts of Salish Sea / Olympic Peninsula are well-handled at this ratio.
- No A* visibility graph — perimeter routing covers >95% of local geography; dashed segments honestly communicate uncertainty.
- **Grazing crossing fix** (`geo.js:336`): when `segmentCrossesPolygon` entry and exit points are < 5 km apart, the polygon is skipped entirely via `visited.add(i); continue;`. Prevents tiny zigzag perimeters from island-tip intersections (Salt Spring, Gulf Islands).

### Synthetic sub-segment first control point

In `augmentSegment` (`map_page.js`), when a land crossing is detected between `pts[i]→pts[i+1]`, the synthetic sub-segment now starts with `usePerim[0]` (first coastline perimeter point) instead of `pts[i]`. The trail point `pts[i]` can be far from the coastline entry (e.g., 47.72N for BUENA VENTURA when the last context point is at 48.32N), causing a Catmull-Rom spike through land. Using the perimeter entry point keeps the spline hugging the coast.
