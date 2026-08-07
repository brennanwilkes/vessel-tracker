// Shape of the ocean-gap spine: composite great-circle latitude cap + the course
// blend that joins it to the vessel's real track. Pure geometry — no coastline, no
// A*, so this runs in milliseconds and guards the numbers in
// docs/ocean-routing-study.md against silent drift.
import { compositeGreatCirclePoints, blendCourse, greatCirclePoints, bearingDeg, haversineKm }
  from '../frontend/app/geo.js';
import { OCEAN_ROUTE } from '../frontend/config.js';

let failures = 0;
const check = (name, ok, detail) => {
  if (ok) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`);
};
const segs = (a, b) => Math.max(2, Math.ceil(haversineKm(a[0], a[1], b[0], b[1]) / 100));
const courseOut = (p) => bearingDeg(p[0][0], p[0][1], p[1][0], p[1][1]);
const courseIn = (p) => bearingDeg(p[p.length - 2][0], p[p.length - 2][1], p[p.length - 1][0], p[p.length - 1][1]);
const peakLat = (p) => p.reduce((m, x) => Math.abs(x[0]) > Math.abs(m) ? x[0] : m, 0);
const angDiff = (x, y) => Math.abs(((x - y + 180) % 360 + 360) % 360 - 180);

const JDF = [48.522, -126.726];
const YOKOHAMA = [35.442, 139.746];
const SINGAPORE = [1.21, 103.88];
const JUNEAU = [58.3, -134.4];

console.log('\nlatitude cap (composite great-circle sailing)');
{
  const n = segs(JDF, YOKOHAMA);
  const plain = greatCirclePoints(JDF, YOKOHAMA, n);
  const capped = compositeGreatCirclePoints(JDF, YOKOHAMA, n, OCEAN_ROUTE.maxLatDeg);
  check('uncapped great circle really does run the Aleutians',
    peakLat(plain) > 53, `peak ${peakLat(plain).toFixed(1)}`);
  check('cap holds the route at the limiting parallel',
    peakLat(capped) <= OCEAN_ROUTE.maxLatDeg + 0.1, `peak ${peakLat(capped).toFixed(1)}`);
  check('cap pulls the departure course toward the observed 267-273',
    courseOut(capped) < courseOut(plain), `${courseOut(plain).toFixed(0)} -> ${courseOut(capped).toFixed(0)}`);
  check('endpoints are preserved exactly',
    haversineKm(...JDF, capped[0][0], capped[0][1]) < 0.001
    && haversineKm(...YOKOHAMA, capped[capped.length - 1][0], capped[capped.length - 1][1]) < 0.001);
}
{
  // An endpoint poleward of the cap belongs up there — a BC->Alaska leg must not
  // be dragged south. Capping below your own departure latitude has no meaning.
  const n = segs(JDF, JUNEAU);
  const plain = greatCirclePoints(JDF, JUNEAU, n);
  const capped = compositeGreatCirclePoints(JDF, JUNEAU, n, OCEAN_ROUTE.maxLatDeg);
  check('cap does NOT bind when an endpoint is already poleward of it',
    Math.abs(peakLat(capped) - peakLat(plain)) < 0.001,
    `plain ${peakLat(plain).toFixed(1)} vs capped ${peakLat(capped).toFixed(1)}`);
}

console.log('\ncourse blend (trust the boat at both ends)');
for (const [name, a, b, entry, exit] of [
  ['SALVIA ACE  JdF->Yokohama', JDF, YOKOHAMA, 271, 226],
  ['CS ANTHEM   JdF->Singapore', JDF, SINGAPORE, 268, 214],
]) {
  const n = segs(a, b);
  const capped = compositeGreatCirclePoints(a, b, n, OCEAN_ROUTE.maxLatDeg);
  const blended = blendCourse(capped, entry, exit, OCEAN_ROUTE.blendHoldKm, OCEAN_ROUTE.blendKm);
  check(`${name}: leaves on the vessel's real course`,
    angDiff(courseOut(blended), entry) < 2,
    `spine ${courseOut(blended).toFixed(0)} vs real ${entry}`);
  check(`${name}: arrives on the vessel's real course`,
    angDiff(courseIn(blended), exit) < 2,
    `spine ${courseIn(blended).toFixed(0)} vs real ${exit}`);
  check(`${name}: endpoints unmoved by the blend`,
    haversineKm(...a, blended[0][0], blended[0][1]) < 0.001
    && haversineKm(...b, blended[blended.length - 1][0], blended[blended.length - 1][1]) < 0.001);
  check(`${name}: mid-ocean shape left alone`,
    Math.abs(peakLat(blended) - peakLat(capped)) < 0.6,
    `peak ${peakLat(capped).toFixed(1)} -> ${peakLat(blended).toFixed(1)}`);
}
{
  // No bearing known (journey ends) must be a no-op, not a crash or a silent swing.
  const n = segs(JDF, YOKOHAMA);
  const capped = compositeGreatCirclePoints(JDF, YOKOHAMA, n, OCEAN_ROUTE.maxLatDeg);
  const blended = blendCourse(capped, undefined, undefined, OCEAN_ROUTE.blendHoldKm, OCEAN_ROUTE.blendKm);
  check('undefined entry/exit bearings leave the spine untouched',
    blended.every((p, i) => Math.abs(p[0] - capped[i][0]) < 1e-12 && Math.abs(p[1] - capped[i][1]) < 1e-12));
}

console.log(failures === 0 ? '\nocean-shape: PASS\n' : `\nocean-shape: ${failures} FAILURE(S)\n`);
process.exit(failures === 0 ? 0 : 1);
