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

  return cwDist <= ccwDist ? cw : ccw;
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

// Push each perimeter point seaward by computing the coastline normal at that
// vertex and offsetting in the direction that's outside the local land polygon.
// Validates the offset point is actually outside the polygon; if not, tries
// the opposite perpendicular. Keeps the original position if both push into
// land (defensive — shouldn't happen for valid perimeters).
function offsetPathSeaward(path, polygon, polygons, gapDist) {
  if (path.length < 2) return path;
  const offsetKm = Math.max(2, gapDist * 0.15);
  if (offsetKm < 0.1) return path;
  const latPerDeg = 111.32;
  const avgLat = polygon.reduce((s, p) => s + p[0], 0) / polygon.length;
  const lonPerDeg = 111.32 * Math.cos(avgLat * Math.PI / 180);
  return path.map((p, idx) => {
    const prev = idx > 0 ? path[idx - 1] : null;
    const next = idx < path.length - 1 ? path[idx + 1] : null;
    let tLat, tLon;
    if (prev && next) {
      tLat = next[0] - prev[0];
      tLon = next[1] - prev[1];
    } else if (next) {
      tLat = next[0] - p[0];
      tLon = next[1] - p[1];
    } else if (prev) {
      tLat = p[0] - prev[0];
      tLon = p[1] - prev[1];
    } else {
      return p;
    }
    const tLen = Math.sqrt(tLat * tLat + tLon * tLon);
    if (tLen < 1e-10) return p;
    const step = 0.1 / latPerDeg;
    const n1 = [-tLon / tLen, tLat / tLen];
    const n2 = [tLon / tLen, -tLat / tLen];
    const s1 = [p[0] + n1[0] * step, p[1] + n1[1] * step];
    const s2 = [p[0] + n2[0] * step, p[1] + n2[1] * step];
    const inside1 = pointInPolygon(s1, polygon);
    const inside2 = pointInPolygon(s2, polygon);
    let n;
    if (inside1 === inside2) {
      // Both inside or both outside — shouldn't happen for a valid perimeter.
      // Fall back: try both normals with full offset and pick the one further
      // from the centroid.
      n = n1;
    } else {
      n = inside1 ? n2 : n1;
    }
    const candidate = [
      p[0] + n[0] * (offsetKm / latPerDeg),
      p[1] + n[1] * (offsetKm / lonPerDeg),
    ];
    // Validate the candidate isn't inside any land polygon
    let valid = true;
    for (let pi = 0; pi < polygons.length; pi++) {
      if (pointInPolygon(candidate, polygons[pi])) {
        valid = false;
        break;
      }
    }
    if (valid) return candidate;
    // Try the reverse direction
    const revN = [-n[0], -n[1]];
    const revCandidate = [
      p[0] + revN[0] * (offsetKm / latPerDeg),
      p[1] + revN[1] * (offsetKm / lonPerDeg),
    ];
    valid = true;
    for (let pi = 0; pi < polygons.length; pi++) {
      if (pointInPolygon(revCandidate, polygons[pi])) {
        valid = false;
        break;
      }
    }
    if (valid) return revCandidate;
    // Both directions push into land — keep original
    return p;
  });
}

// Main entry point: given two [lat,lon] points and a list of land polygons
// with pre-computed bounding boxes, returns the synthetic perimeter path
// around the first intersected landmass, or null if no land is crossed.
//
// Tolerance scales with gap distance so short crossings are tight (harbour
// features) while long crossings (entire peninsulas) produce loose arcs.
//
// After routing around one landmass, the path is offset seaward and each
// segment is checked against *other* polygons (recursion with visited set).
// This handles archipelago routing (Gulf Islands) where a single arc around
// one island would cross another.
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
      visited.add(i);
      const perimeter = walkPolygonPerimeter(
        polygon, crossing.entryPt, crossing.exitPt,
        crossing.entryEdgeIdx, crossing.exitEdgeIdx
      );
      if (perimeter.length >= 2) {
        const first = perimeter[0], last = perimeter[perimeter.length - 1];
        if (Math.abs(first[0] - last[0]) < 1e-8 && Math.abs(first[1] - last[1]) < 1e-8) {
          perimeter.pop();
        }
        if (perimeter.length > 1) {
          const dFirst = haversineKm(a[0], a[1], perimeter[0][0], perimeter[0][1]);
          if (dFirst < 0.01) perimeter.shift();
        }
        if (perimeter.length > 1) {
          const dLast = haversineKm(b[0], b[1], perimeter[perimeter.length - 1][0], perimeter[perimeter.length - 1][1]);
          if (dLast < 0.01) perimeter.pop();
        }
      }
      if (perimeter.length > 2 && simplifyToleranceKm > 0) {
        const adaptiveTol = Math.max(simplifyToleranceKm, dist * 0.2);
        let simplified = simplifyPath(perimeter, adaptiveTol);
        simplified = offsetPathSeaward(simplified, polygon, polygons, dist);

        // Recursive routing: each segment of the offset path may cross another
        // unvisited polygon (archipelago pattern).
        if (simplified.length >= 2) {
          const merged = [simplified[0]];
          for (let j = 0; j < simplified.length - 1; j++) {
            const subResult = routeAroundLand(
              simplified[j], simplified[j + 1],
              polygons, bboxes, simplifyToleranceKm, visited
            );
            if (subResult && subResult.length > 1) {
              for (let k = 1; k < subResult.length; k++) {
                merged.push(subResult[k]);
              }
            } else {
              merged.push(simplified[j + 1]);
            }
          }
          // Snap any remaining control points that are inside other polygons
          // to the nearest outside position along their offset direction.
          const snapped = snapPathToWater(merged, polygons, polygon, dist);
          return snapped;
        }
        // Same snap for non-recursive path
        const snapped = snapPathToWater(simplified, polygons, polygon, dist);
        return snapped;
      }
      return perimeter;
    }
  }
  return null;
}

// After offset, some control points may still be inside a polygon. Find
// the nearest polygon vertex, compute the coastline normal at that vertex
// (same method as offsetPathSeaward), and push outward by the seaward
// offset distance. Gives catmull-rom interpolation enough clearance.
function snapPathToWater(path, allPolygons, routingPolygon, gapDist) {
  const offsetKm = Math.max(2, gapDist * 0.15);
  const latPerDeg = 111.32;
  const avgLat = routingPolygon.reduce((s, p) => s + p[0], 0) / routingPolygon.length;
  const step = 0.1 / latPerDeg;
  return path.map(p => {
    for (let pi = 0; pi < allPolygons.length; pi++) {
      if (pointInPolygon(p, allPolygons[pi])) {
        const poly = allPolygons[pi];
        // Find nearest polygon vertex
        let minD = Infinity, bestIdx = 0;
        for (let vi = 0; vi < poly.length; vi++) {
          const d = (poly[vi][0] - p[0]) ** 2 + (poly[vi][1] - p[1]) ** 2;
          if (d < minD) { minD = d; bestIdx = vi; }
        }
        // Coastline tangent at nearest vertex
        const prev = poly[bestIdx > 0 ? bestIdx - 1 : poly.length - 1];
        const next = poly[(bestIdx + 1) % poly.length];
        const tLat = next[0] - prev[0], tLon = next[1] - prev[1];
        const tLen = Math.sqrt(tLat * tLat + tLon * tLon);
        if (tLen < 1e-10) return p;
        const n1 = [-tLon / tLen, tLat / tLen];
        // Pick the perpendicular that steps outside this polygon
        for (let s = 1; s <= 200; s++) {
          const sc = Math.cos(poly[bestIdx][0] * Math.PI / 180);
          for (const n of [n1, [-n1[0], -n1[1]]]) {
            const candidate = [
              p[0] + n[0] * (offsetKm / latPerDeg) * s,
              p[1] + n[1] * (offsetKm / latPerDeg) * s / sc,
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
