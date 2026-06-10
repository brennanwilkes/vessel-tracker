// Stitch OSM natural=coastline ways (directed, land-on-left) into chains.
// Input: Overpass `out body geom` elements. Output: { closed:[ring], open:[chain] }
// where each ring/chain is an array of [lon,lat]; rings have first===last.
// Ways connect head-to-tail by shared node id (OSM coastline is consistently
// directed). A greedy forward walk can still fragment one coastline when
// iteration order consumes a shared continuation, so a second join pass merges
// chains whose end node matches another chain's start node.

export function stitchCoastline(elements) {
  const ways = elements.filter(e => e.type === 'way' && e.nodes && e.geometry && e.nodes.length === e.geometry.length);

  const startsAt = new Map(); // node id → way indices starting there
  for (let i = 0; i < ways.length; i++) {
    const first = ways[i].nodes[0];
    if (!startsAt.has(first)) startsAt.set(first, []);
    startsAt.get(first).push(i);
  }

  const used = new Uint8Array(ways.length);
  // chain = { pts:[[lon,lat]], head:nodeId, tail:nodeId }
  let chains = [];

  for (let i = 0; i < ways.length; i++) {
    if (used[i]) continue;
    const pts = [];
    let head = ways[i].nodes[0], tail = head;
    let cur = i;
    while (cur !== -1 && !used[cur]) {
      used[cur] = 1;
      const w = ways[cur];
      const startK = pts.length > 0 ? 1 : 0;
      for (let k = startK; k < w.geometry.length; k++) pts.push([w.geometry[k].lon, w.geometry[k].lat]);
      tail = w.nodes[w.nodes.length - 1];
      const cands = startsAt.get(tail);
      let next = -1;
      if (cands) for (const c of cands) { if (!used[c]) { next = c; break; } }
      cur = next;
    }
    chains.push({ pts, head, tail });
  }

  // Join pass: repeatedly concatenate chains where one's tail == another's head.
  let merged = true;
  while (merged) {
    merged = false;
    const byHead = new Map();
    for (let i = 0; i < chains.length; i++) {
      if (chains[i] === null) continue;
      if (!byHead.has(chains[i].head)) byHead.set(chains[i].head, i);
    }
    for (let i = 0; i < chains.length; i++) {
      const a = chains[i];
      if (a === null || a.head === a.tail) continue; // skip closed
      const j = byHead.get(a.tail);
      if (j === undefined || j === i || chains[j] === null) continue;
      const b = chains[j];
      // a.tail === b.head: append b's pts (skip duplicated shared point)
      for (let k = 1; k < b.pts.length; k++) a.pts.push(b.pts[k]);
      a.tail = b.tail;
      chains[j] = null;
      merged = true;
    }
    chains = chains.filter(c => c !== null);
  }

  const closed = [], open = [];
  for (const c of chains) {
    if (c.pts.length > 3 && c.head === c.tail) closed.push(c.pts);
    else open.push(c.pts);
  }
  return { closed, open };
}

// ── Close open (mainland) chains along the bbox boundary ─────────────────────
// OSM coastline is directed land-on-left. An open chain enters and exits the
// bbox; the boundary between a chain's EXIT and the next chain's ENTRY (walking
// the perimeter so the interior/land stays on the left) is land. We clip each
// open chain to the bbox, then pair exits→entries around the perimeter to form
// closed land rings. Returns array of closed rings ([[lon,lat],...]).

// Perimeter parameter, counter-clockwise from the SW corner (interior on left).
function perimParam(lon, lat, BB) {
  const W = BB.maxLon - BB.minLon, H = BB.maxLat - BB.minLat;
  const eps = 1e-6;
  if (Math.abs(lat - BB.minLat) < eps) return (lon - BB.minLon);                       // S edge L→R
  if (Math.abs(lon - BB.maxLon) < eps) return W + (lat - BB.minLat);                    // E edge B→T
  if (Math.abs(lat - BB.maxLat) < eps) return W + H + (BB.maxLon - lon);                // N edge R→L
  return 2 * W + H + (BB.maxLat - lat);                                                 // W edge T→B
}

// The four corners at their CCW perimeter params.
function cornerParams(BB) {
  const W = BB.maxLon - BB.minLon, H = BB.maxLat - BB.minLat;
  return [
    { p: 0,             pt: [BB.minLon, BB.minLat] },
    { p: W,             pt: [BB.maxLon, BB.minLat] },
    { p: W + H,         pt: [BB.maxLon, BB.maxLat] },
    { p: 2 * W + H,     pt: [BB.minLon, BB.maxLat] },
  ];
}

const inside = (p, BB) => p[0] >= BB.minLon && p[0] <= BB.maxLon && p[1] >= BB.minLat && p[1] <= BB.maxLat;

// Intersection of segment a→b with the bbox edges, nearest to `a`. Clamps to
// the boundary. Assumes exactly one of a,b is inside.
function boundaryCross(a, b, BB) {
  let bestT = Infinity, pt = null;
  const cand = [
    { t: (BB.minLon - a[0]) / (b[0] - a[0]), axis: 0, v: BB.minLon },
    { t: (BB.maxLon - a[0]) / (b[0] - a[0]), axis: 0, v: BB.maxLon },
    { t: (BB.minLat - a[1]) / (b[1] - a[1]), axis: 1, v: BB.minLat },
    { t: (BB.maxLat - a[1]) / (b[1] - a[1]), axis: 1, v: BB.maxLat },
  ];
  for (const c of cand) {
    if (!(c.t > 0 && c.t <= 1)) continue;
    const x = a[0] + (b[0] - a[0]) * c.t, y = a[1] + (b[1] - a[1]) * c.t;
    const q = c.axis === 0 ? [c.v, y] : [x, c.v];
    if (inside([q[0] + (q[0] === BB.minLon ? 1e-9 : -1e-9), q[1]], BB) || true) {
      if (c.t < bestT && q[0] >= BB.minLon - 1e-9 && q[0] <= BB.maxLon + 1e-9 && q[1] >= BB.minLat - 1e-9 && q[1] <= BB.maxLat + 1e-9) {
        bestT = c.t; pt = q;
      }
    }
  }
  return pt;
}

// Clip a polyline to the bbox → list of inside sub-chains (each first/last on boundary).
function clipChain(pts, BB) {
  const subs = [];
  let cur = null;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], pIn = inside(p, BB);
    const prev = i > 0 ? pts[i - 1] : null;
    if (pIn) {
      if (cur === null) {
        cur = [];
        if (prev !== null) { const x = boundaryCross(prev, p, BB); if (x) cur.push(x); }
      }
      cur.push(p);
    } else if (cur !== null) {
      const x = boundaryCross(prev !== null && inside(prev, BB) ? prev : pts[i - 1], p, BB);
      if (x) cur.push(x);
      if (cur.length >= 2) subs.push(cur);
      cur = null;
    }
  }
  if (cur !== null && cur.length >= 2) subs.push(cur);
  return subs;
}

export function closeOpenChains(open, BB, ccw = true) {
  const corners = cornerParams(BB);
  const TOTAL = 2 * (BB.maxLon - BB.minLon) + 2 * (BB.maxLat - BB.minLat);

  // Walk the boundary from `fromP` to `toP` (CCW if ccw, else CW), emitting
  // corner points crossed.
  function boundaryArc(fromP, toP) {
    const out = [];
    if (ccw) {
      let t = toP; if (t <= fromP) t += TOTAL;
      for (const c of corners) { let cp = c.p; while (cp < fromP) cp += TOTAL; if (cp > fromP && cp < t) out.push({ d: cp - fromP, pt: c.pt }); }
    } else {
      let t = toP; if (t >= fromP) t -= TOTAL;
      for (const c of corners) { let cp = c.p; while (cp > fromP) cp -= TOTAL; if (cp < fromP && cp > t) out.push({ d: fromP - cp, pt: c.pt }); }
    }
    out.sort((a, b) => a.d - b.d);
    return out.map(o => o.pt);
  }

  // Each open chain is one landmass boundary (the join pass merged fragments).
  // Clip it to the bbox and self-close each inside sub-chain: connect its exit
  // back to its own entry along the boundary (land-side arc, ccw flag).
  const rings = [];
  for (const chain of open) {
    for (const sub of clipChain(chain, BB)) {
      if (sub.length < 2) continue;
      const ring = sub.slice();
      const exitP = perimParam(sub[sub.length - 1][0], sub[sub.length - 1][1], BB);
      const entryP = perimParam(sub[0][0], sub[0][1], BB);
      for (const cpt of boundaryArc(exitP, entryP)) ring.push(cpt);
      ring.push([ring[0][0], ring[0][1]]);
      if (ring.length >= 4) rings.push(ring);
    }
  }
  return rings;
}

