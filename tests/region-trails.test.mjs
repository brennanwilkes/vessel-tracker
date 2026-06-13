// Region-aware trail regression for LONG land-crossing gaps that depend on lazy
// fine-coast regions — the cases the home-only trail.test.mjs can't cover (its
// lib.mjs land test is coarse-only and it never loads regions).
//
//   node tests/region-trails.test.mjs
//
// Each fixture is a real captured /track (newest-first, real fixes only — stored
// inferred fakes stripped) for a vessel whose trail used to STRAIGHT-BRIDGE through
// land because routeWater returned null:
//   • columbia-offshore (338815000) — Columbia R. @ Portland → offshore Vancouver Is.
//     The ~1 km river closed at the old length-based cellKm (≥1.5 km cells) → null.
//   • columbia-salish   (357777000) — Columbia R. → Salish Sea.
//   • bc-inside-passage (316011773) — Prince Rupert → N. Vancouver Is. through the
//     51.3–54°N central-BC channels the coarse layer merged shut (no fine data).
//
// The fix: routeWater's cell-COUNT budget keeps cells fine (0.2 km floor) on long gaps
// (server-side A* affords the bigger grid), and the bc-central-{south,north} fine-land
// regions re-open the BC channels. This test runs the FULL pipeline region-aware (as the
// precompute does) and asserts the rendered spline is water-tight — no straight bridge.
import { readFileSync, readdirSync } from 'fs';
import { ensureRegionsForExtent, extentOf, isLand } from '../frontend/app/region_coast.js';
import { harvestInferredSegments } from '../frontend/app/trail_geometry.js';
import { dedup, splitJourneys, catmullRom } from '../frontend/app/trail_spline.js';
import { haversineKm } from '../frontend/app/geo.js';

// A spline sample on land deeper than this is a real defect. Shallower clips are
// sub-pixel grazes in the tightest channels; a graze near a real on/near-land fix
// (docked, or a coarse-data endpoint) is "trust the boat", tolerated separately.
const MAX_PENETRATION_M = 200;
const NEAR_REAL_LAND_KM = 1.5;

function penetrationM(la, lo) {
  if (!isLand(la, lo)) return 0;
  for (let r = 0.1; r <= 3; r += 0.1) {
    const dLa = r / 111.32, dLo = r / (111.32 * Math.cos(la * Math.PI / 180));
    for (let a = 0; a < 16; a++) { const th = a / 16 * 2 * Math.PI; if (!isLand(la + dLa * Math.sin(th), lo + dLo * Math.cos(th))) return r * 1000; }
  }
  return 3000;
}

const dir = new URL('./fixtures/regions/', import.meta.url);
let failures = 0;
for (const file of readdirSync(dir).filter(f => f.endsWith('.json')).sort()) {
  const fx = JSON.parse(readFileSync(new URL(file, dir)));
  const real = [...fx.points].reverse().map(p => ({ lat: p.lat, lon: p.lon, speed: p.speed, t: p.t, tier: p.tier }));
  await ensureRegionsForExtent(extentOf(real));

  const onLand = real.filter(p => isLand(p.lat, p.lon));
  const segs = harvestInferredSegments(real, { vesselLength: fx.vesselLength ?? null });
  const fakes = segs.flatMap(g => g.fakes.map(f => ({ lat: f.lat, lon: f.lon, t: f.t, fake: true, synthetic: f.dashed === 1 })));
  const combined = [...real.map(p => ({ ...p, fake: false, synthetic: false })), ...fakes].sort((a, b) => a.t - b.t);

  let defects = 0, maxPen = 0, worst = null;
  for (const journey of splitJourneys(dedup(combined))) {
    if (journey.length < 2) continue;
    for (const s of catmullRom(journey)) {
      if (!isLand(s.lat, s.lon)) continue;
      if (onLand.some(r => haversineKm(r.lat, r.lon, s.lat, s.lon) < NEAR_REAL_LAND_KM)) continue;
      const penM = penetrationM(s.lat, s.lon);
      if (penM > maxPen) { maxPen = penM; worst = [s.lat.toFixed(3), s.lon.toFixed(3)]; }
      if (penM > MAX_PENETRATION_M) defects++;
    }
  }

  const ok = defects === 0;
  if (!ok) failures++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${fx.name.padEnd(18)} reals=${String(real.length).padStart(3)} ` +
    `routedSegs=${segs.length} fakes=${fakes.length} onLandReals=${onLand.length} ` +
    `landDefects=${defects} maxPenetration=${maxPen.toFixed(0)}m${worst && defects ? ` @${worst}` : ''}`
  );
}

if (failures > 0) { console.error(`\n${failures} region-trail fixture(s) crossed land.`); process.exit(1); }
console.log('\nAll region-trail fixtures water-tight (no straight-bridge through land).');
