import { VIEWSHEDS } from '../config.js';
import { subscribe as subscribeVessels } from './store.js';
import { subscribe as subscribeSettings, passesExtentFilter } from './settings_store.js';
import { haversineNm, haversineKm } from './geo.js';
import { vesselColor, vesselCategoryLabel } from './vessels.js';

// ── Constants ────────────────────────────────────────────────────────────────

const HOME = VIEWSHEDS[0].home;
const UNIT_KEY = 'vessel-tracker:unit';

// ── State ────────────────────────────────────────────────────────────────────

let unsubscribeVessels = null;
let unsubscribeSettings = null;
let container = null;
let unitNm = localStorage.getItem(UNIT_KEY) !== 'km';
let lastVessels = [];
let lastSettings = null;

// ── Helpers ──────────────────────────────────────────────────────────────────

function vesselIconSvg(vessel) {
  const color = vesselColor(vessel);
  return `<svg viewBox="0 0 20 20" width="18" height="18">
    <polygon points="10,1 17,17 10,13 3,17" fill="${color}" stroke="rgba(0,0,0,0.4)" stroke-width="1.5" stroke-linejoin="round"/>
  </svg>`;
}

function distanceLabel(vessel) {
  if (unitNm) {
    const d = haversineNm(HOME.lat, HOME.lon, vessel.lat, vessel.lon);
    return { value: d.toFixed(1), unit: 'nm' };
  }
  const d = haversineKm(HOME.lat, HOME.lon, vessel.lat, vessel.lon);
  return { value: d.toFixed(1), unit: 'km' };
}

// ── Render ───────────────────────────────────────────────────────────────────

function renderVessels() {
  if (container === null || lastSettings === null) return;

  const filtered = lastVessels.filter(v => passesExtentFilter(v, lastSettings.extent));

  const countEl = container.querySelector('.list-header-count');
  if (countEl !== null) countEl.textContent = `${filtered.length} vessel${filtered.length !== 1 ? 's' : ''} in view`;

  const listEl = container.querySelector('.vessel-list');
  if (listEl === null) return;

  if (filtered.length === 0) {
    listEl.innerHTML = `<div class="state-empty">No vessels currently in view</div>`;
    return;
  }

  const sorted = [...filtered].sort((a, b) => {
    const da = haversineNm(HOME.lat, HOME.lon, a.lat, a.lon);
    const db = haversineNm(HOME.lat, HOME.lon, b.lat, b.lon);
    return da - db;
  });

  listEl.innerHTML = sorted.map((v, i) => {
    const dist = distanceLabel(v);
    const category = vesselCategoryLabel(v);
    const color = vesselColor(v);
    const speed = v.speed !== null ? `${v.speed.toFixed(1)} kn` : '— kn';
    const name = v.name ?? 'Unknown Vessel';

    return `<div class="vessel-card" style="border-left-color:${color};animation-delay:${i * 30}ms" data-mmsi="${v.mmsi}">
      <div class="vessel-card-icon">${vesselIconSvg(v)}</div>
      <div class="vessel-card-body">
        <div class="vessel-card-name">${name}</div>
        <div class="vessel-card-meta">${category}${v.destination ? ' · ' + v.destination : ''}</div>
      </div>
      <div class="vessel-card-right">
        <div class="vessel-card-dist">${dist.value}<span class="unit">${dist.unit}</span></div>
        <div class="vessel-card-speed">${speed}</div>
      </div>
    </div>`;
  }).join('');
}

// ── Mount / unmount ──────────────────────────────────────────────────────────

export function mount(root) {
  container = root;

  container.innerHTML = `
    <div class="list-page">
      <div class="list-header">
        <div class="list-header-left">
          <div class="list-header-title">Vessels</div>
          <div class="list-header-count">—</div>
        </div>
        <button class="unit-toggle" id="unit-toggle">${unitNm ? 'nm' : 'km'}</button>
      </div>
      <div class="vessel-list"></div>
    </div>
  `;

  container.querySelector('#unit-toggle').addEventListener('click', () => {
    unitNm = !unitNm;
    localStorage.setItem(UNIT_KEY, unitNm ? 'nm' : 'km');
    container.querySelector('#unit-toggle').textContent = unitNm ? 'nm' : 'km';
    renderVessels();
  });

  unsubscribeVessels = subscribeVessels((vessels, error) => {
    if (error !== null) {
      console.error('[list] poll error:', error);
      const listEl = container?.querySelector('.vessel-list');
      if (listEl !== null) listEl.innerHTML = `<div class="state-error">Poll failed: ${error.message}</div>`;
      return;
    }
    lastVessels = vessels;
    renderVessels();
  });

  unsubscribeSettings = subscribeSettings(settings => {
    lastSettings = settings;
    renderVessels();
  });
}

export function unmount() {
  if (unsubscribeVessels !== null) { unsubscribeVessels(); unsubscribeVessels = null; }
  if (unsubscribeSettings !== null) { unsubscribeSettings(); unsubscribeSettings = null; }
  container = null;
  lastVessels = [];
  lastSettings = null;
}
