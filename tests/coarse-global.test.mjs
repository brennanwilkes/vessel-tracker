// Global coarse-land layer (coast_coarse.js, built by worker/scripts/build-coarse-coast.mjs).
// The coarse layer was extended from the NA Pacific coast to the WHOLE WORLD (minus the
// fine OSM home bbox) so foreign-port and trans-Pacific inferred trails bow around
// continents instead of cutting straight through Asia / Oceania / the Americas. This
// asserts three things the extension must preserve:
//   1. Land/water classification is correct worldwide (continents=land, open ocean=water).
//   2. The Salish Sea home region is NOT coarse-closed (the home bbox is carved out).
//   3. A modest foreign-coast graze routes AROUND land, water-tight (Taiwan).
// Big continental obstructions whose detour exceeds routeWater's margin correctly fall
// back to a straight bridge — that's graceful degradation, not tested here.
//
//   node tests/coarse-global.test.mjs
import { routeWater, haversineKm } from '../frontend/app/geo.js';
import { isLand, extentOf, ensureRegionsForExtent } from '../frontend/app/region_coast.js';

let failures = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS  ' : 'FAIL  ') + msg); if (!cond) failures++; };

// ── 1. Worldwide land/water classification ──────────────────────────────────────
const CLASSIFY = [
  ['Tokyo (land)',                    35.68, 139.76, true],
  ['Sydney (land)',                   -33.87, 151.21, true],
  ['Shanghai city (land)',            31.23, 121.47, true],
  ['Beijing inland (land)',           39.90, 116.40, true],
  ['Open mid-Pacific (water)',        30.00, -150.00, false],
  ['Vancouver→Tokyo midpoint (water)', 47.00, 180.00, false],
  ['Hawaii open water E (water)',     19.50, -154.00, false],
];
for (const [name, la, lo, exp] of CLASSIFY) ok(isLand(la, lo) === exp, `classify: ${name}`);

// ── 2. Salish Sea home region not coarse-closed ─────────────────────────────────
ok(!isLand(48.40, -123.20), 'home: Haro Strait is open water');
ok(!isLand(49.10, -123.60), 'home: Strait of Georgia is open water');

// ── 3. Foreign-coast graze routes around land, water-tight ──────────────────────
const crosses = (a, b) => {
  const n = Math.max(2, Math.ceil(haversineKm(a[0], a[1], b[0], b[1]) / 2));
  for (let s = 0; s <= n; s++) { const f = s / n; if (isLand(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f)) return true; }
  return false;
};
const penetrates = (path) => {
  for (let i = 1; i < path.length; i++) {
    const [p0, p1] = [path[i - 1], path[i]];
    const n = Math.max(2, Math.ceil(haversineKm(p0[0], p0[1], p1[0], p1[1]) / 1.0));
    for (let k = 0; k <= n; k++) { const f = k / n; if (isLand(p0[0] + (p1[0] - p0[0]) * f, p0[1] + (p1[1] - p0[1]) * f)) return true; }
  }
  return false;
};

const a = [21.8, 119.5], b = [25.4, 122.2]; // SW → NE around Taiwan
await ensureRegionsForExtent(extentOf([{ lat: a[0], lon: a[1] }, { lat: b[0], lon: b[1] }]));
ok(crosses(a, b), 'Taiwan: straight line crosses the island (scenario valid)');
const path = routeWater(a, b, null, null, { isLand });
ok(path !== null && path.length > 2, 'Taiwan: routeWater found a path around the island');
if (path) ok(!penetrates(path), 'Taiwan: routed path is water-tight');

console.log(failures === 0
  ? '\nGlobal coarse layer: classification correct, home preserved, foreign land avoided.'
  : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
