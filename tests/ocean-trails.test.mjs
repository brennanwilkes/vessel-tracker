// Ocean-scale trails: dateline crossings and long open-water legs.
//
// Two failures used to live here, both from the same root cause — nothing in the
// pipeline knew longitude wraps:
//
//   1. WRONG WAY AROUND THE WORLD. Every stage interpolates longitude linearly
//      (spline, A* grid span, Laplacian smoothing), so a BC→Asia leg was drawn
//      the LONG way — east across North America, the Atlantic and Eurasia — and
//      A* built a grid spanning a third of the planet (which is what put the
//      precompute cron at 1–2.5 h/run). Fixed by the unwrapped longitude frame
//      (geo.js "Longitude frames", established in trail_spline.dedup).
//   2. STRAIGHT THROUGH WHATEVER'S IN THE WAY. A gap too long for one A* grid
//      bridged as a plain line, cutting peninsulas and islands. Fixed by
//      trail_geometry.routeOceanGap: great-circle spine, A* on ONLY the spans
//      that actually hit land, at the resolution that span's data supports.
//
// Asserts, per fixture: the drawn path takes the SHORT way around (its longitude
// span is the small arc, not the 360° complement), it stays off land, and the
// whole thing computes in seconds rather than hours.
//
//   node tests/ocean-trails.test.mjs
import { readFileSync } from 'node:fs';
import { computeControlPoints } from '../frontend/app/trail_geometry.js';
import { catmullRom } from '../frontend/app/trail_spline.js';
import { ensureRegionsForExtent, extentOf, isLand, hasFineLand } from '../frontend/app/region_coast.js';
import { haversineKm, wrapLon } from '../frontend/app/geo.js';

// Fixtures whose track spans an ocean. cs-anthem/cosco-santos cross the dateline
// (BC → Singapore / Hong Kong); maunawili is the Oakland↔Honolulu run, no
// dateline but legs far longer than a single A* grid can cover.
const FIXTURES = ['maunawili', 'cs-anthem', 'cosco-santos'];

// A real fix on land is our coastline being wrong, not the router (trust the
// boat), and coarse-only coasts graze by design — so only INFERRED points are
// held to the water-tight standard, and only past a tolerance the ~2 km coarse
// layer can actually meet. See tests/README.md §1.
const COARSE_GRAZE_KM = 6;
// Guards the 1–2.5 h regression this suite exists for, so it is deliberately loose
// — it is an "is it hours again?" alarm, not a perf target. Raised 180s→300s when
// the SF Bay FINE_ZONE landed: harbour-grade polygons there make every isLand call
// in the Bay dearer, and maunawili (24 routed segments, the most of any fixture)
// went 63s→194s. cs-anthem 50s and cosco-santos 37s are unaffected.
const BUDGET_MS = 300_000;

let failures = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS  ' : 'FAIL  ') + msg); if (!cond) failures++; };

for (const name of FIXTURES) {
  const { points } = JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url)));
  const chrono = points.slice().sort((a, b) => a.t - b.t);
  await ensureRegionsForExtent(extentOf(chrono));

  const t0 = Date.now();
  const journeys = computeControlPoints(chrono, { denoise: false });
  const elapsed = Date.now() - t0;

  let minLon = Infinity, maxLon = -Infinity, maxStepKm = 0;
  const defects = [];
  for (const { controls } of journeys) {
    const spline = catmullRom(controls);
    for (let i = 0; i < spline.length; i++) {
      const s = spline[i];
      minLon = Math.min(minLon, s.lon); maxLon = Math.max(maxLon, s.lon);
      if (i > 0) maxStepKm = Math.max(maxStepKm, haversineKm(spline[i - 1].lat, spline[i - 1].lon, s.lat, s.lon));
      if (!s.synthetic || !isLand(s.lat, s.lon)) continue;
      // Measure how deep the graze goes: walk out until we hit water.
      let depth = 0;
      for (let k = 1; k <= 12; k++) {
        depth = k * (COARSE_GRAZE_KM / 6);
        const dLat = depth / 111.32;
        if (!isLand(s.lat + dLat, s.lon) || !isLand(s.lat - dLat, s.lon)) break;
      }
      if (depth > COARSE_GRAZE_KM) defects.push({ lat: s.lat, lon: wrapLon(s.lon), depth, fine: hasFineLand(s.lat, s.lon) });
    }
  }

  // The unwrapped frame keeps the drawn span equal to the true (short-way) span.
  // Anything over 180° means the path went round the wrong side of the globe.
  const lonSpan = maxLon - minLon;
  ok(lonSpan < 180, `${name.padEnd(13)} short way around  lonSpan=${lonSpan.toFixed(0)}°`);
  ok(defects.length === 0,
    `${name.padEnd(13)} inferred path off land  defects=${defects.length}` +
    (defects.length ? `  worst=${defects.map(d => `${d.lat.toFixed(1)},${d.lon.toFixed(1)}@${d.depth.toFixed(0)}km${d.fine ? ' FINE' : ''}`).slice(0, 3).join(' ')}` : ''));
  ok(elapsed < BUDGET_MS, `${name.padEnd(13)} computes in seconds  ${(elapsed / 1000).toFixed(1)}s (budget ${BUDGET_MS / 1000}s)`);
  console.log(`      journeys=${journeys.length} maxSplineStep=${maxStepKm.toFixed(0)}km`);
}

console.log(failures === 0
  ? '\nOcean trails: short way around, water-tight, tractable.'
  : `\n${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
