#!/usr/bin/env node
// Data generation: build frontend/app/coastline.js from high-resolution OSM
// coastline (natural=coastline), assembled into closed land polygons and
// simplified with a distance-weighted tolerance — fine near the viewshed
// (Victoria / Haro Strait / Gulf Islands), coarse offshore — to keep the
// shipped file small while resolving harbours and narrow passes.
//
// Prerequisites — fetch OSM coastline for the region via Overpass:
//   curl -sS -H "User-Agent: vessel-tracker/1.0" \
//     "https://overpass-api.de/api/interpreter" \
//     --data-urlencode 'data=[out:json][timeout:170];(way["natural"="coastline"](46.9,-128.8,51.3,-121.9););out body geom;' \
//     -o /tmp/osm_coast.json
//
// Usage:  node --max-old-space-size=2048 scripts/build-coastline.mjs [/tmp/osm_coast.json]
// Run from worker/ directory.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stitchCoastline, closeOpenChains } from './lib-osm-coastline.mjs';

const BB = { minLat: 46.9, maxLat: 51.3, minLon: -128.8, maxLon: -121.9 };
const HOME = { lat: 48.4299, lon: -123.3622 };

// FINE tier (harbour-grade, ~25 m) is applied inside these high-traffic, tight
// waterways regardless of distance from home — anywhere vessels of interest
// regularly transit narrow water that coarse simplification would close
// (harbours, rivers). Add bboxes here to expand coverage (e.g. Portland, Alaska
// ports). The viewshed (Victoria/Haro/southern Gulf) is covered by the 60 km
// distance tier below, so it doesn't need a box.
const FINE_ZONES = [
  { minLat: 49.00, maxLat: 49.40, minLon: -123.30, maxLon: -122.70 }, // Vancouver harbour, Burrard Inlet, lower Fraser River
  { minLat: 48.40, maxLat: 48.80, minLon: -123.20, maxLon: -122.50 }, // Bellingham / north Puget approaches
  { minLat: 47.40, maxLat: 48.10, minLon: -122.65, maxLon: -122.20 }, // Puget Sound: Seattle/Elliott Bay, Bremerton, Tacoma
];
const FINE = { simplifyKm: 0.025, dropIslandKm: 0.05 };

// Distance-weighted simplification & island-drop tiers (km from HOME), used
// outside the fine zones.
const TIERS = [
  { maxKm: 60,       simplifyKm: 0.025, dropIslandKm: 0.05 }, // viewshed: harbours, passes
  { maxKm: 160,      simplifyKm: 0.12,  dropIslandKm: 0.3  }, // Salish Sea
  { maxKm: Infinity, simplifyKm: 0.6,   dropIslandKm: 2.0  }, // outer coast
];

const inFineZone = (lon, lat) =>
  FINE_ZONES.some(z => lat >= z.minLat && lat <= z.maxLat && lon >= z.minLon && lon <= z.maxLon);

const INPUT = process.argv[2] || '/tmp/osm_coast.json';
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(SCRIPT_DIR, '../../frontend/app/coastline.js');

const R_KM = 6371.0;
function haversineKm(la1, lo1, la2, lo2) {
  const r = Math.PI / 180, dLat = (la2 - la1) * r, dLon = (lo2 - lo1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.sqrt(a));
}
function tierFor(lon, lat) {
  if (inFineZone(lon, lat)) return FINE;
  const d = haversineKm(HOME.lat, HOME.lon, lat, lon);
  for (const t of TIERS) if (d <= t.maxKm) return t;
  return TIERS[TIERS.length - 1];
}

// Perpendicular distance (km) of point p from segment a→b, equirectangular-local.
function perpKm(p, a, b) {
  const lat0 = (a[1] + b[1]) / 2 * Math.PI / 180, kx = 111.32 * Math.cos(lat0), ky = 111.32;
  const ax = a[0] * kx, ay = a[1] * ky, bx = b[0] * kx, by = b[1] * ky, px = p[0] * kx, py = p[1] * ky;
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  let t = L2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Douglas-Peucker where the keep-threshold is the simplifyKm of the tier the
// farthest point falls in — so a ring spanning tiers (the mainland) keeps
// detail near the viewshed and coarsens offshore. Iterative to avoid deep
// recursion on the 200k-point mainland ring.
function variableDP(pts) {
  if (pts.length <= 2) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = 1; keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop();
    if (hi - lo < 2) continue;
    let maxD = 0, maxI = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = perpKm(pts[i], pts[lo], pts[hi]);
      if (d > maxD) { maxD = d; maxI = i; }
    }
    if (maxI === -1) continue;
    if (maxD > tierFor(pts[maxI][0], pts[maxI][1]).simplifyKm) {
      keep[maxI] = 1;
      stack.push([lo, maxI], [maxI, hi]);
    }
  }
  const out = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

function ringSpanKm(ring) {
  let mnx = 999, mxx = -999, mny = 999, mxy = -999;
  for (const [lo, la] of ring) { if (lo < mnx) mnx = lo; if (lo > mxx) mxx = lo; if (la < mny) mny = la; if (la > mxy) mxy = la; }
  return haversineKm(mny, mnx, mxy, mxx);
}

// ── Build ───────────────────────────────────────────────────────────────────
const data = JSON.parse(fs.readFileSync(INPUT, 'utf8'));
const { closed, open } = stitchCoastline(data.elements);
const mainland = closeOpenChains(open, BB, true);
const rings = closed.concat(mainland); // [lon,lat] rings

const kept = [];
let droppedSmall = 0;
for (const ring of rings) {
  const cx = ring.reduce((s, p) => s + p[0], 0) / ring.length;
  const cy = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  const tier = tierFor(cx, cy);
  // Keep big landmasses regardless; drop tiny islands by their tier.
  if (ring.length < 50_000 && ringSpanKm(ring) < tier.dropIslandKm) { droppedSmall++; continue; }
  const simp = variableDP(ring);
  if (simp.length >= 4) kept.push(simp);
}

// Convert [lon,lat] → [lat,lon], round to 5 decimals (~1 m).
const round = n => Math.round(n * 1e5) / 1e5;
const polysLatLon = kept.map(r => r.map(([lo, la]) => [round(la), round(lo)]));
polysLatLon.sort((a, b) => b.length - a.length);

const totalVerts = polysLatLon.reduce((s, r) => s + r.length, 0);
const body = `// Auto-generated by build-coastline.mjs — do not edit manually.
// Source: OpenStreetMap natural=coastline (via Overpass), assembled into land
// polygons and simplified with a distance-weighted tolerance (fine near the
// viewshed, coarse offshore). Clipped to [${BB.minLat}, ${BB.minLon}] -> [${BB.maxLat}, ${BB.maxLon}].
// ${polysLatLon.length} polygons, ${totalVerts} vertices.

export const LAND_POLYGONS = ${JSON.stringify(polysLatLon)};
`;
fs.writeFileSync(OUT, body);
const kb = (Buffer.byteLength(body) / 1024).toFixed(0);
console.log(`polygons: ${rings.length} -> ${polysLatLon.length} kept (${droppedSmall} tiny dropped)`);
console.log(`vertices: ${rings.reduce((s, r) => s + r.length, 0)} -> ${totalVerts}`);
console.log(`wrote ${OUT}  (${kb} KB)`);
