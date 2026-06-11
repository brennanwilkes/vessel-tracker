// Smoke test for the trajectory compressor (worker/src/compress.ts).
// Local only, no framework:  node tests/compress.test.mjs
import assert from 'node:assert';
import { isSignificantMove } from '../worker/src/compress.ts';

const NOW = 1_000_000_000_000;
const NM_PER_DEG_LAT = 60;

// prev = last emitted point; move north by `nm` to make the candidate fix.
function fix({ nm = 0, speed = 10, heading = 0, type = 70, prevSpeed = 10, prevHeading = 0, ageS = 60 }) {
  const prev = {
    last_lat: 48.3, last_lon: -123.3,
    last_speed: prevSpeed, last_heading: prevHeading, last_pos_ts: NOW - ageS * 1000,
  };
  const v = {
    mmsi: 1, name: null, vesselType: type, length: null, destination: null, updated: NOW,
    lat: 48.3 + nm / NM_PER_DEG_LAT, lon: -123.3, speed, heading,
  };
  return { v, prev };
}

let pass = 0;
const check = (name, got, want) => { assert.strictEqual(got, want, `${name}: got ${got}, want ${want}`); pass++; };

// Straight run, within gaps → dropped (the whole point of compression).
{ const { v, prev } = fix({ nm: 0.10, heading: 0, prevHeading: 0 });
  check('direct straight → drop', isSignificantMove(v, prev, 'direct', NOW), false); }

// A turn is kept by construction.
{ const { v, prev } = fix({ nm: 0.10, heading: 200, prevHeading: 0 });
  check('direct turn → keep', isSignificantMove(v, prev, 'direct', NOW), true); }

// A speed change is kept.
{ const { v, prev } = fix({ nm: 0.10, speed: 13, prevSpeed: 10 });
  check('direct speed change → keep', isSignificantMove(v, prev, 'direct', NOW), true); }

// Start/stop flip is kept.
{ const { v, prev } = fix({ nm: 0.10, speed: 5, prevSpeed: 0 });
  check('direct start moving → keep', isSignificantMove(v, prev, 'direct', NOW), true); }

// Below the jitter floor → dropped no matter what.
{ const { v, prev } = fix({ nm: 0.02, heading: 200, prevHeading: 0 });
  check('sub-floor jitter → drop', isSignificantMove(v, prev, 'direct', NOW), false); }

// Time gap exceeded (direct maxGapMs = 3 min) → kept even when straight.
{ const { v, prev } = fix({ nm: 0.10, heading: 0, prevHeading: 0, ageS: 600 });
  check('direct time gap → keep', isSignificantMove(v, prev, 'direct', NOW), true); }

// Local: straight 1nm within the 3nm gap → dropped (coarser than direct).
{ const { v, prev } = fix({ nm: 1.0, heading: 0, prevHeading: 0 });
  check('local straight 1nm → drop', isSignificantMove(v, prev, 'local', NOW), false); }

// Local: distance gap (>3nm) → kept.
{ const { v, prev } = fix({ nm: 4.0, heading: 0, prevHeading: 0 });
  check('local distance gap → keep', isSignificantMove(v, prev, 'local', NOW), true); }

// Per-class coarsening: a tug (type 52) tolerates a wider distance gap than a tanker.
{ const tug = fix({ nm: 0.25, heading: 0, prevHeading: 0, type: 52 });
  const tanker = fix({ nm: 0.25, heading: 0, prevHeading: 0, type: 80 });
  check('direct tug 0.25nm → drop (coarsened)', isSignificantMove(tug.v, tug.prev, 'direct', NOW), false);
  check('direct tanker 0.25nm → keep', isSignificantMove(tanker.v, tanker.prev, 'direct', NOW), true); }

console.log(`compress smoke test: ${pass} checks passed`);
