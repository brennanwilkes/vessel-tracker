// Coastline COVERAGE guard. The land-avoidance router can only route around land
// that exists in the polygons — a landmass missing from coastline.js reads as open
// water, so a trail crosses it and neither the router nor the trail test notices
// (they share the same data). This test asserts a fixed set of known landmasses
// read as LAND and known navigable water reads as WATER, so a coastline regeneration
// that silently drops an island/coast (a real past bug) fails loudly here.
//
//   node tests/coverage.test.mjs
//
// Points are INTERIOR (well inside the feature), not on the shore, so simplification
// can't flip them. Add a row whenever a new fine zone / corridor coast is built.
import { pointInAnyLand } from './lib.mjs';

const LAND = [
  // Salish Sea islands (fine)
  ['Whidbey I',        48.293, -122.643],
  ['Galiano I',        48.880, -123.327],
  ['Mayne I',          48.840, -123.280],
  ['Saltspring I',     48.810, -123.500],
  ['San Juan I',       48.534, -123.016],
  ['Orcas I',          48.650, -122.950],
  ['Bainbridge I',     47.630, -122.520],
  ['Vashon I',         47.420, -122.460],
  // Mainland / peninsula (fine)
  ['Victoria',         48.428, -123.365],
  ['Seattle',          47.606, -122.330],
  ['Tacoma',           47.250, -122.440],
  ['Olympic interior', 47.800, -123.500],
  ['Vancouver BC',     49.250, -123.120],
  // NA-Pacific corridor outer coast (medium — was coarse before)
  ['Tillamook OR',     45.460, -123.840],
  ['Coos Bay OR',      43.380, -124.210],
  ['Cape Mendocino CA',40.440, -124.360],
  ['Marin CA',         38.000, -122.700],
  ['LA basin',         34.000, -118.300],
  ['San Diego',        32.760, -117.100],
];

const WATER = [
  ['Haro Strait',       48.480, -123.230],
  ['Strait of Georgia', 49.100, -123.500],
  ['Juan de Fuca mid',  48.250, -123.800],
  ['Mid Puget Sound',   47.600, -122.450],
  ['Open Pacific',      45.000, -127.000],
  ['Off SoCal',         33.000, -119.500],
];

let failures = 0;
for (const [name, lat, lon] of LAND) {
  if (pointInAnyLand([lat, lon]) < 0) { console.error(`FAIL  ${name} should be LAND, reads water  (${lat},${lon})`); failures++; }
}
for (const [name, lat, lon] of WATER) {
  if (pointInAnyLand([lat, lon]) >= 0) { console.error(`FAIL  ${name} should be WATER, reads land  (${lat},${lon})`); failures++; }
}

if (failures > 0) { console.error(`\n${failures} coverage assertion(s) failed.`); process.exit(1); }
console.log(`Coastline coverage OK — ${LAND.length} landmasses, ${WATER.length} waterways verified.`);
