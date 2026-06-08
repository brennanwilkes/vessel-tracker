import { VIEWSHEDS, DIRECT_BOUNDING_BOX, MOVING_SPEED_KN, TIER_STYLE } from '../config.js';
import { subscribe as subscribeVessels } from './store.js';
import { subscribe as subscribeSettings, getSettings, passesExtentFilter, vesselCategory } from './settings_store.js';
import { haversineNm, bearingDeg } from './geo.js';
import { vesselColor, vesselCategoryLabel, vesselFlag } from './vessels.js';
import { getTrail, pruneTrails } from './trails.js';

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
let container = null;
let statusEl = null;
let lastVessels = [];
let lastSettings = getSettings();
let trailReqToken = 0;

// ── Icon helpers ─────────────────────────────────────────────────────────────

function isMoving(vessel) {
  return vessel.speed !== null && vessel.speed > MOVING_SPEED_KN;
}

function makeArrowIcon(vessel, heading) {
  const color = vesselColor(vessel);
  const rotation = heading ?? 0;
  return L.divIcon({
    html: `<div style="transform:rotate(${rotation}deg);width:20px;height:20px;">
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

function makeDotIcon(vessel) {
  const color = vesselColor(vessel);
  return L.divIcon({
    html: `<div class="vessel-dot" style="--dot-color:${color}"></div>`,
    className: 'vessel-marker',
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });
}

function makeVesselIcon(vessel, heading) {
  return isMoving(vessel) ? makeArrowIcon(vessel, heading) : makeDotIcon(vessel);
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
    <div class="detail-destination">
      <div class="detail-destination-label">Destination</div>
      <div class="detail-destination-value">${vessel.destination ?? '—'}</div>
    </div>
    <div class="detail-footer">Updated ${formatAge(vessel.last_seen)}</div>
  `;

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
  cur = laplacianPass(cur, -1, 0.8); // outward: expand past data
  return cur;
}

// Centripetal Catmull-Rom spline (α=0.5): passes through every data point and
// weights tangents by √distance between points. This prevents the overshoot/zigzag
// artifacts that uniform Catmull-Rom produces when AIS points are unevenly spaced.
// Pre-smoothed so sparse/noisy AIS data produces gentle curves rather than kinks.
function catmullRomPoints(pts, samples = 12) {
  if (pts.length < 2) return pts;
  pts = preSmooth(pts);

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

function segmentsByTier(points) {
  const segments = [];
  if (points.length === 0) return segments;

  let current = { tier: points[0].tier, pts: [[points[0].lat, points[0].lon]] };
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    if (p.tier !== current.tier) {
      // carry one overlap point so segments connect visually
      current.pts.push([p.lat, p.lon]);
      segments.push(current);
      current = { tier: p.tier, pts: [[p.lat, p.lon]] };
    } else {
      current.pts.push([p.lat, p.lon]);
    }
  }
  segments.push(current);
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
        marker.setIcon(makeVesselIcon(vessel, trailHeading));
      }
    }
  }

  const color = vesselColor(vessel);
  const segments = segmentsByTier(allPoints);
  const layers = [];

  for (const seg of segments) {
    const style = TIER_STYLE[seg.tier];
    const layer = L.polyline(catmullRomPoints(seg.pts), {
      color,
      weight: style.weight,
      opacity: 0,
      className: 'vessel-trail',
      interactive: false,
    });
    layer._targetOpacity = style.opacity;
    layer.addTo(map);
    layers.push(layer);
  }

  trailLayers.set(mmsi, layers);

  requestAnimationFrame(() => {
    for (const layer of layers) {
      layer.setStyle({ opacity: layer._targetOpacity });
    }
  });
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
      if (
        prev.heading !== vessel.heading ||
        prev.vessel_type !== vessel.vessel_type ||
        prev.name !== vessel.name ||
        isMoving(prev) !== isMoving(vessel) ||
        (vessel.heading === null && isMoving(vessel) && posChanged)
      ) {
        existing.setIcon(makeVesselIcon(vessel, effectiveHeading));
      }
      existing._vessel = vessel;
      existing._effectiveHeading = effectiveHeading;
    } else {
      const marker = L.marker([vessel.lat, vessel.lon], { icon: makeVesselIcon(vessel, vessel.heading) });
      marker._vessel = vessel;
      marker._effectiveHeading = vessel.heading;
      marker.on('click', () => openSheet(marker._vessel));
      marker.addTo(map);
      markers.set(vessel.mmsi, marker);
    }
  }

  for (const [mmsi, marker] of markers) {
    if (!seen.has(mmsi)) {
      marker.remove();
      markers.delete(mmsi);
    }
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
      <div class="detail-backdrop"></div>
      <div class="detail-sheet"></div>
    </div>
  `;

  statusEl = container.querySelector('#map-status');

  container.querySelector('.detail-backdrop').addEventListener('click', closeSheet);

  map = L.map('leaflet-map', { zoomControl: true, attributionControl: true })
    .setView([HOME.lat, HOME.lon], 11);

  L.tileLayer(TILE_URL, { attribution: TILE_ATTR, maxZoom: 18 }).addTo(map);

  requestAnimationFrame(() => map !== null && map.invalidateSize());

  L.rectangle(
    [DIRECT_BOUNDING_BOX.sw, DIRECT_BOUNDING_BOX.ne],
    { color: '#17c3d4', weight: 1, opacity: 0.35, fill: false, interactive: false, dashArray: '6 4' }
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
}

export function unmount() {
  if (unsubscribeVessels !== null) { unsubscribeVessels(); unsubscribeVessels = null; }
  if (unsubscribeSettings !== null) { unsubscribeSettings(); unsubscribeSettings = null; }
  if (map !== null) { map.remove(); map = null; }
  markers.clear();
  for (const layers of trailLayers.values()) {
    for (const layer of layers) layer.remove();
  }
  trailLayers.clear();
  trailReqToken++;
  container = null;
  statusEl = null;
  lastVessels = [];
}
