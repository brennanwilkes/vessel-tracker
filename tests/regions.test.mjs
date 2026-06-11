// Validates every lazy coastline region listed in the manifest:
//   structure (REGION export, bbox, land rings, water polys), value ranges (valid
//   lat/lon, no NaN, closed-ish rings), manifest↔region bbox agreement, non-empty,
//   and that geometry actually falls within (a padded) region bbox.
//
//   node tests/regions.test.mjs
// Runs against whatever build-all-regions.mjs has produced so far (resumable-friendly).
import { REGIONS } from '../frontend/app/coast/manifest.js';

let failures = 0;
const fail = (id, msg) => { console.log(`FAIL  ${id}: ${msg}`); failures++; };

const validRing = ring => Array.isArray(ring) && ring.length >= 4 &&
  ring.every(p => Array.isArray(p) && p.length === 2 &&
    Number.isFinite(p[0]) && Number.isFinite(p[1]) &&
    p[0] >= -90 && p[0] <= 90 && p[1] >= -180 && p[1] <= 180);

const ringInBox = (ring, bb, pad = 0.5) => ring.every(([la, lo]) =>
  la >= bb[0][0] - pad && la <= bb[1][0] + pad && lo >= bb[0][1] - pad && lo <= bb[1][1] + pad);

if (REGIONS.length === 0) { console.log('regions test: manifest empty (nothing built yet)'); process.exit(0); }

for (const entry of REGIONS) {
  let mod;
  try { mod = await entry.load(); } catch (e) { fail(entry.id, `load failed: ${e.message}`); continue; }
  const R = mod.REGION || mod.default;
  if (!R) { fail(entry.id, 'no REGION export'); continue; }

  if (R.id !== entry.id) fail(entry.id, `id mismatch (${R.id})`);
  // bbox well-formed + matches manifest
  const b = R.bbox;
  if (!b || b[0][0] >= b[1][0] || b[0][1] >= b[1][1]) { fail(entry.id, `malformed bbox ${JSON.stringify(b)}`); continue; }
  const bClose = Math.abs(b[0][0] - entry.bbox[0][0]) < 1e-3 && Math.abs(b[0][1] - entry.bbox[0][1]) < 1e-3 &&
    Math.abs(b[1][0] - entry.bbox[1][0]) < 1e-3 && Math.abs(b[1][1] - entry.bbox[1][1]) < 1e-3;
  if (!bClose) fail(entry.id, `bbox != manifest bbox (${JSON.stringify(b)} vs ${JSON.stringify(entry.bbox)})`);

  if (!Array.isArray(R.land) || !Array.isArray(R.water)) { fail(entry.id, 'land/water not arrays'); continue; }
  if (R.land.length === 0 && R.water.length === 0) fail(entry.id, 'empty (no land or water)');

  for (const ring of R.land) {
    if (!validRing(ring)) { fail(entry.id, 'invalid land ring'); break; }
    if (!ringInBox(ring, b)) { fail(entry.id, 'land ring outside bbox'); break; }
  }
  for (const w of R.water) {
    if (!w.o || !validRing(w.o)) { fail(entry.id, 'invalid water outer ring'); break; }
    if (w.h && !w.h.every(validRing)) { fail(entry.id, 'invalid water hole ring'); break; }
    if (!ringInBox(w.o, b)) { fail(entry.id, 'water ring outside bbox'); break; }
  }

  const verts = R.land.reduce((s, r) => s + r.length, 0) + R.water.reduce((s, w) => s + w.o.length + (w.h ?? []).reduce((t, h) => t + h.length, 0), 0);
  console.log(`OK    ${entry.id.padEnd(18)} land=${String(R.land.length).padStart(3)} water=${String(R.water.length).padStart(3)} verts=${verts}`);
}

console.log(failures === 0 ? `\nAll ${REGIONS.length} regions valid.` : `\n${failures} region check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
