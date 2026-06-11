// Trail geometry pipeline — pure, DOM-free, no Leaflet. Turns chronological AIS
// points into smooth, water-tight spline runs. Shared by map_page.js (main
// thread + Web Worker) and the server-side precompute cron, so it imports only
// geo math + coastline + config.
//
//   dedup → split journeys at stops → per journey: denoise real points, splice
//   water-routed waypoints into land-crossing gaps, repair spline bulges off
//   land → one centripetal Catmull-Rom → runs grouped by real/inferred.
//
// See frontend/CLAUDE.md "Trail rendering & land avoidance" for the design and
// the core "trust the boat" principle.
import { haversineKm, routeWater, segmentCrossesLand, pointOnLand } from './geo.js';
import { getLand, getLandBboxes, getWater, getWaterBboxes } from './region_coast.js';
import { MOVING_SPEED_KN, TRAIL_GAP_SEVER_MS, LAND_AVOIDANCE, ROUTE_SMOOTHING, NARROW_WEIGHT } from '../config.js';

// Geometry (home OSM coast + coarse continental + home water, plus any lazily-loaded
// foreign regions) is owned by region_coast.js. We read it live via getters so a
// region appended by `ensureRegionsForExtent` (call it before routing a trail whose
// extent reaches a foreign port) is picked up here without re-importing.
//
// Bound land/water helpers — the layered land test (coastline minus water rivers/
// harbours, plus the coarse continental fallback) lives behind these so every call
// site stays consistent. See geo.js.
const isLand = (lat, lon) => pointOnLand(lat, lon, getLand(), getLandBboxes(), getWater(), getWaterBboxes());
const crossesLand = (a, b, stepKm) => segmentCrossesLand(a, b, getLand(), getLandBboxes(), stepKm, getWater(), getWaterBboxes());
const routeAroundLand = (a, b, narrowWeight) => routeWater(a, b, getLand(), getLandBboxes(), { waterPolygons: getWater(), waterBboxes: getWaterBboxes(), narrowWeight });

const SPLINE_SAMPLES = 12;

// Drop consecutive fixes closer than this. Duplicate/near-duplicate AIS reports
// otherwise make centripetal Catmull-Rom divide by ~0 and spike.
const DEDUP_KM = 0.02;

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
export function splitJourneys(points) {
  const journeys = [];
  let cur = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const gap = points[i].t - points[i - 1].t;
    const sever = TRAIL_GAP_SEVER_MS[points[i - 1].tier] ?? TRAIL_GAP_SEVER_MS.local;
    const parked = (points[i - 1].speed ?? 0) <= MOVING_SPEED_KN;
    if (sever !== null && gap > sever && parked) { journeys.push(cur); cur = [points[i]]; }
    else cur.push(points[i]);
  }
  journeys.push(cur);
  return journeys;
}

// cos-weighted Laplacian denoise of real AIS positions. A point that would move
// onto land (smoothing toward a neighbor-midpoint near a concave shore) keeps
// its original position. Returns [lat,lon] parallel to the input.
function denoise(points, passes = 2, factor = 0.2) {
  let cur = points.map(p => [p.lat, p.lon]);
  for (let pass = 0; pass < passes; pass++) {
    const next = [cur[0]];
    for (let i = 1; i < cur.length - 1; i++) {
      const [ax, ay] = cur[i - 1], [bx, by] = cur[i], [cx, cy] = cur[i + 1];
      const dx1 = bx - ax, dy1 = by - ay, dx2 = cx - bx, dy2 = cy - by;
      const l1 = Math.hypot(dx1, dy1), l2 = Math.hypot(dx2, dy2);
      if (l1 < 1e-10 || l2 < 1e-10) { next.push(cur[i]); continue; }
      const cos = (dx1 * dx2 + dy1 * dy2) / (l1 * l2);
      const t = Math.max(cos, 0) * factor;
      const moved = [bx + (((ax + cx) / 2) - bx) * t, by + (((ay + cy) / 2) - by) * t];
      next.push(isLand(moved[0], moved[1]) ? cur[i] : moved);
    }
    next.push(cur[cur.length - 1]);
    cur = next;
  }
  return cur;
}

// Turn a raw A*+string-pull water path (sparse and angular — shortest-path has
// no notion of a vessel's turning radius, so spliced raw it kinks hard where it
// meets the real track) into a physically-plausible inferred path. Densify to
// ~uniform spacing, then Laplacian-relax toward the neighbour-midpoint with the
// endpoints pinned and every moved point land-checked. Corners round out as much
// as the surrounding water allows and stay sharp ONLY where the channel forces
// the turn — the inferred curve never shows a turn a boat couldn't make, yet
// stays water-tight (a move onto land is rejected, the same "trust the water"
// guard as denoise). Returns [[lat,lon], …] including the pinned endpoints.
function smoothRoute(wp) {
  if (wp.length < 3) return wp;
  let totalKm = 0;
  for (let i = 1; i < wp.length; i++) totalKm += haversineKm(wp[i - 1][0], wp[i - 1][1], wp[i][0], wp[i][1]);
  const stepKm = Math.max(ROUTE_SMOOTHING.minStepKm, totalKm / ROUTE_SMOOTHING.targetPoints);

  const dense = [wp[0]];
  for (let i = 1; i < wp.length; i++) {
    const [ay, ax] = wp[i - 1], [by, bx] = wp[i];
    const n = Math.max(1, Math.round(haversineKm(ay, ax, by, bx) / stepKm));
    for (let k = 1; k <= n; k++) dense.push([ay + (by - ay) * k / n, ax + (bx - ax) * k / n]);
  }
  if (dense.length < 3) return dense;

  let cur = dense;
  const f = ROUTE_SMOOTHING.factor;
  // A move is accepted only if BOTH polyline segments it touches stay clear of
  // land (not just the point itself) — relaxing toward the chord erodes the
  // clearance A* left, so a point-only check would let the curve bulge ashore.
  const moveClear = (prev, p, next) => !isLand(p[0], p[1])
    && !crossesLand(prev, p, 0.1) && !crossesLand(p, next, 0.1);
  for (let pass = 0; pass < ROUTE_SMOOTHING.passes; pass++) {
    const next = [cur[0]];
    for (let i = 1; i < cur.length - 1; i++) {
      const my = cur[i][0] + (((cur[i - 1][0] + cur[i + 1][0]) / 2) - cur[i][0]) * f;
      const mx = cur[i][1] + (((cur[i - 1][1] + cur[i + 1][1]) / 2) - cur[i][1]) * f;
      next.push(moveClear(cur[i - 1], [my, mx], cur[i + 1]) ? [my, mx] : cur[i]);
    }
    next.push(cur[cur.length - 1]);
    cur = next;
  }
  return cur;
}

// A point dKm beyond `to`, continuing the heading from→to (equirectangular-local).
// Used to anchor the inferred path's exit/entry to the real course either side of
// a gap, so the spline leaves/joins the real track tangentially instead of kinking.
function stepBeyond(from, to, dKm) {
  const ky = 111.32, kx = 111.32 * Math.cos(to[0] * Math.PI / 180);
  let vx = (to[1] - from[1]) * kx, vy = (to[0] - from[0]) * ky;
  const m = Math.hypot(vx, vy);
  if (m < 1e-9) return null;
  return [to[0] + (vy / m) * dKm / ky, to[1] + (vx / m) * dKm / kx];
}

// Build the spline control points for one journey: denoised real fixes, with
// smoothed water-routed waypoints spliced into every land-crossing gap. Each
// control point carries its time and whether it's an inferred (synthetic) waypoint.
export function buildControlPoints(journey, route = true, narrowWeight) {
  const real = denoise(journey);
  const ctrl = [{ lat: real[0][0], lon: real[0][1], t: journey[0].t, synthetic: false }];
  for (let i = 1; i < real.length; i++) {
    const a = real[i - 1], b = real[i];
    // Route around land only across a real data GAP (lost signal). Dense
    // tracking that nicks land is the vessel's true path through complex
    // nearshore water — routing every such segment over-inserts waypoints and
    // makes the spline diverge (Vancouver/Fraser delta). Spline bulges in dense
    // stretches are handled by repairOffLand instead. `route` is false for the
    // instant first-paint pass (no A*).
    const isGap = (journey[i].t - journey[i - 1].t) > LAND_AVOIDANCE.gapMinMs || haversineKm(a[0], a[1], b[0], b[1]) > LAND_AVOIDANCE.gapMinKm;
    if (route && isGap && crossesLand(a, b)) {
      const raw = routeAroundLand(a, b, narrowWeight);
      if (raw && raw.length > 2) {
        // Anchor the inferred path's exit/entry to the boat's real heading just
        // outside the gap (a real vessel leaves its course gradually, not in a
        // kink at the first A* waypoint). The anchor sits a short step beyond the
        // endpoint along that heading; only kept if it lands in clear water.
        const dKm = Math.max(0.5, Math.min(3, haversineKm(a[0], a[1], b[0], b[1]) * 0.15));
        const anchorA = i >= 2 ? stepBeyond(real[i - 2], a, dKm) : null;
        const anchorB = i + 1 < real.length ? stepBeyond(real[i + 1], b, dKm) : null;
        if (anchorA && !crossesLand(a, anchorA, 0.1)) raw.splice(1, 0, anchorA);
        if (anchorB && !crossesLand(b, anchorB, 0.1)) raw.splice(raw.length - 1, 0, anchorB);
        const wp = smoothRoute(raw);
        const t0 = journey[i - 1].t, t1 = journey[i].t;
        for (let k = 1; k < wp.length - 1; k++) {
          ctrl.push({ lat: wp[k][0], lon: wp[k][1], t: t0 + (t1 - t0) * (k / (wp.length - 1)), synthetic: true });
        }
      }
    }
    ctrl.push({ lat: b[0], lon: b[1], t: journey[i].t, synthetic: false });
  }
  // Splicing in/out routes through a narrow feature can leave near-duplicate
  // control points; collapse them so the spline doesn't spike.
  const out = [ctrl[0]];
  for (let i = 1; i < ctrl.length; i++) {
    const p = out[out.length - 1];
    if (haversineKm(p.lat, p.lon, ctrl[i].lat, ctrl[i].lon) > DEDUP_KM) out.push(ctrl[i]);
  }
  return out;
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

// Find the nearest water point to an on-land point, then step a little further
// into water so the re-splined curve clears the shore. Spiral ring search.
function nearestWaterBeyond(lat, lon) {
  const marginKm = 0.2;
  for (let radKm = 0.1; radKm <= 3; radKm += 0.1) {
    const dLat = radKm / 111.32, dLon = radKm / (111.32 * Math.cos(lat * Math.PI / 180));
    for (let a = 0; a < 24; a++) {
      const th = a / 24 * 2 * Math.PI;
      const wlat = lat + dLat * Math.sin(th), wlon = lon + dLon * Math.cos(th);
      if (!isLand(wlat, wlon)) {
        const ext = (radKm + marginKm) / radKm;
        return [lat + dLat * Math.sin(th) * ext, lon + dLon * Math.cos(th) * ext];
      }
    }
  }
  return null;
}

// Repair land-crossing spline runs. Re-spline; for each run of output samples
// on land, look at the control points bracketing it. Trust the boat: if a
// bracketing control is itself on our "land" our coastline is wrong there (a
// river simplified/absent) — skip, don't fight it. Else if their chord crosses
// land the vessel genuinely went around something — replace the bracketed
// controls with a routeWater (A*) water path; else it's a pure spline bulge
// across a clear chord — insert a nearest-water control to pull the curve off.
// Bounded passes, monotonic (keeps the pass with fewest land samples, never
// returns worse — repair can diverge in very tight harbours like Victoria's).
export function repairOffLand(ctrl, maxPasses = 6, narrowWeight) {
  const landCount = (c) => {
    const sm = catmullRom(c, SPLINE_SAMPLES);
    let n = 0;
    for (const s of sm) if (isLand(s.lat, s.lon)) n++;
    return n;
  };
  let best = ctrl.slice(), bestLand = landCount(ctrl);

  for (let pass = 0; pass < maxPasses && bestLand > 0; pass++) {
    const sm = catmullRom(ctrl, SPLINE_SAMPLES);
    const runs = [];
    let runStart = -1;
    for (let i = 0; i <= sm.length; i++) {
      const onLand = i < sm.length && isLand(sm[i].lat, sm[i].lon);
      if (onLand && runStart < 0) runStart = i;
      else if (!onLand && runStart >= 0) { runs.push([runStart, i - 1]); runStart = -1; }
    }
    if (runs.length === 0) break;

    // Apply edits back-to-front so control indices stay valid.
    let changed = false;
    for (let r = runs.length - 1; r >= 0; r--) {
      const [a, b] = runs[r];
      const segA = Math.min(ctrl.length - 2, Math.floor(a / SPLINE_SAMPLES));
      const segB = Math.min(ctrl.length - 2, Math.floor(b / SPLINE_SAMPLES));
      const c0 = ctrl[segA], c1 = ctrl[segB + 1];
      if (isLand(c0.lat, c0.lon) || isLand(c1.lat, c1.lon)) continue;
      if (crossesLand([c0.lat, c0.lon], [c1.lat, c1.lon])) {
        const raw = routeAroundLand([c0.lat, c0.lon], [c1.lat, c1.lon], narrowWeight);
        if (raw && raw.length > 2) {
          const wp = smoothRoute(raw);
          const inferred = c0.synthetic || c1.synthetic;
          const mids = [];
          for (let k = 1; k < wp.length - 1; k++) {
            mids.push({ lat: wp[k][0], lon: wp[k][1], t: c0.t + (c1.t - c0.t) * (k / (wp.length - 1)), synthetic: inferred });
          }
          ctrl.splice(segA + 1, segB - segA, ...mids); // replace bracketed controls with the water path
          changed = true;
          continue;
        }
      }
      const mid = (a + b) >> 1;
      const water = nearestWaterBeyond(sm[mid].lat, sm[mid].lon);
      if (water) {
        const frac = (mid - segA * SPLINE_SAMPLES) / SPLINE_SAMPLES;
        ctrl.splice(segA + 1, 0, {
          lat: water[0], lon: water[1],
          t: c0.t + (c1.t - c0.t) * Math.max(0, Math.min(1, frac)),
          synthetic: c0.synthetic || c1.synthetic,
        });
        changed = true;
      }
    }
    if (!changed) break;
    const land = landCount(ctrl);
    if (land < bestLand) { bestLand = land; best = ctrl.slice(); }
    else break; // a pass that didn't improve → stop and keep the best
  }
  return best;
}

// Cheap estimate of how much a trail needs routed enrichment: total km of
// land-crossing data gaps (coarse-sampled — gaps only, not the whole track).
// Used to enrich the "worst" ships first. No A*, no spline — fast.
export function gapEnrichmentScore(allPoints) {
  let score = 0;
  for (const journey of splitJourneys(dedup(allPoints))) {
    for (let i = 1; i < journey.length; i++) {
      const a = journey[i - 1], b = journey[i];
      const gapKm = haversineKm(a.lat, a.lon, b.lat, b.lon);
      if ((b.t - a.t) <= LAND_AVOIDANCE.gapMinMs && gapKm <= LAND_AVOIDANCE.gapMinKm) continue;
      if (crossesLand([a.lat, a.lon], [b.lat, b.lon], 5)) score += gapKm;
    }
  }
  return score;
}

// Top-level: chronological points → styled spline runs. route=false skips A*
// (instant straight bridges) for the first paint; route=true does the full
// water-routing + repair.
export function computeRuns(allPoints, route, opts = {}) {
  // Narrow-channel penalty scales with vessel size: big ships hold the main
  // channel (Fraser), small craft dart through tight Gulf Island passages.
  // Linear in length between the configured bounds; null length → default.
  const len = opts.vesselLength;
  const NW = NARROW_WEIGHT;
  const narrowWeight = (len === null || len === undefined) ? NW.default
    : len <= NW.minLenM ? NW.small
    : len >= NW.maxLenM ? NW.large
    : NW.small + (NW.large - NW.small) * (len - NW.minLenM) / (NW.maxLenM - NW.minLenM);

  const runs = [];
  for (const journey of splitJourneys(dedup(allPoints))) {
    if (journey.length < 2) continue;
    let ctrl = buildControlPoints(journey, route, narrowWeight);
    if (route) ctrl = repairOffLand(ctrl, undefined, narrowWeight);
    for (const run of runsBySynthetic(catmullRom(ctrl))) {
      if (run.samples.length >= 2) runs.push(run);
    }
  }
  return runs;
}
