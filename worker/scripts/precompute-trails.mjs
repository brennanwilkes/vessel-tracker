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
// I/O is BATCHED so the run is dominated by A* CPU, not DB round-trips: remote
// uses the D1 HTTP query API (one fetch per chunk — no per-vessel process spawn,
// and no `wrangler d1 execute --file` import-lock, which is what prints "your D1
// will be unavailable"). All reads are chunked `IN(...)`; all writes accumulate
// into one batched multi-statement flush at the end. `--local` falls back to
// wrangler against the local dev DB. Needs CLOUDFLARE_API_TOKEN +
// CLOUDFLARE_ACCOUNT_ID (the deploy workflow provides both).
//
// Converge, don't churn: a vessel is skipped (no A*, no write) when either its
// newest position hasn't advanced since we last looked (precompute_state) OR its
// already-stored fakes still keep the curve off land. Only a new land-crossing
// triggers a recompute, and only changed segments are written. So the FIRST run
// (empty state, every gapped vessel needs backfill) is the slow one; later runs
// touch only the handful of vessels that moved into a new gap since. Bump
// GENERATOR_VERSION (or pass --regenerate) to force a full rebuild.
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { harvestInferredSegments } from '../../frontend/app/trail_geometry.js';
import { ensureRegionsForExtent, extentOf, isLand } from '../../frontend/app/region_coast.js';
import { dedup, splitJourneys, catmullRom } from '../../frontend/app/trail_spline.js';
import { haversineKm } from '../../frontend/app/geo.js';

const GENERATOR_VERSION = 1;
const DB_NAME = 'vessel-tracker';
const API_BASE = 'https://api.cloudflare.com/client/v4';
const READ_CHUNK = 60;   // mmsis per IN(...) read
const WRITE_CHUNK = 50;  // statements per batched HTTP write
const FLUSH_EVERY = 400; // flush accumulated writes mid-run past this many statements

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valOf = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const DRY = has('--dry-run');
const LOCAL = has('--local');
const REGENERATE = has('--regenerate');
const LIMIT = valOf('--limit') ? parseInt(valOf('--limit'), 10) : Infinity;
const ONLY_MMSI = valOf('--mmsi') ? parseInt(valOf('--mmsi'), 10) : null;

const tmp = LOCAL ? mkdtempSync(join(tmpdir(), 'precompute-')) : null;
const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
const sqlStr = (s) => `'${String(s).replace(/'/g, "''")}'`;

// ── D1 access ────────────────────────────────────────────────────────────────
function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name} (set it, or pass --local)`);
  return v;
}

const RETRY_MAX = 5;       // attempts per request
const RETRY_BASE_MS = 500; // exponential backoff base

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// A transient network drop (EPIPE/ECONNRESET from undici reusing a keep-alive
// socket the edge already closed, or a DNS/connect blip) surfaces as a
// `TypeError: fetch failed` whose `.cause.code` names the syscall error. These,
// plus 429/5xx, are safe to retry — our writes are INSERT OR REPLACE / DELETE,
// idempotent by design — so a fresh connection on retry recovers without losing
// the run's A* work.
function isTransient(err) {
  const code = err?.cause?.code ?? err?.code;
  return code === 'EPIPE' || code === 'ECONNRESET' || code === 'ETIMEDOUT' ||
    code === 'ECONNREFUSED' || code === 'EAI_AGAIN' || code === 'UND_ERR_SOCKET' ||
    err?.message === 'fetch failed';
}

async function cfFetch(url, init = {}) {
  const token = mustEnv('CLOUDFLARE_API_TOKEN');
  let lastErr;
  for (let attempt = 1; attempt <= RETRY_MAX; attempt++) {
    try {
      const res = await fetch(url, {
        ...init,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
      });
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`Cloudflare API ${res.status} ${res.statusText} (retryable)`);
      }
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        throw new Error(`Cloudflare API error (${res.status}): ${data?.errors?.[0]?.message ?? res.statusText}`);
      }
      return data;
    } catch (err) {
      lastErr = err;
      const retryable = isTransient(err) || /retryable/.test(err.message);
      if (!retryable || attempt === RETRY_MAX) throw err;
      const wait = RETRY_BASE_MS * 2 ** (attempt - 1);
      console.warn(`[precompute] request failed (attempt ${attempt}/${RETRY_MAX}): ${err.message} — retrying in ${wait}ms`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

let DB_ID = null;
async function resolveDbId() {
  const acct = mustEnv('CLOUDFLARE_ACCOUNT_ID');
  const data = await cfFetch(`${API_BASE}/accounts/${acct}/d1/database`);
  const db = (data.result ?? []).find(d => d.name === DB_NAME);
  if (!db) throw new Error(`D1 database "${DB_NAME}" not found`);
  return db.uuid;
}

// Single-statement read → rows. Remote = one HTTP query; local = wrangler.
async function read(sql) {
  if (LOCAL) {
    const out = execFileSync('npx', ['wrangler', 'd1', 'execute', DB_NAME, '--local', '--json', '--command', sql],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 });
    return JSON.parse(out.slice(out.indexOf('[')))[0]?.results ?? [];
  }
  const acct = mustEnv('CLOUDFLARE_ACCOUNT_ID');
  const data = await cfFetch(`${API_BASE}/accounts/${acct}/d1/database/${DB_ID}/query`,
    { method: 'POST', body: JSON.stringify({ sql }) });
  return data.result?.[0]?.results ?? [];
}

// Batched multi-statement writes. Remote = chunked HTTP queries (no import-lock);
// local = one wrangler --file.
async function writeBatch(statements) {
  if (statements.length === 0 || DRY) return;
  if (LOCAL) {
    const file = join(tmp, 'writes.sql');
    writeFileSync(file, statements.join('\n'));
    execFileSync('npx', ['wrangler', 'd1', 'execute', DB_NAME, '--local', '--file', file], { stdio: 'inherit' });
    return;
  }
  const acct = mustEnv('CLOUDFLARE_ACCOUNT_ID');
  for (const c of chunk(statements, WRITE_CHUNK)) {
    await cfFetch(`${API_BASE}/accounts/${acct}/d1/database/${DB_ID}/query`,
      { method: 'POST', body: JSON.stringify({ sql: c.join('\n') }) });
  }
}

// A segment's stable key: bracketing real timestamps (positions are immutable, so
// these pin the bracket + its coords) + vessel length + version. Length jitter is
// rare and a correction SHOULD regenerate, so it's included raw.
function segHash(aT, bT, length) {
  return `${aT}-${bT}-${length === null || length === undefined ? 'n' : length}-v${GENERATOR_VERSION}`;
}

function stateUpsertSql(mmsi, ts, at) {
  return `INSERT OR REPLACE INTO precompute_state (mmsi, last_pos_ts_seen, last_run_at) VALUES (${mmsi}, ${ts}, ${at});`;
}

// Tier to attribute to a gap's fakes: the coarser tier of its bracketing reals
// (so the client's per-tier trail filter keeps/hides them with the reals).
function tierForGap(points, aT, bT) {
  const order = { direct: 0, local: 1, global: 2 };
  const ta = points.find(p => p.t === aT)?.tier ?? 'local';
  const tb = points.find(p => p.t === bT)?.tier ?? 'local';
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
      if (!realOnLand.some(r => haversineKm(r.lat, r.lon, s.lat, s.lon) < 1.5)) return false;
    }
  }
  return true;
}

// Bulk-read positions / existing fakes for many vessels in chunked IN(...) queries.
async function readByMmsi(mmsis, sqlFor, rowMap) {
  const out = new Map(mmsis.map(m => [m, []]));
  for (const c of chunk(mmsis, READ_CHUNK)) {
    for (const r of await read(sqlFor(c))) out.get(r.mmsi)?.push(rowMap(r));
  }
  return out;
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  if (!LOCAL) DB_ID = await resolveDbId();

  const vessels = (await read(
    `SELECT mmsi, length, last_pos_ts FROM vessels
     WHERE of_interest = 1 AND first_direct_at IS NOT NULL AND last_pos_ts IS NOT NULL
     ORDER BY last_seen DESC`
  )).filter(v => ONLY_MMSI === null || v.mmsi === ONLY_MMSI);

  const stateRows = await read(`SELECT mmsi, last_pos_ts_seen FROM precompute_state`);
  const lastSeenTs = new Map(stateRows.map(r => [r.mmsi, r.last_pos_ts_seen]));

  // Heuristic: examine only vessels whose newest position advanced since last run.
  let skippedHeuristic = 0;
  const eligible = vessels.filter(v => {
    const skip = !REGENERATE && lastSeenTs.has(v.mmsi) && v.last_pos_ts <= lastSeenTs.get(v.mmsi);
    if (skip) skippedHeuristic++;
    return !skip;
  });
  const candidates = eligible.slice(0, LIMIT);
  const mmsis = candidates.map(v => v.mmsi);

  const posByMmsi = await readByMmsi(mmsis,
    c => `SELECT mmsi, lat, lon, speed, ts, tier FROM positions WHERE mmsi IN (${c.join(',')}) ORDER BY mmsi, ts ASC`,
    r => ({ lat: r.lat, lon: r.lon, speed: r.speed, t: r.ts, tier: r.tier }));
  const infByMmsi = await readByMmsi(mmsis,
    c => `SELECT mmsi, seg_hash, lat, lon, t, tier, dashed FROM inferred_positions WHERE mmsi IN (${c.join(',')})`,
    r => r);

  const writes = [];
  const now = Date.now();
  let examined = 0, skippedConverged = 0, segmentsWritten = 0, pointsWritten = 0, segmentsDeleted = 0, flushedStatements = 0;

  // Flush completed-vessel writes mid-run so memory stays bounded as coverage
  // grows and a late transient failure can't discard the whole run's A* work.
  // Safe at the top of the loop because every vessel's last pushed statement is
  // its precompute_state upsert — so the buffer always ends on a vessel boundary
  // (state is committed only after that vessel's segment writes). Local batches
  // once at the end (one wrangler --file; no keep-alive race, avoids N spawns).
  async function maybeFlush() {
    if (LOCAL || writes.length < FLUSH_EVERY) return;
    flushedStatements += writes.length;
    await writeBatch(writes.splice(0));
  }

  console.log(`[precompute] ${candidates.length} candidate(s) to examine (${skippedHeuristic} skipped by heuristic)…`);
  for (const v of candidates) {
    examined++;
    if (examined % 25 === 0) console.log(`[precompute] …examined ${examined}/${candidates.length} (routed ${segmentsWritten} segments so far)`);
    await maybeFlush();
    const points = posByMmsi.get(v.mmsi) ?? [];
    if (points.length < 2) { writes.push(stateUpsertSql(v.mmsi, v.last_pos_ts, now)); continue; }

    await ensureRegionsForExtent(extentOf(points));
    const existing = infByMmsi.get(v.mmsi) ?? [];

    if (!REGENERATE && curveIsLandFree(points, existing)) {
      skippedConverged++;
      writes.push(stateUpsertSql(v.mmsi, v.last_pos_ts, now));
      continue;
    }

    // Route every land-crossing segment; keep the minimal water-tight fakes.
    const wantBySeg = new Map();   // seg_hash → fakes (with inherited tier)
    for (const seg of harvestInferredSegments(points, { vesselLength: v.length })) {
      const hash = segHash(seg.aT, seg.bT, v.length);
      const tier = tierForGap(points, seg.aT, seg.bT);
      wantBySeg.set(hash, seg.fakes.map(f => ({ ...f, tier })));
    }

    const haveSegs = new Set(existing.map(r => r.seg_hash));
    const wantSegs = new Set(wantBySeg.keys());
    for (const h of haveSegs) {
      if (REGENERATE || !wantSegs.has(h)) {
        writes.push(`DELETE FROM inferred_positions WHERE mmsi = ${v.mmsi} AND seg_hash = ${sqlStr(h)};`);
        writes.push(`DELETE FROM inferred_segments WHERE mmsi = ${v.mmsi} AND seg_hash = ${sqlStr(h)};`);
        segmentsDeleted++;
      }
    }
    for (const h of wantSegs) {
      if (!REGENERATE && haveSegs.has(h)) continue;
      const fakes = wantBySeg.get(h);
      fakes.forEach((f, seq) => {
        writes.push(
          `INSERT OR REPLACE INTO inferred_positions (mmsi, seg_hash, seq, lat, lon, t, tier, dashed, generator_version)` +
          ` VALUES (${v.mmsi}, ${sqlStr(h)}, ${seq}, ${f.lat}, ${f.lon}, ${Math.round(f.t)}, ${sqlStr(f.tier)}, ${f.dashed}, ${GENERATOR_VERSION});`);
        pointsWritten++;
      });
      writes.push(
        `INSERT OR REPLACE INTO inferred_segments (mmsi, seg_hash, point_count, generator_version, computed_at)` +
        ` VALUES (${v.mmsi}, ${sqlStr(h)}, ${fakes.length}, ${GENERATOR_VERSION}, ${now});`);
      segmentsWritten++;
    }
    writes.push(stateUpsertSql(v.mmsi, v.last_pos_ts, now));
  }

  flushedStatements += writes.length;
  await writeBatch(writes);

  console.log(
    `[precompute] candidates=${candidates.length} examined=${examined} ` +
    `skipped_heuristic=${skippedHeuristic} skipped_converged=${skippedConverged} ` +
    `segments_written=${segmentsWritten} segments_deleted=${segmentsDeleted} points_written=${pointsWritten} ` +
    `write_statements=${flushedStatements}` + (DRY ? '  (DRY RUN — no writes)' : '')
  );
}

main().catch(err => { console.error(err); process.exit(1); });
