// Multi-leg corridor scenario. A single vessel making a long NA-Pacific voyage
// with signal gaps between port approaches — Fraser/Salish Sea → Tacoma → Columbia
// mouth (Portland approach) → San Francisco → LA/Long Beach. Each inter-port leg is
// a data GAP the precompute must route AROUND the coast (down the Strait, along the
// outer coast), not straight across land. Asserts the whole rendered trail is
// water-tight end-to-end across every region the corridor coastline must cover.
//
//   node tests/scenario.test.mjs
//
// Why approaches, not docks: routing UP a narrow meandering river (Columbia→Portland,
// ~1 km wide) over a 400 km ocean gap is beyond A*'s scale (coarse cells can't thread
// it) — a real Portland call is dense AIS fixes up the river, drawn as real track, not
// an inferred gap. So the stops are deep-water approaches; the legs between them are
// the open-coast routing this test guards.
import { pointInAnyLand, LAND_POLYGONS } from './lib.mjs';
import { haversineKm } from '../frontend/app/geo.js';
import { harvestInferredSegments } from '../frontend/app/trail_geometry.js';
import { ensureRegionsForExtent, extentOf } from '../frontend/app/region_coast.js';
import { dedup, splitJourneys, catmullRom } from '../frontend/app/trail_spline.js';

const FINE = LAND_POLYGONS.length;
const COARSE_MAX_PEN_M = 2500;
const FINE_MAX_PEN_M = 150;
const NEAR_REAL_KM = 2;

function penetrationKm(p) {
  for (let r = 0.05; r <= 3; r += 0.05) {
    const dLat = r / 111.32, dLon = r / (111.32 * Math.cos(p[0] * Math.PI / 180));
    for (let a = 0; a < 16; a++) { const th = a / 16 * 2 * Math.PI; if (pointInAnyLand([p[0] + dLat * Math.sin(th), p[1] + dLon * Math.cos(th)]) < 0) return r; }
  }
  return 3;
}

// Deep-water fixes, oldest→newest, ~hourly. Each leg between distant points is a gap.
const TRACK = [
  ['Fraser mouth',      49.08, -123.30],
  ['Strait of Georgia', 49.00, -123.30],
  ['Haro Strait',       48.55, -123.25],
  ['Juan de Fuca E',    48.30, -123.20],
  ['Admiralty Inlet',   48.16, -122.66],
  ['Tacoma',            47.29, -122.42],   // ← Tacoma visit (Puget Sound)
  ['Admiralty Inlet 2', 48.16, -122.66],
  ['Juan de Fuca W',    48.33, -124.30],
  ['WA outer coast',    47.00, -124.70],
  ['Columbia mouth',    46.24, -124.10],   // ← Portland approach (deep-water Columbia mouth)
  ['Oregon coast',      44.00, -124.55],
  ['S Oregon coast',    42.00, -124.90],
  ['Cape Mendocino off',40.40, -124.70],
  ['SF approach',       37.90, -123.10],
  ['Golden Gate',       37.81, -122.50],   // ← SF Bay visit
  ['Oakland',           37.80, -122.33],
  ['SF out',            37.60, -122.90],
  ['Big Sur off',       36.00, -122.30],
  ['Pt Conception off', 34.40, -120.90],
  ['LA approach',       33.90, -118.90],
  ['Long Beach',        33.74, -118.18],    // ← LA/Long Beach visit
];

const t0 = 1.7e12;
const pts = TRACK.map(([name, lat, lon], i) => ({ name, lat, lon, t: t0 + i * 3600e3, tier: 'global', speed: 9 }));

const onLandInputs = pts.filter(p => pointInAnyLand([p.lat, p.lon]) >= 0);
await ensureRegionsForExtent(extentOf(pts));
const segs = harvestInferredSegments(pts.map(p => ({ lat: p.lat, lon: p.lon, speed: p.speed, t: p.t, tier: p.tier })), { vesselLength: 200 });
const fakes = segs.flatMap(s => s.fakes.map(f => ({ lat: f.lat, lon: f.lon, t: f.t, fake: true, synthetic: f.dashed === 1 })));
const combined = [...pts.map(p => ({ lat: p.lat, lon: p.lon, t: p.t, tier: p.tier, speed: p.speed, fake: false, synthetic: false })), ...fakes].sort((a, b) => a.t - b.t);

let defects = 0, maxPen = 0;
for (const journey of splitJourneys(dedup(combined))) {
  for (const s of catmullRom(journey)) {
    if (pointInAnyLand([s.lat, s.lon]) < 0) continue;
    if (onLandInputs.some(r => haversineKm(r.lat, r.lon, s.lat, s.lon) < NEAR_REAL_KM)) continue;
    const idx = pointInAnyLand([s.lat, s.lon]);
    const penM = penetrationKm([s.lat, s.lon]) * 1000;
    maxPen = Math.max(maxPen, penM);
    if (penM > (idx >= FINE ? COARSE_MAX_PEN_M : FINE_MAX_PEN_M)) defects++;
  }
}

console.log(`scenario: ${pts.length} fixes, ${segs.length} routed legs, ${fakes.length} inferred waypoints`);
console.log(`inputs on land: ${onLandInputs.length ? onLandInputs.map(p => p.name).join(', ') : 'none'}`);
console.log(`spline land defects: ${defects}  maxPenetration: ${maxPen.toFixed(0)}m`);

if (onLandInputs.length > 0) { console.error(`\nFAIL: ${onLandInputs.length} scenario fix(es) are on land — move them to navigable water.`); process.exit(1); }
if (defects > 0) { console.error(`\nFAIL: ${defects} routed spline sample(s) cross land — the corridor isn't water-tight.`); process.exit(1); }
console.log('\nMulti-leg corridor routes water-tight: Fraser → Tacoma → Columbia/Portland approach → SF → LA.');
