#!/usr/bin/env node
// Build frontend/app/coast_coarse.js (COARSE_LAND_POLYGONS) — a tiny, very low-res
// landmass of the North American west coast OUTSIDE the fine OSM region, so long
// open-ocean inferred routes (Vancouver <-> California/Mexico, or up to Alaska) bend
// around the continent instead of cutting through Oregon / N. California / Baja.
//
// Source: Natural Earth 1:50M land (coarse + tiny — the opposite of the local need;
// here coarse IS correct). Clipped to lat strips that EXCLUDE the fine OSM band
// (46.9–51.3 N) so it tiles with coastline.js and never coarsens the Salish Sea
// channels. Concatenated into the land array in trail_geometry.js (+ tests/lib.mjs);
// no geo.js change — pointOnLand's OR-of-polygons handles it, and the strips don't
// overlap the fine region.
//
// Prereq:  curl -sS -o /tmp/ne_50m_land.geojson \
//   https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_land.geojson
// Usage:   node scripts/build-coarse-coast.mjs [/tmp/ne_50m_land.geojson]   (run from worker/)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Strips bounding the NA Pacific coast, excluding the fine band [46.9, 51.3].
const STRIPS = [
  { minLat: 18.0, maxLat: 46.9, minLon: -132.0, maxLon: -104.0 }, // S: Baja/Mexico → Oregon/Washington
  { minLat: 51.3, maxLat: 60.5, minLon: -145.0, maxLon: -120.0 }, // N: northern BC → SE Alaska
];
const SIMPLIFY_KM = 2.0;   // coarse — only the gross landmass matters offshore
const DROP_SPAN_KM = 10.0; // drop small islands

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

const round = n => Math.round(n * 1e5) / 1e5;
const polys = [];
let dropped = 0;
for (const ring of outerRings) {
  for (const R of STRIPS) {
    const clipped = clipToRect(ring, R);
    if (clipped.length < 4) continue;
    if (clipped[0][0] !== clipped[clipped.length - 1][0] || clipped[0][1] !== clipped[clipped.length - 1][1]) clipped.push(clipped[0]);
    if (spanKm(clipped) < DROP_SPAN_KM) { dropped++; continue; }
    const simp = simplifyRing(clipped, SIMPLIFY_KM).map(([lo, la]) => [round(la), round(lo)]);
    if (simp.length >= 4) polys.push(simp);
  }
}
polys.sort((a, b) => b.length - a.length);

const totalVerts = polys.reduce((s, r) => s + r.length, 0);
const body = `// Auto-generated by build-coarse-coast.mjs — do not edit manually.
// Source: Natural Earth 1:50M land, clipped to the NA Pacific coast OUTSIDE the fine
// OSM band [46.9, 51.3] N and simplified to ≈${SIMPLIFY_KM} km. Coarse on purpose: it only
// keeps long open-ocean routes from cutting across the continent. Concatenated into the
// land array in trail_geometry.js / tests/lib.mjs. ${polys.length} polygons, ${totalVerts} vertices.

export const COARSE_LAND_POLYGONS = ${JSON.stringify(polys)};
`;
fs.writeFileSync(OUT, body);
const kb = (Buffer.byteLength(body) / 1024).toFixed(0);
console.log(`coarse polygons: ${polys.length} kept (${dropped} tiny dropped), ${totalVerts} vertices`);
console.log(`wrote ${OUT}  (${kb} KB)`);
