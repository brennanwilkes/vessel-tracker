// Shared test helpers: load coastline + geo, normalize D1 trail dumps, land tests.
import { readFileSync } from 'fs';
import { LAND_POLYGONS } from '../frontend/app/coastline.js';
export { LAND_POLYGONS };

export const POLYGON_BBOXES = LAND_POLYGONS.map(poly => {
  let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
  for (const [lat, lon] of poly) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }
  return { minLat, maxLat, minLon, maxLon };
});

export function pointInPolygon(pt, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const yi = polygon[i][0], xi = polygon[i][1];
    const yj = polygon[j][0], xj = polygon[j][1];
    if ((yi > pt[0]) !== (yj > pt[0]) &&
        pt[1] < (xj - xi) * (pt[0] - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Which polygon (index) contains pt, or -1. Uses bbox prefilter.
export function pointInAnyLand(pt) {
  for (let i = 0; i < LAND_POLYGONS.length; i++) {
    const bb = POLYGON_BBOXES[i];
    if (pt[0] < bb.minLat || pt[0] > bb.maxLat || pt[1] < bb.minLon || pt[1] > bb.maxLon) continue;
    if (pointInPolygon(pt, LAND_POLYGONS[i])) return i;
  }
  return -1;
}

// Load a D1 db-positions dump ({results:[...]}) → chronological
// [{lat, lon, t, tier, speed}], oldest first.
export function loadTrail(path) {
  const raw = JSON.parse(readFileSync(path, 'utf-8'));
  // wrangler d1 execute returns [{results:[...], success, meta}]
  const rows = Array.isArray(raw) ? raw[0].results : (raw.results ?? raw.rows ?? raw);
  const pts = rows.map(r => ({ lat: r.lat, lon: r.lon, t: r.ts_utc, tier: r.tier, speed: r.speed }));
  pts.sort((a, b) => a.t - b.t);
  return pts;
}
