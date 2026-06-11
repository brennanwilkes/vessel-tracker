const R_NM = 3440.065;
const R_KM = 6371.0;

export function haversineNm(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R_NM * Math.asin(Math.sqrt(a));
}

export function haversineKm(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.sqrt(a));
}

export function bearingDeg(lat1, lon1, lat2, lon2) {
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const y = Math.sin(dLon) * Math.cos(lat2 * Math.PI / 180);
  const x = Math.cos(lat1 * Math.PI / 180) * Math.sin(lat2 * Math.PI / 180)
    - Math.sin(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}

// ── Land geometry ─────────────────────────────────────────────────────────

export function pointInPolygon(pt, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const yi = polygon[i][0], xi = polygon[i][1];
    const yj = polygon[j][0], xj = polygon[j][1];
    if ((yi > pt[0]) !== (yj > pt[0]) &&
        pt[1] < (xj - xi) * (pt[0] - yi) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// Is [lat,lon] inside a water polygon (river/harbour basin)? Water entries are
// { o: outer ring [[lat,lon],…], h?: hole rings (mid-water islands → land) }. Holes
// flip back to not-water. Bbox-prefiltered like land.
export function pointInWater(lat, lon, waterPolygons, waterBboxes) {
  for (let i = 0; i < waterPolygons.length; i++) {
    const bb = waterBboxes[i];
    if (lat < bb.minLat || lat > bb.maxLat || lon < bb.minLon || lon > bb.maxLon) continue;
    const w = waterPolygons[i];
    if (!pointInPolygon([lat, lon], w.o)) continue;
    if (w.h) { let inHole = false; for (const h of w.h) if (pointInPolygon([lat, lon], h)) { inHole = true; break; } if (inHole) continue; }
    return true;
  }
  return false;
}

// Is [lat,lon] on land? Land = inside a coastline polygon AND NOT inside a water
// polygon (the second layer re-opens rivers/harbours the coastline closed). The
// water test runs only for the minority of points already on land, and bbox-
// prefilters, so it's cheap. `waterPolygons` is optional (omit → coastline only).
export function pointOnLand(lat, lon, polygons, bboxes, waterPolygons, waterBboxes) {
  let onLand = false;
  for (let i = 0; i < polygons.length; i++) {
    const bb = bboxes[i];
    if (lat < bb.minLat || lat > bb.maxLat || lon < bb.minLon || lon > bb.maxLon) continue;
    if (pointInPolygon([lat, lon], polygons[i])) { onLand = true; break; }
  }
  if (!onLand) return false;
  if (waterPolygons && pointInWater(lat, lon, waterPolygons, waterBboxes)) return false;
  return true;
}

// Does the straight line a→b pass over land? Sampled at ~stepKm.
export function segmentCrossesLand(a, b, polygons, bboxes, stepKm = 1, waterPolygons, waterBboxes) {
  const n = Math.max(2, Math.ceil(haversineKm(a[0], a[1], b[0], b[1]) / stepKm));
  for (let s = 0; s <= n; s++) {
    const f = s / n;
    if (pointOnLand(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, polygons, bboxes, waterPolygons, waterBboxes)) return true;
  }
  return false;
}

// ── Water router (A* + string-pull) ─────────────────────────────────────────
//
// Replaces the old coastline-perimeter walker. Builds a local land/water grid
// over the gap's bounding box (lazily — only cells the search visits are
// tested), runs A* for the shortest WATER-ONLY path between the endpoints, then
// string-pulls it into a sparse any-angle sequence of waypoints. Because the
// search only steps through water cells, the path structurally cannot cross
// land — there is no "push seaward" heuristic to get wrong.
//
// Obstacle inflation (clearanceCells) keeps waypoints off the coast so the
// downstream smoothing spline has slack to cut corners without clipping land.
// If inflation closes the only passage (a channel narrower than the clearance,
// or an endpoint in a cove), the search retries with zero clearance.
//
// Returns [[lat,lon], ...] from a to b inclusive, or null when no route is
// found within the covered area (e.g. outside the coastline data — the caller
// then bridges the gap with a straight spline segment).

// Min-heap keyed by f-score (A* open set).
class MinHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(node, f) {
    const a = this.a; a.push({ node, f });
    let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (a[p].f <= a[i].f) break; [a[p], a[i]] = [a[i], a[p]]; i = p; }
  }
  pop() {
    const a = this.a; const top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last; let i = 0; const n = a.length;
      for (;;) {
        let l = 2 * i + 1, r = 2 * i + 2, m = i;
        if (l < n && a[l].f < a[m].f) m = l;
        if (r < n && a[r].f < a[m].f) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top;
  }
}

const NEIGHBORS = [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[-1,1],[1,-1],[1,1]];

export function routeWater(a, b, polygons, bboxes, opts = {}) {
  const waterPolygons = opts.waterPolygons;
  const waterBboxes = opts.waterBboxes;
  const directKm = haversineKm(a[0], a[1], b[0], b[1]);
  // Fine enough to thread Gulf Island channels and harbour mouths (~150 m floor)
  // while staying coarse on long offshore detours.
  const cellKm = opts.cellKm ?? Math.min(1.0, Math.max(0.2, directKm / 250));
  const marginKm = opts.marginKm ?? Math.min(90, Math.max(12, directKm * 0.6));
  const clearanceCells = opts.clearanceCells ?? 1;

  // Equirectangular grid with ~square cells (km), local to this gap.
  const lat0 = (a[0] + b[0]) / 2;
  const latCell = cellKm / 111.32;
  const lonCell = cellKm / (111.32 * Math.cos(lat0 * Math.PI / 180));
  const minLat = Math.min(a[0], b[0]) - marginKm / 111.32;
  const minLon = Math.min(a[1], b[1]) - marginKm / (111.32 * Math.cos(lat0 * Math.PI / 180));
  const rows = Math.ceil((Math.max(a[0], b[0]) + marginKm / 111.32 - minLat) / latCell) + 1;
  const cols = Math.ceil((Math.max(a[1], b[1]) + marginKm / (111.32 * Math.cos(lat0 * Math.PI / 180)) - minLon) / lonCell) + 1;

  const cellLat = r => minLat + r * latCell;
  const cellLon = c => minLon + c * lonCell;
  const toRow = lat => Math.max(0, Math.min(rows - 1, Math.round((lat - minLat) / latCell)));
  const toCol = lon => Math.max(0, Math.min(cols - 1, Math.round((lon - minLon) / lonCell)));

  const landMemo = new Int8Array(rows * cols).fill(-1);
  const cellIsLand = (r, c) => {
    const k = r * cols + c;
    let v = landMemo[k];
    if (v === -1) { v = pointOnLand(cellLat(r), cellLon(c), polygons, bboxes, waterPolygons, waterBboxes) ? 1 : 0; landMemo[k] = v; }
    return v === 1;
  };

  const blockedMemo = new Int8Array(rows * cols).fill(-1);
  const blocked = (r, c) => {
    const k = r * cols + c;
    let v = blockedMemo[k];
    if (v !== -1) return v === 1;
    v = 0;
    for (let dr = -clearanceCells; dr <= clearanceCells && !v; dr++) {
      for (let dc = -clearanceCells; dc <= clearanceCells; dc++) {
        const nr = r + dr, nc = c + dc;
        if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
        if (cellIsLand(nr, nc)) { v = 1; break; }
      }
    }
    blockedMemo[k] = v;
    return v === 1;
  };

  // Coast-proximity cost. Shortest-path alone hugs the coast and threads
  // archipelagos in long straight LOS runs; penalizing cells close to land
  // makes the route bow into open water (wider, more natural detours) and
  // hold channel-centers between islands (more real turns, so string-pull
  // keeps weaving waypoints instead of one long straight cut). It's a soft
  // cost — narrow channels with no open-water option still route, just dearer.
  const proximityKm = opts.proximityKm ?? 4;
  const proximityWeight = opts.proximityWeight ?? 2;
  // Narrow-channel penalty: a quadratic term on `nearness` so the COST/km in a
  // narrow waterway (land close on both sides → high nearness throughout) is
  // disproportionately higher than mid-channel in a wide one. This nudges the
  // route onto the main channel (e.g. the Fraser) instead of a shortcut up a
  // small tributary, without affecting open-water routing (nearness → 0 a few
  // cells offshore, so the term vanishes). Mild by design — a big-enough real
  // shortcut still wins; it won't detour absurdly.
  const narrowWeight = opts.narrowWeight ?? 3;
  // Cap the ring-search depth: at a fine cell size proximityKm/cellKm would be
  // huge and the per-cell ring search O(d^2) would dominate runtime.
  const maxProxCells = Math.min(8, Math.max(1, Math.round(proximityKm / cellKm)));
  const proxMemo = new Int16Array(rows * cols).fill(-1); // Chebyshev cells to nearest land
  const nearness = (r, c) => {
    const k = r * cols + c;
    let d = proxMemo[k];
    if (d === -1) {
      d = maxProxCells;
      for (let radius = 1; radius <= maxProxCells; radius++) {
        let hit = false;
        for (let dr = -radius; dr <= radius && !hit; dr++) {
          for (let dc = -radius; dc <= radius; dc++) {
            if (Math.max(Math.abs(dr), Math.abs(dc)) !== radius) continue;
            const nr = r + dr, nc = c + dc;
            if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
            if (cellIsLand(nr, nc)) { hit = true; break; }
          }
        }
        if (hit) { d = radius; break; }
      }
      proxMemo[k] = d;
    }
    return (maxProxCells - d) / maxProxCells; // 1 at the shore → 0 once clear
  };

  // Snap an endpoint to the nearest water cell (ring search) if it landed on a
  // land cell (coarse coastline vs a real near-shore AIS fix).
  function snapToWater(r, c) {
    if (!cellIsLand(r, c)) return [r, c];
    for (let radius = 1; radius < Math.max(rows, cols); radius++) {
      for (let dr = -radius; dr <= radius; dr++) {
        for (let dc = -radius; dc <= radius; dc++) {
          if (Math.max(Math.abs(dr), Math.abs(dc)) !== radius) continue;
          const nr = r + dr, nc = c + dc;
          if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
          if (!cellIsLand(nr, nc)) return [nr, nc];
        }
      }
    }
    return null;
  }

  const startSnap = snapToWater(toRow(a[0]), toCol(a[1]));
  const goalSnap = snapToWater(toRow(b[0]), toCol(b[1]));
  if (!startSnap || !goalSnap) return null;
  const [sr, sc] = startSnap, [gr, gc] = goalSnap;

  const N = rows * cols;
  const idx = (r, c) => r * cols + c;
  const startN = idx(sr, sc), goalN = idx(gr, gc);
  const hCost = (r, c) => haversineKm(cellLat(r), cellLon(c), cellLat(gr), cellLon(gc));

  // start/goal are always allowed so endpoints near shore still route.
  function search(passable) {
    const gScore = new Float64Array(N).fill(Infinity);
    const parent = new Int32Array(N).fill(-1);
    const closed = new Uint8Array(N);
    const heap = new MinHeap();
    gScore[startN] = 0;
    heap.push(startN, hCost(sr, sc));
    while (heap.size > 0) {
      const { node } = heap.pop();
      if (closed[node]) continue;
      if (node === goalN) {
        const grid = [];
        for (let n = goalN; n !== -1; n = parent[n]) { grid.push([(n / cols) | 0, n % cols]); if (n === startN) break; }
        return grid.reverse();
      }
      closed[node] = 1;
      const r = (node / cols) | 0, c = node % cols;
      for (const [dr, dc] of NEIGHBORS) {
        const nr = r + dr, nc = c + dc;
        if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
        const n = idx(nr, nc);
        if (closed[n] || (n !== goalN && !passable(nr, nc))) continue;
        const step = haversineKm(cellLat(r), cellLon(c), cellLat(nr), cellLon(nc));
        const nn = nearness(nr, nc);
        const tentative = gScore[node] + step * (1 + proximityWeight * nn + narrowWeight * nn * nn);
        if (tentative < gScore[n]) { gScore[n] = tentative; parent[n] = node; heap.push(n, tentative + hCost(nr, nc)); }
      }
    }
    return null;
  }

  let grid = search((r, c) => !blocked(r, c));
  let inflated = true;
  if (!grid) { grid = search((r, c) => !cellIsLand(r, c)); inflated = false; }
  if (!grid) return null;

  // String-pull: drop a vertex while the next-kept vertex stays in line of
  // sight (same inflation as the successful search).
  const losStep = Math.min(0.3, cellKm * 0.5);
  const sampleBlocked = (lat, lon) => {
    if (pointOnLand(lat, lon, polygons, bboxes, waterPolygons, waterBboxes)) return true;
    if (!inflated) return false;
    const r = Math.round((lat - minLat) / latCell), c = Math.round((lon - minLon) / lonCell);
    return r >= 0 && r < rows && c >= 0 && c < cols && blocked(r, c);
  };
  const los = (r1, c1, r2, c2) => {
    const aLat = cellLat(r1), aLon = cellLon(c1), bLat = cellLat(r2), bLon = cellLon(c2);
    const n = Math.max(1, Math.ceil(haversineKm(aLat, aLon, bLat, bLon) / losStep));
    for (let s = 0; s <= n; s++) {
      const f = s / n;
      if (sampleBlocked(aLat + (bLat - aLat) * f, aLon + (bLon - aLon) * f)) return false;
    }
    return true;
  };
  const pulled = [grid[0]];
  let anchor = 0;
  for (let i = 2; i < grid.length; i++) {
    if (!los(grid[anchor][0], grid[anchor][1], grid[i][0], grid[i][1])) { pulled.push(grid[i - 1]); anchor = i - 1; }
  }
  pulled.push(grid[grid.length - 1]);

  const path = pulled.map(([r, c]) => [cellLat(r), cellLon(c)]);
  path[0] = [a[0], a[1]];
  path[path.length - 1] = [b[0], b[1]];
  return path;
}
