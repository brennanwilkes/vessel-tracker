import { VIEWSHEDS, DIRECT_BOUNDING_BOX, LOCAL_BOUNDING_BOX, MOVING_SPEED_KN, TIER_STYLE, LIVE_TTL_MS, FADE_TTL_MS, LAND_AVOIDANCE } from '../config.js';
import { subscribe as subscribeVessels } from './store.js';
import { subscribe as subscribeSettings, getSettings, passesExtentFilter, passesVesselTypeFilter, vesselCategory } from './settings_store.js';
import { haversineNm, bearingDeg } from './geo.js';
import { vesselColor, vesselCategoryLabel, vesselFlag } from './vessels.js';
import { getTrail, pruneTrails } from './trails.js';
import { subscribe as subscribeHighlight, getHighlight, setHighlight, clearHighlight } from './highlight_store.js';
// Pure spline pipeline only — NO coastline/A* in the browser. The trail's
// inferred (A*-routed) waypoints are precomputed server-side and arrive inline
// in /track (flagged `fake`/`dashed`); the client just splines the union.
import { dedup, splitJourneys, catmullRom, runsBySynthetic } from './trail_spline.js';

// ── Constants ────────────────────────────────────────────────────────────────

const HOME = VIEWSHEDS[0].home;

const TILE_URL = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
const TILE_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com">CARTO</a>';

// ── State (module-level, reset on each mount) ────────────────────────────────

let map = null;
let markers = new Map();
let trailLayers = new Map();   // mmsi → [L.polyline, ...]
let trailGeom = new Map();     // mmsi → { sig, runs } — cached spline geometry (cheap re-style)
let unsubscribeVessels = null;
let unsubscribeSettings = null;
let unsubscribeHighlight = null;
let container = null;
let statusEl = null;
let resetBtn = null;
let highlightedMmsi = null;
let keydownHandler = null;
let lastVessels = [];
let lastSettings = getSettings();
let trailReqToken = 0;

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

function removeTrailLayers(mmsi) {
  const layers = trailLayers.get(mmsi);
  if (layers !== undefined) {
    for (const layer of layers) layer.remove();
    trailLayers.delete(mmsi);
  }
}

// Render precomputed runs for a vessel (cheap — styling only). Re-reads current
// highlight/fade so deferred redraws pick up the latest state.
function drawRuns(vessel, runs, bounds) {
  const mmsi = vessel.mmsi;
  removeTrailLayers(mmsi);
  const isHighlighted = mmsi === highlightedMmsi;
  const color = vesselColor(vessel);
  const trailFade = isHighlighted ? 1.0 : markerOpacity(vessel);
  const trailBounds = isHighlighted ? 'flat' : bounds;
  const style = isHighlighted ? { opacity: 1.0, weight: 3 } : TIER_STYLE.direct;
  const layers = [];
  for (const run of runs) {
    const opacityMul = run.synthetic ? LAND_AVOIDANCE.fadeRatio : 1;
    const runLayers = makeFadePolylines(
      run.samples, color, style.weight, style.opacity * opacityMul * trailFade,
      trailBounds, run.synthetic ? LAND_AVOIDANCE.dashArray : null
    );
    for (const layer of runLayers) { layer.addTo(map); layers.push(layer); }
  }
  trailLayers.set(mmsi, layers);
}

// Spline the combined real+inferred point stream into styled runs — PURE, no
// coastline, no A*. The server already routed every land-crossing gap and the
// fakes arrive inline (flagged `fake`/`dashed`); a gap not yet precomputed has
// no fakes, so it simply bridges straight (the fast "good-enough" fallback).
function clientRuns(allPoints) {
  const ctrl = allPoints.map(p => ({
    lat: p.lat, lon: p.lon, t: p.t, speed: p.speed, tier: p.tier,
    fake: p.fake === true, synthetic: p.dashed === 1,
  }));
  const runs = [];
  for (const journey of splitJourneys(dedup(ctrl))) {
    if (journey.length < 2) continue;
    for (const run of runsBySynthetic(catmullRom(journey))) {
      if (run.samples.length >= 2) runs.push(run);
    }
  }
  return runs;
}

function drawTrail(vessel, points, token) {
  if (token !== trailReqToken) return;
  if (map === null) return;

  const mmsi = vessel.mmsi;
  if (points.length === 0) { removeTrailLayers(mmsi); return; }

  // API returns points newest-first; reverse to chronological order for drawing.
  const chronological = [...points].reverse();

  // Extend to the vessel's current position so the trail is always live. The
  // newest point is always a real fix (inferred points sit between reals).
  const last = chronological[chronological.length - 1];
  const allPoints = (last.lat === vessel.lat && last.lon === vessel.lon)
    ? chronological
    : [...chronological, { ...last, lat: vessel.lat, lon: vessel.lon, fake: false, dashed: 0 }];

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

  const lastPt = allPoints[allPoints.length - 1];
  const bounds = { t0: allPoints[0].t, t1: lastPt.t };
  const sig = `${allPoints.length}|${allPoints[0].t}|${lastPt.t}|${lastPt.lat},${lastPt.lon}`;

  // Spline geometry depends only on the points, not highlight/fade — cache it per
  // vessel so re-styling on poll/highlight/settings stays cheap. The spline is
  // pure now (server did the A*), so a miss computes inline without freezing.
  const cached = trailGeom.get(mmsi);
  const runs = (cached !== undefined && cached.sig === sig) ? cached.runs : clientRuns(allPoints);
  if (cached === undefined || cached.sig !== sig) trailGeom.set(mmsi, { sig, runs });
  drawRuns(vessel, runs, bounds);
}

async function scheduleTrails(visibleVessels, token) {
  const liveSet = new Set(visibleVessels.map(v => v.mmsi));
  pruneTrails(liveSet);

  // Remove trail layers + cached geometry for vessels no longer visible
  for (const mmsi of trailLayers.keys()) {
    if (!liveSet.has(mmsi)) removeTrailLayers(mmsi);
  }
  for (const mmsi of trailGeom.keys()) {
    if (!liveSet.has(mmsi)) trailGeom.delete(mmsi);
  }

  // Fetch ALL tiers so a far-ranging vessel's full journey renders as one
  // continuous routed path (the long coastal/global legs are A*-routed by the
  // precompute and dashed). Without global, the client would bridge straight
  // from the last local fix to a distant current position — cutting across land.
  const TRAIL_TIERS = ['direct', 'local', 'global'];

  for (const vessel of visibleVessels) {
    if (token !== trailReqToken) break;
    if (!lastSettings.trail[vesselCategory(vessel)]) continue;
    if (!passesVesselTypeFilter(vessel, lastSettings.vesselType)) continue;
    getTrail(vessel.mmsi, TRAIL_TIERS).then(points => drawTrail(vessel, points, token));
  }
}

// ── Marker management ────────────────────────────────────────────────────────

function render() {
  if (map === null || container === null) return;

  const vessels = lastVessels;
  const settings = lastSettings;
  const error = null; // error is handled by status chip only

  const filtered = vessels.filter(v =>
    passesExtentFilter(v, settings.extent) &&
    passesVesselTypeFilter(v, settings.vesselType)
  );

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

  keydownHandler = e => {
    if (e.key === 'Escape' && highlightedMmsi !== null) {
      clearHighlight();
      closeSheet();
    }
  };
  document.addEventListener('keydown', keydownHandler);

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

  // ── Viewshed obstructions (canvas overlay) ──────────────────────────────────
  // Dark sectors radiating from HOME where terrain/building blocks the view.
  // Each sector: opaque at home, fades radially to transparent at OBST_MAX_KM.
  // View obstructions (bearings from HOME):
  //   1. East block: 0°→141.07° — firm edge at 141.07°, fades out over the 25° before it
  //   2. 153.66°→162.38° — firm edges
  //   3. 183.26°→204.86° — firm edges

  const OBST_MAX_KM = 30;
  const OBST_MAX_OPACITY = 0.55;
  const OBST_FADE_STRIPS = 60;

  // Canvas lives in overlayPane so Leaflet's CSS zoom/pan transforms carry it
  // along with markers and polylines automatically. Drawing uses layer coordinates
  // (latLngToLayerPoint) so the canvas origin stays anchored to the map, not the
  // viewport — then we position the canvas element itself to cover the viewport.
  const obstCanvas = L.DomUtil.create('canvas', 'leaflet-zoom-animated');
  obstCanvas.style.cssText = 'position:absolute;pointer-events:none';
  map.getPanes().overlayPane.appendChild(obstCanvas);

  // State stored at draw time — used by zoomanim to replicate L.Renderer._updateTransform.
  let _drawnZoom = null, _drawnCenter = null, _drawnTopLeft = null;

  function drawObstructions() {
    const size = map.getSize();
    // Anchor canvas at the viewport's top-left in layer space so it covers the viewport.
    const topLeft = map.containerPointToLayerPoint(L.point(0, 0));
    L.DomUtil.setPosition(obstCanvas, topLeft);
    obstCanvas.width  = size.x;
    obstCanvas.height = size.y;
    const ctx = obstCanvas.getContext('2d');
    if (!ctx) return;

    _drawnZoom   = map.getZoom();
    _drawnCenter = map.getCenter();
    _drawnTopLeft = topLeft;

    // Layer coords are stable during CSS pan/zoom animations; subtract topLeft
    // to get canvas-local pixel coordinates.
    const homeLayer = map.latLngToLayerPoint([HOME.lat, HOME.lon]);
    const homePx = L.point(homeLayer.x - topLeft.x, homeLayer.y - topLeft.y);
    const mPerPx  = 156543.03392 * Math.cos(HOME.lat * Math.PI / 180) / Math.pow(2, map.getZoom());
    const outerPx = (OBST_MAX_KM * 1000) / mPerPx;

    // Geographic bearing (N=0, clockwise) → canvas angle (E=0, clockwise, radians).
    const toCanvas = brg => (brg - 90) * Math.PI / 180;

    function fillArc(startBrg, endBrg, opacity) {
      const grad = ctx.createRadialGradient(homePx.x, homePx.y, 0, homePx.x, homePx.y, outerPx);
      grad.addColorStop(0,   `rgba(0,0,0,${opacity.toFixed(3)})`);
      grad.addColorStop(1,   'rgba(0,0,0,0)');
      ctx.beginPath();
      ctx.moveTo(homePx.x, homePx.y);
      ctx.arc(homePx.x, homePx.y, outerPx, toCanvas(startBrg), toCanvas(endBrg));
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
    }

    // Draw a sector with optional angular fades on either edge.
    // fadeLeft:  degrees at startBrg side — opacity ramps 0 → MAX going CW.
    // fadeRight: degrees at endBrg side   — opacity ramps MAX → 0 going CW.
    function drawSector(startBrg, endBrg, fadeLeft = 0, fadeRight = 0) {
      const solidStart = startBrg + fadeLeft;
      const solidEnd   = endBrg   - fadeRight;
      if (solidStart < solidEnd) fillArc(solidStart, solidEnd, OBST_MAX_OPACITY);
      if (fadeLeft > 0) {
        const step = fadeLeft / OBST_FADE_STRIPS;
        for (let i = 0; i < OBST_FADE_STRIPS; i++) {
          fillArc(
            startBrg + step * i,
            startBrg + step * (i + 1),
            OBST_MAX_OPACITY * ((i + 0.5) / OBST_FADE_STRIPS),
          );
        }
      }
      if (fadeRight > 0) {
        const step = fadeRight / OBST_FADE_STRIPS;
        for (let i = 0; i < OBST_FADE_STRIPS; i++) {
          fillArc(
            solidEnd + step * i,
            solidEnd + step * (i + 1),
            OBST_MAX_OPACITY * (1 - (i + 0.5) / OBST_FADE_STRIPS),
          );
        }
      }
    }

    // East block: fades in from 0°→25° (CCW edge), then solid to the firm edge at 141.07°.
    drawSector(0, 141.07, 25, 0);
    // Obstructions with firm edges on both sides.
    drawSector(153.66, 162.38);
    drawSector(183.26, 204.86);
  }

  // Leaflet only CSS-scales tilePane during zoom animation — overlayPane does
  // NOT scale automatically. Mirror L.Renderer._updateTransform exactly: scale
  // relative to the zoom at last draw, then shift for any center change.
  // Exact mirror of L.Renderer._updateTransform (no padding). zoomanim fires once
  // at animation start; leaflet-zoom-animated CSS class makes the transform change
  // transition smoothly (0.25s) in sync with the tile pane — same as SVG trails.
  map.on('zoomanim', e => {
    if (_drawnZoom === null) return;
    const scale              = map.getZoomScale(e.zoom, _drawnZoom);
    const viewHalf           = map.getSize().multiplyBy(0.5);
    const currentCenterPoint = map.project(_drawnCenter, e.zoom);
    const topLeftOffset      = viewHalf.multiplyBy(-scale)
      .add(currentCenterPoint)
      .subtract(map._getNewPixelOrigin(e.center, e.zoom));
    L.DomUtil.setTransform(obstCanvas, topLeftOffset, scale);
  });
  // After zoom/pan settles, reset the animated transform and redraw at correct coords.
  map.on('moveend', drawObstructions);
  map.on('zoomend', drawObstructions);
  map.on('resize',  drawObstructions);
  drawObstructions();

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
  if (keydownHandler !== null) { document.removeEventListener('keydown', keydownHandler); keydownHandler = null; }
  if (map !== null) { map.remove(); map = null; }
  markers.clear();
  for (const layers of trailLayers.values()) {
    for (const layer of layers) layer.remove();
  }
  trailLayers.clear();
  trailGeom.clear();
  trailReqToken++;
  container = null;
  statusEl = null;
  resetBtn = null;
  highlightedMmsi = null;
  lastVessels = [];
}
