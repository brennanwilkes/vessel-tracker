// Assemble OSM water (natural=water / waterway=riverbank) into water polygons WITH
// holes. Unlike coastline (directed open ways closed along the bbox), water is already
// area geometry: closed `way` rings, and `multipolygon` relations whose member ways
// (role outer/inner) stitch into closed rings. Inner rings are mid-water islands
// (e.g. Annacis Is. in the Fraser) — they must read as LAND, so we keep them as holes.
//
// Input: Overpass `out body geom` elements. Output: array of
//   { outer: [[lon,lat],…], holes: [[[lon,lat],…], …] }   (lon,lat, matching the
//   coastline lib's convention; build-water.mjs flips to [lat,lon] on emit).

const keyOf = p => `${p[0].toFixed(7)},${p[1].toFixed(7)}`;
const isClosed = ring => ring.length > 3 && keyOf(ring[0]) === keyOf(ring[ring.length - 1]);

// Even-odd point-in-ring on [lon,lat] vertices.
function pointInRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Join open arcs into closed rings by matching shared endpoints (member ways of a
// multipolygon are arbitrary-order fragments). Arcs already closed pass through.
function stitchRings(arcs) {
  const rings = [];
  const used = new Array(arcs.length).fill(false);
  for (let i = 0; i < arcs.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    let ring = arcs[i].slice();
    while (!isClosed(ring)) {
      const tail = keyOf(ring[ring.length - 1]);
      let extended = false;
      for (let j = 0; j < arcs.length; j++) {
        if (used[j]) continue;
        const a = arcs[j];
        if (keyOf(a[0]) === tail) { for (let k = 1; k < a.length; k++) ring.push(a[k]); used[j] = true; extended = true; break; }
        if (keyOf(a[a.length - 1]) === tail) { for (let k = a.length - 2; k >= 0; k--) ring.push(a[k]); used[j] = true; extended = true; break; }
      }
      if (!extended) break; // dangling arc — drop this incomplete ring
    }
    if (isClosed(ring) && ring.length >= 4) rings.push(ring);
  }
  return rings;
}

export function assembleWater(elements) {
  const polys = [];

  // Standalone closed ways (lakes, ponds, basins). Member ways of relations are
  // embedded in the relation's members[].geometry, not emitted standalone (verified:
  // 0 open top-level ways), so this does not double-count.
  for (const e of elements) {
    if (e.type !== 'way' || !e.geometry) continue;
    const ring = e.geometry.map(p => [p.lon, p.lat]);
    if (isClosed(ring)) polys.push({ outer: ring, holes: [] });
  }

  // Multipolygon relations (rivers): stitch outer/inner member arcs, assign each
  // inner hole to the outer ring that contains it.
  for (const e of elements) {
    if (e.type !== 'relation' || !e.members) continue;
    const outerArcs = [], innerArcs = [];
    for (const m of e.members) {
      if (m.type !== 'way' || !m.geometry) continue;
      const arc = m.geometry.map(p => [p.lon, p.lat]);
      (m.role === 'inner' ? innerArcs : outerArcs).push(arc);
    }
    const outers = stitchRings(outerArcs);
    const inners = stitchRings(innerArcs);
    for (const outer of outers) {
      const holes = inners.filter(h => pointInRing(h[0], outer));
      polys.push({ outer, holes });
    }
  }
  return polys;
}
