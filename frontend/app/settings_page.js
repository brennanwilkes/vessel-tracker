import { EXTENTS } from '../config.js';
import { subscribe, getSettings, setExtentFilter, setTrailFilter } from './settings_store.js';

const CATEGORY_LABELS = {
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
    const on = section === 'extent' ? settings.extent[tier] : settings.trail[tier];
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-checked', String(on));
  });
}

function buildHTML() {
  const settings = getSettings();

  const extentRows = EXTENTS.map(cat => {
    const on = settings.extent[cat];
    return `<button class="settings-toggle${on ? ' on' : ''}" data-section="extent" data-tier="${cat}" role="switch" aria-checked="${on}">
      <span class="toggle-label">${CATEGORY_LABELS[cat]}</span>
      <span class="toggle-track"><span class="toggle-thumb"></span></span>
    </button>`;
  }).join('');

  const trailRows = EXTENTS.map(cat => {
    const on = settings.trail[cat];
    return `<button class="settings-toggle${on ? ' on' : ''}" data-section="trail" data-tier="${cat}" role="switch" aria-checked="${on}">
      <span class="toggle-label">${CATEGORY_LABELS[cat]}</span>
      <span class="toggle-track"><span class="toggle-thumb"></span></span>
    </button>`;
  }).join('');

  return `
    <div class="settings-page">
      <div class="settings-header">Settings</div>

      <div class="settings-card">
        <div class="settings-card-title">Vessel Type</div>
        <div class="settings-card-hint">Local Boats: never left direct view, or re-entered 3+ times. Passing Through: seen outside direct view but not a regular. Distant Visitors: tracked globally.</div>
        <div class="settings-toggles">${extentRows}</div>
      </div>

      <div class="settings-card">
        <div class="settings-card-title">Show Trails For</div>
        <div class="settings-toggles">${trailRows}</div>
      </div>
    </div>
  `;
}

export function mount(root) {
  container = root;
  container.innerHTML = buildHTML();

  clickHandler = e => {
    const btn = e.target.closest('.settings-toggle');
    if (btn === null) return;
    const section = btn.dataset.section;
    const tier = btn.dataset.tier;
    const currentlyOn = btn.classList.contains('on');
    if (section === 'extent') {
      setExtentFilter(tier, !currentlyOn);
    } else {
      setTrailFilter(tier, !currentlyOn);
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
