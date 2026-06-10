import { EXTENTS, TIERS, DEFAULT_EXTENT_FILTERS, DEFAULT_TRAIL_FILTERS } from '../config.js';

const EXTENT_KEY = 'vessel-tracker:extent-filters';
const TRAIL_KEY  = 'vessel-tracker:trail-filters';
const UNIT_KEY   = 'vessel-tracker:unit';

function loadFilters(key, defaults, keys) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return { ...defaults };
    const parsed = JSON.parse(raw);
    const result = { ...defaults };
    for (const k of keys) {
      if (typeof parsed[k] === 'boolean') result[k] = parsed[k];
    }
    return result;
  } catch {
    return { ...defaults };
  }
}

let state = {
  extent: loadFilters(EXTENT_KEY, DEFAULT_EXTENT_FILTERS, EXTENTS),
  trail:  loadFilters(TRAIL_KEY,  DEFAULT_TRAIL_FILTERS,  EXTENTS),
  unitNm: localStorage.getItem(UNIT_KEY) !== 'km',
};

const subscribers = new Set();

function notify() {
  for (const fn of subscribers) fn(state);
}

export function subscribe(fn) {
  subscribers.add(fn);
  fn(state);
  return () => subscribers.delete(fn);
}

export function getSettings() {
  return state;
}

export function setExtentFilter(tier, on) {
  state = { ...state, extent: { ...state.extent, [tier]: on } };
  localStorage.setItem(EXTENT_KEY, JSON.stringify(state.extent));
  notify();
}

export function setTrailFilter(tier, on) {
  state = { ...state, trail: { ...state.trail, [tier]: on } };
  localStorage.setItem(TRAIL_KEY, JSON.stringify(state.trail));
  notify();
}

export function vesselCategory(vessel) {
  if (vessel.max_extent === 'global') return 'distant_visitor';
  if (vessel.max_extent === 'direct' || vessel.direct_entry_count >= 3) return 'local_boat';
  return 'passing_through';
}

export function passesExtentFilter(vessel, extentFilters) {
  return extentFilters[vesselCategory(vessel)] === true;
}

export function setUnitNm(val) {
  state = { ...state, unitNm: val };
  localStorage.setItem(UNIT_KEY, val ? 'nm' : 'km');
  notify();
}
