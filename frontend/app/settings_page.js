import { EXTENTS } from '../config.js';
import { subscribe, getSettings, setExtentFilter, setTrailFilter } from './settings_store.js';

const EXTENT_LABELS = {
  direct: 'Direct View',
  local:  'Local Area',
  global: 'Global',
};

const TRAIL_LABELS = {
  direct: 'Direct View',
  local:  'Local Area',
  global: 'Global',
};

let container = null;
let unsubscribe = null;

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

  const extentRows = EXTENTS.map(tier => {
    const on = settings.extent[tier];
    return `<button class="settings-toggle${on ? ' on' : ''}" data-section="extent" data-tier="${tier}" role="switch" aria-checked="${on}">
      <span class="toggle-label">${EXTENT_LABELS[tier]}</span>
      <span class="toggle-track"><span class="toggle-thumb"></span></span>
    </button>`;
  }).join('');

  const trailRows = EXTENTS.map(tier => {
    const on = settings.trail[tier];
    return `<button class="settings-toggle${on ? ' on' : ''}" data-section="trail" data-tier="${tier}" role="switch" aria-checked="${on}">
      <span class="toggle-label">${TRAIL_LABELS[tier]}</span>
      <span class="toggle-track"><span class="toggle-thumb"></span></span>
    </button>`;
  }).join('');

  return `
    <div class="settings-page">
      <div class="settings-header">Settings</div>

      <div class="settings-card">
        <div class="settings-card-title">Vessel Extent</div>
        <div class="settings-card-hint">Every shown vessel has entered the direct view at least once</div>
        <div class="settings-toggles">${extentRows}</div>
      </div>

      <div class="settings-card">
        <div class="settings-card-title">Trail Tiers</div>
        <div class="settings-toggles">${trailRows}</div>
      </div>
    </div>
  `;
}

export function mount(root) {
  container = root;
  container.innerHTML = buildHTML();

  container.addEventListener('click', e => {
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
  });

  unsubscribe = subscribe(() => renderToggles());
}

export function unmount() {
  if (unsubscribe !== null) { unsubscribe(); unsubscribe = null; }
  container = null;
}
