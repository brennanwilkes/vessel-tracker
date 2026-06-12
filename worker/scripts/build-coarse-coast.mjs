#!/usr/bin/env node
// Build frontend/app/coast_coarse.js (COARSE_LAND_POLYGONS) — a low-res landmass of
// the WHOLE WORLD outside the fine OSM home region, so long open-ocean inferred
// routes bend around continents instead of cutting through them. Originally NA-Pacific
// only (Vancouver <-> California/Mexico/Alaska); now global so foreign-port and
// trans-Pacific routes (Asia, Oceania) bow around Asia/Australia/the Americas too.
//
// Source: Natural Earth 1:50M land (coarse + tiny — the opposite of the local need;
// here coarse IS correct). The world is tiled into 4 rects that EXCLUDE the fine OSM
// home bbox (HOME below) so coarse never coarsens the Salish Sea channels; every fine
// FOREIGN region (coast/<id>.js) instead overrides coarse at runtime inside its own
// bbox (region_coast.isLand), so a port's shipping channel stays open wherever we have
// fine data while the 2 km coarse landmass keeps the open-ocean legs off the continent.
// Antarctica and the high Arctic are dropped (no vessel routes there) to keep size down.
// Loaded as the COARSE base layer in region_coast.js — no geo.js change (pointOnLand's
// OR-of-polygons handles it; the home rect is carved out so there's no overlap).
//
// Prereq:  curl -sS -o /tmp/ne_50m_land.geojson \
//   https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_land.geojson
// Usage:   node scripts/build-coarse-coast.mjs [/tmp/ne_50m_land.geojson]   (run from worker/)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Fine OSM home bbox (Salish Sea) — coarse must NOT cover it (it would close the
// channels coastline.js/water.js keep open). Matches the fine clip in build-coastline.mjs.
const HOME = { minLat: 46.9, maxLat: 51.3, minLon: -128.8, maxLon: -121.9 };
// The NA-Pacific coast our home vessels actually hug (Baja → SE Alaska): kept at the
// finer NEAR_KM so the shipped Vancouver↔California/Alaska routing is unchanged. It
// contains HOME, carved out below.
const NA = { minLat: 18.0, maxLat: 60.5, minLon: -170.0, maxLon: -104.0 };
const WORLD = { minLat: -60.0, maxLat: 80.0, minLon: -180.0, maxLon: 180.0 }; // sans Antarctica/high-Arctic
const NEAR_KM = 2.0;       // NA-Pacific coast — routes hug it; keep shipped fidelity
const FAR_KM = 5.0;        // rest of the world — only the gross landmass matters offshore
const DROP_SPAN_KM = 30.0; // drop small islands — the ports that matter are fine regions
                           // (coast/<id>.js) that override coarse, so coarse needs only
                           // the gross continents/large islands for open-ocean detours.

// Disjoint rects tiling WORLD minus HOME (no overlap → no double-counted vertices, and
// no seaward-bulge where two simplifications of the same coast would OR together). The
// NA box (minus HOME) is the finer NEAR_KM; everything else is FAR_KM. A polygon spanning
// a tile boundary is split by the clip into separate closed rings — fine for PIP testing.
const STRIPS = [
  // NA-Pacific (NEAR_KM), tiled around the carved-out HOME bbox.
  { tolKm: NEAR_KM, minLat: NA.minLat,   maxLat: HOME.minLat, minLon: NA.minLon,  maxLon: NA.maxLon },
  { tolKm: NEAR_KM, minLat: HOME.maxLat, maxLat: NA.maxLat,   minLon: NA.minLon,  maxLon: NA.maxLon },
  { tolKm: NEAR_KM, minLat: HOME.minLat, maxLat: HOME.maxLat, minLon: NA.minLon,  maxLon: HOME.minLon },
  { tolKm: NEAR_KM, minLat: HOME.minLat, maxLat: HOME.maxLat, minLon: HOME.maxLon, maxLon: NA.maxLon },
  // Rest of the world (FAR_KM), tiled around the NA box.
  { tolKm: FAR_KM, minLat: WORLD.minLat, maxLat: WORLD.maxLat, minLon: WORLD.minLon, maxLon: NA.minLon },
  { tolKm: FAR_KM, minLat: WORLD.minLat, maxLat: WORLD.maxLat, minLon: NA.maxLon,   maxLon: WORLD.maxLon },
  { tolKm: FAR_KM, minLat: WORLD.minLat, maxLat: NA.minLat,    minLon: NA.minLon,   maxLon: NA.maxLon },
  { tolKm: FAR_KM, minLat: NA.maxLat,    maxLat: WORLD.maxLat, minLon: NA.minLon,   maxLon: NA.maxLon },
];

const INPUT = process.argv[2] || '/tmp/ne_50m_land.geojson';
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(SCRIPT_DIR, '../../frontend/app/coast_coarse.js');

const R_KM = 6371.0;
function haversineKm(la1, lo1, la2, lo2) {
  const r = Math.PI / 180, dLat = (la2 - la1) * r, dLon = (lo2 - lo1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.sqrt(a));
}
function perpKm(p, a, b) {
  const lat0 = ((a[1] + b[1]) / 2) * Math.PI / 180, kx = 111.32 * Math.cos(lat0), ky = 111.32;
  const ax = a[0] * kx, ay = a[1] * ky, bx = b[0] * kx, by = b[1] * ky, px = p[0] * kx, py = p[1] * ky;
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  let t = L2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
function simplifyRing(pts, tolKm) {
  if (pts.length <= 4) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = 1; keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop();
    if (hi - lo < 2) continue;
    let maxD = 0, maxI = -1;
    for (let i = lo + 1; i < hi; i++) { const d = perpKm(pts[i], pts[lo], pts[hi]); if (d > maxD) { maxD = d; maxI = i; } }
    if (maxI !== -1 && maxD > tolKm) { keep[maxI] = 1; stack.push([lo, maxI], [maxI, hi]); }
  }
  const out = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
  return out;
}
function spanKm(ring) {
  let mnx = 999, mxx = -999, mny = 999, mxy = -999;
  for (const [lo, la] of ring) { if (lo < mnx) mnx = lo; if (lo > mxx) mxx = lo; if (la < mny) mny = la; if (la > mxy) mxy = la; }
  return haversineKm(mny, mnx, mxy, mxx);
}

// Sutherland-Hodgman clip of a [lon,lat] ring against an axis-aligned rect.
function clipToRect(ring, R) {
  const edges = [
    { inside: p => p[0] >= R.minLon, isect: (a, b) => lerpX(a, b, R.minLon) },
    { inside: p => p[0] <= R.maxLon, isect: (a, b) => lerpX(a, b, R.maxLon) },
    { inside: p => p[1] >= R.minLat, isect: (a, b) => lerpY(a, b, R.minLat) },
    { inside: p => p[1] <= R.maxLat, isect: (a, b) => lerpY(a, b, R.maxLat) },
  ];
  function lerpX(a, b, x) { const t = (x - a[0]) / (b[0] - a[0]); return [x, a[1] + (b[1] - a[1]) * t]; }
  function lerpY(a, b, y) { const t = (y - a[1]) / (b[1] - a[1]); return [a[0] + (b[0] - a[0]) * t, y]; }
  let poly = ring;
  for (const e of edges) {
    if (poly.length === 0) break;
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const cur = poly[i], prev = poly[(i + poly.length - 1) % poly.length];
      const curIn = e.inside(cur), prevIn = e.inside(prev);
      if (curIn) { if (!prevIn) out.push(e.isect(prev, cur)); out.push(cur); }
      else if (prevIn) out.push(e.isect(prev, cur));
    }
    poly = out;
  }
  return poly;
}

// ── Build ─────────────────────────────────────────────────────────────────────
const data = JSON.parse(fs.readFileSync(INPUT, 'utf8'));
const outerRings = [];
for (const f of data.features) {
  const g = f.geometry;
  if (g.type === 'Polygon') outerRings.push(g.coordinates[0]);
  else if (g.type === 'MultiPolygon') for (const poly of g.coordinates) outerRings.push(poly[0]);
}

// 3 decimals ≈ 110 m — far finer than the 2 km simplification, and ~30% smaller on
// the wire than the 1e5 (1 m) precision the fine layers use. Coarse doesn't need it.
const round = n => Math.round(n * 1e3) / 1e3;
const polys = [];
let dropped = 0;
for (const ring of outerRings) {
  for (const R of STRIPS) {
    const clipped = clipToRect(ring, R);
    if (clipped.length < 4) continue;
    if (clipped[0][0] !== clipped[clipped.length - 1][0] || clipped[0][1] !== clipped[clipped.length - 1][1]) clipped.push(clipped[0]);
    if (spanKm(clipped) < DROP_SPAN_KM) { dropped++; continue; }
    const simp = simplifyRing(clipped, R.tolKm).map(([lo, la]) => [round(la), round(lo)]);
    if (simp.length >= 4) polys.push(simp);
  }
}
polys.sort((a, b) => b.length - a.length);

const totalVerts = polys.reduce((s, r) => s + r.length, 0);
const body = `// Auto-generated by build-coarse-coast.mjs — do not edit manually.
// Source: Natural Earth 1:50M land, WHOLE WORLD outside the fine OSM home bbox
// [${HOME.minLat}, ${HOME.minLon}]→[${HOME.maxLat}, ${HOME.maxLon}] (Antarctica/high-Arctic dropped). NA-Pacific coast
// simplified to ≈${NEAR_KM} km, the rest of the world to ≈${FAR_KM} km.
// Coarse on purpose: it only keeps long open-ocean routes from cutting across continents
// (NA, Asia, Oceania, trans-Pacific). Fine foreign regions override it in their bbox at
// runtime. Loaded as the COARSE base layer in region_coast.js. ${polys.length} polygons, ${totalVerts} vertices.

export const COARSE_LAND_POLYGONS = ${JSON.stringify(polys)};
`;
fs.writeFileSync(OUT, body);
const kb = (Buffer.byteLength(body) / 1024).toFixed(0);
console.log(`coarse polygons: ${polys.length} kept (${dropped} tiny dropped), ${totalVerts} vertices`);
console.log(`wrote ${OUT}  (${kb} KB)`);
