import { readFileSync } from 'fs';
import { LAND_POLYGONS } from './coastline.js';
import { haversineKm, bearingDeg } from './geo.js';
import { TRAIL_GAP_SEVER_MS } from '../config.js';

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
if (!MMSI) { console.error('Usage: node real-test.mjs <MMSI>'); process.exit(1); }
const apiData = JSON.parse(readFileSync(new URL(`/tmp/vessel-${MMSI}.json`, import.meta.url), 'utf8'));
const chronological = [...apiData.points].reverse();

console.log(`\n=== MMSI ${MMSI} — Direct import pipeline ===`);
console.log(`Raw points: ${chronological.length}`);

const segments = segmentsByTier(chronological, TRAIL_GAP_SEVER_MS);
console.log(`Segments: ${segments.length}`);
segments.forEach((s, si) => console.log(`  seg[${si}]: ${s.pts.length} pts t0=${s.t0} t1=${s.t1}`));

const allSmooth = [];
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

const landPts = [];
for (let pi = 0; pi < allSmooth.length; pi++) {
  const pt = allSmooth[pi];
  const lat = pt.lat !== undefined ? pt.lat : pt[0];
  const lon = pt.lon !== undefined ? pt.lon : pt[1];
  for (let polyIdx = 0; polyIdx < LAND_POLYGONS.length; polyIdx++) {
    const bb = LAND_POLYGONS[polyIdx].reduce((acc, [lat, lon]) => {
      acc.minLat = Math.min(acc.minLat, lat);
      acc.maxLat = Math.max(acc.maxLat, lat);
      acc.minLon = Math.min(acc.minLon, lon);
      acc.maxLon = Math.max(acc.maxLon, lon);
      return acc;
    }, { minLat: 90, maxLat: -90, minLon: 180, maxLon: -180 });
    if (lat < bb.minLat || lat > bb.maxLat || lon < bb.minLon || lon > bb.maxLon) continue;
    if (pointInPolygon([lat, lon], LAND_POLYGONS[polyIdx])) { landPts.push({ idx: pi, lat, lon, polyIdx }); break; }
  }
}

console.log(`\n=== LAND CROSSING ANALYSIS ===`);
console.log(`Spline points over land: ${landPts.length} / ${allSmooth.length} (${(landPts.length / allSmooth.length * 100).toFixed(1)}%)`);

const landRuns = [];
if (landPts.length > 0) {
  let rs = landPts[0].idx, re = landPts[0].idx;
  for (let li = 1; li < landPts.length; li++) {
    if (landPts[li].idx === landPts[li - 1].idx + 1) { re = landPts[li].idx; }
    else { landRuns.push({ start: rs, end: re, count: re - rs + 1 }); rs = landPts[li].idx; re = landPts[li].idx; }
  }
  landRuns.push({ start: rs, end: re, count: re - rs + 1 });
}
console.log(`Land-crossing runs: ${landRuns.length}`);
for (const r of landRuns) {
  const st = allSmooth[r.start], en = allSmooth[r.end];
  const slat = st.lat !== undefined ? st.lat : st[0], slon = st.lon !== undefined ? st.lon : st[1];
  const elat = en.lat !== undefined ? en.lat : en[0], elon = en.lon !== undefined ? en.lon : en[1];
  const d = haversineKm(slat, slon, elat, elon);
  console.log(`  [${r.start}-${r.end}] ${r.count} pts: ${slat.toFixed(4)}N ${slon.toFixed(4)}W → ${elat.toFixed(4)}N ${elon.toFixed(4)}W (${d.toFixed(1)} km)`);
}

console.log(`\n=== ZIGZAG ANALYSIS ===`);
const bearings = [];
for (let i = 0; i < allSmooth.length - 1; i++) {
  const a = allSmooth[i], b = allSmooth[i + 1];
  const alat = a.lat !== undefined ? a.lat : a[0], alon = a.lon !== undefined ? a.lon : a[1];
  const blat = b.lat !== undefined ? b.lat : b[0], blon = b.lon !== undefined ? b.lon : b[1];
  bearings.push(bearingDeg(alat, alon, blat, blon));
}
const zigzags = [];
for (let i = 1; i < bearings.length; i++) {
  const raw = Math.abs(bearings[i] - bearings[i - 1]);
  const diff = Math.min(raw, 360 - raw);
  if (diff > 90) {
    const pt = allSmooth[i];
    const lat = pt.lat !== undefined ? pt.lat : pt[0], lon = pt.lon !== undefined ? pt.lon : pt[1];
    zigzags.push({ idx: i, pt: { lat, lon }, b0: bearings[i - 1], b1: bearings[i], diff });
  }
}
console.log(`Zigzag points (>90°): ${zigzags.length}`);
for (let zi = 0; zi < Math.min(zigzags.length, 20); zi++) {
  const z = zigzags[zi];
  console.log(`  [${zi}] pt[${z.idx}] ${z.pt.lat.toFixed(4)}N ${z.pt.lon.toFixed(4)}W: ${z.b0.toFixed(0)}°→${z.b1.toFixed(0)}° (Δ${z.diff.toFixed(0)}°)`);
}
if (zigzags.length > 20) console.log(`  ... and ${zigzags.length - 20} more`);

console.log(`\n${'='.repeat(60)}`);
console.log(`SUMMARY MMSI ${MMSI}`);
console.log(`${'='.repeat(60)}`);
console.log(`  Raw points:           ${chronological.length}`);
console.log(`  Segments:             ${segments.length}`);
console.log(`  Catmull-Rom points:   ${allSmooth.length}`);
console.log(`  Points over land:     ${landPts.length} (${(landPts.length / allSmooth.length * 100).toFixed(1)}%)`);
console.log(`  Land-crossing runs:   ${landRuns.length}`);
console.log(`  Zigzags (>90°):       ${zigzags.length}`);
