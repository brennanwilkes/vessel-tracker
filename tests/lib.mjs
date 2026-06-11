// Shared test helpers: load coastline + water + geo, normalize D1 trail dumps, land tests.
import { readFileSync } from 'fs';
import { LAND_POLYGONS } from '../frontend/app/coastline.js';
import { COARSE_LAND_POLYGONS } from '../frontend/app/coast_coarse.js';
import { WATER_POLYGONS } from '../frontend/app/water.js';
export { LAND_POLYGONS, WATER_POLYGONS };

// Fine OSM coast + coarse continental fallback — mirrors trail_geometry.js's LAND.
const LAND = LAND_POLYGONS.concat(COARSE_LAND_POLYGONS);

const ringBbox = ring => {
  let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
  for (const [lat, lon] of ring) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }
  return { minLat, maxLat, minLon, maxLon };
};

export const POLYGON_BBOXES = LAND.map(ringBbox);
export const WATER_BBOXES = WATER_POLYGONS.map(w => ringBbox(w.o));

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

// Is pt inside a water polygon (river/harbour), holes excluded? Mirrors geo.pointInWater.
export function pointInAnyWater(pt) {
  for (let i = 0; i < WATER_POLYGONS.length; i++) {
    const bb = WATER_BBOXES[i];
    if (pt[0] < bb.minLat || pt[0] > bb.maxLat || pt[1] < bb.minLon || pt[1] > bb.maxLon) continue;
    const w = WATER_POLYGONS[i];
    if (!pointInPolygon(pt, w.o)) continue;
    if (w.h && w.h.some(h => pointInPolygon(pt, h))) continue;
    return true;
  }
  return false;
}

// Which land polygon (index) contains pt, or -1. Two-layer: a point inside a water
// polygon (river/harbour the coastline closed) is NOT land. Mirrors geo.pointOnLand.
export function pointInAnyLand(pt) {
  let hit = -1;
  for (let i = 0; i < LAND.length; i++) {
    const bb = POLYGON_BBOXES[i];
    if (pt[0] < bb.minLat || pt[0] > bb.maxLat || pt[1] < bb.minLon || pt[1] > bb.maxLon) continue;
    if (pointInPolygon(pt, LAND[i])) { hit = i; break; }
  }
  if (hit === -1) return -1;
  return pointInAnyWater(pt) ? -1 : hit;
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
