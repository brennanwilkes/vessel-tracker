import { VIEWSHEDS, LOCAL_BOUNDING_BOX } from '../config.js';
import { subscribe } from './store.js';
import { haversineNm } from './geo.js';
import { vesselColor, vesselCategoryLabel } from './vessels.js';

// ── Constants ────────────────────────────────────────────────────────────────

const HOME = VIEWSHEDS[0].home;

const TILE_URL = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
const TILE_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com">CARTO</a>';

// ── State (module-level, reset on each mount) ────────────────────────────────

let map = null;
let markers = new Map();
let unsubscribe = null;
let container = null;
let statusEl = null;

function makeVesselIcon(vessel) {
  const color = vesselColor(vessel);
  const rotation = vessel.heading !== null ? vessel.heading : 0;
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

  sheet.innerHTML = `
    <div class="sheet-handle"></div>
    <div class="detail-vessel-name">${vessel.name ?? 'Unknown Vessel'}</div>
    <div class="detail-type-row">
      <div class="detail-type-dot" style="background:${color}"></div>
      <div class="detail-vessel-type">${vesselCategoryLabel(vessel)}${vessel.vesselType !== null ? ` · Type ${vessel.vesselType}` : ''}</div>
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
    <div class="detail-footer">Updated ${formatAge(vessel.updated)}</div>
  `;

  backdrop.classList.add('open');
  sheet.classList.add('open');
}

function closeSheet() {
  container.querySelector('.detail-backdrop').classList.remove('open');
  container.querySelector('.detail-sheet').classList.remove('open');
}

// ── Marker management ────────────────────────────────────────────────────────

function updateMarkers(vessels, error) {
  if (error !== null) {
    console.error('[map] poll error:', error);
  }

  if (statusEl !== null) {
    statusEl.innerHTML = error !== null
      ? `<span style="color:var(--red)">⚠ ${error.message}</span>`
      : `<span class="dot"></span>${vessels.length} vessel${vessels.length !== 1 ? 's' : ''}`;
  }

  const seen = new Set();

  for (const vessel of vessels) {
    seen.add(vessel.mmsi);
    const existing = markers.get(vessel.mmsi);

    if (existing !== undefined) {
      existing.setLatLng([vessel.lat, vessel.lon]);
      // Only recreate the SVG icon when the visual actually changes
      if (existing._vessel.heading !== vessel.heading || existing._vessel.vesselType !== vessel.vesselType || existing._vessel.name !== vessel.name) {
        existing.setIcon(makeVesselIcon(vessel));
      }
      existing._vessel = vessel;
    } else {
      const marker = L.marker([vessel.lat, vessel.lon], { icon: makeVesselIcon(vessel) });
      marker._vessel = vessel;
      marker.on('click', () => openSheet(marker._vessel));
      marker.addTo(map);
      markers.set(vessel.mmsi, marker);
    }
  }

  // Remove markers for vessels no longer in the snapshot
  for (const [mmsi, marker] of markers) {
    if (!seen.has(mmsi)) {
      marker.remove();
      markers.delete(mmsi);
    }
  }
}

// ── Mount / unmount ──────────────────────────────────────────────────────────

export function mount(root) {
  container = root;

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

  // Leaflet reads container dimensions synchronously on init — defer invalidation
  // one frame so the browser has finished laying out the container.
  requestAnimationFrame(() => map !== null && map.invalidateSize());

  L.rectangle(
    [LOCAL_BOUNDING_BOX.sw, LOCAL_BOUNDING_BOX.ne],
    { color: '#17c3d4', weight: 1, opacity: 0.35, fill: true, fillOpacity: 0.04, interactive: false, dashArray: '6 4' }
  ).addTo(map);

  const homeIcon = L.divIcon({
    html: `<div class="home-pulse-outer"><div class="home-pulse-inner"></div></div>`,
    className: '',
    iconSize: [40, 40],
    iconAnchor: [20, 20],
  });
  L.marker([HOME.lat, HOME.lon], { icon: homeIcon, interactive: false }).addTo(map);

  unsubscribe = subscribe(updateMarkers);
}

export function unmount() {
  if (unsubscribe !== null) { unsubscribe(); unsubscribe = null; }
  if (map !== null) { map.remove(); map = null; }
  markers.clear();
  container = null;
  statusEl = null;
}
