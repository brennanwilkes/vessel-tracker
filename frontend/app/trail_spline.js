// Pure, coastline-free half of the trail pipeline. Everything here is plain
// geometry over chronological point arrays — no land/water tests, no A*, no
// region loading — so the BROWSER can import it without shipping any coastline
// data. The land-aware half (denoise, smoothRoute, routeWater splicing,
// repairOffLand) lives in trail_geometry.js and is imported only by the Node
// precompute (worker/scripts/precompute-trails.mjs).
//
//   dedup → splitJourneys → catmullRom → runsBySynthetic
//
// plus simplifyForSpline, used by the precompute to store the fewest waypoints
// whose spline still reproduces a routed segment. See frontend/CLAUDE.md.
import { haversineKm } from './geo.js';
import { MOVING_SPEED_KN, TRAIL_GAP_SEVER_MS, TRAIL_SIMPLIFY } from '../config.js';

export const SPLINE_SAMPLES = 12;

// Drop consecutive fixes closer than this. Duplicate/near-duplicate AIS reports
// otherwise make centripetal Catmull-Rom divide by ~0 and spike.
export const DEDUP_KM = 0.02;

export function dedup(points) {
  if (points.length === 0) return points;
  const out = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const p = out[out.length - 1];
    if (haversineKm(p.lat, p.lon, points[i].lat, points[i].lon) > DEDUP_KM) out.push(points[i]);
  }
  return out;
}

// Break the trail into journeys at stops only: the vessel was stationary at its
// last fix (speed ~0) and then a long gap followed — it parked and we lost it.
// Wherever it resurfaces starts a fresh journey/curve. A vessel still moving
// when signal dropped stays in one journey so the spline bridges the gap
// continuously (the derivative stays continuous across the bridge).
//
// A break can ONLY fall between two adjacent REAL fixes. When the client streams
// the combined real+precomputed track, an inferred (`fake`) waypoint sits inside
// a gap the server already chose to bridge — so two reals separated by fakes are
// no longer adjacent and the gap is (correctly) not severed. All-real input has
// `fake` undefined, so this is a no-op for the server/tests.
export function splitJourneys(points) {
  const journeys = [];
  let cur = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const gap = points[i].t - points[i - 1].t;
    const sever = TRAIL_GAP_SEVER_MS[points[i - 1].tier] ?? TRAIL_GAP_SEVER_MS.local;
    const parked = (points[i - 1].speed ?? 0) <= MOVING_SPEED_KN;
    const realPair = !points[i].fake && !points[i - 1].fake;
    if (realPair && sever !== null && gap > sever && parked) { journeys.push(cur); cur = [points[i]]; }
    else cur.push(points[i]);
  }
  journeys.push(cur);
  return journeys;
}

// Centripetal Catmull-Rom spline (α=0.5) over a whole journey's control points
// (one spline ⇒ continuous derivative everywhere, including real→inferred
// transitions). Each output sample carries an interpolated time and the
// inferred flag of the segment it lies on (either endpoint synthetic), for styling.
export function catmullRom(ctrl, samples = SPLINE_SAMPLES) {
  if (ctrl.length < 2) return ctrl.map(c => ({ lat: c.lat, lon: c.lon, t: c.t, synthetic: c.synthetic }));

  const knot = (t, a, b) => Math.pow(Math.max(Math.hypot(b.lat - a.lat, b.lon - a.lon), 1e-10), 0.5) + t;
  const mirror = (a, b) => ({ lat: 2 * a.lat - b.lat, lon: 2 * a.lon - b.lon });
  const out = [];

  for (let i = 0; i < ctrl.length - 1; i++) {
    const p0 = i > 0 ? ctrl[i - 1] : mirror(ctrl[0], ctrl[1]);
    const p1 = ctrl[i], p2 = ctrl[i + 1];
    const p3 = i < ctrl.length - 2 ? ctrl[i + 2] : mirror(ctrl[ctrl.length - 1], ctrl[ctrl.length - 2]);
    const t0 = 0, t1 = knot(t0, p0, p1), t2 = knot(t1, p1, p2), t3 = knot(t2, p2, p3);
    const inferred = p1.synthetic || p2.synthetic;

    for (let j = 0; j < samples; j++) {
      const t = t1 + (t2 - t1) * (j / samples);
      const lat = catmull('lat', p0, p1, p2, p3, t, t0, t1, t2, t3);
      const lon = catmull('lon', p0, p1, p2, p3, t, t0, t1, t2, t3);
      out.push({ lat, lon, t: p1.t + (p2.t - p1.t) * (j / samples), synthetic: inferred });
    }
  }
  const lastC = ctrl[ctrl.length - 1];
  out.push({ lat: lastC.lat, lon: lastC.lon, t: lastC.t, synthetic: lastC.synthetic });
  return out;
}

// Barry-Goldman pyramidal evaluation of one coordinate of the centripetal spline.
function catmull(k, p0, p1, p2, p3, t, t0, t1, t2, t3) {
  const A1 = p0[k] + (p1[k] - p0[k]) * (t - t0) / (t1 - t0);
  const A2 = p1[k] + (p2[k] - p1[k]) * (t - t1) / (t2 - t1);
  const A3 = p2[k] + (p3[k] - p2[k]) * (t - t2) / (t3 - t2);
  const B1 = A1 + (A2 - A1) * (t - t0) / (t2 - t0);
  const B2 = A2 + (A3 - A2) * (t - t1) / (t3 - t1);
  return B1 + (B2 - B1) * (t - t1) / (t2 - t1);
}

// Split spline samples into contiguous runs of equal `synthetic` flag so each
// run can be styled (solid for real tracking, dashed/faint for inferred gaps).
// Runs overlap by one sample at boundaries so there is no visual seam.
export function runsBySynthetic(samples) {
  const runs = [];
  let start = 0;
  for (let i = 1; i <= samples.length; i++) {
    if (i === samples.length || samples[i].synthetic !== samples[start].synthetic) {
      runs.push({ synthetic: samples[start].synthetic, samples: samples.slice(start, Math.min(i + 1, samples.length)) });
      start = i;
    }
  }
  return runs;
}

// Distance (km) from p to a polyline of [{lat,lon}] samples, equirectangular-local.
function pointToPolylineKm(p, poly) {
  const ky = 111.32, kx = 111.32 * Math.cos(p.lat * Math.PI / 180);
  const px = p.lon * kx, py = p.lat * ky;
  let best = Infinity;
  for (let i = 1; i < poly.length; i++) {
    const ax = poly[i - 1].lon * kx, ay = poly[i - 1].lat * ky;
    const bx = poly[i].lon * kx, by = poly[i].lat * ky;
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    let t = L2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
    t = Math.max(0, Math.min(1, t));
    best = Math.min(best, Math.hypot(px - (ax + t * dx), py - (ay + t * dy)));
  }
  return best;
}

// Reduce a routed segment's control points to the FEWEST whose Catmull-Rom
// spline still reproduces the full-resolution curve (within TRAIL_SIMPLIFY.tolKm)
// AND stays off land. The precompute stores only the interior (synthetic) points
// of the result, so storage stays minimal (D1 write budget) while the client —
// which re-splines with pure math, no coastline — still draws the right curve.
//
// `ctrl` is the segment in order: [realA, …synthetics…, realB]. Both real
// endpoints are always kept (the client already has them from /track); they are
// the spline's local context. Greedy: start from the endpoints, repeatedly add
// the dropped control nearest the worst-deviating reference sample until the
// candidate spline is within tolerance, then (if `isLandFn` given) add back any
// control bracketing a sample that still lands on land.
export function simplifyForSpline(ctrl, isLandFn = null) {
  if (ctrl.length <= 2) return ctrl.slice();
  const tolKm = TRAIL_SIMPLIFY.tolKm;
  const reference = catmullRom(ctrl);

  const chosen = new Set([0, ctrl.length - 1]);
  const candidateSpline = () => catmullRom(ctrl.filter((_, i) => chosen.has(i)));

  const worstDroppedIndex = (spline) => {
    let worst = -1, worstDev = 0;
    for (const s of reference) {
      const dev = pointToPolylineKm(s, spline);
      if (dev <= worstDev) continue;
      // The control nearest this worst-deviating sample is the one to add back.
      let near = -1, nearKm = Infinity;
      for (let i = 1; i < ctrl.length - 1; i++) {
        if (chosen.has(i)) continue;
        const d = haversineKm(ctrl[i].lat, ctrl[i].lon, s.lat, s.lon);
        if (d < nearKm) { nearKm = d; near = i; }
      }
      if (near >= 0) { worstDev = dev; worst = near; }
    }
    return { worst, worstDev };
  };

  // Greedy add until within tolerance.
  for (let guard = 0; guard < ctrl.length; guard++) {
    const { worst, worstDev } = worstDroppedIndex(candidateSpline());
    if (worstDev <= tolKm || worst < 0) break;
    chosen.add(worst);
  }

  // Land-tight guard: never let simplification push the curve onto land. Add
  // back the dropped control nearest any on-land sample until clear (or full).
  if (isLandFn !== null) {
    for (let guard = 0; guard < ctrl.length; guard++) {
      const spline = candidateSpline();
      let onLand = null;
      for (const s of spline) if (isLandFn(s.lat, s.lon)) { onLand = s; break; }
      if (onLand === null) break;
      let near = -1, nearKm = Infinity;
      for (let i = 1; i < ctrl.length - 1; i++) {
        if (chosen.has(i)) continue;
        const d = haversineKm(ctrl[i].lat, ctrl[i].lon, onLand.lat, onLand.lon);
        if (d < nearKm) { nearKm = d; near = i; }
      }
      if (near < 0) break;
      chosen.add(near);
    }
  }

  return ctrl.filter((_, i) => chosen.has(i));
}
