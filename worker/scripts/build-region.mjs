#!/usr/bin/env node
// Build one lazy-loaded coastline REGION → frontend/app/coast/<id>.js, exporting
//   { id, bbox, land: [[ [lat,lon],… ] …], water: [{ o, h? } …] }
// Regions are fine, self-contained harbour/river areas loaded ON DEMAND by the
// frontend (and the future GH-Actions A* precompute) only when a trail's extent
// intersects their bbox — so the base download stays small as ports are added.
//
// A region is uniformly FINE (harbour-grade) — it only exists to render trails INTO a
// port precisely; the coarse continental layer + zone dots cover everything else.
//
// Exposes buildRegion() for the batch driver (build-all-regions.mjs); also runnable as
// a CLI for a single region whose OSM dumps are already in /tmp:
//   node scripts/build-region.mjs <id> <minLat> <minLon> <maxLat> <maxLon>   (run from worker/)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stitchCoastline } from './lib-osm-coastline.mjs';
import { assembleWater } from './lib-osm-water.mjs';

const LAND_SIMPLIFY_KM = 0.04;   // ~40 m harbour-grade
// ~50 m — still ≤ ⅓ of a ~180 m channel (Willamette), per the resolution policy, but
// roughly halves the river vertex count vs 25 m.
const WATER_SIMPLIFY_KM = 0.05;
const LAND_DROP_SPAN_KM = 0.08;
// Water: keep only NAVIGABLE bodies (major rivers/basins) — drop the region's ponds,
// lakes and minor sloughs a ship never enters and that otherwise bloat the lazy file.
const WATER_DROP_SPAN_KM = 1.0;

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const COAST_DIR = path.resolve(SCRIPT_DIR, '../../frontend/app/coast');

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
  for (const p of ring) { const lo = p[0], la = p[1]; if (lo < mnx) mnx = lo; if (lo > mxx) mxx = lo; if (la < mny) mny = la; if (la > mxy) mxy = la; }
  return haversineKm(mny, mnx, mxy, mxx);
}
const round = n => Math.round(n * 1e5) / 1e5;

// Sutherland-Hodgman clip of a [lon,lat] ring to the region bbox. Essential because
// OSM `out geom` returns a relation's FULL geometry — a river relation fetched for one
// port (Yangtze@Shanghai, Pearl@Hong Kong) would otherwise drag in the entire river.
// Returns a closed clipped ring, or [] if the ring is entirely outside.
function clipRingToBox(ring, bbox) {
  const edges = [
    { in: p => p[0] >= bbox.minLon, x: (a, b) => lerpX(a, b, bbox.minLon) },
    { in: p => p[0] <= bbox.maxLon, x: (a, b) => lerpX(a, b, bbox.maxLon) },
    { in: p => p[1] >= bbox.minLat, x: (a, b) => lerpY(a, b, bbox.minLat) },
    { in: p => p[1] <= bbox.maxLat, x: (a, b) => lerpY(a, b, bbox.maxLat) },
  ];
  function lerpX(a, b, x) { const t = (x - a[0]) / (b[0] - a[0]); return [x, a[1] + (b[1] - a[1]) * t]; }
  function lerpY(a, b, y) { const t = (y - a[1]) / (b[1] - a[1]); return [a[0] + (b[0] - a[0]) * t, y]; }
  let poly = ring;
  for (const e of edges) {
    if (poly.length === 0) break;
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const cur = poly[i], prev = poly[(i + poly.length - 1) % poly.length];
      const ci = e.in(cur), pi = e.in(prev);
      if (ci) { if (!pi) out.push(e.x(prev, cur)); out.push(cur); }
      else if (pi) out.push(e.x(prev, cur));
    }
    poly = out;
  }
  if (poly.length >= 3 && (poly[0][0] !== poly[poly.length - 1][0] || poly[0][1] !== poly[poly.length - 1][1])) poly.push(poly[0]);
  return poly;
}

// Build a region from already-parsed OSM dumps. bbox = {minLat,minLon,maxLat,maxLon}.
// Writes frontend/app/coast/<id>.js and returns stats.
//
// Ships fine LAND (validated against the coarse layer to drop the closeOpenChains
// ocean-as-land rings) + navigable WATER. The frontend uses regions to OVERRIDE coarse
// within their bbox (region_coast.js), so fine region land is what keeps shipping
// waterways (Inside Passage, port/river approaches) open where coarse would close them.
export function buildRegion({ id, bbox, coastElements, waterElements, landSimplifyKm = LAND_SIMPLIFY_KM, outDir = COAST_DIR }) {
  // Land = ISLANDS only (closed OSM coastline ways — reliable closed loops). We DROP the
  // open-mainland perimeter closure (closeOpenChains): it's orientation-fragile and was
  // filling open ocean as land (the Golden-Gate bug). The coarse layer handles the
  // mainland correctly; region fine-land exists to open inter-island channels (Inside
  // Passage) where coarse 2 km wrongly merges islands and closes the passages. Open-coast
  // ports therefore carry no fine land (water-only) — coarse land + region water is right.
  const { closed } = stitchCoastline(coastElements ?? []);
  const land = [];
  for (const raw of closed) {
    const ring = clipRingToBox(raw, bbox);
    if (ring.length < 4 || spanKm(ring) < LAND_DROP_SPAN_KM) continue;
    const simp = simplifyRing(ring, landSimplifyKm).map(([lo, la]) => [round(la), round(lo)]);
    if (simp.length >= 4) land.push(simp);
  }
  land.sort((a, b) => b.length - a.length);

  // Water (navigable bodies only)
  const water = [];
  let holes = 0;
  for (const { outer, holes: hh } of assembleWater(waterElements ?? [])) {
    const outerC = clipRingToBox(outer, bbox);
    if (outerC.length < 4 || spanKm(outerC) < WATER_DROP_SPAN_KM) continue;
    const o = simplifyRing(outerC, WATER_SIMPLIFY_KM).map(([lo, la]) => [round(la), round(lo)]);
    if (o.length < 4) continue;
    const h = hh.map(hr => clipRingToBox(hr, bbox))
      .filter(hr => hr.length >= 4 && spanKm(hr) >= LAND_DROP_SPAN_KM)
      .map(hr => simplifyRing(hr, WATER_SIMPLIFY_KM).map(([lo, la]) => [round(la), round(lo)]))
      .filter(hr => hr.length >= 4);
    holes += h.length;
    water.push(h.length ? { o, h } : { o });
  }
  water.sort((a, b) => b.o.length - a.o.length);

  const bb = [[bbox.minLat, bbox.minLon], [bbox.maxLat, bbox.maxLon]];
  const verts = land.reduce((s, r) => s + r.length, 0) + water.reduce((s, w) => s + w.o.length + (w.h ?? []).reduce((t, hr) => t + hr.length, 0), 0);
  const body = `// Auto-generated by build-region.mjs (region: ${id}) — do not edit manually.
// Lazy-loaded coastline+water for one harbour/river region. Loaded on demand by
// region_coast.js when a trail's extent intersects bbox. ${land.length} land rings,
// ${water.length} water polys (${holes} holes), ${verts} vertices.
export const REGION = {
  id: ${JSON.stringify(id)},
  bbox: ${JSON.stringify(bb)},
  land: ${JSON.stringify(land)},
  water: ${JSON.stringify(water)},
};
export default REGION;
`;
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `${id}.js`);
  fs.writeFileSync(out, body);
  return { id, out, landRings: land.length, waterPolys: water.length, holes, verts, kb: +(Buffer.byteLength(body) / 1024).toFixed(0) };
}

// ── CLI: build one region whose dumps are already in /tmp/osm_{coast,water}_<id>.json ──
if (import.meta.url === `file://${process.argv[1]}`) {
  const [id, mnLa, mnLo, mxLa, mxLo] = process.argv.slice(2);
  if (!id || mxLo === undefined) { console.error('usage: build-region.mjs <id> <minLat> <minLon> <maxLat> <maxLon>'); process.exit(1); }
  const bbox = { minLat: +mnLa, minLon: +mnLo, maxLat: +mxLa, maxLon: +mxLo };
  const coastElements = JSON.parse(fs.readFileSync(`/tmp/osm_coast_${id}.json`, 'utf8')).elements;
  const waterElements = JSON.parse(fs.readFileSync(`/tmp/osm_water_${id}.json`, 'utf8')).elements;
  const s = buildRegion({ id, bbox, coastElements, waterElements });
  console.log(`region ${id}: ${s.landRings} land rings, ${s.waterPolys} water polys (${s.holes} holes) → ${s.out} (${s.kb} KB)`);
}
