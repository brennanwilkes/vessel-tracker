import { VIEWSHEDS, DIRECT_BOUNDING_BOX, LOCAL_BOUNDING_BOX, MOVING_SPEED_KN, TIER_STYLE, LIVE_TTL_MS, FADE_TTL_MS, LAND_AVOIDANCE } from '../config.js';
import { subscribe as subscribeVessels } from './store.js';
import { subscribe as subscribeSettings, getSettings, passesExtentFilter, passesVesselTypeFilter, vesselCategory } from './settings_store.js';
import { haversineNm, bearingDeg } from './geo.js';
import { vesselColor, vesselCategoryLabel, vesselFlag } from './vessels.js';
import { getTrail, pruneTrails } from './trails.js';
import { subscribe as subscribeHighlight, getHighlight, setHighlight, clearHighlight } from './highlight_store.js';
import { computeRuns, gapEnrichmentScore } from './trail_geometry.js';
import { ensureRegionsForExtent, extentOf } from './region_coast.js';

// ── Constants ────────────────────────────────────────────────────────────────

const HOME = VIEWSHEDS[0].home;

const TILE_URL = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
const TILE_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com">CARTO</a>';

// ── State (module-level, reset on each mount) ────────────────────────────────

let map = null;
let markers = new Map();
let trailLayers = new Map();   // mmsi → [L.polyline, ...]
let trailGeom = new Map();     // mmsi → { sig, runs } — cached spline geometry (the A*/spline work)
let trailWorker = null;        // Web Worker running the routed geometry off the main thread
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

// The expensive routed geometry (A* + repair) runs OFF the main thread in a Web
// Worker so the map never freezes. First paint is instant straight bridges
// (inline); routed curves stream back and replace them. Pending trails form a
// priority queue processed one at a time, WORST-FIRST — the ships whose straight
// bridges cross the most land (gapEnrichmentScore) get their real curves first,
// so the most-wrong trails self-correct soonest. If the Worker can't start (old
// browser / file://), the same queue runs inline via setTimeout (brief jank, no
// freeze).
let pendingRoute = new Map(); // mmsi → { allPoints, sig, bounds, score } (latest wins)
let routeInFlight = false;

// Cache a routed result and redraw the vessel if its trail is still on screen.
function applyRoutedRuns(mmsi, sig, bounds, runs) {
  trailGeom.set(mmsi, { sig, runs });
  const live = lastVessels.find(v => v.mmsi === mmsi);
  if (live !== undefined && trailLayers.has(mmsi)) drawRuns(live, runs, bounds);
}

function startTrailWorker() {
  try {
    const w = new Worker(new URL('./trail_worker.js', import.meta.url), { type: 'module' });
    w.onmessage = (e) => {
      const { mmsi, sig, bounds, runs } = e.data;
      if (runs) {
        const cached = trailGeom.get(mmsi);
        if (cached === undefined || cached.sig !== sig) applyRoutedRuns(mmsi, sig, bounds, runs);
      }
      routeInFlight = false;
      pumpRoute();
    };
    w.onerror = () => { trailWorker = null; routeInFlight = false; pumpRoute(); };
    return w;
  } catch {
    return null;
  }
}

function requestRoutedRuns(mmsi, allPoints, sig, bounds, vesselLength) {
  pendingRoute.set(mmsi, { allPoints, sig, bounds, vesselLength, score: gapEnrichmentScore(allPoints) });
  pumpRoute();
}

function pumpRoute() {
  if (routeInFlight || map === null || pendingRoute.size === 0) return;
  // Pick the worst (highest enrichment score) pending trail.
  let pickMmsi = null, pickJob = null, best = -Infinity;
  for (const [mmsi, job] of pendingRoute) if (job.score > best) { best = job.score; pickMmsi = mmsi; pickJob = job; }
  pendingRoute.delete(pickMmsi);
  const cached = trailGeom.get(pickMmsi);
  if (cached !== undefined && cached.sig === pickJob.sig) { pumpRoute(); return; } // already routed
  routeInFlight = true;
  if (trailWorker !== null) {
    trailWorker.postMessage({ mmsi: pickMmsi, allPoints: pickJob.allPoints, sig: pickJob.sig, bounds: pickJob.bounds, vesselLength: pickJob.vesselLength });
  } else {
    setTimeout(async () => {
      await ensureRegionsForExtent(extentOf(pickJob.allPoints)); // load any foreign region this trail reaches
      applyRoutedRuns(pickMmsi, pickJob.sig, pickJob.bounds, computeRuns(pickJob.allPoints, true, { vesselLength: pickJob.vesselLength }));
      routeInFlight = false;
      pumpRoute();
    }, 0);
  }
}

function drawTrail(vessel, points, token) {
  if (token !== trailReqToken) return;
  if (map === null) return;

  const mmsi = vessel.mmsi;
  if (points.length === 0) { removeTrailLayers(mmsi); return; }

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

  const lastPt = allPoints[allPoints.length - 1];
  const bounds = { t0: allPoints[0].t, t1: lastPt.t };
  const sig = `${allPoints.length}|${allPoints[0].t}|${lastPt.t}|${lastPt.lat},${lastPt.lon}`;

  // Full routed geometry is cached per vessel keyed on trail content, and the
  // expensive A* depends only on the points (not highlight/fade). Cache hit →
  // draw the curves immediately. Cache miss → paint instant straight bridges
  // now and queue the routing to fill in.
  const cached = trailGeom.get(mmsi);
  if (cached !== undefined && cached.sig === sig) {
    drawRuns(vessel, cached.runs, bounds);
    return;
  }
  drawRuns(vessel, computeRuns(allPoints, false), bounds);
  requestRoutedRuns(mmsi, allPoints, sig, bounds, vessel.length);
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
  for (const mmsi of pendingRoute.keys()) if (!liveSet.has(mmsi)) pendingRoute.delete(mmsi);

  const TRAIL_TIERS = ['direct', 'local'];

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

  trailWorker = startTrailWorker();

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
  // Smooth radial + angular gradients drawn on a canvas, re-rendered on every
  // map move/zoom. Canvas `createRadialGradient` avoids banding entirely.

  const OBST_MAX_KM = 30;
  const OBST_STRIPS = 80;

  const obstCanvas = L.DomUtil.create('canvas', '');
  obstCanvas.style.cssText = 'position:absolute;pointer-events:none;z-index:350';
  map.getContainer().appendChild(obstCanvas);

  function obstDest(lat, lon, brgDeg, distKm) {
    const brg = brgDeg * Math.PI / 180;
    const d = distKm / 6371;
    const l1 = lat * Math.PI / 180;
    const l2 = Math.asin(Math.sin(l1) * Math.cos(d) + Math.cos(l1) * Math.sin(d) * Math.cos(brg));
    const lo = lon * Math.PI / 180 + Math.atan2(Math.sin(brg) * Math.sin(d) * Math.cos(l1), Math.cos(d) - Math.sin(l1) * Math.sin(l2));
    return [l2 * 180 / Math.PI, lo * 180 / Math.PI];
  }

  function drawObstructions() {
    const size = map.getSize();
    const homePx = map.latLngToContainerPoint([HOME.lat, HOME.lon]);
    const margin = Math.max(size.x, size.y);
    const w = margin * 2, h = margin * 2;
    obstCanvas.width = w;
    obstCanvas.height = h;
    obstCanvas.style.left = (homePx.x - margin) + 'px';
    obstCanvas.style.top = (homePx.y - margin) + 'px';
    obstCanvas.style.width = w + 'px';
    obstCanvas.style.height = h + 'px';
    const ctx = obstCanvas.getContext('2d');
    if (!ctx) return;

    const refPx = map.latLngToContainerPoint(obstDest(HOME.lat, HOME.lon, 0, OBST_MAX_KM));
    const outerPx = Math.min(Math.hypot(refPx.x - homePx.x, refPx.y - homePx.y), margin);
    const dx = homePx.x - margin, dy = homePx.y - margin;
    const toC = (p) => ({ x: p.x - dx, y: p.y - dy });
    const hc = toC(homePx);

    function drawSector(startBrg, endBrg, maxOpacity, fadeAngle) {
      if (fadeAngle > 0) {
        const fadeDeg = Math.min(fadeAngle, endBrg - startBrg);
        const solidStart = endBrg - fadeDeg;
        const degPerStrip = fadeDeg / OBST_STRIPS;
        for (let i = 0; i < OBST_STRIPS; i++) {
          const a = solidStart + degPerStrip * i;
          const b = solidStart + degPerStrip * (i + 1);
          const fadeMul = (i + 0.5) / OBST_STRIPS;
          const grad = ctx.createRadialGradient(hc.x, hc.y, 0, hc.x, hc.y, outerPx);
          grad.addColorStop(0, `rgba(0,0,0,${(maxOpacity * fadeMul).toFixed(3)})`);
          grad.addColorStop(1, 'rgba(0,0,0,0)');
          const p1 = toC(map.latLngToContainerPoint(obstDest(HOME.lat, HOME.lon, a, OBST_MAX_KM)));
          const p2 = toC(map.latLngToContainerPoint(obstDest(HOME.lat, HOME.lon, b, OBST_MAX_KM)));
          ctx.beginPath();
          ctx.moveTo(hc.x, hc.y);
          ctx.lineTo(p1.x, p1.y);
          ctx.lineTo(p2.x, p2.y);
          ctx.closePath();
          ctx.fillStyle = grad;
          ctx.fill();
        }
      } else {
        const grad = ctx.createRadialGradient(hc.x, hc.y, 0, hc.x, hc.y, outerPx);
        grad.addColorStop(0, `rgba(0,0,0,${maxOpacity.toFixed(3)})`);
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        const p1 = toC(map.latLngToContainerPoint(obstDest(HOME.lat, HOME.lon, startBrg, OBST_MAX_KM)));
        const p2 = toC(map.latLngToContainerPoint(obstDest(HOME.lat, HOME.lon, endBrg, OBST_MAX_KM)));
        ctx.beginPath();
        ctx.moveTo(hc.x, hc.y);
        ctx.lineTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();
      }
    }

    drawSector(0, 141.07, 0.5, 25);
    drawSector(153.66, 162.38, 0.5, 0);
    drawSector(183.26, 204.86, 0.5, 0);
  }

  map.on('moveend', drawObstructions);
  map.on('zoomend', drawObstructions);
  map.on('resize', drawObstructions);
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
  pendingRoute.clear();
  routeInFlight = false;
  if (trailWorker !== null) { trailWorker.terminate(); trailWorker = null; }
  trailReqToken++;
  container = null;
  statusEl = null;
  resetBtn = null;
  highlightedMmsi = null;
  lastVessels = [];
}
