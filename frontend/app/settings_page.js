import { EXTENTS, VESSEL_TYPE_KEYS } from '../config.js';
import { subscribe, getSettings, setExtentFilter, setTrailFilter, setVesselTypeFilter, setUnitNm } from './settings_store.js';
import { CATEGORY_LABELS, CATEGORY_COLORS } from './vessels.js';

const JOURNEY_LABELS = {
  local_boat:       'Local Boats',
  passing_through:  'Vessels Passing Through',
  distant_visitor:  'Distant Visitors',
};

let container = null;
let unsubscribe = null;
let clickHandler = null;

function renderToggles() {
  if (container === null) return;
  const settings = getSettings();

  container.querySelectorAll('.settings-toggle').forEach(btn => {
    const section = btn.dataset.section;
    const tier = btn.dataset.tier;
    let on;
    if (section === 'extent') on = settings.extent[tier];
    else if (section === 'trail') on = settings.trail[tier];
    else if (section === 'vessel-type') on = settings.vesselType[tier];
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-checked', String(on));
  });

  container.querySelectorAll('.unit-option').forEach(btn => {
    btn.classList.toggle('active', (btn.dataset.unit === 'nm') === settings.unitNm);
  });
}

function buildHTML() {
  const settings = getSettings();

  const extentRows = EXTENTS.map(cat => {
    const on = settings.extent[cat];
    return `<button class="settings-toggle${on ? ' on' : ''}" data-section="extent" data-tier="${cat}" role="switch" aria-checked="${on}">
      <span class="toggle-label">${JOURNEY_LABELS[cat]}</span>
      <span class="toggle-track"><span class="toggle-thumb"></span></span>
    </button>`;
  }).join('');

  const trailRows = EXTENTS.map(cat => {
    const on = settings.trail[cat];
    return `<button class="settings-toggle${on ? ' on' : ''}" data-section="trail" data-tier="${cat}" role="switch" aria-checked="${on}">
      <span class="toggle-label">${JOURNEY_LABELS[cat]}</span>
      <span class="toggle-track"><span class="toggle-thumb"></span></span>
    </button>`;
  }).join('');

  const vesselTypeRows = VESSEL_TYPE_KEYS.map(cat => {
    const on = settings.vesselType[cat];
    const color = CATEGORY_COLORS[cat];
    return `<button class="settings-toggle${on ? ' on' : ''}" data-section="vessel-type" data-tier="${cat}" role="switch" aria-checked="${on}">
      <span class="toggle-left">
        <span class="category-dot" style="background:${color}"></span>
        <span class="toggle-label">${CATEGORY_LABELS[cat]}</span>
      </span>
      <span class="toggle-track"><span class="toggle-thumb"></span></span>
    </button>`;
  }).join('');

  const unitNm = settings.unitNm;

  return `
    <div class="settings-page">
      <div class="settings-header">Settings</div>

      <div class="settings-card">
        <div class="settings-card-row">
          <div class="settings-card-title">Distance Unit</div>
          <div class="unit-selector">
            <button class="unit-option${unitNm ? ' active' : ''}" data-unit="nm">NM</button>
            <button class="unit-option${unitNm ? '' : ' active'}" data-unit="km">KM</button>
          </div>
        </div>
      </div>

      <div class="settings-card">
        <div class="settings-card-title">Vessel Journey Type</div>
        <div class="settings-card-hint">Local Boats: never left direct view, or re-entered 3+ times. Passing Through: seen outside direct view but not a regular. Distant Visitors: tracked globally.</div>
        <div class="settings-toggles">${extentRows}</div>
      </div>

      <div class="settings-card">
        <div class="settings-card-title">Show Trails For</div>
        <div class="settings-toggles">${trailRows}</div>
      </div>

      <div class="settings-card">
        <div class="settings-card-title">Vessel Type</div>
        <div class="settings-card-hint">Filter which vessel types appear on the map and list.</div>
        <div class="settings-toggles">${vesselTypeRows}</div>
      </div>
    </div>
  `;
}

export function mount(root) {
  container = root;
  container.innerHTML = buildHTML();

  clickHandler = e => {
    const toggle = e.target.closest('.settings-toggle');
    if (toggle !== null) {
      const section = toggle.dataset.section;
      const tier = toggle.dataset.tier;
      const currentlyOn = toggle.classList.contains('on');
      if (section === 'extent') {
        setExtentFilter(tier, !currentlyOn);
      } else if (section === 'trail') {
        setTrailFilter(tier, !currentlyOn);
      } else if (section === 'vessel-type') {
        setVesselTypeFilter(tier, !currentlyOn);
      }
      return;
    }

    const unitBtn = e.target.closest('.unit-option');
    if (unitBtn !== null) {
      setUnitNm(unitBtn.dataset.unit === 'nm');
    }
  };
  container.addEventListener('click', clickHandler);

  unsubscribe = subscribe(() => renderToggles());
}

export function unmount() {
  if (unsubscribe !== null) { unsubscribe(); unsubscribe = null; }
  if (clickHandler !== null) { container.removeEventListener('click', clickHandler); clickHandler = null; }
  container = null;
}
