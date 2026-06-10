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

// Check if segment (a→b) crosses any edge of polygon.
// Returns { entryPt, exitPt, entryEdgeIdx, exitEdgeIdx } or null.
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
  if (hits.length < 2) return null;

  // Sort by distance from a
  const aLat = a[0], aLon = a[1];
  hits.sort((x, y) => {
    const dx1 = x.pt[0] - aLat, dy1 = x.pt[1] - aLon;
    const dx2 = y.pt[0] - aLat, dy2 = y.pt[1] - aLon;
    return (dx1 * dx1 + dy1 * dy1) - (dx2 * dx2 + dy2 * dy2);
  });

  return {
    entryPt: hits[0].pt,
    exitPt: hits[hits.length - 1].pt,
    entryEdgeIdx: hits[0].edgeIdx,
    exitEdgeIdx: hits[hits.length - 1].edgeIdx,
  };
}

// Walk the shorter arc of polygon perimeter between entry and exit points.
// entryPt lies on polygon edge at entryEdgeIdx (between vertices entryEdgeIdx and entryEdgeIdx+1).
// exitPt lies on polygon edge at exitEdgeIdx.
// Returns array of [lat, lon] along the perimeter (entryPt → vertices → exitPt).
export function walkPolygonPerimeter(polygon, entryPt, exitPt, entryEdgeIdx, exitEdgeIdx) {
  const n = polygon.length - 1;

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

// Main entry point: given two [lat,lon] points and a list of land polygons
// with pre-computed bounding boxes, returns the synthetic perimeter path
// around the first intersected landmass, or null if no land is crossed.
// The path is simplified (Douglas-Peucker) using simplifyToleranceKm to
// create a visual buffer between the trail and the coastline.
export function routeAroundLand(a, b, polygons, bboxes, simplifyToleranceKm) {
  const minKm = 5;
  const dist = haversineKm(a[0], a[1], b[0], b[1]);
  if (dist < minKm) return null;

  const segMinLat = Math.min(a[0], b[0]);
  const segMaxLat = Math.max(a[0], b[0]);
  const segMinLon = Math.min(a[1], b[1]);
  const segMaxLon = Math.max(a[1], b[1]);

  for (let i = 0; i < polygons.length; i++) {
    const bb = bboxes[i];
    if (segMinLat > bb.maxLat || segMaxLat < bb.minLat ||
        segMinLon > bb.maxLon || segMaxLon < bb.minLon) continue;

    const polygon = polygons[i];
    const crossing = segmentCrossesPolygon(a, b, polygon);
    if (crossing) {
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
        return simplifyPath(perimeter, simplifyToleranceKm);
      }
      return perimeter;
    }
  }
  return null;
}
