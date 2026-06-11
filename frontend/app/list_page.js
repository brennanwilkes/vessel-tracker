import { VIEWSHEDS, MOVING_SPEED_KN } from '../config.js';
import { subscribe as subscribeVessels } from './store.js';
import { subscribe as subscribeSettings, passesExtentFilter, passesVesselTypeFilter, getSettings, setSort } from './settings_store.js';
import { haversineNm, haversineKm } from './geo.js';
import { vesselColor, vesselCategoryLabel, vesselFlag, vesselCountryCode } from './vessels.js';
import { setHighlight } from './highlight_store.js';

// ── Constants ────────────────────────────────────────────────────────────────

const HOME = VIEWSHEDS[0].home;

// ── State ────────────────────────────────────────────────────────────────────

let unsubscribeVessels = null;
let unsubscribeSettings = null;
let container = null;
let clickHandler = null;
let lastVessels = [];
let lastSettings = null;

// ── Helpers ──────────────────────────────────────────────────────────────────

function vesselIconSvg(vessel) {
  const color = vesselColor(vessel);
  const moving = vessel.speed !== null && vessel.speed > MOVING_SPEED_KN;
  if (!moving) {
    return `<svg viewBox="0 0 20 20" width="18" height="18">
      <circle cx="10" cy="10" r="5" fill="${color}" stroke="rgba(0,0,0,0.4)" stroke-width="1.5"/>
    </svg>`;
  }
  return `<svg viewBox="0 0 20 20" width="18" height="18">
    <polygon points="10,1 17,17 10,13 3,17" fill="${color}" stroke="rgba(0,0,0,0.4)" stroke-width="1.5" stroke-linejoin="round"/>
  </svg>`;
}

function distanceLabel(vessel) {
  const unitNm = getSettings().unitNm;
  if (unitNm) {
    const d = haversineNm(HOME.lat, HOME.lon, vessel.lat, vessel.lon);
    return { value: d.toFixed(1), unit: 'nm' };
  }
  const d = haversineKm(HOME.lat, HOME.lon, vessel.lat, vessel.lon);
  return { value: d.toFixed(1), unit: 'km' };
}

// ── Sort helpers ─────────────────────────────────────────────────────────────

const SORT_FUNCS = {
  name:        v => (v.name ?? 'Unknown Vessel').toLowerCase(),
  country:     v => vesselCountryCode(v) ?? '',
  distance:    v => haversineNm(HOME.lat, HOME.lon, v.lat, v.lon),
  speed:       v => v.speed ?? -1,
  vessel_type: v => vesselCategoryLabel(v),
};

function makeSortComparator(field, dir) {
  const fn = SORT_FUNCS[field];
  if (dir === 'asc') {
    return (a, b) => {
      const va = fn(a);
      const vb = fn(b);
      if (va === null || va === undefined) return 1;
      if (vb === null || vb === undefined) return -1;
      if (va < vb) return -1;
      if (va > vb) return 1;
      return 0;
    };
  }
  return (a, b) => {
    const va = fn(a);
    const vb = fn(b);
    if (va === null || va === undefined) return 1;
    if (vb === null || vb === undefined) return -1;
    if (va > vb) return -1;
    if (va < vb) return 1;
    return 0;
  };
}

function sortDirIcon(dir) {
  return dir === 'asc' ? '↑' : '↓';
}

// ── Render ───────────────────────────────────────────────────────────────────

function renderVessels() {
  if (container === null || lastSettings === null) return;

  const filtered = lastVessels.filter(v =>
    passesExtentFilter(v, lastSettings.extent) &&
    passesVesselTypeFilter(v, lastSettings.vesselType)
  );

  const countEl = container.querySelector('.list-header-count');
  if (countEl !== null) countEl.textContent = `${filtered.length} vessel${filtered.length !== 1 ? 's' : ''} in view`;

  const listEl = container.querySelector('.vessel-list');
  if (listEl === null) return;

  if (filtered.length === 0) {
    listEl.innerHTML = `<div class="state-empty">No vessels currently in view</div>`;
    return;
  }

  const comparator = makeSortComparator(lastSettings.sortField, lastSettings.sortDir);
  const sorted = [...filtered].sort(comparator);

  listEl.innerHTML = sorted.map((v, i) => {
    const dist = distanceLabel(v);
    const category = vesselCategoryLabel(v);
    const color = vesselColor(v);
    const flag = vesselFlag(v);
    const speed = v.speed !== null ? `${v.speed.toFixed(1)} kn` : '— kn';
    const name = v.name ?? 'Unknown Vessel';

    return `<div class="vessel-card" style="border-left-color:${color};animation-delay:${i * 30}ms" data-mmsi="${v.mmsi}">
      <div class="vessel-card-icon">${vesselIconSvg(v)}</div>
      <div class="vessel-card-body">
        <div class="vessel-card-name">${flag !== null ? flag + ' ' : ''}${name}</div>
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

  const sortField = getSettings().sortField;
  const sortDir = getSettings().sortDir;

  container.innerHTML = `
    <div class="list-page">
      <div class="list-header">
        <div class="list-header-left">
          <div class="list-header-title">Vessels</div>
          <div class="list-header-count">—</div>
        </div>
        <div class="list-header-right">
          <select class="sort-select" aria-label="Sort by">
            <option value="name" ${sortField === 'name' ? 'selected' : ''}>Name</option>
            <option value="country" ${sortField === 'country' ? 'selected' : ''}>Country</option>
            <option value="distance" ${sortField === 'distance' ? 'selected' : ''}>Distance</option>
            <option value="speed" ${sortField === 'speed' ? 'selected' : ''}>Speed</option>
            <option value="vessel_type" ${sortField === 'vessel_type' ? 'selected' : ''}>Type</option>
          </select>
          <button class="sort-dir-btn" aria-label="Toggle sort direction">${sortDirIcon(sortDir)}</button>
        </div>
      </div>
      <div class="vessel-list"></div>
    </div>
  `;

  clickHandler = e => {
    const card = e.target.closest('.vessel-card');
    if (card === null) return;
    const mmsi = Number(card.dataset.mmsi);
    setHighlight(mmsi);
    location.hash = 'map';
  };
  container.addEventListener('click', clickHandler);

  const selectEl = container.querySelector('.sort-select');
  const dirBtn = container.querySelector('.sort-dir-btn');

  selectEl.addEventListener('change', () => {
    setSort(selectEl.value, getSettings().sortDir);
  });

  dirBtn.addEventListener('click', () => {
    const current = getSettings().sortDir;
    const next = current === 'asc' ? 'desc' : 'asc';
    setSort(getSettings().sortField, next);
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
    const selectEl = container?.querySelector('.sort-select');
    const dirBtn = container?.querySelector('.sort-dir-btn');
    if (selectEl !== null && selectEl.value !== settings.sortField) {
      selectEl.value = settings.sortField;
    }
    if (dirBtn !== null) {
      dirBtn.textContent = sortDirIcon(settings.sortDir);
    }
    renderVessels();
  });
}

export function unmount() {
  if (unsubscribeVessels !== null) { unsubscribeVessels(); unsubscribeVessels = null; }
  if (unsubscribeSettings !== null) { unsubscribeSettings(); unsubscribeSettings = null; }
  if (clickHandler !== null) { container?.removeEventListener('click', clickHandler); clickHandler = null; }
  container = null;
  lastVessels = [];
  lastSettings = null;
}
