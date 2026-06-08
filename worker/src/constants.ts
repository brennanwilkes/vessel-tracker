export const JSON_CT = 'application/json; charset=utf-8';

// Strait of Juan de Fuca + Haro Strait visible from Victoria BC (48.43°N 123.36°W).
// Western edge: Race Rocks / western Strait entrance
// Eastern edge: Port Townsend — excludes Anacortes / Rosario Strait
// Southern edge: Port Angeles area
// Northern edge: ~10nm north of home, just past 10 Mile Point / south Sidney
// Format: [[SW_lat, SW_lon], [NE_lat, NE_lon]] as required by aisstream.
export const LOCAL_BOUNDING_BOX: [[number, number], [number, number]] = [
  [48.0, -123.9],
  [48.6, -122.76],
];

// Used by the daily enrichment cron paired with FiltersShipMMSI.
// As large as possible so coverage is bounded only by aisstream's AIS network,
// not our box. TODO: verify aisstream accepts [-90/-180, 90/180] global box;
// tighten to documented max if not.
export const GLOBAL_BOUNDING_BOX: [[number, number], [number, number]] = [
  [-90, -180],
  [90, 180],
];

// Max age before a vessel is dropped from the /vessels response
export const STALE_THRESHOLD_MS = 5 * 60 * 1000;

// How long to drain the AIS WebSocket per live cron run (ms)
export const DRAIN_WINDOW_MS = 40_000;

// How long to drain the wide-area daily enrichment feed
export const ENRICHMENT_DRAIN_MS = 30_000;

export const SNAPSHOT_KEY = 'snapshot:current';
