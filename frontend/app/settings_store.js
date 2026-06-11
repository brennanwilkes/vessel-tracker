import { EXTENTS, TIERS, DEFAULT_EXTENT_FILTERS, DEFAULT_TRAIL_FILTERS, VESSEL_TYPE_KEYS, DEFAULT_VESSEL_TYPE_FILTERS } from '../config.js';
import { classifyVessel } from './vessels.js';

const EXTENT_KEY = 'vessel-tracker:extent-filters';
const TRAIL_KEY  = 'vessel-tracker:trail-filters';
const UNIT_KEY   = 'vessel-tracker:unit';
const VESSEL_TYPE_KEY = 'vessel-tracker:vessel-type-filters';
const SORT_FIELD_KEY = 'vessel-tracker:sort-field';
const SORT_DIR_KEY  = 'vessel-tracker:sort-dir';

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
  extent:     loadFilters(EXTENT_KEY,     DEFAULT_EXTENT_FILTERS,      EXTENTS),
  trail:      loadFilters(TRAIL_KEY,      DEFAULT_TRAIL_FILTERS,       EXTENTS),
  vesselType: loadFilters(VESSEL_TYPE_KEY, DEFAULT_VESSEL_TYPE_FILTERS, VESSEL_TYPE_KEYS),
  unitNm:     localStorage.getItem(UNIT_KEY) !== 'km',
  sortField:  localStorage.getItem(SORT_FIELD_KEY) ?? 'distance',
  sortDir:    localStorage.getItem(SORT_DIR_KEY) ?? 'asc',
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

export function setVesselTypeFilter(cat, on) {
  state = { ...state, vesselType: { ...state.vesselType, [cat]: on } };
  localStorage.setItem(VESSEL_TYPE_KEY, JSON.stringify(state.vesselType));
  notify();
}

export function passesVesselTypeFilter(vessel, typeFilters) {
  const cat = classifyVessel(vessel);
  return typeFilters[cat] !== false;
}

export function setUnitNm(val) {
  state = { ...state, unitNm: val };
  localStorage.setItem(UNIT_KEY, val ? 'nm' : 'km');
  notify();
}

export function setSort(field, dir) {
  state = { ...state, sortField: field, sortDir: dir };
  localStorage.setItem(SORT_FIELD_KEY, field);
  localStorage.setItem(SORT_DIR_KEY, dir);
  notify();
}
