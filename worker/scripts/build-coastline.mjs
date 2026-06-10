#!/usr/bin/env node
// One-time data generation: clip Natural Earth 10m land to local bounding box,
// simplify, and output frontend/app/coastline.js as an ES module.
//
// Prerequisites:
//   curl -sS -o /tmp/ne_10m_land.geojson "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_land.geojson"
//
// Usage:  node scripts/build-coastline.mjs [/path/to/ne_10m_land.geojson]
// Run from worker/ directory.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LOCAL_BB = { minLat: 47.0, minLon: -128.7, maxLat: 51.2, maxLon: -122.0 };
const MARGIN = 0.1;
const SIMPLIFY_TOL = 0; // no simplification — full 10m resolution

const INPUT = process.argv[2] || '/tmp/ne_10m_land.geojson';
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(SCRIPT_DIR, '../../frontend/app/coastline.js');

// ── Sutherland-Hodgman polygon clipping ─────────────────────────────────────
// Clips a polygon (array of [lon,lat]) to a rectangular bounding box.
// Returns array of clipped polygons (may be empty).

function clipPolygonToBBox(ring, minLat, maxLat, minLon, maxLon) {
  // The ring is in [lon, lat] GeoJSON order. Sutherland-Hodgman clips against
  // each edge of the bounding box in sequence.
  let output = ring.slice(ring.length - 1, ring.length); // start from last point as first
  // Extend output with all points from ring (excluding the closing duplicate)
  output = output.concat(ring.slice(0, ring.length - 1));

  // Clip against each edge: left (minLon), right (maxLon), bottom (minLat), top (maxLat)
  const edges = [
    { test: (lon, lat) => lon >= minLon,   axis: 'lon', edge: minLon },
    { test: (lon, lat) => lon <= maxLon,   axis: 'lon', edge: maxLon },
    { test: (lon, lat) => lat >= minLat,   axis: 'lat', edge: minLat },
    { test: (lon, lat) => lat <= maxLat,   axis: 'lat', edge: maxLat },
  ];

  for (const edge of edges) {
    if (output.length < 2) return [];
    const input = output;
    output = [];

    for (let i = 0; i < input.length; i++) {
      const curr = input[i];
      const prev = input[(i - 1 + input.length) % input.length];
      const currInside = edge.test(curr[0], curr[1]);
      const prevInside = edge.test(prev[0], prev[1]);

      if (currInside) {
        if (!prevInside) {
          // Entering: emit intersection
          output.push(intersect(prev, curr, edge));
        }
        output.push(curr);
      } else if (prevInside) {
        // Exiting: emit intersection
        output.push(intersect(prev, curr, edge));
      }
    }
  }

  // Split into separate rings if the polygon was broken (e.g. clipped to
  // multiple disjoint pieces inside the bbox). For a single landmass in a
  // small bbox this is unlikely but handle it.
  // We dedupe by joining segments that share endpoints.
  if (output.length < 3) return [];
  // Close the ring and return
  if (output.length > 0) {
    if (output[0][0] !== output[output.length - 1][0] || output[0][1] !== output[output.length - 1][1]) {
      output.push([output[0][0], output[0][1]]);
    }
  }
  return output.length >= 4 ? [output] : [];
}

function intersect(p, q, edge) {
  const [lon1, lat1] = p;
  const [lon2, lat2] = q;
  if (edge.axis === 'lon') {
    const t = (edge.edge - lon1) / (lon2 - lon1);
    return [edge.edge, lat1 + t * (lat2 - lat1)];
  } else {
    const t = (edge.edge - lat1) / (lat2 - lat1);
    return [lon1 + t * (lon2 - lon1), edge.edge];
  }
}

// ── Douglas-Peucker simplification ──────────────────────────────────────────

function pointDistSq(lon1, lat1, lon2, lat2) {
  const dlon = lon2 - lon1, dlat = lat2 - lat1;
  return dlon * dlon + dlat * dlat;
}

function perpendicularDistSq(lon, lat, lonA, latA, lonB, latB) {
  const dx = lonB - lonA, dy = latB - latA;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-12) return pointDistSq(lon, lat, lonA, latA);
  const t = ((lon - lonA) * dx + (lat - latA) * dy) / lenSq;
  const cx = lonA + t * dx, cy = latA + t * dy;
  return pointDistSq(lon, lat, cx, cy);
}

function dpSimplify(pts, tolSq) {
  if (pts.length <= 2) return pts;
  let dmax = 0, idx = 0;
  const end = pts.length - 1;
  for (let i = 1; i < end; i++) {
    const d = perpendicularDistSq(pts[i][0], pts[i][1], pts[0][0], pts[0][1], pts[end][0], pts[end][1]);
    if (d > dmax) { dmax = d; idx = i; }
  }
  if (dmax > tolSq) {
    const left = dpSimplify(pts.slice(0, idx + 1), tolSq);
    const right = dpSimplify(pts.slice(idx), tolSq);
    return [...left.slice(0, -1), ...right];
  }
  return [pts[0], pts[end]];
}

function simplifyRing(ring, tol) {
  const tolSq = tol * tol;
  const closed = ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];
  const inner = closed ? ring.slice(0, -1) : ring;
  const simplified = dpSimplify(inner, tolSq);
  simplified.push([simplified[0][0], simplified[0][1]]);
  return simplified;
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main() {
  console.log(`Reading ${INPUT}...`);
  const geojson = JSON.parse(fs.readFileSync(INPUT, 'utf-8'));

  const clipped = [];
  let processed = 0, skipped = 0;

  const minLat = LOCAL_BB.minLat - MARGIN;
  const maxLat = LOCAL_BB.maxLat + MARGIN;
  const minLon = LOCAL_BB.minLon - MARGIN;
  const maxLon = LOCAL_BB.maxLon + MARGIN;

  console.log(`Clipping to [${minLat}, ${minLon}] → [${maxLat}, ${maxLon}]`);

  for (const feature of geojson.features) {
    const geom = feature.geometry;
    if (!geom) continue;

    const rings = [];
    if (geom.type === 'Polygon') {
      rings.push(geom.coordinates[0]);
    } else if (geom.type === 'MultiPolygon') {
      for (const poly of geom.coordinates) rings.push(poly[0]);
    }

    for (const ring of rings) {
      processed++;
      const results = clipPolygonToBBox(ring, minLat, maxLat, minLon, maxLon);
      if (results.length === 0) { skipped++; continue; }
      for (const clippedRing of results) {
        const simplified = simplifyRing(clippedRing, SIMPLIFY_TOL);
        if (simplified.length >= 4) clipped.push(simplified);
      }
    }
  }

  console.log(`Processed ${processed} rings, clipped & simplified ${clipped.length} polygons.`);

  // Convert from GeoJSON [lon, lat] to our [lat, lon] convention
  const polygons = clipped.map(ring => ring.map(([lon, lat]) => [lat, lon]));

  const code = `// Auto-generated by build-coastline.mjs — do not edit manually.
// Source: Natural Earth 10m land (ne_10m_land.geojson)
// Clipped to [${LOCAL_BB.minLat}, ${LOCAL_BB.minLon}] → [${LOCAL_BB.maxLat}, ${LOCAL_BB.maxLon}]

export const LAND_POLYGONS = ${JSON.stringify(polygons)};\n`;

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, code, 'utf-8');

  const totalPts = polygons.reduce((s, p) => s + p.length, 0);
  const sizeKB = (Buffer.byteLength(code) / 1024).toFixed(1);
  console.log(`Wrote ${polygons.length} polygons (${totalPts} pts, ${sizeKB} KB) → ${OUT}`);
}

try {
  main();
} catch (err) {
  console.error('Error:', err.message);
  process.exit(1);
}
