// Trail-geometry regression test. Runs the REAL production pipeline
// (map_page.js: dedup → splitJourneys → buildControlPoints → catmullRom) over
// captured trails for the four vessels that used to break, and asserts the
// rendered spline is water-tight and smooth (continuous derivative).
//
//   node tests/trail.test.mjs
//
// Fixtures live in tests/fixtures/*.json (API-shaped: newest-first points).
import { readFileSync, readdirSync } from 'fs';
import { pointInAnyLand, LAND_POLYGONS } from './lib.mjs';
import { haversineKm, bearingDeg } from '../frontend/app/geo.js';

import { dedup, splitJourneys, buildControlPoints, repairOffLand, catmullRom } from '../frontend/app/trail_geometry.js';

// Acceptance thresholds.
const MAX_LAND_PENETRATION_M = 150;  // shallower clips are sub-pixel "grazes" in
                                     // the tightest inlets/harbours; deeper = a real defect
// Clips on the COARSE continental layer (coast_coarse.js, ~2 km simplify — polygon
// index >= FINE_COUNT) carry that layer's ~km positional uncertainty, so a graze there
// on a long open-ocean inferred segment isn't a routing defect, just coarse data.
const FINE_COUNT = LAND_POLYGONS.length;
const COARSE_MAX_PENETRATION_M = 2500;
// Fixtures whose residual defects are a known DATA-coverage limit, not a routing
// bug — they don't fail the suite but are still reported. See tests/README.md §1.
// (glovis-star — upper Fraser — graduated to PASS once the water-polygon layer
// landed: pointOnLand = inLand && !inWater. See worker/CLAUDE.md "Rivers & harbours".)
const KNOWN_DATA_LIMITED = {};
// Max distance the spline may stray from its control polyline. Catches the
// div-by-near-zero "spike" failure mode (old code threw 50–200 km excursions)
// without flagging genuine sharp turns or the wide curve-bulge of sparse
// long-gap detours, which are real and water-tight.
const MAX_OVERSHOOT_KM = 10;
// A spline point is allowed on land only within this radius of a real fix that
// is itself on/near land (out-of-coverage endpoints, docked positions).
const NEAR_REAL_LAND_KM = 1.5;
// Smoothness of the INFERRED (A*-routed) path: a real boat can't turn on a dime,
// so a sharp bend in the middle of an inferred stretch — away from any real fix —
// is a physically-impossible artifact (the old sparse-string-pull dogleg, 68–98°
// mid-channel). Genuine sharp turns happen AT a real fix (dock wiggle, a lone fix
// between long gaps) or where the channel forces a turn around land; those sit on
// or within FAR_FROM_REAL_KM of a real fix and are exempt. `smoothRoute` rounds
// the open-water doglegs out, so far-from-real turns must stay gentle.
const MAX_INFERRED_TURN_DEG = 60;
const FAR_FROM_REAL_KM = 2;

// Turn angle (deg) at b for a→b→c: 0 = straight, 180 = full reversal.
function turnDeg(a, b, c) {
  let d = Math.abs(bearingDeg(b.lat, b.lon, c.lat, c.lon) - bearingDeg(a.lat, a.lon, b.lat, b.lon)) % 360;
  return d > 180 ? 360 - d : d;
}

// Distance (km) from p to segment a→b, equirectangular-local.
function segDistKm(p, a, b) {
  const lat0 = (a.lat + b.lat) / 2 * Math.PI / 180, kx = 111.32 * Math.cos(lat0), ky = 111.32;
  const ax = a.lon * kx, ay = a.lat * ky, bx = b.lon * kx, by = b.lat * ky, px = p.lon * kx, py = p.lat * ky;
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  let t = L2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

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

let failures = 0;
for (const file of readdirSync(new URL('./fixtures/', import.meta.url)).filter(f => f.endsWith('.json')).sort()) {
  const fx = JSON.parse(readFileSync(new URL('./fixtures/' + file, import.meta.url)));
  const chronological = [...fx.points].reverse();
  const realOnLand = chronological.filter(p => pointInAnyLand([p.lat, p.lon]) >= 0);

  let splinePts = 0, defects = 0, maxOvershootKm = 0, maxPenM = 0, kinks = 0, maxFarTurn = 0;
  for (const journey of splitJourneys(dedup(chronological))) {
    if (journey.length < 2) continue;
    const ctrl = repairOffLand(buildControlPoints(journey));
    const reals = ctrl.filter(c => !c.synthetic);
    const smooth = catmullRom(ctrl);
    splinePts += smooth.length;

    // Inferred-path smoothness: a sharp bend far from any real fix is impossible.
    for (let i = 1; i < smooth.length - 1; i++) {
      const t = turnDeg(smooth[i - 1], smooth[i], smooth[i + 1]);
      if (t < MAX_INFERRED_TURN_DEG) continue;
      const nearReal = reals.some(r => haversineKm(r.lat, r.lon, smooth[i].lat, smooth[i].lon) <= FAR_FROM_REAL_KM);
      if (!nearReal) { maxFarTurn = Math.max(maxFarTurn, t); kinks++; }
    }

    for (const s of smooth) {
      // water-tightness
      const landIdx = pointInAnyLand([s.lat, s.lon]);
      if (landIdx >= 0) {
        // Tolerate clips that hug a real on/near-land fix (real data, not a defect).
        const nearReal = realOnLand.some(r => haversineKm(r.lat, r.lon, s.lat, s.lon) < NEAR_REAL_LAND_KM);
        if (!nearReal) {
          const penM = penetrationKm([s.lat, s.lon]) * 1000;
          maxPenM = Math.max(maxPenM, penM);
          const tol = landIdx >= FINE_COUNT ? COARSE_MAX_PENETRATION_M : MAX_LAND_PENETRATION_M;
          if (penM > tol) defects++;
        }
      }
      // overshoot (spike detection)
      let nearest = Infinity;
      for (let i = 1; i < ctrl.length; i++) nearest = Math.min(nearest, segDistKm(s, ctrl[i - 1], ctrl[i]));
      maxOvershootKm = Math.max(maxOvershootKm, nearest);
    }
  }

  const clean = defects === 0 && maxOvershootKm <= MAX_OVERSHOOT_KM && kinks === 0;
  const known = KNOWN_DATA_LIMITED[fx.name];
  const status = clean ? 'PASS' : (known ? 'KNOWN' : 'FAIL');
  if (!clean && !known) failures++;
  console.log(
    `${status}  ${fx.name.padEnd(16)} splinePts=${String(splinePts).padStart(4)} ` +
    `landDefects=${defects} maxPenetration=${maxPenM.toFixed(0)}m maxOvershoot=${maxOvershootKm.toFixed(1)}km ` +
    `inferredKinks=${kinks}${kinks ? ` (maxFarTurn=${maxFarTurn.toFixed(0)}°)` : ''}` +
    (status === 'KNOWN' ? `  (data-limited: ${known})` : '')
  );
}

if (failures > 0) { console.error(`\n${failures} fixture(s) failed.`); process.exit(1); }
console.log('\nAll trail fixtures water-tight and smooth.');
