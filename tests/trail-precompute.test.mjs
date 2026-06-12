// Precompute regression test. Verifies the server-side trail precompute:
// `harvestInferredSegments` produces the sparse fake waypoints the cron stores,
// and the CLIENT reconstruction (raw real /track points UNION those fakes,
// re-splined with the PURE pipeline — no coastline) is:
//   (a) water-tight — the rendered curve stays off land (the whole point);
//   (b) minimal — far fewer stored fakes than the full-resolution control set;
//   (c) deterministic — harvesting twice yields identical points.
//
//   node tests/trail-precompute.test.mjs
//
// Mirrors tests/trail.test.mjs's land-tightness thresholds. Fixtures are
// home-area, so no foreign regions need loading.
import { readFileSync, readdirSync } from 'fs';
import { pointInAnyLand, LAND_POLYGONS } from './lib.mjs';
import { haversineKm } from '../frontend/app/geo.js';
import { harvestInferredSegments, computeControlPoints } from '../frontend/app/trail_geometry.js';
import { dedup, splitJourneys, catmullRom } from '../frontend/app/trail_spline.js';

const MAX_LAND_PENETRATION_M = 150;
const FINE_COUNT = LAND_POLYGONS.length;
const COARSE_MAX_PENETRATION_M = 2500;
const NEAR_REAL_LAND_KM = 1.5;

function penetrationKm(p) {
  for (let radKm = 0.05; radKm <= 2; radKm += 0.05) {
    const dLat = radKm / 111.32, dLon = radKm / (111.32 * Math.cos(p[0] * Math.PI / 180));
    for (let a = 0; a < 16; a++) {
      const th = a / 16 * 2 * Math.PI;
      if (pointInAnyLand([p[0] + dLat * Math.sin(th), p[1] + dLon * Math.cos(th)]) < 0) return radKm;
    }
  }
  return 2;
}

// Reconstruct exactly what the browser does: combine raw real fixes with the
// stored fakes (sorted by t), map to control points (fakes carry `synthetic`
// from `dashed`), then the PURE pipeline. No coastline, no A*, no repair.
function clientReconstruct(realPts, segments) {
  const fakes = segments.flatMap(s => s.fakes.map(f => ({
    lat: f.lat, lon: f.lon, t: f.t, fake: true, synthetic: f.dashed === 1,
  })));
  const reals = realPts.map(p => ({ lat: p.lat, lon: p.lon, t: p.t, tier: p.tier, speed: p.speed, fake: false, synthetic: false }));
  const combined = [...reals, ...fakes].sort((a, b) => a.t - b.t);
  return splitJourneys(dedup(combined));
}

let failures = 0;
for (const file of readdirSync(new URL('./fixtures/', import.meta.url)).filter(f => f.endsWith('.json')).sort()) {
  const fx = JSON.parse(readFileSync(new URL('./fixtures/' + file, import.meta.url)));
  const chronological = [...fx.points].reverse();
  const realOnLand = chronological.filter(p => pointInAnyLand([p.lat, p.lon]) >= 0);
  const opts = { vesselLength: fx.length ?? null };

  const segments = harvestInferredSegments(chronological, opts);
  const segments2 = harvestInferredSegments(chronological, opts);

  // (c) determinism
  const deterministic = JSON.stringify(segments) === JSON.stringify(segments2);

  // (b) minimality — fakes stored vs synthetic control points in the full set
  const storedFakes = segments.reduce((n, s) => n + s.fakes.length, 0);
  const fullSynthetic = computeControlPoints(chronological, opts)
    .reduce((n, j) => n + j.controls.filter(c => c.fake).length, 0);

  // (a) water-tightness of the client reconstruction
  let defects = 0, maxPenM = 0, splinePts = 0;
  for (const journey of clientReconstruct(chronological, segments)) {
    if (journey.length < 2) continue;
    const smooth = catmullRom(journey);
    splinePts += smooth.length;
    for (const s of smooth) {
      const landIdx = pointInAnyLand([s.lat, s.lon]);
      if (landIdx < 0) continue;
      const nearReal = realOnLand.some(r => haversineKm(r.lat, r.lon, s.lat, s.lon) < NEAR_REAL_LAND_KM);
      if (nearReal) continue;
      const penM = penetrationKm([s.lat, s.lon]) * 1000;
      maxPenM = Math.max(maxPenM, penM);
      const tol = landIdx >= FINE_COUNT ? COARSE_MAX_PENETRATION_M : MAX_LAND_PENETRATION_M;
      if (penM > tol) defects++;
    }
  }

  const reduced = fullSynthetic === 0 || storedFakes <= fullSynthetic;
  const clean = defects === 0 && deterministic && reduced;
  if (!clean) failures++;
  console.log(
    `${clean ? 'PASS' : 'FAIL'}  ${fx.name.padEnd(16)} ` +
    `storedFakes=${String(storedFakes).padStart(3)} (full=${String(fullSynthetic).padStart(4)}) ` +
    `segments=${String(segments.length).padStart(2)} splinePts=${String(splinePts).padStart(4)} ` +
    `landDefects=${defects} maxPen=${maxPenM.toFixed(0)}m ` +
    `${deterministic ? '' : 'NONDETERMINISTIC '}${reduced ? '' : 'NOT-REDUCED'}`
  );
}

if (failures > 0) { console.error(`\n${failures} fixture(s) failed.`); process.exit(1); }
console.log('\nPrecompute: client reconstruction water-tight, minimal, deterministic.');
