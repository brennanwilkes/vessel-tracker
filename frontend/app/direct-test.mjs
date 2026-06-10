import { readFileSync } from 'fs';
import { LAND_POLYGONS } from './coastline.js';
import { routeAroundLand, haversineKm } from './geo.js';

const POLYGON_BBOXES = LAND_POLYGONS.map(poly => {
  let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
  for (const [lat, lon] of poly) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }
  return { minLat, maxLat, minLon, maxLon };
});

globalThis.window = { __DEBUG_MMSI: 319201600 };

const MMSI = parseInt(process.argv[2]);
const apiData = JSON.parse(readFileSync(new URL(`/tmp/vessel-${MMSI}.json`, import.meta.url), 'utf8'));
const points = [...apiData.points].reverse();

console.log(`MMSI ${MMSI}: ${points.length} points`);
console.log(`routeAroundLand toString length: ${routeAroundLand.toString().length} chars`);
console.log(`Has pushPtRadial: ${routeAroundLand.toString().includes('pushPtRadial')}`);
console.log(`Has Math.max(simplifyToleranceKm, 3): ${routeAroundLand.toString().includes('Math.max(simplifyToleranceKm, 3)')}`);

for (let i = 0; i < Math.min(points.length - 1, 100); i++) {
  const a = [points[i].lat, points[i].lon];
  const b = [points[i + 1].lat, points[i + 1].lon];
  const d = haversineKm(a[0], a[1], b[0], b[1]);
  if (d < 5) continue;

  const perim = routeAroundLand(a, b, LAND_POLYGONS, POLYGON_BBOXES, 3);

  if (perim && perim.length > 1) {
    const entryExitKm = haversineKm(perim[0][0], perim[0][1], perim[perim.length - 1][0], perim[perim.length - 1][1]);
    console.log(`\n=== pair[${i}]→[${i+1}] d=${d.toFixed(1)}km perim=${perim.length}pts entryExit=${entryExitKm.toFixed(1)}km`);
    console.log(`  a: ${a[0].toFixed(4)}N ${a[1].toFixed(4)}W`);
    console.log(`  b: ${b[0].toFixed(4)}N ${b[1].toFixed(4)}W`);
    for (let pi = 0; pi < perim.length; pi++) {
      console.log(`  perim[${pi}]: ${perim[pi][0].toFixed(4)}N ${perim[pi][1].toFixed(4)}W`);
    }
  }
}
