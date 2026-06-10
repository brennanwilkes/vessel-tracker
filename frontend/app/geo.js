const R_NM = 3440.065;
const R_KM = 6371.0;

export function haversineNm(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R_NM * Math.asin(Math.sqrt(a));
}

export function haversineKm(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.sqrt(a));
}

export function bearingDeg(lat1, lon1, lat2, lon2) {
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const y = Math.sin(dLon) * Math.cos(lat2 * Math.PI / 180);
  const x = Math.cos(lat1 * Math.PI / 180) * Math.sin(lat2 * Math.PI / 180)
    - Math.sin(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}

// ── Coastline helpers ───────────────────────────────────────────────────────

function ccw(a, b, c) {
  return (c[1] - a[1]) * (b[0] - a[0]) > (b[1] - a[1]) * (c[0] - a[0]);
}

export function segmentsIntersect(a, b, c, d) {
  return ccw(a, c, d) !== ccw(b, c, d) && ccw(a, b, c) !== ccw(a, b, d);
}

export function intersectionPoint(a, b, c, d) {
  const ax = a[0], ay = a[1], bx = b[0], by = b[1];
  const cx = c[0], cy = c[1], dx = d[0], dy = d[1];
  const denom = (ax - bx) * (cy - dy) - (ay - by) * (cx - dx);
  if (Math.abs(denom) < 1e-12) return null;
  const t = ((ax - cx) * (cy - dy) - (ay - cy) * (cx - dx)) / denom;
  return [ax + t * (bx - ax), ay + t * (by - ay)];
}

function pointOnSegment(p, a, b) {
  const minX = Math.min(a[0], b[0]), maxX = Math.max(a[0], b[0]);
  const minY = Math.min(a[1], b[1]), maxY = Math.max(a[1], b[1]);
  return p[0] >= minX - 1e-12 && p[0] <= maxX + 1e-12 &&
         p[1] >= minY - 1e-12 && p[1] <= maxY + 1e-12;
}

// Check if segment (a→b) crosses any edge of polygon, or if either endpoint
// is inside the polygon (offset path push-in). Returns
// { entryPt, exitPt, entryEdgeIdx, exitEdgeIdx } or null.
function segmentCrossesPolygon(a, b, polygon) {
  const hits = [];
  for (let i = 0; i < polygon.length - 1; i++) {
    const c = polygon[i];
    const d = polygon[(i + 1) % polygon.length];
    if (segmentsIntersect(a, b, c, d)) {
      const pt = intersectionPoint(a, b, c, d);
      if (pt && pointOnSegment(pt, a, b)) {
        hits.push({ pt, edgeIdx: i });
      }
    }
  }

  const aInside = pointInPolygon(a, polygon);
  const bInside = pointInPolygon(b, polygon);

  // Both inside — no boundary crossing possible
  if (aInside && bInside) return null;
  // Start inside, exit through first hit
  if (aInside && hits.length >= 1) {
    hits.sort((x, y) => segDist(x.pt, a) - segDist(y.pt, a));
    return { entryPt: a, exitPt: hits[0].pt, entryEdgeIdx: -1, exitEdgeIdx: hits[0].edgeIdx };
  }
  // Enter through last hit, end inside
  if (bInside && hits.length >= 1) {
    hits.sort((x, y) => segDist(x.pt, a) - segDist(y.pt, a));
    return { entryPt: hits[hits.length - 1].pt, exitPt: b, entryEdgeIdx: hits[hits.length - 1].edgeIdx, exitEdgeIdx: -1 };
  }
  // Both outside — need at least 2 hits (entry + exit)
  if (hits.length < 2) return null;

  // Sort by distance from a
  const aLat = a[0], aLon = a[1];
  hits.sort((x, y) => {
    const dx1 = x.pt[0] - aLat, dy1 = x.pt[1] - aLon;
    const dx2 = y.pt[0] - aLat, dy2 = y.pt[1] - aLon;
    return (dx1 * dx1 + dy1 * dy1) - (dx2 * dx2 + dy2 * dy2);
  });

  // Normal case: both outside, at least 2 hits
  hits.sort((x, y) => segDist(x.pt, a) - segDist(y.pt, a));
  return {
    entryPt: hits[0].pt,
    exitPt: hits[hits.length - 1].pt,
    entryEdgeIdx: hits[0].edgeIdx,
    exitEdgeIdx: hits[hits.length - 1].edgeIdx,
  };
}

// Squared distance along segment a→b (for sorting hits by t parameter)
function segDist(p, a) {
  return (p[0] - a[0]) ** 2 + (p[1] - a[1]) ** 2;
}

// Walk the shorter arc of polygon perimeter between entry and exit points.
// entryPt lies on polygon edge at entryEdgeIdx (between vertices entryEdgeIdx and entryEdgeIdx+1).
// exitPt lies on polygon edge at exitEdgeIdx.
// entryEdgeIdx === -1 means entryPt is inside the polygon (not on an edge — occurs
// when offset pushes a point into a polygon). In that case, first vertex is used
// as start. Same for exitEdgeIdx === -1.
// Returns array of [lat, lon] along the perimeter (entryPt → vertices → exitPt).
export function walkPolygonPerimeter(polygon, entryPt, exitPt, entryEdgeIdx, exitEdgeIdx) {
  const n = polygon.length - 1;

  // When a point is inside the polygon (not on the boundary), find the
  // nearest vertex to start/end the perimeter walk from.
  if (entryEdgeIdx === -1) {
    let minD = Infinity;
    for (let i = 0; i < n; i++) {
      const d = (polygon[i][0] - entryPt[0]) ** 2 + (polygon[i][1] - entryPt[1]) ** 2;
      if (d < minD) { minD = d; entryEdgeIdx = i; }
    }
  }
  if (exitEdgeIdx === -1) {
    let minD = Infinity;
    for (let i = 0; i < n; i++) {
      const d = (polygon[i][0] - exitPt[0]) ** 2 + (polygon[i][1] - exitPt[1]) ** 2;
      if (d < minD) { minD = d; exitEdgeIdx = i; }
    }
  }

  function walkCW() {
    const path = [entryPt];
    let i = (entryEdgeIdx + 1) % n;
    while (i !== exitEdgeIdx) {
      path.push(polygon[i]);
      i = (i + 1) % n;
    }
    path.push(polygon[exitEdgeIdx]);
    path.push(exitPt);
    return path;
  }

  function walkCCW() {
    const path = [entryPt];
    // Walk backwards from entry edge to exit edge
    let i = entryEdgeIdx;
    while (i !== (exitEdgeIdx + 1) % n) {
      path.push(polygon[i]);
      i = (i - 1 + n) % n;
    }
    path.push(polygon[(exitEdgeIdx + 1) % n]);
    path.push(exitPt);
    return path;
  }

  const cw = walkCW();
  const ccw = walkCCW();

  const cwDist = pathLengthKm(cw);
  const ccwDist = pathLengthKm(ccw);

  // Walk along `path` from start until `minKm` of cumulative haversine
  // distance has been accumulated, then return that point.  Used to find
  // a point far enough from the entry that the two walks have diverged
  // geographically (cw[1] vs ccw[1] are adjacent vertices ~1 km apart and
  // cannot distinguish direction).
  function advanceAlong(path) {
    const MIN_ADVANCE_KM = 25;
    let total = 0;
    for (let i = 1; i < path.length; i++) {
      total += haversineKm(path[i-1][0], path[i-1][1], path[i][0], path[i][1]);
      if (total >= MIN_ADVANCE_KM) return { point: path[i], km: total };
    }
    return { point: path[path.length - 1], km: total };
  }

  const ADVANCE_RATIO = 0.15; // 15% threshold
  const minDist = Math.min(cwDist, ccwDist);
  const maxDist = Math.max(cwDist, ccwDist);

  // When one walk is clearly shorter, use total-distance comparison.
  // Only when distances are similar (antipodal entry/exit) use the
  // advance-and-compare heuristic, which gives a geographic signal
  // rather than a noise-driven total-distance comparison.
  let chosen;
  if (maxDist - minDist > minDist * ADVANCE_RATIO) {
    chosen = cwDist <= ccwDist ? cw : ccw;
  } else {
    const cwAdv = advanceAlong(cw);
    const ccwAdv = advanceAlong(ccw);
    const dCw = haversineKm(cwAdv.point[0], cwAdv.point[1], exitPt[0], exitPt[1]);
    const dCcw = haversineKm(ccwAdv.point[0], ccwAdv.point[1], exitPt[0], exitPt[1]);
    chosen = dCw <= dCcw ? cw : ccw;
  }

  const DBG = window.__DEBUG_MMSI;
  if (DBG) {
    const cwAdv = advanceAlong(cw);
    const ccwAdv = advanceAlong(ccw);
    const dCw = haversineKm(cwAdv.point[0], cwAdv.point[1], exitPt[0], exitPt[1]);
    const dCcw = haversineKm(ccwAdv.point[0], ccwAdv.point[1], exitPt[0], exitPt[1]);
    console.log('[walkPolygonPerimeter] entryPt=%f,%f exitPt=%f,%f entryEdgeIdx=%d exitEdgeIdx=%d',
      entryPt[0], entryPt[1], exitPt[0], exitPt[1], entryEdgeIdx, exitEdgeIdx);
    console.log('[walkPolygonPerimeter] cwDist=%f ccwDist=%f ratio=%f chose=%s',
      cwDist, ccwDist, cwDist > ccwDist ? ccwDist/cwDist : cwDist/ccwDist, chosen === cw ? 'CW' : 'CCW');
    console.log('[walkPolygonPerimeter] cwAdv[km=%f]=%f,%f ccwAdv[km=%f]=%f,%f dCw=%f dCcw=%f',
      cwAdv.km, cwAdv.point[0], cwAdv.point[1],
      ccwAdv.km, ccwAdv.point[0], ccwAdv.point[1], dCw, dCcw);
  }

  return chosen;
}

// Ramer-Douglas-Peucker simplification of a [lat,lon] path.
// toleranceKm is the maximum haversine distance a vertex can deviate from
// the simplified line before it's kept. This smooths out small coastline
// wiggles and creates a natural-looking buffer between the trail and land.
export function simplifyPath(path, toleranceKm) {
  if (path.length <= 2) return path;

  let maxD = 0, maxI = 0;
  const first = path[0], last = path[path.length - 1];
  for (let i = 1; i < path.length - 1; i++) {
    const d = perpendicularKm(path[i], first, last);
    if (d > maxD) { maxD = d; maxI = i; }
  }

  if (maxD > toleranceKm) {
    const left = simplifyPath(path.slice(0, maxI + 1), toleranceKm);
    const right = simplifyPath(path.slice(maxI), toleranceKm);
    return left.slice(0, -1).concat(right);
  }
  return [first, last];
}

// Perpendicular distance of point p from the line a→b, in km.
function perpendicularKm(p, a, b) {
  const dAb = haversineKm(a[0], a[1], b[0], b[1]);
  if (dAb < 1e-10) return haversineKm(p[0], p[1], a[0], a[1]);
  // Convert to approx meters for cross-track formula
  const R = 6371000;
  const d13 = R * haversineKm(p[0], p[1], a[0], a[1]) / 6371;
  const theta = bearingDeg(a[0], a[1], p[0], p[1]) - bearingDeg(a[0], a[1], b[0], b[1]);
  return Math.abs(Math.asin(Math.sin(d13 / R) * Math.sin(theta))) * R / 1000;
}

function pathLengthKm(path) {
  let d = 0;
  for (let i = 1; i < path.length; i++) {
    d += haversineKm(path[i - 1][0], path[i - 1][1], path[i][0], path[i][1]);
  }
  return d;
}

function pointInPolygon(pt, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const yi = polygon[i][0], xi = polygon[i][1];
    const yj = polygon[j][0], xj = polygon[j][1];
    if ((yi > pt[0]) !== (yj > pt[0]) &&
        pt[1] < (xj - xi) * (pt[0] - yi) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// Main entry point: given two [lat,lon] points and a list of land polygons
// with pre-computed bounding boxes, returns the synthetic perimeter path
// around the first intersected landmass, or null if no land is crossed.
//
// Generates a smooth open-water arc (entry→apex→exit) by finding the coastline
// perimeter point farthest from the entry→exit chord (the apex) and pushing it
// seaward. Each of the 3 points uses its own LOCAL seaward direction:
//   - Apex: chord-perpendicular (midpoint→apex), creating the arc bulge
//   - Entry/Exit: polygon edge outward normal, giving correct local heading
// Unlike the old centroid-based approach that pushed all points in one global
// direction (failing for large polygons like Vancouver Island + Olympic Peninsula),
// local directions ensure each point moves correctly seaward.
//
// After routing around one landmass, segments of the arc are checked against
// *other* polygons (recursion with visited set). This handles archipelago
// routing (Gulf Islands) where a single arc around one island would cross
// another.
export function routeAroundLand(a, b, polygons, bboxes, simplifyToleranceKm, visited = null) {
  const minKm = 5;
  const dist = haversineKm(a[0], a[1], b[0], b[1]);
  if (dist < minKm) return null;

  const segMinLat = Math.min(a[0], b[0]);
  const segMaxLat = Math.max(a[0], b[0]);
  const segMinLon = Math.min(a[1], b[1]);
  const segMaxLon = Math.max(a[1], b[1]);

  if (visited === null) visited = new Set();

  for (let i = 0; i < polygons.length; i++) {
    if (visited.has(i)) continue;
    const bb = bboxes[i];
    if (segMinLat > bb.maxLat || segMaxLat < bb.minLat ||
        segMinLon > bb.maxLon || segMaxLon < bb.minLon) continue;

    const polygon = polygons[i];
    const crossing = segmentCrossesPolygon(a, b, polygon);
    if (crossing) {
      const entryExitKm = haversineKm(
        crossing.entryPt[0], crossing.entryPt[1],
        crossing.exitPt[0], crossing.exitPt[1]
      );
      if (entryExitKm < 5) {
        visited.add(i);
        continue;
      }

      visited.add(i);
      const perimeter = walkPolygonPerimeter(
        polygon, crossing.entryPt, crossing.exitPt,
        crossing.entryEdgeIdx, crossing.exitEdgeIdx
      );

      if (perimeter.length < 2) return null;

      // Find coastline arc apex — the perimeter vertex farthest from the
      // entry→exit chord. This defines the land bulge to route around.
      let maxD = -1, apexIdx = 0;
      for (let pi = 1; pi < perimeter.length - 1; pi++) {
        const d = perpendicularKm(perimeter[pi], perimeter[0], perimeter[perimeter.length - 1]);
        if (d > maxD) { maxD = d; apexIdx = pi; }
      }

      if (maxD < 0.1) return null;

      const entryPt = perimeter[0];
      const exitPt = perimeter[perimeter.length - 1];
      const apex = perimeter[apexIdx];

      const offsetKm = Math.max(2, entryExitKm * 0.15);
      const apexOffsetKm = Math.max(offsetKm * 2, entryExitKm * 0.3);
      const avgLat = polygon.reduce((s, p) => s + p[0], 0) / polygon.length;
      const lonPerDeg = 111.32 * Math.cos(avgLat * Math.PI / 180);
      const latPerDeg = 111.32;

      // Apex direction: from chord midpoint toward apex. This pushes the
      // apex perpendicular to the chord, further onto the coastline bulge
      // side (open water).
      const chordMid = [(entryPt[0] + exitPt[0]) / 2, (entryPt[1] + exitPt[1]) / 2];
      const adx = apex[0] - chordMid[0], ady = apex[1] - chordMid[1];
      const aLen = Math.sqrt(adx * adx + ady * ady);
      const apexDir = aLen > 1e-10 ? [adx / aLen, ady / aLen] : null;

      // Entry/exit direction: outward normal of the polygon edge they're on.
      // Tries both perpendiculars to the edge; picks the one pointing into
      // water (not inside any polygon). This gives a locally correct seaward
      // direction regardless of polygon winding or centroid position.
      function edgeOutwardNormal(edgeIdx) {
        const n = polygon.length - 1;
        const pa = polygon[edgeIdx], pb = polygon[(edgeIdx + 1) % n];
        const dx = pb[0] - pa[0], dy = pb[1] - pa[1];
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len < 1e-10) return null;
        const ex = dx / len, ey = dy / len;
        const mx = (pa[0] + pb[0]) / 2, my = (pa[1] + pb[1]) / 2;
        for (const [nx, ny] of [[-ey, ex], [ey, -ex]]) {
          const probe = [mx + nx * 0.01, my + ny * 0.01];
          let inside = false;
          for (let pi = 0; pi < polygons.length; pi++) {
            if (pointInPolygon(probe, polygons[pi])) { inside = true; break; }
          }
          if (!inside) return [nx, ny];
        }
        return null;
      }

      const entryDir = edgeOutwardNormal(crossing.entryEdgeIdx);
      const exitDir = edgeOutwardNormal(crossing.exitEdgeIdx);

      // For apex, also compute edge outward normal (fallback if chord-perp fails)
      let apexEdgeDir = null;
      const n = polygon.length - 1;
      for (const ei of [(apexIdx - 1 + n) % n, apexIdx]) {
        const d = edgeOutwardNormal(ei);
        if (d) { apexEdgeDir = d; break; }
      }

      function pushPt(pt, dir, km) {
        if (!dir) return pt;
        const c = [pt[0] + dir[0] * (km / latPerDeg), pt[1] + dir[1] * (km / lonPerDeg)];
        let inside = false;
        for (let pi = 0; pi < polygons.length; pi++) {
          if (pointInPolygon(c, polygons[pi])) { inside = true; break; }
        }
        if (!inside) return c;
        return pt;
      }

      const pushedEntry = pushPt(entryPt, entryDir, offsetKm);
      const pushedApex = pushPt(apex, apexDir || apexEdgeDir, apexOffsetKm);
      const pushedExit = pushPt(exitPt, exitDir, offsetKm);

      const arc = [pushedEntry, pushedApex, pushedExit];

      const DBG = window.__DEBUG_MMSI;
      if (DBG) {
        console.log('[routeAroundLand] polyIdx=%d entryExitKm=%f apexDist=%f offsetKm=%f apexOffsetKm=%f',
          i, entryExitKm, maxD, offsetKm, apexOffsetKm);
        for (let ki = 0; ki < arc.length; ki++) {
          console.log('  arc[%d] %f,%f', ki, arc[ki][0], arc[ki][1]);
        }
      }

      // Recursive archipelago routing: each segment of the 3-point arc may
      // cross another unvisited polygon.
      if (arc.length >= 2) {
        const merged = [arc[0]];
        for (let j = 0; j < arc.length - 1; j++) {
          const sub = routeAroundLand(arc[j], arc[j + 1], polygons, bboxes, simplifyToleranceKm, visited);
          if (sub && sub.length > 1) {
            for (let k = 1; k < sub.length; k++) merged.push(sub[k]);
          } else {
            merged.push(arc[j + 1]);
          }
        }
        return snapPathToWater(merged, polygons, polygon, dist);
      }
      return snapPathToWater(arc, polygons, polygon, dist);
    }
  }
  return null;
}

// Safety net: some control points from recursive archipelago routing may
// still end up inside a polygon. Pushes them seaward from polygon centroid.
function snapPathToWater(path, allPolygons, routingPolygon, gapDist) {
  const offsetKm = Math.max(2, gapDist * 0.15);
  const latPerDeg = 111.32;
  const avgLat = routingPolygon.reduce((s, p) => s + p[0], 0) / routingPolygon.length;
  const lonPerDeg = 111.32 * Math.cos(avgLat * Math.PI / 180);
  return path.map(p => {
    for (let pi = 0; pi < allPolygons.length; pi++) {
      if (pointInPolygon(p, allPolygons[pi])) {
        const poly = allPolygons[pi];
        const cx = poly.reduce((s, v) => s + v[0], 0) / poly.length;
        const cy = poly.reduce((s, v) => s + v[1], 0) / poly.length;
        const dx = p[0] - cx, dy = p[1] - cy;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len < 1e-10) return p;
        for (let s = 1; s <= 200; s++) {
          for (const sign of [1, -1]) {
            const candidate = [
              p[0] + (dx / len) * (offsetKm / latPerDeg) * s * sign,
              p[1] + (dy / len) * (offsetKm / lonPerDeg) * s * sign,
            ];
            let ok = true;
            for (let cpi = 0; cpi < allPolygons.length; cpi++) {
              if (pointInPolygon(candidate, allPolygons[cpi])) { ok = false; break; }
            }
            if (ok) return candidate;
          }
        }
        return p;
      }
    }
    return p;
  });
}
