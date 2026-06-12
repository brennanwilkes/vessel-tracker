#!/usr/bin/env node
// Reproducible, resumable batch builder for all lazy coastline regions.
//
// Derives regions from the FOREIGN zones in src/zones.ts (padded, with a few merges),
// fetches OSM coastline + water per region from Overpass (politeness delay + retry),
// builds each via buildRegion(), validates, and regenerates frontend/app/coast/manifest.js.
// RESUMABLE: skips regions whose coast/<id>.js already exists (unless --force), and
// loops over fetch failures until everything is built or MAX_ROUNDS is hit. Safe to run
// in the background and re-run.
//
//   node scripts/build-all-regions.mjs            # build missing regions
//   node scripts/build-all-regions.mjs --force    # rebuild all
//   node scripts/build-all-regions.mjs --only=columbia,busan
// Run from worker/.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRegion, COAST_DIR } from './build-region.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ZONES_TS = path.resolve(SCRIPT_DIR, '../src/zones.ts');
const MANIFEST = path.join(COAST_DIR, 'manifest.js');

const PAD_DEG = 0.2;                 // pad a port box to capture its approach coastline
const DELAY_MS = 6000;               // politeness between Overpass queries
const MAX_ROUNDS = 4;                // retry rounds over failed regions
const OVERPASS = 'https://overpass-api.de/api/interpreter';

// Region grouping (region id → member zone ids) + explicit bbox overrides (rivers need
// a corridor bigger than a padded harbour box). Zones not listed get their own region.
const MERGE = {
  columbia: ['astoria-columbia', 'portland'],
  'sf-bay': ['golden-gate', 'sf-bay-oakland'],
};
const BBOX_OVERRIDE = {
  columbia: { minLat: 45.45, minLon: -124.10, maxLat: 46.35, maxLon: -122.50 },
};

// Shipping CORRIDORS — regions covering navigable channels (not derived from a port
// zone). Island fine-land here opens the inter-island passages the coarse layer closes.
// landSimplifyKm coarser than a harbour (channels are ~0.5 km+, per the resolution policy).
const CORRIDORS = [
  { id: 'inside-passage', bbox: { minLat: 54.0, minLon: -134.2, maxLat: 58.6, maxLon: -129.6 }, landSimplifyKm: 0.15 },
];

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const ONLY = (args.find(a => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Parse FOREIGN zones from zones.ts (one zone object per line).
function parseForeignZones() {
  const src = fs.readFileSync(ZONES_TS, 'utf8');
  const zones = [];
  for (const line of src.split('\n')) {
    if (!line.includes('box:') || !line.includes("reach: 'foreign'")) continue;
    const id = line.match(/id:\s*'([^']+)'/)?.[1];
    const m = line.match(/box:\s*\[\[(-?[\d.]+),\s*(-?[\d.]+)\],\s*\[(-?[\d.]+),\s*(-?[\d.]+)\]\]/);
    if (!id || !m) continue;
    zones.push({ id, box: { minLat: +m[1], minLon: +m[2], maxLat: +m[3], maxLon: +m[4] } });
  }
  return zones;
}

function deriveRegions() {
  const zones = parseForeignZones();
  const byId = new Map(zones.map(z => [z.id, z]));
  const used = new Set();
  const regions = [];
  // merged regions first
  for (const [rid, members] of Object.entries(MERGE)) {
    const boxes = members.map(id => byId.get(id)).filter(Boolean).map(z => z.box);
    if (boxes.length === 0) continue;
    members.forEach(id => used.add(id));
    let bbox = BBOX_OVERRIDE[rid] ?? unionPad(boxes);
    regions.push({ id: rid, bbox });
  }
  // one region per remaining zone
  for (const z of zones) {
    if (used.has(z.id)) continue;
    regions.push({ id: z.id, bbox: BBOX_OVERRIDE[z.id] ?? unionPad([z.box]) });
  }
  for (const c of CORRIDORS) regions.push({ id: c.id, bbox: c.bbox, landSimplifyKm: c.landSimplifyKm });
  return regions;
}
function unionPad(boxes) {
  let minLat = 90, minLon = 180, maxLat = -90, maxLon = -180;
  for (const b of boxes) { minLat = Math.min(minLat, b.minLat); minLon = Math.min(minLon, b.minLon); maxLat = Math.max(maxLat, b.maxLat); maxLon = Math.max(maxLon, b.maxLon); }
  const r = n => Math.round(n * 1e4) / 1e4;
  return { minLat: r(minLat - PAD_DEG), minLon: r(minLon - PAD_DEG), maxLat: r(maxLat + PAD_DEG), maxLon: r(maxLon + PAD_DEG) };
}

async function overpass(query) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 200_000);
  try {
    const res = await fetch(OVERPASS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'vessel-tracker/1.0' },
      body: 'data=' + encodeURIComponent(query),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    return JSON.parse(text).elements;
  } finally { clearTimeout(to); }
}
const coastQuery = b => `[out:json][timeout:120];(way["natural"="coastline"](${b.minLat},${b.minLon},${b.maxLat},${b.maxLon}););out body geom;`;
const waterQuery = b => `[out:json][timeout:120];(way["natural"="water"](${b.minLat},${b.minLon},${b.maxLat},${b.maxLon});relation["natural"="water"](${b.minLat},${b.minLon},${b.maxLat},${b.maxLon});way["waterway"="riverbank"](${b.minLat},${b.minLon},${b.maxLat},${b.maxLon});relation["waterway"="riverbank"](${b.minLat},${b.minLon},${b.maxLat},${b.maxLon}););out body geom;`;

async function fetchWithRetry(label, query, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try { return await overpass(query); }
    catch (e) {
      console.warn(`    ${label} attempt ${i}/${tries} failed: ${e.message}`);
      if (i < tries) await sleep(DELAY_MS * i * 2);
    }
  }
  throw new Error(`${label}: all ${tries} attempts failed`);
}

function regenerateManifest(allRegions) {
  const built = allRegions.filter(r => fs.existsSync(path.join(COAST_DIR, `${r.id}.js`)));
  const entries = built.map(r => {
    const b = r.bbox;
    return `  { id: ${JSON.stringify(r.id)}, bbox: [[${b.minLat}, ${b.minLon}], [${b.maxLat}, ${b.maxLon}]], load: () => import(${JSON.stringify('./' + r.id + '.js')}) },`;
  }).join('\n');
  const body = `// Auto-generated by build-all-regions.mjs — do not edit manually.
// Lazy region manifest — tiny, loaded upfront. Each region's full geometry
// (coast/<id>.js) is dynamically imported ON DEMAND by region_coast.js when a trail's
// extent intersects its bbox. bbox = [[swLat, swLon], [neLat, neLon]].
export const REGIONS = [
${entries}
];
`;
  fs.writeFileSync(MANIFEST, body);
  return built.length;
}

// ── Run ─────────────────────────────────────────────────────────────────────
const allRegions = deriveRegions();              // full set — manifest always lists all built
let regions = ONLY.length ? allRegions.filter(r => ONLY.includes(r.id)) : allRegions;
console.log(`[regions] ${allRegions.length} regions derived; ${regions.length} in this run`);

let pending = regions.filter(r => FORCE || !fs.existsSync(path.join(COAST_DIR, `${r.id}.js`)));
console.log(`[regions] ${pending.length} to build, ${regions.length - pending.length} already present`);

for (let round = 1; round <= MAX_ROUNDS && pending.length; round++) {
  console.log(`\n=== round ${round}/${MAX_ROUNDS} — ${pending.length} regions ===`);
  const failed = [];
  for (const r of pending) {
    try {
      console.log(`[${r.id}] fetching coastline…`);
      const coastElements = await fetchWithRetry(`${r.id} coast`, coastQuery(r.bbox));
      await sleep(DELAY_MS);
      console.log(`[${r.id}] fetching water…`);
      const waterElements = await fetchWithRetry(`${r.id} water`, waterQuery(r.bbox));
      const s = buildRegion({ id: r.id, bbox: r.bbox, coastElements, waterElements, landSimplifyKm: r.landSimplifyKm });
      if (s.landRings === 0 && s.waterPolys === 0) console.warn(`[${r.id}] WARN: empty (no land or water in bbox)`);
      console.log(`[${r.id}] ✓ ${s.landRings} land, ${s.waterPolys} water (${s.holes} holes), ${s.kb} KB`);
      regenerateManifest(allRegions); // keep manifest current as we go
      await sleep(DELAY_MS);
    } catch (e) {
      console.error(`[${r.id}] ✗ ${e.message}`);
      failed.push(r);
    }
  }
  pending = failed;
  if (pending.length) { console.log(`round ${round} done; ${pending.length} failed, retrying after backoff`); await sleep(DELAY_MS * 3); }
}

const builtCount = regenerateManifest(allRegions);
console.log(`\n[regions] done. manifest lists ${builtCount}/${allRegions.length} regions.`);
if (pending.length) { console.error(`[regions] STILL FAILED: ${pending.map(r => r.id).join(', ')} — re-run to retry.`); process.exit(1); }
