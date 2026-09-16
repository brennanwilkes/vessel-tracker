// Audit LIVE production trails for land crossings.
//
//   node tests/audit-prod.mjs <mmsi> [<mmsi> ...]   # specific vessels
//   node tests/audit-prod.mjs --all                 # every vessel in /current
//   node tests/audit-prod.mjs --all --top 20        # worst 20 only
//
// Fetches what the browser actually receives (`/vessel/<mmsi>/track`, real fixes
// UNION stored inferred waypoints), splines it with the same pure pipeline the
// client uses, and reports where the rendered curve sits on land.
//
// This is the check the fixture suites cannot make: fixtures cover 12 vessels,
// production carries ~700. It found both live defect classes in docs/known-issues.md
// §4, and it is how to verify a `--regenerate` actually improved anything.
//
// Reading the output — each column changes the diagnosis:
//   fine=N  coarse=M   which land layer was hit. ALL-coarse means the fine
//                      coastline does not cover that area at all (a data-coverage
//                      gap, §4), NOT a router bug. See tests/README.md §1.
//   nearRealFix        defects within 1.5 km of a real fix that is itself on land
//                      — the berth artifact (§2), generally accepted, not a bug.
//   awayFromReal       genuine rendering defects. This is the number that matters.
//   largest spans      an UNROUTED gap renders as a straight bridge; a routed one
//                      has waypoints every few km. A big span between two
//                      `fake=false` points means routing produced nothing (§4a).
import { pointInAnyLand, LAND_POLYGONS } from './lib.mjs';
import { haversineKm } from '../frontend/app/geo.js';
import { dedup, splitJourneys, catmullRom } from '../frontend/app/trail_spline.js';
import { isLand as regionIsLand, hasFineLand, ensureRegionsForExtent, extentOf } from '../frontend/app/region_coast.js';
import { WORKER_URL } from '../frontend/config.js';

// `tests/lib.mjs` loads ONLY the home-bbox coastline (to 51.2N) plus the ~2 km
// coarse layer — it does NOT load the lazily-fetched regional fine coastlines
// (bc-central-*, foreign zones) that the precompute and the client actually use.
// Judging a north-coast BC trail with it therefore reports every defect as
// "coarse" and every point as outside fine coverage, which reads as a data-coverage
// gap that does not exist. That misread cost real time — see docs/known-issues.md §4.
// So classify against region_coast, the same authority the router uses, after
// explicitly loading the regions covering each vessel's extent.

const NEAR_REAL_LAND_KM = 1.5;
const SPAN_REPORT_KM = 50;

// Radial search outward until open water is found — how deep inside land a point is.
function penetrationM(p) {
  for (let radKm = 0.05; radKm <= 3; radKm += 0.05) {
    const dLat = radKm / 111.32, dLon = radKm / (111.32 * Math.cos(p[0] * Math.PI / 180));
    for (let a = 0; a < 16; a++) {
      const th = a / 16 * 2 * Math.PI;
      if (pointInAnyLand([p[0] + dLat * Math.sin(th), p[1] + dLon * Math.cos(th)]) < 0) return radKm * 1000;
    }
  }
  return 3000;
}

async function audit(mmsi) {
  const res = await fetch(`${WORKER_URL}/vessel/${mmsi}/track`);
  if (!res.ok) throw new Error(`/vessel/${mmsi}/track → HTTP ${res.status}`);
  const { points } = await res.json();
  const pts = points.map(p => ({
    lat: p.lat, lon: p.lon, t: p.t, tier: p.tier, speed: p.speed,
    fake: !!p.fake, synthetic: p.dashed === 1,
  })).sort((a, b) => a.t - b.t);

  await ensureRegionsForExtent(extentOf(pts));
  const realOnLand = pts.filter(p => !p.fake && regionIsLand(p.lat, p.lon));

  const spans = [];
  for (let i = 1; i < pts.length; i++) {
    const d = haversineKm(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon);
    if (d > SPAN_REPORT_KM) spans.push({ d, a: pts[i - 1], b: pts[i] });
  }
  spans.sort((x, y) => y.d - x.d);

  let near = 0, away = 0, fine = 0, coarse = 0, maxPenM = 0, worst = null, peakLat = -90;
  for (const journey of splitJourneys(dedup(pts))) {
    if (journey.length < 2) continue;
    for (const s of catmullRom(journey)) {
      if (s.lat > peakLat) peakLat = s.lat;
      if (!regionIsLand(s.lat, s.lon)) continue;
      // fine = the router had harbour-grade data here and still crossed it (a real
      // routing defect); coarse = only the ~2 km layer covers it, where a graze is
      // expected and largely cosmetic.
      hasFineLand(s.lat, s.lon) ? fine++ : coarse++;
      if (realOnLand.some(r => haversineKm(r.lat, r.lon, s.lat, s.lon) < NEAR_REAL_LAND_KM)) { near++; continue; }
      away++;
      const pen = penetrationM([s.lat, s.lon]);
      if (pen > maxPenM) { maxPenM = pen; worst = s; }
    }
  }
  return { mmsi, pts, spans, near, away, fine, coarse, maxPenM, worst, peakLat, realOnLand: realOnLand.length };
}

function report(r, verbose) {
  console.log(
    `${String(r.mmsi).padEnd(10)} pts=${String(r.pts.length).padStart(4)} ` +
    `fake=${String(r.pts.filter(p => p.fake).length).padStart(4)}  ` +
    `awayFromReal=${String(r.away).padStart(4)} nearRealFix=${String(r.near).padStart(3)}  ` +
    `fine=${String(r.fine).padStart(4)} coarse=${String(r.coarse).padStart(4)}  ` +
    `maxPen=${String(Math.round(r.maxPenM)).padStart(4)}m  peak=${r.peakLat.toFixed(1)}N` +
    (r.worst ? `  worst ${r.worst.lat.toFixed(3)},${r.worst.lon.toFixed(3)}` : '')
  );
  if (!verbose) return;
  for (const s of r.spans.slice(0, 5)) {
    console.log(`    span ${s.d.toFixed(0).padStart(5)} km ${((s.b.t - s.a.t) / 3600000).toFixed(1).padStart(6)} h  ` +
      `${s.a.lat.toFixed(2)},${s.a.lon.toFixed(2)} -> ${s.b.lat.toFixed(2)},${s.b.lon.toFixed(2)} ` +
      `${!s.a.fake && !s.b.fake ? '** both real -> UNROUTED' : ''}`);
  }
}

const args = process.argv.slice(2);
const all = args.includes('--all');
const topIdx = args.indexOf('--top');
const top = topIdx >= 0 ? Number(args[topIdx + 1]) : Infinity;

let mmsis = args.filter(a => /^\d+$/.test(a));
if (all) {
  const { vessels } = await fetch(`${WORKER_URL}/current`).then(r => r.json());
  mmsis = vessels.map(v => v.mmsi);
  console.log(`auditing ${mmsis.length} vessels from /current …\n`);
}
if (!mmsis.length) { console.error('usage: node tests/audit-prod.mjs <mmsi>... | --all [--top N]'); process.exit(2); }

const results = [];
for (const m of mmsis) {
  try {
    const r = await audit(m);
    results.push(r);
    if (!all) report(r, true);
  } catch (e) {
    console.error(`${m}: ${e.message}`);
  }
}

if (all) {
  results.sort((a, b) => b.away - a.away || b.maxPenM - a.maxPenM);
  for (const r of results.slice(0, top)) report(r, false);
  const bad = results.filter(r => r.away > 0);
  console.log(`\n${bad.length}/${results.length} vessels with genuine land defects; ` +
    `${results.filter(r => r.away > 0 && r.fine === 0).length} of those are COARSE-ONLY ` +
    `(data-coverage gaps, see docs/known-issues.md §4).`);
}
