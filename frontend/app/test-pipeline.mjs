import { readFileSync } from 'fs';
import { LAND_POLYGONS } from './coastline.js';
import { routeAroundLand, haversineKm, haversineNm, bearingDeg, segmentsIntersect, intersectionPoint } from './geo.js';
import { LAND_AVOIDANCE, TRAIL_GAP_SEVER_MS } from '../config.js';

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

globalThis.window = { __DEBUG_MMSI: null };

// Enable it for the target MMSI (matching drawTrail debug list)
const targetMMSI = parseInt(process.argv[2] || '0');
if ([357777000, 563303100, 319201600, 369970257].includes(targetMMSI)) {
  globalThis.window.__DEBUG_MMSI = targetMMSI;
}

const mapPageCode = readFileSync(new URL('./map_page.js', import.meta.url), 'utf8');
const stripExports = s => s.replace(/^export /gm, '');
const L = lines => stripExports(mapPageCode.split('\n').slice(lines[0] - 1, lines[1]).join('\n'));
eval([
  L([51, 132]),   // augmentSegment
  L([137, 207]),  // buildSubSegments
  L([414, 443]),  // preSmooth
  L([450, 490]),  // catmullRomPoints
  L([491, 522]),  // segmentsByTier
  // Expose to globalThis for access outside strict eval scope
  'globalThis.augmentSegment = augmentSegment;',
  'globalThis.buildSubSegments = buildSubSegments;',
  'globalThis.preSmooth = preSmooth;',
  'globalThis.catmullRomPoints = catmullRomPoints;',
  'globalThis.segmentsByTier = segmentsByTier;',
].join('\n'));

const { augmentSegment, buildSubSegments, preSmooth, catmullRomPoints, segmentsByTier } = globalThis;

function pointInPolygon(pt, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const yi = polygon[i][0], xi = polygon[i][1];
    const yj = polygon[j][0], xj = polygon[j][1];
    if ((yi > pt[0]) !== (yj > pt[0]) && pt[1] < (xj - xi) * (pt[0] - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const MMSI = parseInt(process.argv[2]);
if (!MMSI) { console.error('Usage: node test-pipeline.mjs <MMSI>'); process.exit(1); }
const apiData = JSON.parse(readFileSync(`/tmp/vessel-${MMSI}.json`, 'utf8'));
const chronological = [...apiData.points].reverse();

console.log(`\n=== MMSI ${MMSI} — Production-identical pipeline ===`);
console.log(`Raw points: ${chronological.length}`);

const segments = segmentsByTier(chronological, TRAIL_GAP_SEVER_MS);
console.log(`Segments: ${segments.length}`);
segments.forEach((s, si) => console.log(`  seg[${si}]: ${s.pts.length} pts t0=${s.t0} t1=${s.t1}`));

const allSmooth = [];
const segStats = [];

for (const [segIdx, seg] of segments.entries()) {
  if (seg.pts.length < 2) {
    console.log(`  seg[${segIdx}]: SKIP (< 2 pts)`);
    continue;
  }
  const augmented = augmentSegment(seg.pts, seg.t0, seg.t1);
  const subSegs = buildSubSegments(augmented);
  const synths = subSegs.filter(s => s.synthetic);
  const reals = subSegs.filter(s => !s.synthetic);
  console.log(`  seg[${segIdx}]: augment=${augmented.length}pts subSegs=${subSegs.length} (${synths.length} synth, ${reals.length} real)`);

  for (const sub of subSegs) {
    const smooth = catmullRomPoints(sub.pts, 12, sub.synthetic);
    for (const pt of smooth) allSmooth.push(pt);
  }
}

console.log(`\nCatmull-Rom spline points: ${allSmooth.length}`);

// Land-crossing analysis using exact pointInPolygon
const landPts = [];
for (let pi = 0; pi < allSmooth.length; pi++) {
  const [lat, lon] = allSmooth[pi];
  let overLand = false;
  for (let polyIdx = 0; polyIdx < LAND_POLYGONS.length; polyIdx++) {
    const bb = POLYGON_BBOXES[polyIdx];
    if (lat < bb.minLat || lat > bb.maxLat || lon < bb.minLon || lon > bb.maxLon) continue;
    if (pointInPolygon([lat, lon], LAND_POLYGONS[polyIdx])) { overLand = true; break; }
  }
  if (overLand) landPts.push({ idx: pi, lat, lon });
}

console.log(`\n=== LAND CROSSING ANALYSIS ===`);
console.log(`Spline points over land: ${landPts.length} / ${allSmooth.length} (${(landPts.length / allSmooth.length * 100).toFixed(1)}%)`);

const landRuns = [];
if (landPts.length > 0) {
  let rs = landPts[0].idx, re = landPts[0].idx;
  for (let li = 1; li < landPts.length; li++) {
    if (landPts[li].idx === landPts[li - 1].idx + 1) { re = landPts[li].idx; }
    else { landRuns.push({ start: rs, end: re, count: re - rs + 1, pts: landPts.slice(landRuns.reduce((s,r)=>s+r.count,0), li) }); rs = landPts[li].idx; re = landPts[li].idx; }
  }
  landRuns.push({ start: rs, end: re, count: re - rs + 1 });
}
console.log(`Land-crossing runs: ${landRuns.length}`);
for (const r of landRuns) {
  const st = allSmooth[r.start], en = allSmooth[r.end];
  const d = haversineKm(st[0], st[1], en[0], en[1]);
  console.log(`  [${r.start}-${r.end}] ${r.count} pts: ${st[0].toFixed(4)}N ${st[1].toFixed(4)}W → ${en[0].toFixed(4)}N ${en[1].toFixed(4)}W (${d.toFixed(1)} km)`);
}

// Zigzag detection
console.log(`\n=== ZIGZAG ANALYSIS ===`);
const bearings = [];
for (let i = 0; i < allSmooth.length - 1; i++) {
  bearings.push(bearingDeg(allSmooth[i][0], allSmooth[i][1], allSmooth[i + 1][0], allSmooth[i + 1][1]));
}
const zigzags = [];
for (let i = 1; i < bearings.length; i++) {
  const raw = Math.abs(bearings[i] - bearings[i - 1]);
  const diff = Math.min(raw, 360 - raw);
  if (diff > 90) zigzags.push({ idx: i, pt: allSmooth[i], b0: bearings[i - 1], b1: bearings[i], diff });
}
console.log(`Zigzag points (>90°): ${zigzags.length}`);
for (let zi = 0; zi < Math.min(zigzags.length, 20); zi++) {
  const z = zigzags[zi];
  console.log(`  [${zi}] pt[${z.idx}] ${z.pt[0].toFixed(4)}N ${z.pt[1].toFixed(4)}W: ${z.b0.toFixed(0)}°→${z.b1.toFixed(0)}° (Δ${z.diff.toFixed(0)}°)`);
}
if (zigzags.length > 20) console.log(`  ... and ${zigzags.length - 20} more`);

// Direct segmentCrossesPolygon check on raw trail pairs
console.log(`\n=== RAW SEGMENT LAND CROSSINGS ===`);
// segmentCrossesPolygon is internal to geo.js, so re-implement using imported primitives
function pointOnSegment(p, a, b) {
  const minX = Math.min(a[0], b[0]), maxX = Math.max(a[0], b[0]);
  const minY = Math.min(a[1], b[1]), maxY = Math.max(a[1], b[1]);
  return p[0] >= minX - 1e-12 && p[0] <= maxX + 1e-12 &&
         p[1] >= minY - 1e-12 && p[1] <= maxY + 1e-12;
}
function segDist(p, a) { return (p[0] - a[0]) ** 2 + (p[1] - a[1]) ** 2; }
function segmentCrossesPolygon(a, b, polygon) {
  const hits = [];
  for (let i = 0; i < polygon.length - 1; i++) {
    const c = polygon[i], d = polygon[(i + 1) % polygon.length];
    if (segmentsIntersect(a, b, c, d)) {
      const pt = intersectionPoint(a, b, c, d);
      if (pt && pointOnSegment(pt, a, b)) hits.push({ pt, edgeIdx: i });
    }
  }
  const aInside = pointInPolygon(a, polygon);
  const bInside = pointInPolygon(b, polygon);
  if (aInside && bInside) return null;
  if (aInside && hits.length >= 1) {
    hits.sort((x, y) => segDist(x.pt, a) - segDist(y.pt, a));
    return { entryPt: a, exitPt: hits[0].pt, entryEdgeIdx: -1, exitEdgeIdx: hits[0].edgeIdx };
  }
  if (bInside && hits.length >= 1) {
    hits.sort((x, y) => segDist(x.pt, a) - segDist(y.pt, a));
    return { entryPt: hits[hits.length - 1].pt, exitPt: b, entryEdgeIdx: hits[hits.length - 1].edgeIdx, exitEdgeIdx: -1 };
  }
  if (hits.length < 2) return null;
  hits.sort((x, y) => segDist(x.pt, a) - segDist(y.pt, a));
  const aLat0 = a[0], aLon0 = a[1];
  hits.sort((x, y) => {
    const dx1 = x.pt[0] - aLat0, dy1 = x.pt[1] - aLon0;
    const dx2 = y.pt[0] - aLat0, dy2 = y.pt[1] - aLon0;
    return (dx1 * dx1 + dy1 * dy1) - (dx2 * dx2 + dy2 * dy2);
  });
  hits.sort((x, y) => segDist(x.pt, a) - segDist(y.pt, a));
  return { entryPt: hits[0].pt, exitPt: hits[hits.length - 1].pt, entryEdgeIdx: hits[0].edgeIdx, exitEdgeIdx: hits[hits.length - 1].edgeIdx };
}

let crossCount = 0;
for (let i = 0; i < chronological.length - 1; i++) {
  const a = [chronological[i].lat, chronological[i].lon];
  const b = [chronological[i + 1].lat, chronological[i + 1].lon];
  const d = haversineKm(a[0], a[1], b[0], b[1]);
  if (d < 5) continue;
  for (let pi = 0; pi < LAND_POLYGONS.length; pi++) {
    const bb = POLYGON_BBOXES[pi];
    if (Math.min(a[0], b[0]) > bb.maxLat || Math.max(a[0], b[0]) < bb.minLat || Math.min(a[1], b[1]) > bb.maxLon || Math.max(a[1], b[1]) < bb.minLon) continue;
    const cross = segmentCrossesPolygon(a, b, LAND_POLYGONS[pi]);
    if (cross) {
      const eekm = haversineKm(cross.entryPt[0], cross.entryPt[1], cross.exitPt[0], cross.exitPt[1]);
      console.log(`  pair[${i}]→[${i+1}] d=${d.toFixed(1)}km poly[${pi}] ee=${eekm.toFixed(1)}km entry=${cross.entryPt[0].toFixed(4)},${cross.entryPt[1].toFixed(4)} exit=${cross.exitPt[0].toFixed(4)},${cross.exitPt[1].toFixed(4)}`);
      crossCount++;
      break;
    }
  }
}
console.log(`Land-crossing raw pairs (>5km): ${crossCount}`);

console.log(`\n${'='.repeat(60)}`);
console.log(`SUMMARY MMSI ${MMSI}`);
console.log(`${'='.repeat(60)}`);
console.log(`  Raw points:           ${chronological.length}`);
console.log(`  Segments:             ${segments.length}`);
console.log(`  Catmull-Rom points:   ${allSmooth.length}`);
console.log(`  Points over land:     ${landPts.length} (${(landPts.length / allSmooth.length * 100).toFixed(1)}%)`);
console.log(`  Land-crossing runs:   ${landRuns.length}`);
console.log(`  Zigzags (>90°):       ${zigzags.length}`);
