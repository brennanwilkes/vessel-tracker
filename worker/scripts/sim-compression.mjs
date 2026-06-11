// Phase-0 compression simulation (read-only).
//
// Pulls real `positions` tracks from the live D1 and replays each vessel's per-tier
// track through the proposed online trajectory compressor (cross-track corridor +
// speed/state change + max time/distance gap). Reports how many points we'd KEEP vs
// DROP, per tier and per vessel category — i.e. the Phase-1 savings, predicted from
// real data before any behavior change.
//
// Caveat: stored points are ALREADY thinned by the current distance threshold
// (direct 0.05nm / local 0.5nm / global 5nm). The live compressor runs on the raw
// stream, so real savings are >= what this reports. For the direct tier (a point
// almost every scan while moving) this is close to representative; for local/global
// it is a conservative lower bound.
//
// Usage:  node scripts/sim-compression.mjs            # remote D1
//         node scripts/sim-compression.mjs --local    # local D1
//         CORRIDOR_NM=0.08 node scripts/sim-compression.mjs   # override a threshold

import { execFileSync } from 'node:child_process';

const REMOTE = process.argv.includes('--local') ? '--local' : '--remote';

// Candidate compressor thresholds, per tier. A point is KEPT when, since the last
// kept point, ANY of these trip: cross-track deviation from the running straight
// segment, an absolute speed change, a moving<->stopped state flip, or a max gap in
// time/distance (bounds dead-reckoning error). Tune from the printed ratios.
const MOVING_KN = 0.5;
const TIERS = {
  direct: { corridorNm: num('CORRIDOR_NM', 0.05), dV: num('DV_KN', 1.0), maxGapMs: mins(10), maxGapNm: 0.5 },
  local:  { corridorNm: num('CORRIDOR_NM', 0.30), dV: num('DV_KN', 2.0), maxGapMs: mins(30), maxGapNm: 3.0 },
  global: { corridorNm: num('CORRIDOR_NM', 2.00), dV: num('DV_KN', 3.0), maxGapMs: mins(120), maxGapNm: 25.0 },
};

function num(env, dflt) { return process.env[env] !== undefined ? Number(process.env[env]) : dflt; }
function mins(m) { return m * 60 * 1000; }

const R_NM = 3440.065;
const toRad = d => (d * Math.PI) / 180;

function haversineNm(aLat, aLon, bLat, bLon) {
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_NM * Math.asin(Math.sqrt(s));
}

function bearingRad(aLat, aLon, bLat, bLon) {
  const y = Math.sin(toRad(bLon - aLon)) * Math.cos(toRad(bLat));
  const x = Math.cos(toRad(aLat)) * Math.sin(toRad(bLat))
    - Math.sin(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.cos(toRad(bLon - aLon));
  return Math.atan2(y, x);
}

// Cross-track distance (nm) of point C from the great-circle ray (E, refBearing).
function crossTrackNm(eLat, eLon, refBearing, cLat, cLon) {
  const d13 = haversineNm(eLat, eLon, cLat, cLon) / R_NM; // angular
  const b13 = bearingRad(eLat, eLon, cLat, cLon);
  return Math.abs(Math.asin(Math.sin(d13) * Math.sin(b13 - refBearing)) * R_NM);
}

// Replay one ordered track; return number of points the compressor would emit.
function compress(track, cfg) {
  if (track.length <= 2) return track.length;
  let kept = 1;            // always keep the first point
  let e = track[0];        // last emitted point
  let ref = null;          // bearing of the current straight segment
  for (let i = 1; i < track.length - 1; i++) {
    const c = track[i];
    if (ref === null) ref = bearingRad(e.lat, e.lon, c.lat, c.lon);
    const dtMs = c.ts - e.ts;
    const dNm = haversineNm(e.lat, e.lon, c.lat, c.lon);
    const eMoving = (e.speed ?? 0) > MOVING_KN;
    const cMoving = (c.speed ?? 0) > MOVING_KN;
    const speedJump = Math.abs((c.speed ?? 0) - (e.speed ?? 0)) > cfg.dV;
    const xtd = crossTrackNm(e.lat, e.lon, ref, c.lat, c.lon);
    if (dtMs > cfg.maxGapMs || dNm > cfg.maxGapNm || speedJump || eMoving !== cMoving || xtd > cfg.corridorNm) {
      kept++; e = c; ref = null;
    }
  }
  return kept + 1;         // always keep the last point
}

function category(type) {
  if (type === null || type === undefined) return 'unknown';
  if (type >= 70 && type <= 79) return 'cargo';
  if (type >= 80 && type <= 89) return 'tanker';
  if (type >= 60 && type <= 69) return 'passenger';
  if (type === 36 || type === 37) return 'pleasure';
  if (type >= 31 && type <= 32) return 'tug';
  if (type === 30) return 'fishing';
  if (type >= 40 && type <= 49) return 'ferry';
  return 'other';
}

function d1(sql) {
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'vessel-tracker', REMOTE, '--json', '--command', sql], {
    encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
  });
  const parsed = JSON.parse(out);
  return parsed[0].results;
}

console.error(`[sim] querying positions (${REMOTE})…`);
const rows = d1(
  `SELECT p.mmsi, p.lat, p.lon, p.speed, p.ts, p.tier, v.vessel_type
   FROM positions p LEFT JOIN vessels v ON v.mmsi = p.mmsi
   ORDER BY p.mmsi, p.tier, p.ts`
);
console.error(`[sim] ${rows.length} position rows loaded`);

// Group into per-(mmsi,tier) tracks.
const tracks = new Map();
for (const r of rows) {
  const key = `${r.mmsi}|${r.tier}`;
  if (!tracks.has(key)) tracks.set(key, { tier: r.tier, type: r.vessel_type, pts: [] });
  tracks.get(key).pts.push({ lat: r.lat, lon: r.lon, speed: r.speed, ts: r.ts });
}

const byTier = {};
const byCat = {};
for (const { tier, type, pts } of tracks.values()) {
  const cfg = TIERS[tier];
  if (!cfg) continue;
  const kept = compress(pts, cfg);
  const cat = category(type);
  (byTier[tier] ??= { in: 0, kept: 0, tracks: 0 });
  byTier[tier].in += pts.length; byTier[tier].kept += kept; byTier[tier].tracks++;
  (byCat[cat] ??= { in: 0, kept: 0 });
  byCat[cat].in += pts.length; byCat[cat].kept += kept;
}

const pct = (kept, inn) => inn === 0 ? '—' : `${(100 * (1 - kept / inn)).toFixed(1)}% dropped (${(inn / kept).toFixed(1)}×)`;

console.log('\n=== Compression simulation — thresholds ===');
for (const [t, c] of Object.entries(TIERS)) {
  console.log(`  ${t.padEnd(7)} corridor=${c.corridorNm}nm dV=${c.dV}kn maxGap=${c.maxGapMs / 60000}min/${c.maxGapNm}nm`);
}
console.log('\n=== By tier ===');
for (const [tier, s] of Object.entries(byTier)) {
  console.log(`  ${tier.padEnd(7)} in=${s.in}  kept=${s.kept}  ${pct(s.kept, s.in)}  (${s.tracks} tracks)`);
}
console.log('\n=== By vessel category ===');
for (const [cat, s] of Object.entries(byCat).sort((a, b) => b[1].in - a[1].in)) {
  console.log(`  ${cat.padEnd(10)} in=${s.in}  kept=${s.kept}  ${pct(s.kept, s.in)}`);
}
const totIn = Object.values(byTier).reduce((a, s) => a + s.in, 0);
const totKept = Object.values(byTier).reduce((a, s) => a + s.kept, 0);
console.log(`\n=== TOTAL position writes: in=${totIn} kept=${totKept}  ${pct(totKept, totIn)} ===`);
console.log('(Position writes only. Each kept move also currently pairs a vessel upsert —');
console.log(' Phase-1 lever #1 decouples that separately. Lower bound: stream is denser than stored.)');
