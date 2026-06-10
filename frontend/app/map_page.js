import { VIEWSHEDS, DIRECT_BOUNDING_BOX, LOCAL_BOUNDING_BOX, MOVING_SPEED_KN, TIER_STYLE, TRAIL_GAP_SEVER_MS, LIVE_TTL_MS, FADE_TTL_MS, LAND_AVOIDANCE } from '../config.js';
import { subscribe as subscribeVessels } from './store.js';
import { subscribe as subscribeSettings, getSettings, passesExtentFilter, vesselCategory } from './settings_store.js';
import { haversineNm, bearingDeg, haversineKm, routeAroundLand } from './geo.js';
import { vesselColor, vesselCategoryLabel, vesselFlag } from './vessels.js';
import { getTrail, pruneTrails } from './trails.js';
import { subscribe as subscribeHighlight, getHighlight, setHighlight, clearHighlight } from './highlight_store.js';
import { LAND_POLYGONS } from './coastline.js';

// ── Constants ────────────────────────────────────────────────────────────────

const HOME = VIEWSHEDS[0].home;

const TILE_URL = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
const TILE_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com">CARTO</a>';

// ── State (module-level, reset on each mount) ────────────────────────────────

let map = null;
let markers = new Map();
let trailLayers = new Map();   // mmsi → [L.polyline, ...]
let unsubscribeVessels = null;
let unsubscribeSettings = null;
let unsubscribeHighlight = null;
let container = null;
let statusEl = null;
let resetBtn = null;
let highlightedMmsi = null;
let lastVessels = [];
let lastSettings = getSettings();
let trailReqToken = 0;

// ── Coastline data ──────────────────────────────────────────────────────────

const POLYGON_BBOXES = LAND_POLYGONS.map(poly => {
  let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
  for (const [lat, lon] of poly) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }
  return { minLat, maxLat, minLon, maxLon };
});

// Insert synthetic perimeter waypoints around land for any consecutive pair
// that crosses a coastline. Returns a new array of { lat, lon, t, tier, synthetic }.
function augmentSegment(pts, segT0, segT1) {
  if (pts.length < 2) return pts.map(([lat, lon], i) => {
    const t = segT0 + (segT1 - segT0) * (i / Math.max(pts.length - 1, 1));
    return { lat, lon, t, tier: 'direct', synthetic: false };
  });

  const result = [];
  for (let i = 0; i < pts.length; i++) {
    const [lat, lon] = pts[i];
    const frac = pts.length > 1 ? i / (pts.length - 1) : 0;
    const t = segT0 + (segT1 - segT0) * frac;
    result.push({ lat, lon, t, synthetic: false });

    if (i < pts.length - 1) {
      const a = pts[i], b = pts[i + 1];
      const perimeter = routeAroundLand(a, b, LAND_POLYGONS, POLYGON_BBOXES, LAND_AVOIDANCE.simplifyToleranceKm);
      if (perimeter && perimeter.length > 0) {
        const t0 = t;
        const t1 = segT0 + (segT1 - segT0) * ((i + 1) / Math.max(pts.length - 1, 1));
        const dt = (t1 - t0) / (perimeter.length + 1);
        for (let j = 0; j < perimeter.length; j++) {
          result.push({
            lat: perimeter[j][0],
            lon: perimeter[j][1],
            t: t0 + dt * (j + 1),
            synthetic: true,
          });
        }
      }
    }
  }
  return result;
}

// Split augmented points into sub-segments at real↔synthetic boundaries,
// then merge short (<2 pt) sub-segments into their neighbors so no orphan
// isolated real point creates a gap after a land crossing.
function buildSubSegments(augmented) {
  if (augmented.length === 0) return [];

  const segs = [];
  let cur = [{ lat: augmented[0].lat, lon: augmented[0].lon, t: augmented[0].t }];
  let curSynth = augmented[0].synthetic;
  let segT0 = augmented[0].t;

  function flush(endT) {
    if (cur.length >= 1) {
      segs.push({
        pts: cur.map(p => [p.lat, p.lon]),
        synthetic: curSynth,
        t0: segT0,
        t1: endT,
      });
    }
  }

  for (let i = 1; i < augmented.length; i++) {
    const p = augmented[i];
    if (p.synthetic !== curSynth) {
      flush(augmented[i - 1].t);
      cur = [{ lat: augmented[i - 1].lat, lon: augmented[i - 1].lon, t: augmented[i - 1].t }];
      curSynth = p.synthetic;
      segT0 = augmented[i - 1].t;
    }
    cur.push({ lat: p.lat, lon: p.lon, t: p.t });
  }
  flush(augmented[augmented.length - 1].t);

  // Give the synthetic sub-segment the last 3 real control points as catmull-rom
  // context so the spline flows smoothly through the transition (no corner where
  // two independent splines meet with different tangents). Only the last 3 real
  // points are stolen — the rest stay in their own real sub-segment — so the
  // vast majority of the trail remains solid.
  for (let i = segs.length - 1; i > 0; i--) {
    if (!segs[i - 1].synthetic && segs[i].synthetic) {
      const realPts = segs[i - 1].pts;
      const n = Math.min(3, realPts.length);
      const context = realPts.slice(-n);
      if (n < realPts.length) {
        segs[i - 1].pts = realPts.slice(0, -n);
      }
      segs[i].pts = [...context, ...segs[i].pts.slice(1)];
      segs[i].synthetic = true;
      // Approximate t0 for the merged synthetic sub-segment: time of first context pt
      const total = realPts.length;
      const tRange = segs[i - 1].t1 - segs[i - 1].t0;
      const idx = total - n;
      segs[i].t0 = segs[i - 1].t0 + (idx / Math.max(total - 1, 1)) * tRange;
      if (n >= realPts.length) segs.splice(i - 1, 1);
    }
  }

  return segs.filter(s => s.pts.length >= 2);
}

// ── Trail fade helpers ────────────────────────────────────────────────────────

function hexToRgb(hex) {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

// Gradient-faded polylines: split the trail into chunks, each with flat opacity
// based on its path-position fraction. This avoids the screen-space banding
// artifacts of a single CanvasGradient on curved trails.
// trailBounds { t0, t1 } — overall trail time range; each segment only paints its
// window of the gradient so there are no opacity seams at segment boundaries.
function makeFadePolylines(pts, color, weight, trailFade, trailBounds, segTimes, dashArray) {
  const [r, g, b] = hexToRgb(color);

  const range = trailFade * 0.9;
  const base = trailFade * 0.1;

  let headOpacity = base;
  let tailOpacity = trailFade;

  if (trailBounds && segTimes && trailBounds.t1 > trailBounds.t0) {
    const frac0 = (segTimes.t0 - trailBounds.t0) / (trailBounds.t1 - trailBounds.t0);
    const frac1 = (segTimes.t1 - trailBounds.t0) / (trailBounds.t1 - trailBounds.t0);
    headOpacity = base + range * frac0;
    tailOpacity = base + range * frac1;
  }

  const delta = tailOpacity - headOpacity;
  const layers = [];
  const CHUNK_PTS = 8;

  for (let i = 0; i < pts.length - 1; i += CHUNK_PTS) {
    const end = Math.min(i + CHUNK_PTS + 1, pts.length);
    const chunk = pts.slice(i, end);
    if (chunk.length < 2) continue;

    const frac = (i + (end - i - 1) / 2) / (pts.length - 1);
    const opacity = trailBounds === 'flat' ? trailFade : headOpacity + delta * frac;

    const opts = {
      color: `rgba(${r},${g},${b},${opacity})`,
      weight,
      className: 'vessel-trail',
      interactive: false,
    };
    if (dashArray) opts.dashArray = dashArray;
    const layer = L.polyline(chunk, opts);
    layers.push(layer);
  }
  return layers;
}

// ── Icon helpers ─────────────────────────────────────────────────────────────

function isMoving(vessel) {
  return vessel.speed !== null && vessel.speed > MOVING_SPEED_KN;
}

function currentExtent(vessel) {
  const { lat, lon } = vessel;
  if (lat >= DIRECT_BOUNDING_BOX.sw[0] && lat <= DIRECT_BOUNDING_BOX.ne[0] &&
      lon >= DIRECT_BOUNDING_BOX.sw[1] && lon <= DIRECT_BOUNDING_BOX.ne[1]) {
    return 'direct';
  }
  if (lat >= LOCAL_BOUNDING_BOX.sw[0] && lat <= LOCAL_BOUNDING_BOX.ne[0] &&
      lon >= LOCAL_BOUNDING_BOX.sw[1] && lon <= LOCAL_BOUNDING_BOX.ne[1]) {
    return 'local';
  }
  return 'global';
}

function markerOpacity(vessel) {
  if (vessel.mmsi === highlightedMmsi) return 1.0;
  const age = Date.now() - vessel.last_seen;
  const ttl = FADE_TTL_MS[currentExtent(vessel)] ?? FADE_TTL_MS.local;
  const remaining = Math.max(0, 1 - age / ttl);
  return Math.max(0.30, remaining);
}

function setMarkerOpacity(marker, opacity) {
  if (marker._icon) {
    marker._icon.style.setProperty('opacity', String(opacity), 'important');
  }
}

function makeArrowIcon(vessel, heading, opacity) {
  const color = vesselColor(vessel);
  const rotation = heading ?? 0;
  return L.divIcon({
    html: `<div class="vessel-arrow" style="transform:rotate(${rotation}deg);width:20px;height:20px;opacity:${opacity}">
      <svg viewBox="0 0 20 20" width="20" height="20" overflow="visible">
        <polygon points="10,1 17,17 10,13 3,17"
          fill="${color}" stroke="rgba(0,0,0,0.6)" stroke-width="1.5" stroke-linejoin="round"/>
      </svg>
    </div>`,
    className: 'vessel-marker',
    iconSize: [20, 20],
    iconAnchor: [10, 10],
  });
}

function makeDotIcon(vessel, opacity) {
  const color = vesselColor(vessel);
  return L.divIcon({
    html: `<div class="vessel-dot" style="--dot-color:${color};opacity:${opacity}"></div>`,
    className: 'vessel-marker',
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });
}

function makeVesselIcon(vessel, heading, opacity) {
  return isMoving(vessel) ? makeArrowIcon(vessel, heading, opacity) : makeDotIcon(vessel, opacity);
}

function applyHighlight(marker, mmsi) {
  if (marker._icon) {
    marker._icon.classList.toggle('highlighted', mmsi === highlightedMmsi);
  }
}

// ── Detail sheet ─────────────────────────────────────────────────────────────

function formatAge(updatedMs) {
  const s = Math.floor((Date.now() - updatedMs) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

function openSheet(vessel) {
  const backdrop = container.querySelector('.detail-backdrop');
  const sheet = container.querySelector('.detail-sheet');
  const color = vesselColor(vessel);
  const distNm = haversineNm(HOME.lat, HOME.lon, vessel.lat, vessel.lon);
  const flag = vesselFlag(vessel);
  const lengthStr = vessel.length !== null ? ` · ${vessel.length}m` : '';
  const typeStr = vessel.vessel_type !== null ? ` · Type ${vessel.vessel_type}` : '';
  const isHighlighted = highlightedMmsi === vessel.mmsi;

  sheet.innerHTML = `
    <div class="sheet-handle"></div>
    <div class="detail-vessel-name">${flag !== null ? flag + ' ' : ''}${vessel.name ?? 'Unknown Vessel'}</div>
    <div class="detail-type-row">
      <div class="detail-type-dot" style="background:${color}"></div>
      <div class="detail-vessel-type">${vesselCategoryLabel(vessel)}${typeStr}${lengthStr}</div>
    </div>
    <div class="detail-grid">
      <div class="detail-stat">
        <div class="detail-stat-label">Speed</div>
        <div class="detail-stat-value live">${vessel.speed !== null ? vessel.speed.toFixed(1) + ' kn' : '—'}</div>
      </div>
      <div class="detail-stat">
        <div class="detail-stat-label">Heading</div>
        <div class="detail-stat-value">${vessel.heading !== null ? vessel.heading + '°' : '—'}</div>
      </div>
      <div class="detail-stat">
        <div class="detail-stat-label">Distance</div>
        <div class="detail-stat-value">${distNm.toFixed(1)} nm</div>
      </div>
      <div class="detail-stat">
        <div class="detail-stat-label">MMSI</div>
        <div class="detail-stat-value na">${vessel.mmsi}</div>
      </div>
    </div>
    <button class="detail-highlight-btn" data-mmsi="${vessel.mmsi}">
      <span class="detail-highlight-icon">${isHighlighted ? '★' : '☆'}</span>
      ${isHighlighted ? 'Remove Highlight' : 'Highlight on Map'}
    </button>
    <div class="detail-destination">
      <div class="detail-destination-label">Destination</div>
      <div class="detail-destination-value">${vessel.destination ?? '—'}</div>
    </div>
    <div class="detail-footer">Updated ${formatAge(vessel.last_seen)}</div>
  `;

  sheet.querySelector('.detail-highlight-btn').addEventListener('click', e => {
    e.stopPropagation();
    const mmsi = Number(e.currentTarget.dataset.mmsi);
    if (highlightedMmsi === mmsi) {
      clearHighlight();
    } else {
      setHighlight(mmsi, false);
    }
    closeSheet();
  });

  backdrop.classList.add('open');
  sheet.classList.add('open');
}

function closeSheet() {
  container.querySelector('.detail-backdrop').classList.remove('open');
  container.querySelector('.detail-sheet').classList.remove('open');
}

// ── Trail drawing ─────────────────────────────────────────────────────────────

// Two-phase pre-processor:
//   Pass 1×: gentle inward Laplacian to kill AIS jitter before expanding.
//   Pass 2×: outward push so the final spline bulges beyond the data on curves.
// Applying the outward pass directly to noisy data amplifies zigzags — the
// inward denoise pass must come first.
// cos-weighting (straight→full effect, turning→none) protects sharp corners.
function preSmooth(pts) {
  if (pts.length < 3) return pts;

  function laplacianPass(cur, sign, factor) {
    const next = [cur[0]];
    for (let i = 1; i < cur.length - 1; i++) {
      const [ax, ay] = cur[i - 1];
      const [bx, by] = cur[i];
      const [cx, cy] = cur[i + 1];
      const dx1 = bx - ax, dy1 = by - ay;
      const dx2 = cx - bx, dy2 = cy - by;
      const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
      const len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);
      if (len1 < 1e-10 || len2 < 1e-10) { next.push(cur[i]); continue; }
      const cos = (dx1 * dx2 + dy1 * dy2) / (len1 * len2);
      const t = Math.max(0, cos) * factor;
      const mx = (ax + cx) / 2, my = (ay + cy) / 2;
      next.push([bx + sign * (mx - bx) * t, by + sign * (my - by) * t]);
    }
    next.push(cur[cur.length - 1]);
    return next;
  }

  let cur = pts.slice();
  cur = laplacianPass(cur, +1, 0.2); // inward: denoise (pass 1)
  cur = laplacianPass(cur, +1, 0.2); // inward: denoise (pass 2)
  cur = laplacianPass(cur, -1, 0.3); // outward: gentle expand past data
  return cur;
}

// Centripetal Catmull-Rom spline (α=0.5): passes through every data point and
// weights tangents by √distance between points. This prevents the overshoot/zigzag
// artifacts that uniform Catmull-Rom produces when AIS points are unevenly spaced.
// Pre-smoothed so sparse/noisy AIS data produces gentle curves rather than kinks.
// skipSmooth: bypass laplacian denoise for synthetic coastline perimeter data
// (Natural Earth vertices are already clean; smoothing pulls them inland).
function catmullRomPoints(pts, samples = 12, skipSmooth = false) {
  if (pts.length < 2) return pts;
  if (!skipSmooth) pts = preSmooth(pts);

  function knot(t, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    return Math.pow(Math.max(Math.sqrt(dx * dx + dy * dy), 1e-10), 0.5) + t;
  }

  const result = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = i > 0 ? pts[i - 1] : [2 * pts[0][0] - pts[1][0], 2 * pts[0][1] - pts[1][1]];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = i < pts.length - 2 ? pts[i + 2] : [2 * pts[pts.length - 1][0] - pts[pts.length - 2][0], 2 * pts[pts.length - 1][1] - pts[pts.length - 2][1]];

    const t0 = 0, t1 = knot(t0, p0, p1), t2 = knot(t1, p1, p2), t3 = knot(t2, p2, p3);

    for (let j = 0; j < samples; j++) {
      const t = t1 + (t2 - t1) * (j / samples);
      const A1 = [p0[0] + (p1[0] - p0[0]) * (t - t0) / (t1 - t0), p0[1] + (p1[1] - p0[1]) * (t - t0) / (t1 - t0)];
      const A2 = [p1[0] + (p2[0] - p1[0]) * (t - t1) / (t2 - t1), p1[1] + (p2[1] - p1[1]) * (t - t1) / (t2 - t1)];
      const A3 = [p2[0] + (p3[0] - p2[0]) * (t - t2) / (t3 - t2), p2[1] + (p3[1] - p2[1]) * (t - t2) / (t3 - t2)];
      const B1 = [A1[0] + (A2[0] - A1[0]) * (t - t0) / (t2 - t0), A1[1] + (A2[1] - A1[1]) * (t - t0) / (t2 - t0)];
      const B2 = [A2[0] + (A3[0] - A2[0]) * (t - t1) / (t3 - t1), A2[1] + (A3[1] - A2[1]) * (t - t1) / (t3 - t1)];
      result.push([B1[0] + (B2[0] - B1[0]) * (t - t1) / (t2 - t1), B1[1] + (B2[1] - B1[1]) * (t - t1) / (t2 - t1)]);
    }
  }
  result.push(pts[pts.length - 1]);
  return result;
}

function segmentsByTier(points, gapByTier) {
  const segments = [];
  if (points.length === 0) return segments;

  let pts = [[points[0].lat, points[0].lon]];
  let segT0 = points[0].t;
  let segT1 = points[0].t;

  function flush() {
    segments.push({ pts, t0: segT0, t1: segT1 });
  }

  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    const gapMs = p.t - points[i - 1].t;
    const threshold = gapByTier[points[i - 1].tier];

    if (threshold !== null && gapMs > threshold) {
      segT1 = points[i - 1].t;
      flush();
      pts = [[p.lat, p.lon]];
      segT0 = p.t;
      segT1 = p.t;
    } else {
      pts.push([p.lat, p.lon]);
      segT1 = p.t;
    }
  }
  flush();
  return segments;
}

function removeTrailLayers(mmsi) {
  const layers = trailLayers.get(mmsi);
  if (layers !== undefined) {
    for (const layer of layers) layer.remove();
    trailLayers.delete(mmsi);
  }
}

function drawTrail(vessel, points, token) {
  if (token !== trailReqToken) return;
  if (map === null) return;

  const mmsi = vessel.mmsi;
  removeTrailLayers(mmsi);
  if (points.length === 0) return;

  // API returns points newest-first; reverse to chronological order for drawing.
  const chronological = [...points].reverse();

  // Extend to the vessel's current position so the trail is always live.
  const last = chronological[chronological.length - 1];
  const allPoints = (last.lat === vessel.lat && last.lon === vessel.lon)
    ? chronological
    : [...chronological, { ...last, lat: vessel.lat, lon: vessel.lon }];

  // When AIS reports no true heading, infer direction of travel from the last
  // two distinct trail points and rotate the arrow to match.
  if (vessel.heading === null && isMoving(vessel)) {
    const marker = markers.get(mmsi);
    if (marker !== undefined) {
      const head = allPoints[allPoints.length - 1];
      let trailHeading = null;
      for (let i = allPoints.length - 2; i >= 0; i--) {
        const p = allPoints[i];
        if (p.lat !== head.lat || p.lon !== head.lon) {
          trailHeading = bearingDeg(p.lat, p.lon, head.lat, head.lon);
          break;
        }
      }
      if (trailHeading !== null && trailHeading !== marker._effectiveHeading) {
        marker._effectiveHeading = trailHeading;
        marker.setIcon(makeVesselIcon(vessel, trailHeading, markerOpacity(vessel)));
        setMarkerOpacity(marker, markerOpacity(vessel));
      }
    }
  }

  const isHighlighted = vessel.mmsi === highlightedMmsi;
  const color = vesselColor(vessel);
  const trailFade = isHighlighted ? 1.0 : markerOpacity(vessel);
  const segments = segmentsByTier(allPoints, TRAIL_GAP_SEVER_MS);

  const trailBounds = isHighlighted ? 'flat' : { t0: allPoints[0].t, t1: allPoints[allPoints.length - 1].t };

  const style = isHighlighted ? { opacity: 1.0, weight: 3 } : TIER_STYLE.direct;
  const layers = [];

  for (const seg of segments) {
    const augmented = augmentSegment(seg.pts, seg.t0, seg.t1);
    const subSegs = buildSubSegments(augmented);

    for (const sub of subSegs) {
      const smooth = catmullRomPoints(sub.pts, 12, sub.synthetic);
      if (smooth.length < 2) continue;
      const segTimes = { t0: sub.t0, t1: sub.t1 };
      const opacityMul = sub.synthetic ? LAND_AVOIDANCE.fadeRatio : 1;
      const segLayers = makeFadePolylines(
        smooth, color, style.weight, style.opacity * opacityMul * trailFade,
        trailBounds, segTimes,
        sub.synthetic ? LAND_AVOIDANCE.dashArray : null
      );
      for (const layer of segLayers) {
        layer.addTo(map);
        layers.push(layer);
      }
    }
  }

  trailLayers.set(mmsi, layers);

  // Debug: dump full rendering output for specific vessels
  if (mmsi === 357777000 || mmsi === 563303100) {
    console.log(`[TRAIL ${mmsi}] ${allPoints.length} trail pts, ${segments.length} segs`);
    for (let si = 0; si < segments.length; si++) {
      const seg = segments[si];
      const augmented = augmentSegment(seg.pts, seg.t0, seg.t1);
      const subSegs = buildSubSegments(augmented);
      console.log(`  Seg ${si}: ${seg.pts.length} trail pts → ${subSegs.length} sub-segs`);
      for (let j = 0; j < subSegs.length; j++) {
        const sub = subSegs[j];
        const ctrl = sub.pts;
        const smooth = catmullRomPoints(ctrl, 12, sub.synthetic);
        console.log(`  Sub ${j} (${ctrl.length} ctrl, synth=${sub.synthetic}) → ${smooth.length} spline pts`);
        // Print ALL control points for synthetic sub-segments
        if (sub.synthetic) {
          console.log('    Ctrl:');
          for (let ci = 0; ci < ctrl.length; ci++) {
            console.log(`      [${ci}]: ${ctrl[ci][0].toFixed(5)},${ctrl[ci][1].toFixed(5)}`);
          }
          // Print ALL spline points
          console.log('    Spline:');
          for (let pi = 0; pi < smooth.length; pi++) {
            console.log(`      ${pi}: ${smooth[pi][0].toFixed(5)},${smooth[pi][1].toFixed(5)}`);
          }
        }
        // For real sub-segments, just print first/last 5 spline pts
        if (!sub.synthetic) {
          const head = smooth.slice(0, 5);
          const tail = smooth.slice(-5);
          console.log('    Spline (first 5):');
          for (let pi = 0; pi < head.length; pi++) {
            console.log(`      ${pi}: ${head[pi][0].toFixed(5)},${head[pi][1].toFixed(5)}`);
          }
          if (smooth.length > 10) console.log('    ...');
          console.log('    Spline (last 5):');
          for (let pi = 0; pi < tail.length; pi++) {
            console.log(`      ${smooth.length - 5 + pi}: ${tail[pi][0].toFixed(5)},${tail[pi][1].toFixed(5)}`);
          }
        }
      }
    }
  }
}

async function scheduleTrails(visibleVessels, token) {
  const liveSet = new Set(visibleVessels.map(v => v.mmsi));
  pruneTrails(liveSet);

  // Remove trail layers for vessels no longer visible
  for (const mmsi of trailLayers.keys()) {
    if (!liveSet.has(mmsi)) removeTrailLayers(mmsi);
  }

  const TRAIL_TIERS = ['direct', 'local'];

  for (const vessel of visibleVessels) {
    if (token !== trailReqToken) break;
    if (!lastSettings.trail[vesselCategory(vessel)]) continue;
    getTrail(vessel.mmsi, TRAIL_TIERS).then(points => drawTrail(vessel, points, token));
  }
}

// ── Marker management ────────────────────────────────────────────────────────

function render() {
  if (map === null || container === null) return;

  const vessels = lastVessels;
  const settings = lastSettings;
  const error = null; // error is handled by status chip only

  const filtered = vessels.filter(v => passesExtentFilter(v, settings.extent));

  if (statusEl !== null) {
    statusEl.innerHTML = `<span class="dot"></span>${filtered.length} vessel${filtered.length !== 1 ? 's' : ''}`;
  }

  const seen = new Set();

  for (const vessel of filtered) {
    seen.add(vessel.mmsi);
    const existing = markers.get(vessel.mmsi);

    if (existing !== undefined) {
      existing.setLatLng([vessel.lat, vessel.lon]);
      const prev = existing._vessel;
      const posChanged = prev.lat !== vessel.lat || prev.lon !== vessel.lon;
      const effectiveHeading = vessel.heading ?? (
        isMoving(vessel) && posChanged
          ? bearingDeg(prev.lat, prev.lon, vessel.lat, vessel.lon)
          : existing._effectiveHeading ?? null
      );
      const opacity = markerOpacity(vessel);
      existing.setIcon(makeVesselIcon(vessel, effectiveHeading, opacity));
      setMarkerOpacity(existing, opacity);
      existing._vessel = vessel;
      existing._effectiveHeading = effectiveHeading;
      applyHighlight(existing, vessel.mmsi);
    } else {
      const opacity = markerOpacity(vessel);
      const marker = L.marker([vessel.lat, vessel.lon], { icon: makeVesselIcon(vessel, vessel.heading, opacity) });
      marker._vessel = vessel;
      marker._effectiveHeading = vessel.heading;
      marker.on('click', () => openSheet(marker._vessel));
      marker.addTo(map);
      setMarkerOpacity(marker, opacity);
      markers.set(vessel.mmsi, marker);
      applyHighlight(marker, vessel.mmsi);
    }
  }

  for (const [mmsi, marker] of markers) {
    if (!seen.has(mmsi)) {
      marker.remove();
      markers.delete(mmsi);
    }
  }

  if (resetBtn !== null) {
    resetBtn.style.display = highlightedMmsi !== null ? '' : 'none';
  }

  trailReqToken++;
  scheduleTrails(filtered, trailReqToken);
}

function onVesselsUpdate(vessels, error) {
  if (error !== null) {
    console.error('[map] poll error:', error);
    if (statusEl !== null) {
      statusEl.innerHTML = `<span style="color:var(--red)">⚠ ${error.message}</span>`;
    }
    return;
  }
  lastVessels = vessels;
  render();
}

function onSettingsUpdate(settings) {
  lastSettings = settings;
  render();
}

// ── Mount / unmount ──────────────────────────────────────────────────────────

export function mount(root) {
  container = root;
  lastSettings = getSettings();

  container.innerHTML = `
    <div class="map-page">
      <div id="leaflet-map"></div>
      <div class="map-status" id="map-status">
        <span class="dot"></span>Loading…
      </div>
      <button class="map-reset-btn" id="map-reset-btn" style="display:none" title="Clear highlight">
        <svg viewBox="0 0 16 16" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
          <line x1="3" y1="3" x2="13" y2="13"/>
          <line x1="13" y1="3" x2="3" y2="13"/>
        </svg>
      </button>
      <div class="detail-backdrop"></div>
      <div class="detail-sheet"></div>
    </div>
  `;

  statusEl = container.querySelector('#map-status');
  resetBtn = container.querySelector('#map-reset-btn');
  resetBtn.addEventListener('click', clearHighlight);

  container.querySelector('.detail-backdrop').addEventListener('click', closeSheet);

  map = L.map('leaflet-map', { zoomControl: true, attributionControl: true, preferCanvas: true })
    .setView([HOME.lat, HOME.lon], 11);

  L.tileLayer(TILE_URL, { attribution: TILE_ATTR, maxZoom: 18 }).addTo(map);

  requestAnimationFrame(() => map !== null && map.invalidateSize());

  L.rectangle(
    [DIRECT_BOUNDING_BOX.sw, DIRECT_BOUNDING_BOX.ne],
    { color: '#17c3d4', weight: 1, opacity: 0.35, fill: false, interactive: false, dashArray: '6 4' }
  ).addTo(map);

  L.rectangle(
    [LOCAL_BOUNDING_BOX.sw, LOCAL_BOUNDING_BOX.ne],
    { color: '#6b7d8a', weight: 1, opacity: 0.12, fill: false, interactive: false, dashArray: '4 6' }
  ).addTo(map);

  const homeIcon = L.divIcon({
    html: `<div class="home-pulse-outer"><div class="home-pulse-inner"></div></div>`,
    className: '',
    iconSize: [40, 40],
    iconAnchor: [20, 20],
  });
  L.marker([HOME.lat, HOME.lon], { icon: homeIcon, interactive: false }).addTo(map);

  unsubscribeVessels = subscribeVessels(onVesselsUpdate);
  unsubscribeSettings = subscribeSettings(onSettingsUpdate);
  unsubscribeHighlight = subscribeHighlight((mmsi, pan) => {
    highlightedMmsi = mmsi;
    if (pan !== false && mmsi !== null && map !== null) {
      const v = lastVessels.find(v => v.mmsi === mmsi);
      if (v !== undefined) map.setView([v.lat, v.lon], map.getZoom(), { animate: true });
    }
    render();
  });
}

export function unmount() {
  if (unsubscribeVessels !== null) { unsubscribeVessels(); unsubscribeVessels = null; }
  if (unsubscribeSettings !== null) { unsubscribeSettings(); unsubscribeSettings = null; }
  if (unsubscribeHighlight !== null) { unsubscribeHighlight(); unsubscribeHighlight = null; }
  if (map !== null) { map.remove(); map = null; }
  markers.clear();
  for (const layers of trailLayers.values()) {
    for (const layer of layers) layer.remove();
  }
  trailLayers.clear();
  trailReqToken++;
  container = null;
  statusEl = null;
  resetBtn = null;
  highlightedMmsi = null;
  lastVessels = [];
}
