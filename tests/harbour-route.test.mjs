// Geography soundness: route between harbours up & down the coast and assert the
// inferred path goes AROUND land (back out to open water) — never CUTS THROUGH the
// continent. For each consecutive harbour pair we (1) note whether the straight line
// crosses land (the scenario being exercised), (2) routeWater, (3) densely sample the
// returned polyline and require no sample to penetrate land deeper than the coarse
// layer's ~km uncertainty (a deep hit = a cut-through bug). Loads the relevant lazy
// regions first, like the real worker does.
//
//   node tests/harbour-route.test.mjs
import { routeWater, haversineKm } from '../frontend/app/geo.js';
import { isLand, ensureRegionsForExtent as ensureRegions } from '../frontend/app/region_coast.js';

const crosses = (a, b) => {
  const n = Math.max(2, Math.ceil(haversineKm(a[0], a[1], b[0], b[1]) / 2));
  for (let s = 0; s <= n; s++) { const f = s / n; if (isLand(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f)) return true; }
  return false;
};
const route = (a, b) => routeWater(a, b, null, null, { isLand });

// Deepest land penetration (km) at a sample, capped at CAP. >CUT_THROUGH_KM = a real
// cut-through (not a coarse-coast graze).
const CAP = 4, CUT_THROUGH_KM = 2.5;
function penetrationKm(la, lo) {
  if (!isLand(la, lo)) return 0;
  for (let r = 0.1; r <= CAP; r += 0.1) {
    const dLa = r / 111.32, dLo = r / (111.32 * Math.cos(la * Math.PI / 180));
    for (let a = 0; a < 16; a++) { const th = a / 16 * 2 * Math.PI; if (!isLand(la + dLa * Math.sin(th), lo + dLo * Math.cos(th))) return r; }
  }
  return CAP;
}

// Near-shore harbour points down the NA Pacific coast (lat,lon). Adjacent pairs'
// straight lines clip the intervening headlands — so a sound router must detour seaward.
// In-water harbour / approach points (a real AIS harbour fix is in water). SF uses its
// ocean-side Golden Gate approach — threading INTO the bay behind that ~1.5 km gate over
// a long single gap is a fine-region/short-gap concern, separate from coastal geography.
const HARBOURS = [
  ['Juan de Fuca',    48.37, -124.60],
  ['Astoria',         46.22, -123.95],
  ['Coos Bay',        43.34, -124.40],
  ['Humboldt/Eureka', 40.74, -124.30],
  ['SF approach',     37.77, -122.60],
  ['Monterey',        36.61, -121.95],
  ['Morro Bay',       35.34, -120.92],
  ['LA / Long Beach', 33.70, -118.25],
  ['San Diego',       32.66, -117.27],
  ['Ensenada',        31.83, -116.68],
];

await ensureRegions([[31.0, -126.0], [49.0, -116.0]]);
console.log('regions loaded for the NA west coast\n');

let failures = 0;
for (let i = 1; i < HARBOURS.length; i++) {
  const [an, aLa, aLo] = HARBOURS[i - 1], [bn, bLa, bLo] = HARBOURS[i];
  const a = [aLa, aLo], b = [bLa, bLo];
  const straightCrossed = crosses(a, b);
  const path = route(a, b);
  const legKm = haversineKm(aLa, aLo, bLa, bLo).toFixed(0);
  if (!path) { console.log(`FAIL  ${an} → ${bn} (${legKm}km): routeWater returned null`); failures++; continue; }

  let maxPen = 0, westmost = 180;
  for (let s = 1; s < path.length; s++) {
    const [p0, p1] = [path[s - 1], path[s]];
    const n = Math.max(2, Math.ceil(haversineKm(p0[0], p0[1], p1[0], p1[1]) / 1.0));
    for (let k = 0; k <= n; k++) {
      const f = k / n, la = p0[0] + (p1[0] - p0[0]) * f, lo = p0[1] + (p1[1] - p0[1]) * f;
      maxPen = Math.max(maxPen, penetrationKm(la, lo));
      westmost = Math.min(westmost, lo);
    }
  }
  const cut = maxPen > CUT_THROUGH_KM;
  if (cut) failures++;
  // "went around" = bowed west of both endpoints (out toward open ocean) when the
  // straight line was blocked.
  const bowed = westmost < Math.min(aLo, bLo) - 0.01;
  console.log(
    `${cut ? 'FAIL' : 'PASS'}  ${(an + ' → ' + bn).padEnd(30)} ${String(legKm).padStart(4)}km  ` +
    `straightCrossedLand=${straightCrossed ? 'Y' : 'n'}  maxPenetration=${maxPen.toFixed(1)}km  ` +
    `${bowed ? 'bowed-seaward' : 'direct-water'}  (${path.length} wp)`
  );
}

console.log(failures === 0
  ? '\nAll coastal legs water-tight — routes go around land, never through.'
  : `\n${failures} leg(s) cut through land.`);
process.exit(failures === 0 ? 0 : 1);
