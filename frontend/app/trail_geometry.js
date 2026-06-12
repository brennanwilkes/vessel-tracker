// Land-aware half of the trail pipeline — denoise real fixes, splice water-routed
// (A*) waypoints into land-crossing gaps, repair spline bulges off land. Imports
// geo math + region-aware coastline + config, so this module is for NODE (the
// precompute cron) and tests only; the BROWSER imports the pure half
// (trail_spline.js) and renders precomputed points without loading coastline data.
//
//   dedup → split journeys at stops → per journey: denoise real points, splice
//   water-routed waypoints into land-crossing gaps, repair spline bulges off
//   land → one centripetal Catmull-Rom → runs grouped by real/inferred.
//
// See frontend/CLAUDE.md "Trail rendering & land avoidance" for the design and
// the core "trust the boat" principle.
import { haversineKm, bearingDeg, routeWater } from './geo.js';
import { isLand } from './region_coast.js';
import { LAND_AVOIDANCE, ROUTE_SMOOTHING, NARROW_WEIGHT } from '../config.js';
import { dedup, splitJourneys, catmullRom, runsBySynthetic, simplifyForSpline, SPLINE_SAMPLES, DEDUP_KM } from './trail_spline.js';

// Re-export the pure pipeline pieces so existing callers/tests that import them
// from here keep working (the browser should import them from trail_spline.js).
export { dedup, splitJourneys, catmullRom, runsBySynthetic, simplifyForSpline } from './trail_spline.js';

// Land/water geometry is owned by region_coast.js, which is REGION-AWARE: inside a
// lazily-loaded fine region (loaded via ensureRegionsForExtent before routing a trail)
// that region's geometry overrides the coarse layer, so shipping waterways stay open.
// `isLand` is imported directly; the two helpers below sample it for segments and pass
// it into routeWater so the A* grid uses the same region-aware test.
const crossesLand = (a, b, stepKm = 1) => {
  const n = Math.max(2, Math.ceil(haversineKm(a[0], a[1], b[0], b[1]) / stepKm));
  for (let s = 0; s <= n; s++) { const f = s / n; if (isLand(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f)) return true; }
  return false;
};
const routeAroundLand = (a, b, narrowWeight, entryBearing, exitBearing) => routeWater(a, b, null, null, { isLand, narrowWeight, entryBearing, exitBearing });

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

// Build the spline control points for one journey: denoised real fixes, with
// smoothed water-routed waypoints spliced into every land-crossing gap. Each
// control point carries its time and whether it's an inferred (synthetic) waypoint.
export function buildControlPoints(journey, route = true, narrowWeight, doDenoise = true) {
  const real = doDenoise ? denoise(journey) : journey.map(p => [p.lat, p.lon]);
  const ctrl = [{ lat: real[0][0], lon: real[0][1], t: journey[0].t, synthetic: false, fake: false }];
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
      // Bias A* to leave/arrive along the boat's real course either side of the
      // gap (the COG just outside it) so it doesn't backtrack against the boat's
      // heading — that read as a sharp kink at the real→inferred boundary.
      const entryBearing = i >= 2 ? bearingDeg(real[i - 2][0], real[i - 2][1], a[0], a[1]) : undefined;
      const exitBearing = i + 1 < real.length ? bearingDeg(b[0], b[1], real[i + 1][0], real[i + 1][1]) : undefined;
      const raw = routeAroundLand(a, b, narrowWeight, entryBearing, exitBearing);
      if (raw && raw.length > 2) {
        const wp = smoothRoute(raw);
        const t0 = journey[i - 1].t, t1 = journey[i].t;
        for (let k = 1; k < wp.length - 1; k++) {
          ctrl.push({ lat: wp[k][0], lon: wp[k][1], t: t0 + (t1 - t0) * (k / (wp.length - 1)), synthetic: true, fake: true });
        }
      }
    }
    ctrl.push({ lat: b[0], lon: b[1], t: journey[i].t, synthetic: false, fake: false });
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
            mids.push({ lat: wp[k][0], lon: wp[k][1], t: c0.t + (c1.t - c0.t) * (k / (wp.length - 1)), synthetic: inferred, fake: true });
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
          synthetic: c0.synthetic || c1.synthetic, fake: true,
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

// Narrow-channel penalty scales with vessel size: big ships hold the main
// channel (Fraser), small craft dart through tight Gulf Island passages.
// Linear in length between the configured bounds; null/unknown length → default.
function narrowWeightFor(len) {
  const NW = NARROW_WEIGHT;
  return (len === null || len === undefined) ? NW.default
    : len <= NW.minLenM ? NW.small
    : len >= NW.maxLenM ? NW.large
    : NW.small + (NW.large - NW.small) * (len - NW.minLenM) / (NW.maxLenM - NW.minLenM);
}

// Land-aware control points per journey (denoised reals + routed/repaired
// synthetic waypoints), ready to spline. Used by the server precompute, which
// harvests the synthetic points to store. Always routes (A*); the browser never
// calls this — it renders precomputed points via trail_spline.catmullRom.
export function computeControlPoints(allPoints, opts = {}) {
  const narrowWeight = narrowWeightFor(opts.vesselLength);
  // The precompute passes denoise:false so the routed/repaired control set is
  // built over RAW real fixes — the same fixes the browser receives from /track.
  // The client can't denoise (no coastline), so matching it here keeps the stored
  // fakes and the client's re-splined curve in agreement (and water-tight).
  const doDenoise = opts.denoise !== false;
  const journeys = [];
  for (const journey of splitJourneys(dedup(allPoints))) {
    if (journey.length < 2) continue;
    const ctrl = repairOffLand(buildControlPoints(journey, true, narrowWeight, doDenoise), undefined, narrowWeight);
    journeys.push({ controls: ctrl });
  }
  return journeys;
}

// Harvest the inferred (fake) waypoints to store server-side. Runs the full
// land-aware pipeline, then for each maximal run of inserted (`fake`) control
// points — bracketed by two real fixes — reduces it to the FEWEST points
// (simplifyForSpline, land-tight) whose spline still keeps the curve off land.
// Returns one entry per inferred SEGMENT: the bracketing real timestamps (which
// the script hashes into a stable per-segment key + uses to inherit a tier) and
// the kept fake points. Only the fakes are stored; the client already has the
// reals from /track and re-splines the union with pure math (no coastline).
export function harvestInferredSegments(allPoints, opts = {}) {
  const segments = [];
  for (const { controls } of computeControlPoints(allPoints, { ...opts, denoise: false })) {
    let i = 0;
    while (i < controls.length) {
      if (!controls[i].fake) { i++; continue; }
      const runStart = i;
      while (i < controls.length && controls[i].fake) i++;
      const before = controls[runStart - 1];   // always real — controls[0] is real
      const after = controls[i];                // always real — controls[last] is real
      if (!before || !after) continue;
      const segCtrl = [before, ...controls.slice(runStart, i), after];
      const kept = simplifyForSpline(segCtrl, isLand);
      const fakes = kept
        .filter(c => c.fake)
        .map(c => ({ lat: c.lat, lon: c.lon, t: c.t, dashed: c.synthetic ? 1 : 0 }));
      if (fakes.length > 0) segments.push({ aT: before.t, bT: after.t, fakes });
    }
  }
  return segments;
}

// Top-level: chronological points → styled spline runs. route=false skips A*
// (instant straight bridges) for the first paint; route=true does the full
// water-routing + repair.
export function computeRuns(allPoints, route, opts = {}) {
  const narrowWeight = narrowWeightFor(opts.vesselLength);
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
