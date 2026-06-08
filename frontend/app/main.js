import { startPolling } from './store.js';
import { mount as mountMap, unmount as unmountMap } from './map_page.js';
import { mount as mountList, unmount as unmountList } from './list_page.js';
import { mount as mountCamera, unmount as unmountCamera } from './camera_page.js';
import { mount as mountSettings, unmount as unmountSettings } from './settings_page.js';

// All setup at top — per project convention
const PAGES = {
  map:      { mount: mountMap,      unmount: unmountMap      },
  list:     { mount: mountList,     unmount: unmountList     },
  camera:   { mount: mountCamera,   unmount: unmountCamera   },
  settings: { mount: mountSettings, unmount: unmountSettings },
};

const TABS = [
  {
    id: 'map',
    label: 'Map',
    icon: `<svg class="tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <polygon points="3,6 9,3 15,6 21,3 21,18 15,21 9,18 3,21"/>
      <line x1="9" y1="3" x2="9" y2="18"/>
      <line x1="15" y1="6" x2="15" y2="21"/>
    </svg>`,
  },
  {
    id: 'list',
    label: 'List',
    icon: `<svg class="tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <line x1="8" y1="6"  x2="21" y2="6"/>
      <line x1="8" y1="12" x2="21" y2="12"/>
      <line x1="8" y1="18" x2="21" y2="18"/>
      <circle cx="3" cy="6"  r="1" fill="currentColor" stroke="none"/>
      <circle cx="3" cy="12" r="1" fill="currentColor" stroke="none"/>
      <circle cx="3" cy="18" r="1" fill="currentColor" stroke="none"/>
    </svg>`,
  },
  {
    id: 'camera',
    label: 'Camera',
    icon: `<svg class="tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
      <circle cx="12" cy="13" r="4"/>
    </svg>`,
  },
  {
    id: 'settings',
    label: 'Settings',
    icon: `<svg class="tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="3"/>
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
    </svg>`,
  },
];

let activePage = null;
let pageRoot = null;

function getPageFromHash() {
  const hash = location.hash.replace('#', '');
  return PAGES[hash] !== undefined ? hash : 'map';
}

function navigate(pageId) {
  if (activePage === pageId) return;

  if (activePage !== null) PAGES[activePage].unmount();

  activePage = pageId;
  location.hash = pageId;

  pageRoot.innerHTML = '';
  PAGES[pageId].mount(pageRoot);

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.page === pageId);
  });
}

function buildShell() {
  const app = document.getElementById('app');

  pageRoot = document.createElement('div');
  pageRoot.id = 'page-root';
  app.appendChild(pageRoot);

  const tabBar = document.createElement('nav');
  tabBar.className = 'tab-bar';
  tabBar.innerHTML = TABS.map(t => `
    <button class="tab-btn" data-page="${t.id}">
      ${t.icon}
      <span class="tab-label">${t.label}</span>
    </button>
  `).join('');

  tabBar.addEventListener('click', e => {
    const btn = e.target.closest('.tab-btn');
    if (btn !== null) navigate(btn.dataset.page);
  });

  app.appendChild(tabBar);
}

function init() {
  buildShell();
  startPolling();

  const initialPage = getPageFromHash();
  navigate(initialPage);

  window.addEventListener('hashchange', () => {
    const page = getPageFromHash();
    if (page !== activePage) navigate(page);
  });
}

init();
