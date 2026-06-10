import { VIEWSHEDS, DIRECT_BOUNDING_BOX, LOCAL_BOUNDING_BOX, MOVING_SPEED_KN, TIER_STYLE, TRAIL_GAP_SEVER_MS, LIVE_TTL_MS, FADE_TTL_MS, LAND_AVOIDANCE } from '../config.js';
import { subscribe as subscribeVessels } from './store.js';
import { subscribe as subscribeSettings, getSettings, passesExtentFilter, vesselCategory } from './settings_store.js';
import { haversineNm, bearingDeg, haversineKm, routeWater, segmentCrossesLand, pointOnLand } from './geo.js';
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

export const POLYGON_BBOXES = LAND_POLYGONS.map(poly => {
  let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
  for (const [lat, lon] of poly) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }
  return { minLat, maxLat, minLon, maxLon };
});

// ── Trail geometry pipeline ──────────────────────────────────────────────────
//
// One spline over the whole journey gives a continuous derivative everywhere —
// including across real→inferred transitions. We only break the spline at a
// genuine stop (the vessel sat still through a long gap); a moving vessel that
// merely lost signal keeps one continuous, smooth trail.
//
//   dedup → split journeys at stops → per journey: denoise real points, splice
//   water-routed waypoints into land-crossing gaps → one centripetal
//   Catmull-Rom → runs grouped by real/inferred for styling.

// Drop consecutive fixes closer than this. Duplicate/near-duplicate AIS reports
// otherwise make centripetal Catmull-Rom divide by ~0 and spike.
const DEDUP_KM = 0.02;

export function dedup(points) {
  if (points.length === 0) return points;
  const out = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const p = out[out.length - 1];
    if (haversineKm(p.lat, p.lon, points[i].lat, points[i].lon) > DEDUP_KM) out.push(points[i]);
  }
  return out;
}

// Break the trail into journeys at stops only: the vessel was stationary at its
// last fix (speed ~0) and then a long gap followed — it parked and we lost it.
// Wherever it resurfaces starts a fresh journey/curve. A vessel still moving
// when signal dropped stays in one journey so the spline bridges the gap
// continuously (the derivative stays continuous across the bridge).
export function splitJourneys(points) {
  const journeys = [];
  let cur = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const gap = points[i].t - points[i - 1].t;
    const sever = TRAIL_GAP_SEVER_MS[points[i - 1].tier] ?? TRAIL_GAP_SEVER_MS.local;
    const parked = (points[i - 1].speed ?? 0) <= MOVING_SPEED_KN;
    if (sever !== null && gap > sever && parked) { journeys.push(cur); cur = [points[i]]; }
    else cur.push(points[i]);
  }
  journeys.push(cur);
  return journeys;
}

// cos-weighted Laplacian denoise of real AIS positions. A point that would move
// onto land (smoothing toward a neighbor-midpoint near a concave shore) keeps
// its original position. Returns [lat,lon] parallel to the input.
function denoise(points, passes = 2, factor = 0.2) {
  let cur = points.map(p => [p.lat, p.lon]);
  for (let pass = 0; pass < passes; pass++) {
    const next = [cur[0]];
    for (let i = 1; i < cur.length - 1; i++) {
      const [ax, ay] = cur[i - 1], [bx, by] = cur[i], [cx, cy] = cur[i + 1];
      const dx1 = bx - ax, dy1 = by - ay, dx2 = cx - bx, dy2 = cy - by;
      const l1 = Math.hypot(dx1, dy1), l2 = Math.hypot(dx2, dy2);
      if (l1 < 1e-10 || l2 < 1e-10) { next.push(cur[i]); continue; }
      const cos = (dx1 * dx2 + dy1 * dy2) / (l1 * l2);
      const t = Math.max(cos, 0) * factor;
      const moved = [bx + (((ax + cx) / 2) - bx) * t, by + (((ay + cy) / 2) - by) * t];
      next.push(pointOnLand(moved[0], moved[1], LAND_POLYGONS, POLYGON_BBOXES) ? cur[i] : moved);
    }
    next.push(cur[cur.length - 1]);
    cur = next;
  }
  return cur;
}

// Build the spline control points for one journey: denoised real fixes, with
// water-routed waypoints spliced into every land-crossing gap. Each control
// point carries its time and whether it's an inferred (synthetic) waypoint.
export function buildControlPoints(journey) {
  const real = denoise(journey);
  const ctrl = [{ lat: real[0][0], lon: real[0][1], t: journey[0].t, synthetic: false }];
  for (let i = 1; i < real.length; i++) {
    const a = real[i - 1], b = real[i];
    const isGap = (journey[i].t - journey[i - 1].t) > LAND_AVOIDANCE.gapMinMs || haversineKm(a[0], a[1], b[0], b[1]) > LAND_AVOIDANCE.gapMinKm;
    if (isGap && segmentCrossesLand(a, b, LAND_POLYGONS, POLYGON_BBOXES)) {
      const route = routeWater(a, b, LAND_POLYGONS, POLYGON_BBOXES);
      if (route && route.length > 2) {
        const t0 = journey[i - 1].t, t1 = journey[i].t;
        for (let k = 1; k < route.length - 1; k++) {
          ctrl.push({ lat: route[k][0], lon: route[k][1], t: t0 + (t1 - t0) * (k / (route.length - 1)), synthetic: true });
        }
      }
    }
    ctrl.push({ lat: b[0], lon: b[1], t: journey[i].t, synthetic: false });
  }
  // Splicing in/out routes through a narrow feature can leave near-duplicate
  // control points; collapse them so the spline doesn't spike.
  const out = [ctrl[0]];
  for (let i = 1; i < ctrl.length; i++) {
    const p = out[out.length - 1];
    if (haversineKm(p.lat, p.lon, ctrl[i].lat, ctrl[i].lon) > DEDUP_KM) out.push(ctrl[i]);
  }
  return out;
}

// ── Trail fade helpers ────────────────────────────────────────────────────────

function hexToRgb(hex) {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

// Gradient-faded polylines: split a run of spline samples into chunks, each
// with flat opacity keyed off the chunk's timestamp. Older = fainter. Chunking
// avoids the screen-space banding a single CanvasGradient shows on curved
// trails. `samples` are {lat,lon,t}; `trailBounds` is the overall {t0,t1} time
// range (or 'flat' for the highlighted vessel, which doesn't fade).
function makeFadePolylines(samples, color, weight, trailFade, trailBounds, dashArray) {
  const [r, g, b] = hexToRgb(color);
  const range = trailFade * 0.9;
  const base = trailFade * 0.1;
  const fadeAt = t => {
    if (trailBounds === 'flat' || !(trailBounds.t1 > trailBounds.t0)) return trailFade;
    return base + range * ((t - trailBounds.t0) / (trailBounds.t1 - trailBounds.t0));
  };

  const layers = [];
  const CHUNK_PTS = 8;
  for (let i = 0; i < samples.length - 1; i += CHUNK_PTS) {
    const end = Math.min(i + CHUNK_PTS + 1, samples.length);
    const chunk = samples.slice(i, end);
    if (chunk.length < 2) continue;
    const opacity = fadeAt(chunk[(chunk.length - 1) >> 1].t);
    const opts = {
      color: `rgba(${r},${g},${b},${opacity})`,
      weight,
      className: 'vessel-trail',
      interactive: false,
    };
    if (dashArray) opts.dashArray = dashArray;
    layers.push(L.polyline(chunk.map(p => [p.lat, p.lon]), opts));
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

// Centripetal Catmull-Rom spline (α=0.5): passes through every control point
// and weights tangents by √distance, avoiding the overshoot/zigzag uniform
// Catmull-Rom produces on unevenly spaced points. Run once over a whole
// journey's control points so the derivative is continuous everywhere,
// including across real→inferred transitions. Control points are pre-cleaned
// (deduped + denoised + clean routed waypoints), so no smoothing happens here.
// Each output sample carries an interpolated time and the inferred flag of the
// segment it lies on (either endpoint synthetic → inferred), for styling.
export function catmullRom(ctrl, samples = 12) {
  if (ctrl.length < 2) return ctrl.map(c => ({ lat: c.lat, lon: c.lon, t: c.t, synthetic: c.synthetic }));

  const knot = (t, a, b) => Math.pow(Math.max(Math.hypot(b.lat - a.lat, b.lon - a.lon), 1e-10), 0.5) + t;
  const mirror = (a, b) => ({ lat: 2 * a.lat - b.lat, lon: 2 * a.lon - b.lon });
  const out = [];

  for (let i = 0; i < ctrl.length - 1; i++) {
    const p0 = i > 0 ? ctrl[i - 1] : mirror(ctrl[0], ctrl[1]);
    const p1 = ctrl[i], p2 = ctrl[i + 1];
    const p3 = i < ctrl.length - 2 ? ctrl[i + 2] : mirror(ctrl[ctrl.length - 1], ctrl[ctrl.length - 2]);
    const t0 = 0, t1 = knot(t0, p0, p1), t2 = knot(t1, p1, p2), t3 = knot(t2, p2, p3);
    const inferred = p1.synthetic || p2.synthetic;

    for (let j = 0; j < samples; j++) {
      const t = t1 + (t2 - t1) * (j / samples);
      const lat = catmull('lat', p0, p1, p2, p3, t, t0, t1, t2, t3);
      const lon = catmull('lon', p0, p1, p2, p3, t, t0, t1, t2, t3);
      out.push({ lat, lon, t: p1.t + (p2.t - p1.t) * (j / samples), synthetic: inferred });
    }
  }
  const lastC = ctrl[ctrl.length - 1];
  out.push({ lat: lastC.lat, lon: lastC.lon, t: lastC.t, synthetic: lastC.synthetic });
  return out;
}

// Barry-Goldman pyramidal evaluation of one coordinate of the centripetal spline.
function catmull(k, p0, p1, p2, p3, t, t0, t1, t2, t3) {
  const A1 = p0[k] + (p1[k] - p0[k]) * (t - t0) / (t1 - t0);
  const A2 = p1[k] + (p2[k] - p1[k]) * (t - t1) / (t2 - t1);
  const A3 = p2[k] + (p3[k] - p2[k]) * (t - t2) / (t3 - t2);
  const B1 = A1 + (A2 - A1) * (t - t0) / (t2 - t0);
  const B2 = A2 + (A3 - A2) * (t - t1) / (t3 - t1);
  return B1 + (B2 - B1) * (t - t1) / (t2 - t1);
}

// Split spline samples into contiguous runs of equal `synthetic` flag so each
// run can be styled (solid for real tracking, dashed/faint for inferred gaps).
// Runs overlap by one sample at boundaries so there is no visual seam.
export function runsBySynthetic(samples) {
  const runs = [];
  let start = 0;
  for (let i = 1; i <= samples.length; i++) {
    if (i === samples.length || samples[i].synthetic !== samples[start].synthetic) {
      runs.push({ synthetic: samples[start].synthetic, samples: samples.slice(start, Math.min(i + 1, samples.length)) });
      start = i;
    }
  }
  return runs;
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
  const trailBounds = isHighlighted ? 'flat' : { t0: allPoints[0].t, t1: allPoints[allPoints.length - 1].t };
  const style = isHighlighted ? { opacity: 1.0, weight: 3 } : TIER_STYLE.direct;
  const layers = [];

  // One spline per journey (journeys break only at stops); within a journey the
  // trail is C1-continuous across real→inferred transitions.
  for (const journey of splitJourneys(dedup(allPoints))) {
    if (journey.length < 2) continue;
    const smooth = catmullRom(buildControlPoints(journey));
    for (const run of runsBySynthetic(smooth)) {
      if (run.samples.length < 2) continue;
      const opacityMul = run.synthetic ? LAND_AVOIDANCE.fadeRatio : 1;
      const runLayers = makeFadePolylines(
        run.samples, color, style.weight, style.opacity * opacityMul * trailFade,
        trailBounds, run.synthetic ? LAND_AVOIDANCE.dashArray : null
      );
      for (const layer of runLayers) { layer.addTo(map); layers.push(layer); }
    }
  }

  trailLayers.set(mmsi, layers);
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
