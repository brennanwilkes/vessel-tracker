// Server-side trail precompute. Runs as a GitHub Actions cron (NOT a CF Worker —
// free Workers are CPU-capped ~10ms; our A* is 0.1–2s). Reuses the frontend's
// land-aware geometry pipeline (trail_geometry.js) under Node, finds where each
// of-interest vessel's rendered curve would cross land, and stores the FEWEST
// inferred (A*-routed) waypoints that keep it off land. The Worker unions these
// with live positions at /track; the browser re-splines with pure math, no
// coastline. See worker/CLAUDE.md "server-side inferred-positions precompute".
//
//   node scripts/precompute-trails.mjs [--local] [--dry-run] [--regenerate]
//                                      [--limit N] [--mmsi N]
//
// Converge, don't churn: a vessel is skipped (no A*, no write) when either its
// newest position hasn't advanced since we last looked (precompute_state) OR its
// already-stored fakes still keep the curve off land. Only a new land-crossing
// triggers a recompute, and only changed segments are written. Bump
// GENERATOR_VERSION (or pass --regenerate) to force a full rebuild after a
// routing/coastline change.
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { harvestInferredSegments } from '../../frontend/app/trail_geometry.js';
import { ensureRegionsForExtent, extentOf, isLand } from '../../frontend/app/region_coast.js';
import { dedup, splitJourneys, catmullRom } from '../../frontend/app/trail_spline.js';
import { haversineKm } from '../../frontend/app/geo.js';

const GENERATOR_VERSION = 1;
const DB = 'vessel-tracker';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valOf = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const DRY = has('--dry-run');
const ENV_FLAG = has('--local') ? '--local' : '--remote';
const REGENERATE = has('--regenerate');
const LIMIT = valOf('--limit') ? parseInt(valOf('--limit'), 10) : Infinity;
const ONLY_MMSI = valOf('--mmsi') ? parseInt(valOf('--mmsi'), 10) : null;

const tmp = mkdtempSync(join(tmpdir(), 'precompute-'));

// ── D1 via wrangler (same backend as scripts/db-*) ──────────────────────────
function query(sql) {
  const out = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', DB, ENV_FLAG, '--json', '--command', sql],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 }
  );
  const start = out.indexOf('[');
  const parsed = JSON.parse(out.slice(start));
  return parsed[0]?.results ?? [];
}

// Run a batch of write statements from a file (multiple statements per call).
function execWrites(statements, label) {
  if (statements.length === 0) return;
  if (DRY) return;
  const file = join(tmp, `${label}.sql`);
  writeFileSync(file, statements.join('\n'));
  execFileSync('npx', ['wrangler', 'd1', 'execute', DB, ENV_FLAG, '--file', file], { stdio: 'inherit' });
}

const sqlStr = (s) => `'${String(s).replace(/'/g, "''")}'`;

// A segment's stable key: the bracketing real timestamps (positions are
// immutable, so these pin the bracket and its coords) + vessel length + version.
// Length jitter is rare and a correction SHOULD regenerate, so it's included raw.
function segHash(aT, bT, length) {
  return `${aT}-${bT}-${length === null || length === undefined ? 'n' : length}-v${GENERATOR_VERSION}`;
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const vessels = query(
    `SELECT mmsi, length, last_pos_ts FROM vessels
     WHERE of_interest = 1 AND first_direct_at IS NOT NULL AND last_pos_ts IS NOT NULL
     ORDER BY last_seen DESC`
  ).filter(v => ONLY_MMSI === null || v.mmsi === ONLY_MMSI);

  const stateRows = query(`SELECT mmsi, last_pos_ts_seen FROM precompute_state`);
  const lastSeenTs = new Map(stateRows.map(r => [r.mmsi, r.last_pos_ts_seen]));

  let examined = 0, skippedHeuristic = 0, skippedConverged = 0;
  let segmentsWritten = 0, pointsWritten = 0, segmentsDeleted = 0;
  const now = Date.now();

  for (const v of vessels) {
    if (examined >= LIMIT) break;

    // Heuristic skip: no new movement since we last examined this vessel.
    if (!REGENERATE && lastSeenTs.has(v.mmsi) && v.last_pos_ts <= lastSeenTs.get(v.mmsi)) {
      skippedHeuristic++;
      continue;
    }
    examined++;

    const points = query(
      `SELECT lat, lon, speed, ts, tier FROM positions WHERE mmsi = ${v.mmsi} ORDER BY ts ASC`
    ).map(r => ({ lat: r.lat, lon: r.lon, speed: r.speed, t: r.ts, tier: r.tier }));
    if (points.length < 2) { upsertState(v.mmsi, v.last_pos_ts, now); continue; }

    await ensureRegionsForExtent(extentOf(points));

    const existing = query(
      `SELECT seg_hash, lat, lon, t, tier, dashed FROM inferred_positions WHERE mmsi = ${v.mmsi}`
    );

    // Cheap convergence check (no A*): does the curve through the live fixes +
    // already-stored fakes still stay off land? If so, nothing to do.
    if (!REGENERATE && curveIsLandFree(points, existing)) {
      skippedConverged++;
      upsertState(v.mmsi, v.last_pos_ts, now);
      continue;
    }

    // Recompute: route every land-crossing segment, keep the minimal water-tight
    // fakes. Diff against what's stored — write only new/changed segments.
    const segments = harvestInferredSegments(points, { vesselLength: v.length });
    const wantBySeg = new Map();      // seg_hash → fakes (with inherited tier)
    for (const seg of segments) {
      const hash = segHash(seg.aT, seg.bT, v.length);
      const tier = tierForGap(points, seg.aT, seg.bT);
      wantBySeg.set(hash, seg.fakes.map(f => ({ ...f, tier })));
    }

    const haveSegs = new Set(existing.map(r => r.seg_hash));
    const wantSegs = new Set(wantBySeg.keys());
    const toInsert = [...wantSegs].filter(h => REGENERATE || !haveSegs.has(h));
    const toDelete = [...haveSegs].filter(h => !wantSegs.has(h) || REGENERATE);

    const writes = [];
    for (const h of toDelete) {
      writes.push(`DELETE FROM inferred_positions WHERE mmsi = ${v.mmsi} AND seg_hash = ${sqlStr(h)};`);
      writes.push(`DELETE FROM inferred_segments WHERE mmsi = ${v.mmsi} AND seg_hash = ${sqlStr(h)};`);
      segmentsDeleted++;
    }
    for (const h of toInsert) {
      const fakes = wantBySeg.get(h);
      fakes.forEach((f, seq) => {
        writes.push(
          `INSERT OR REPLACE INTO inferred_positions (mmsi, seg_hash, seq, lat, lon, t, tier, dashed, generator_version)` +
          ` VALUES (${v.mmsi}, ${sqlStr(h)}, ${seq}, ${f.lat}, ${f.lon}, ${Math.round(f.t)}, ${sqlStr(f.tier)}, ${f.dashed}, ${GENERATOR_VERSION});`
        );
        pointsWritten++;
      });
      writes.push(
        `INSERT OR REPLACE INTO inferred_segments (mmsi, seg_hash, point_count, generator_version, computed_at)` +
        ` VALUES (${v.mmsi}, ${sqlStr(h)}, ${fakes.length}, ${GENERATOR_VERSION}, ${now});`
      );
      segmentsWritten++;
    }
    writes.push(stateUpsertSql(v.mmsi, v.last_pos_ts, now));
    execWrites(writes, `mmsi-${v.mmsi}`);
  }

  console.log(
    `[precompute] candidates=${vessels.length} examined=${examined} ` +
    `skipped_heuristic=${skippedHeuristic} skipped_converged=${skippedConverged} ` +
    `segments_written=${segmentsWritten} segments_deleted=${segmentsDeleted} points_written=${pointsWritten}` +
    (DRY ? '  (DRY RUN — no writes)' : '')
  );

  // ── helpers that need the closure's counters/state ────────────────────────
  function upsertState(mmsi, ts, at) { execWrites([stateUpsertSql(mmsi, ts, at)], `state-${mmsi}`); }
}

function stateUpsertSql(mmsi, ts, at) {
  return `INSERT OR REPLACE INTO precompute_state (mmsi, last_pos_ts_seen, last_run_at) VALUES (${mmsi}, ${ts}, ${at});`;
}

// Tier to attribute to a gap's fakes: the tier of its bracketing real fixes
// (so the client's per-tier trail filter keeps/hides them with the reals).
function tierForGap(points, aT, bT) {
  const a = points.find(p => p.t === aT);
  const b = points.find(p => p.t === bT);
  // Prefer the coarser tier of the two ends so a fake never outlives its reals.
  const order = { direct: 0, local: 1, global: 2 };
  const ta = a?.tier ?? 'local', tb = b?.tier ?? 'local';
  return order[ta] >= order[tb] ? ta : tb;
}

// Reconstruct the client's pure render (live fixes + stored fakes) and report
// whether the rendered spline stays off land (ignoring samples that hug a real
// fix that is itself on land — trust the boat). Region-aware isLand; no A*.
function curveIsLandFree(points, existingFakes) {
  const realOnLand = points.filter(p => isLand(p.lat, p.lon));
  const fakes = existingFakes.map(f => ({ lat: f.lat, lon: f.lon, t: f.t, fake: true, synthetic: f.dashed === 1 }));
  const reals = points.map(p => ({ lat: p.lat, lon: p.lon, t: p.t, tier: p.tier, speed: p.speed, fake: false, synthetic: false }));
  const combined = [...reals, ...fakes].sort((a, b) => a.t - b.t);
  for (const journey of splitJourneys(dedup(combined))) {
    if (journey.length < 2) continue;
    for (const s of catmullRom(journey)) {
      if (!isLand(s.lat, s.lon)) continue;
      const nearReal = realOnLand.some(r => haversineKm(r.lat, r.lon, s.lat, s.lon) < 1.5);
      if (!nearReal) return false;
    }
  }
  return true;
}

main().catch(err => { console.error(err); process.exit(1); });
