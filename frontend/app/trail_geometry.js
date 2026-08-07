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
import { haversineKm, bearingDeg, routeWater, greatCirclePoints, compositeGreatCirclePoints, blendCourse } from './geo.js';
import { isLand, hasFineLand } from './region_coast.js';
import { LAND_AVOIDANCE, ROUTE_SMOOTHING, NARROW_WEIGHT, OCEAN_ROUTE } from '../config.js';
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
const routeAroundLand = (a, b, narrowWeight, entryBearing, exitBearing, cellKm) => routeWater(a, b, null, null, { isLand, narrowWeight, entryBearing, exitBearing, cellKm });

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
// Post-splice cleanup of an ASSEMBLED control list. Splicing a routed path in
// beside existing controls leaves two artifacts, and both must be cleared before
// the spline sees them:
//   1. NEAR-DUPLICATES — centripetal Catmull-Rom divides by ~0 and spikes.
//   2. REVERSALS — where consecutive routed segments join, the path can double
//      back on itself (10–40 m steps with a ~170° hairpin). Seen on approaches to
//      a berth: a moored vessel's fix sits on the WHARF, which is land at 25 m
//      coastline resolution, so routeWater's snapToWater can pick the channel on
//      the wrong side of a pier and the approach overshoots and returns.
// Only SYNTHETIC points are dropped — a real fix is ground truth and always
// stays — and a reversal is removed only when the bypass chord is itself clear
// of land, so this can never cut a corner across a headland. Repeats to a
// fixpoint: one reversal routinely hides the next.
function cleanControls(ctrl) {
  const collapsed = [ctrl[0]];
  for (let i = 1; i < ctrl.length; i++) {
    const p = collapsed[collapsed.length - 1];
    if (haversineKm(p.lat, p.lon, ctrl[i].lat, ctrl[i].lon) > DEDUP_KM) collapsed.push(ctrl[i]);
  }
  let cur = collapsed;
  for (let pass = 0; pass < ROUTE_SMOOTHING.backtrackPasses && cur.length >= 3; pass++) {
    const next = [cur[0]];
    let removed = 0;
    for (let i = 1; i < cur.length - 1; i++) {
      const c = cur[i];
      const prev = next[next.length - 1], after = cur[i + 1];
      let turn = Math.abs(bearingDeg(c.lat, c.lon, after.lat, after.lon)
                        - bearingDeg(prev.lat, prev.lon, c.lat, c.lon)) % 360;
      if (turn > 180) turn = 360 - turn;
      if (c.synthetic && turn > ROUTE_SMOOTHING.backtrackDeg
          && !crossesLand([prev.lat, prev.lon], [after.lat, after.lon], 0.1)) { removed++; continue; }
      next.push(c);
    }
    next.push(cur[cur.length - 1]);
    cur = next;
    if (removed === 0) break;
  }
  return cur;
}

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

// Ocean-scale gap router — resolution follows the WATER, not the gap length.
//
// One A* grid over a trans-Pacific gap is the wrong tool twice over: it spans a
// third of the planet (millions of cells, each running a full isLand polygon
// scan — this is what put the precompute cron at 1–2.5 h/run) and it spends all
// that work on open water where there is nothing to route around. But a plain
// bridge is wrong too: it cuts straight through whatever island or peninsula
// happens to lie between.
//
// So bi-segment the gap. Lay a great-circle spine (a ship's actual course, and
// it curves), classify each span of it as water or land, and hand ONLY the
// land-crossing stretches to A*. Each such stretch is short — a strait, an
// island, a cape — so `routeWater`'s own cell budget lands it at fine
// resolution, exactly where fine resolution buys something. The coastal ends of
// a long gap fall out of this for free: they are the stretches that hit land,
// so they get the fine treatment while the ocean middle stays a clean curve.
// Bi-segmentation assumes each blocked span is bracketed by water the vessel can
// actually sail between. That holds for an island or a cape, and fails completely
// when the great circle crosses a CONTINENT: the spine re-emerges into a different
// ocean, so A* is asked to sail from Oregon to the Gulf of Mexico and correctly
// finds nothing — leaving the spine to drive straight over North America. When any
// span fails, re-route the whole gap on one coarse grid, which is free to go around
// the landmass entirely (Columbia mouth → Panama: 41 pts, ~5 s, land-clean).
// Deliberately NOT smoothed — same reason the spine isn't (see caller).
function routeWholeOceanGap(a, b, narrowWeight, totalKm) {
  const marginKm = Math.max(LAND_AVOIDANCE.oceanMarginMinKm, totalKm);
  const cellKm = Math.max(LAND_AVOIDANCE.coarseCellKm,
    (totalKm + 2 * marginKm) / LAND_AVOIDANCE.oceanMaxCellsPerSide);
  return routeWater(a, b, null, null, {
    isLand, narrowWeight, marginKm, cellKm,
    headingKm: Math.max(4, cellKm * LAND_AVOIDANCE.oceanHeadingCells),
  });
}

export function routeOceanGap(a, b, narrowWeight, entryBearing, exitBearing) {
  const totalKm = haversineKm(a[0], a[1], b[0], b[1]);
  // Shape the spine BEFORE classifying it: the latitude cap and the course blend
  // both move it, and anything they push onto land must still be routed around by
  // the A* pass below. See geo.compositeGreatCirclePoints / blendCourse.
  // Both ends blend, so on a gap barely over routeMaxKm the two would overlap and
  // compose into a shape neither end asked for. Give each half the gap at most.
  const blendKm = Math.min(OCEAN_ROUTE.blendKm, totalKm / 2);
  const n = Math.max(2, Math.ceil(totalKm / LAND_AVOIDANCE.spineStepKm));
  const spine = totalKm < OCEAN_ROUTE.shapeMinKm
    ? greatCirclePoints(a, b, n)
    : blendCourse(compositeGreatCirclePoints(a, b, n, OCEAN_ROUTE.maxLatDeg),
        entryBearing, exitBearing, Math.min(OCEAN_ROUTE.blendHoldKm, blendKm / 2), blendKm);

  // Land-crossing runs of spine SEGMENTS, widened by one vertex each side so the
  // routed sub-gap starts and ends in open water (A* needs water endpoints).
  const blocked = [];
  for (let i = 1; i < spine.length; i++) {
    const hits = crossesLand(spine[i - 1], spine[i], LAND_AVOIDANCE.spineStepKm / 20);
    if (!hits) continue;
    const last = blocked[blocked.length - 1];
    if (last && last[1] >= i - 1) last[1] = i;
    else blocked.push([i - 1, i]);
  }

  const onLand = (v) => isLand(v[0], v[1]);
  const out = [spine[0]];
  let cursor = 0;
  let unrouted = false;
  for (const [s0, s1] of blocked) {
    // Back the bracket out to open water. A spine vertex can land INSIDE the
    // obstacle (a 100 km step lands mid-peninsula), and A* needs water endpoints.
    let from = Math.max(cursor, s0 - 1), to = Math.min(spine.length - 1, s1 + 1);
    while (from > cursor && onLand(spine[from])) from--;
    while (to < spine.length - 1 && onLand(spine[to])) to++;
    // Widening one run can swallow the next: backing `to` out of a long
    // landmass advances the cursor past a later obstacle. Routing that
    // already-covered run would emit points going BACKWARDS along the spine,
    // which splices in as a hairpin (the 156° turns this fixture showed).
    if (to <= from) { unrouted = true; continue; }
    if (onLand(spine[from]) || onLand(spine[to])) { unrouted = true; continue; }
    for (let i = cursor + 1; i <= from; i++) out.push(spine[i]);
    // Resolution follows BOTH the data and the scale of the detour.
    //
    // A short bracket in fine coverage is an ordinary coastal gap — give it the
    // defaults and its harbour-grade threading. Anything else is a coastal- or
    // continental-scale swing: rounding the Olympic Peninsula to enter Juan de
    // Fuca, or clearing Kamchatka. Those need two things the defaults refuse.
    // First, room: the default margin caps a detour at 90 km, but the real
    // route here runs hundreds of km offshore, and with too little room A*
    // finds nothing at all — which is worse than a coarse route, because the
    // spine is then left driving straight over the peninsula. Second, a cell
    // size that keeps the resulting wide grid affordable; a vessel 50 km
    // offshore is not using 200 m detail, and where the data is the ~2 km
    // coarse layer that detail does not exist in the first place.
    const subKm = haversineKm(spine[from][0], spine[from][1], spine[to][0], spine[to][1]);
    const fine = (hasFineLand(spine[from][0], spine[from][1]) || hasFineLand(spine[to][0], spine[to][1]))
      && subKm <= LAND_AVOIDANCE.fineBracketMaxKm;
    // Bias A* to leave and rejoin along the spine's own direction — the same
    // fix, and the same reason, as the COG bias on a coastal gap: without it the
    // proximity cost can send the route backwards out of the endpoint to reach a
    // better-looking corridor, which splices into the spine as a hairpin. On a
    // coarse grid the bias has to act over a proportionally longer distance to
    // reach past the first cell.
    const entryBearing = from > 0 ? bearingDeg(spine[from - 1][0], spine[from - 1][1], spine[from][0], spine[from][1]) : undefined;
    const exitBearing = to < spine.length - 1 ? bearingDeg(spine[to][0], spine[to][1], spine[to + 1][0], spine[to + 1][1]) : undefined;
    let detour;
    if (fine) {
      detour = routeWater(spine[from], spine[to], null, null, { isLand, narrowWeight, entryBearing, exitBearing });
    } else {
      const marginKm = Math.max(LAND_AVOIDANCE.oceanMarginMinKm, subKm);
      const cellKm = Math.max(LAND_AVOIDANCE.coarseCellKm,
        (subKm + 2 * marginKm) / LAND_AVOIDANCE.oceanMaxCellsPerSide);
      detour = routeWater(spine[from], spine[to], null, null, {
        isLand, narrowWeight, marginKm, cellKm, entryBearing, exitBearing,
        headingKm: Math.max(4, cellKm * LAND_AVOIDANCE.oceanHeadingCells),
      });
    }
    // No route (out of coastline coverage) → keep the spine and let it graze;
    // the same graceful degradation as a short gap that can't be routed.
    if (detour && detour.length > 2) for (const p of smoothRoute(detour).slice(1, -1)) out.push(p);
    else { unrouted = true; for (let i = from + 1; i < to; i++) out.push(spine[i]); }
    out.push(spine[to]);
    cursor = to;
  }
  for (let i = cursor + 1; i < spine.length; i++) out.push(spine[i]);

  if (unrouted) {
    const whole = routeWholeOceanGap(a, b, narrowWeight, totalKm);
    if (whole && whole.length > 2) return whole;
  }
  return out;
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
    const gapKm = haversineKm(a[0], a[1], b[0], b[1]);
    const isGap = (journey[i].t - journey[i - 1].t) > LAND_AVOIDANCE.gapMinMs || gapKm > LAND_AVOIDANCE.gapMinKm;
    // Past routeMaxKm a single A* grid is both unaffordable and pointless (see
    // routeOceanGap); the ocean router always runs on such a gap — even when it
    // clears land — because the bridge itself should follow the great circle.
    const ocean = isGap && gapKm > LAND_AVOIDANCE.routeMaxKm;
    if (route && isGap && (ocean || crossesLand(a, b))) {
      // Bias A* to leave/arrive along the boat's real course either side of the
      // gap (the COG just outside it) so it doesn't backtrack against the boat's
      // heading — that read as a sharp kink at the real→inferred boundary.
      const entryBearing = i >= 2 ? bearingDeg(real[i - 2][0], real[i - 2][1], a[0], a[1]) : undefined;
      const exitBearing = i + 1 < real.length ? bearingDeg(b[0], b[1], real[i + 1][0], real[i + 1][1]) : undefined;
      const raw = ocean
        ? routeOceanGap(a, b, narrowWeight, entryBearing, exitBearing)
        : routeAroundLand(a, b, narrowWeight, entryBearing, exitBearing);
      if (raw && raw.length > 2) {
        // An ocean spine is already smooth and its spans are ~100 km; running
        // smoothRoute over it would densify then land-check every 100 m of an
        // ocean crossing. Its short A*-routed detours are smoothed in place.
        const wp = ocean ? raw : smoothRoute(raw);
        const t0 = journey[i - 1].t, t1 = journey[i].t;
        for (let k = 1; k < wp.length - 1; k++) {
          ctrl.push({ lat: wp[k][0], lon: wp[k][1], t: t0 + (t1 - t0) * (k / (wp.length - 1)), synthetic: true, fake: true });
        }
      }
    }
    ctrl.push({ lat: b[0], lon: b[1], t: journey[i].t, synthetic: false, fake: false });
  }
  return cleanControls(ctrl);
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
      // Same ocean-crossing cap as buildControlPoints: an unrouted trans-ocean
      // bridge whose spline grazes a far coast must not pull A* back in here.
      const bracketKm = haversineKm(c0.lat, c0.lon, c1.lat, c1.lon);
      if (bracketKm <= LAND_AVOIDANCE.routeMaxKm && crossesLand([c0.lat, c0.lon], [c1.lat, c1.lon])) {
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
  // repairOffLand splices its OWN mids in after buildControlPoints already
  // cleaned, so the near-duplicates and reversals have to be cleared again here —
  // this is where the berth-approach hairpins actually came from.
  return cleanControls(best);
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
