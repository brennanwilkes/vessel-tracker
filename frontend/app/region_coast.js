// Region-aware land/water geometry for trail routing.
//
// Layers, in precedence order:
//   • Home — fine OSM coastline (`coastline.js`) + water (`water.js`), the Salish Sea.
//   • Regions — fine per-port/channel land+water (`coast/<id>.js`), loaded ON DEMAND by
//     `ensureRegionsForExtent` when a trail's extent reaches them.
//   • Coarse — the NA continental landmass (`coast_coarse.js`), the open-ocean fallback.
//
// KEY RULE (resolution follows navigation): inside a loaded region that HAS fine land,
// that region's geometry is AUTHORITATIVE — the coarse layer is ignored there. So a
// shipping waterway (Inside Passage, river/port approach) the coarse 2 km layer would
// close stays open wherever we have fine data. Elsewhere it's home/coarse land minus all
// loaded water (rivers re-open coarse land). Works in browser, Worker, and Node.
import { LAND_POLYGONS } from './coastline.js';
import { COARSE_LAND_POLYGONS } from './coast_coarse.js';
import { WATER_POLYGONS } from './water.js';
import { REGIONS } from './coast/manifest.js';

const ringBbox = ring => {
  let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
  for (const [lat, lon] of ring) {
    if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon; if (lon > maxLon) maxLon = lon;
  }
  return { minLat, maxLat, minLon, maxLon };
};
function pip(lat, lon, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const yi = ring[i][0], xi = ring[i][1], yj = ring[j][0], xj = ring[j][1];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const inRings = (lat, lon, rings, bbs) => {
  for (let i = 0; i < rings.length; i++) {
    const b = bbs[i];
    if (lat < b.minLat || lat > b.maxLat || lon < b.minLon || lon > b.maxLon) continue;
    if (pip(lat, lon, rings[i])) return true;
  }
  return false;
};
const inWaters = (lat, lon, waters, bbs) => {
  for (let i = 0; i < waters.length; i++) {
    const b = bbs[i];
    if (lat < b.minLat || lat > b.maxLat || lon < b.minLon || lon > b.maxLon) continue;
    const w = waters[i];
    if (!pip(lat, lon, w.o)) continue;
    if (w.h && w.h.some(h => pip(lat, lon, h))) continue;
    return true;
  }
  return false;
};

const HOME_LAND = LAND_POLYGONS, HOME_LAND_BB = LAND_POLYGONS.map(ringBbox);
const HOME_WATER = WATER_POLYGONS, HOME_WATER_BB = WATER_POLYGONS.map(w => ringBbox(w.o));
const COARSE = COARSE_LAND_POLYGONS, COARSE_BB = COARSE_LAND_POLYGONS.map(ringBbox);

// Loaded regions: { id, bbox:[[swLat,swLon],[neLat,neLon]], land, landBB, water, waterBB, hasLand }
const loaded = [];
const loadedIds = new Set();
const inBox = (lat, lon, bx) => lat >= bx[0][0] && lat <= bx[1][0] && lon >= bx[0][1] && lon <= bx[1][1];

// Is (lat,lon) navigable water (river/harbour basin)? Home + every loaded region.
export function isWater(lat, lon) {
  if (inWaters(lat, lon, HOME_WATER, HOME_WATER_BB)) return true;
  for (const r of loaded) if (inBox(lat, lon, r.bbox) && inWaters(lat, lon, r.water, r.waterBB)) return true;
  return false;
}

// Is (lat,lon) on land? Region-aware: a loaded region WITH fine land is authoritative in
// its bbox (coarse ignored → channels stay open); otherwise home+coarse land minus water.
export function isLand(lat, lon) {
  for (const r of loaded) {
    if (r.hasLand && inBox(lat, lon, r.bbox)) {
      if (!(inRings(lat, lon, r.land, r.landBB) || inRings(lat, lon, HOME_LAND, HOME_LAND_BB))) return false;
      return !(inWaters(lat, lon, r.water, r.waterBB) || inWaters(lat, lon, HOME_WATER, HOME_WATER_BB));
    }
  }
  if (!(inRings(lat, lon, HOME_LAND, HOME_LAND_BB) || inRings(lat, lon, COARSE, COARSE_BB))) return false;
  return !isWater(lat, lon);
}

const boxesOverlap = (a, b) => a[0][0] <= b[1][0] && a[1][0] >= b[0][0] && a[0][1] <= b[1][1] && a[1][1] >= b[0][1];

// Load (once) every region whose bbox intersects `extent` and register its geometry.
export async function ensureRegionsForExtent(extent) {
  const pending = REGIONS.filter(r => !loadedIds.has(r.id) && boxesOverlap(extent, r.bbox));
  if (pending.length === 0) return;
  pending.forEach(r => loadedIds.add(r.id));
  const mods = await Promise.all(pending.map(r => r.load().catch(() => null)));
  for (let i = 0; i < mods.length; i++) {
    const R = mods[i] && (mods[i].REGION || mods[i].default);
    if (!R) { loadedIds.delete(pending[i].id); continue; }
    loaded.push({
      id: R.id, bbox: R.bbox,
      land: R.land, landBB: R.land.map(ringBbox),
      water: R.water, waterBB: R.water.map(w => ringBbox(w.o)),
      hasLand: R.land.length > 0,
    });
  }
}

// Extent of a list of {lat,lon} points (padded), for ensureRegionsForExtent.
export function extentOf(points, padDeg = 0.1) {
  let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat; if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon; if (p.lon > maxLon) maxLon = p.lon;
  }
  return [[minLat - padDeg, minLon - padDeg], [maxLat + padDeg, maxLon + padDeg]];
}
