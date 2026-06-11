// Lazy per-region coastline/water geometry.
//
// Owns the combined land + water arrays the trail pipeline routes against. The BASE
// layers are always present: home OSM coastline (`coastline.js`) + the coarse
// continental landmass (`coast_coarse.js`) + home water (`water.js`). Foreign
// harbour/river REGIONS (coast/<id>.js, listed in coast/manifest.js) are appended ON
// DEMAND — call `ensureRegionsForExtent(bbox)` before routing a trail and only the
// regions intersecting that bbox are fetched (once, cached). So the base download
// stays small as ports are added, and a Singapore-bound trail never loads Vancouver.
//
// Works in the browser, a module Web Worker, and Node (the future GH-Actions A*
// precompute) — `import()` is universal. `trail_geometry.js` reads the live arrays via
// the getters below, so appends are picked up without re-importing.
import { LAND_POLYGONS } from './coastline.js';
import { COARSE_LAND_POLYGONS } from './coast_coarse.js';
import { WATER_POLYGONS } from './water.js';
import { REGIONS } from './coast/manifest.js';

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

// Two [[swLat,swLon],[neLat,neLon]] boxes overlap?
const boxesOverlap = (a, b) =>
  a[0][0] <= b[1][0] && a[1][0] >= b[0][0] && a[0][1] <= b[1][1] && a[1][1] >= b[0][1];

// Live combined arrays — mutated in place by ensureRegionsForExtent (getters return the
// same references, so consumers see appends).
const land = LAND_POLYGONS.concat(COARSE_LAND_POLYGONS);
const landBboxes = land.map(ringBbox);
const water = WATER_POLYGONS.slice();
const waterBboxes = water.map(w => ringBbox(w.o));
const loaded = new Set();

export const getLand = () => land;
export const getLandBboxes = () => landBboxes;
export const getWater = () => water;
export const getWaterBboxes = () => waterBboxes;

// Load (once) every region whose bbox intersects `extent` ([[swLat,swLon],[neLat,neLon]])
// and append its land/water to the combined arrays. Idempotent; safe to call per trail.
export async function ensureRegionsForExtent(extent) {
  const pending = REGIONS.filter(r => !loaded.has(r.id) && boxesOverlap(extent, r.bbox));
  if (pending.length === 0) return;
  pending.forEach(r => loaded.add(r.id)); // mark before await so concurrent calls don't double-load
  const mods = await Promise.all(pending.map(r => r.load().catch(() => null)));
  for (const mod of mods) {
    const R = mod && (mod.REGION || mod.default);
    if (!R) continue;
    for (const ring of R.land) { land.push(ring); landBboxes.push(ringBbox(ring)); }
    for (const w of R.water) { water.push(w); waterBboxes.push(ringBbox(w.o)); }
  }
}

// Extent of a list of {lat,lon} points (with a small pad), for ensureRegionsForExtent.
export function extentOf(points, padDeg = 0.1) {
  let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }
  return [[minLat - padDeg, minLon - padDeg], [maxLat + padDeg, maxLon + padDeg]];
}
