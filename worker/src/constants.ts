export const JSON_CT = 'application/json; charset=utf-8';

// Direct view: vessels visble from the apartment window.
// No size filter — everything in this box gets tracked and rendered.
export const DIRECT_BOUNDING_BOX: [[number, number], [number, number]] = [
  [48.070, -123.70],
  [48.524, -123.02],
];

// Local area: all of Vancouver Island + waterways + open Pacific.
// Only large vessels (or already-of-interest) are stored from this zone.
export const LOCAL_BOUNDING_BOX: [[number, number], [number, number]] = [
  [47.8, -128.7],
  [51.2, -122.5],
];

// Used by the daily global scan paired with FiltersShipMMSI.
export const GLOBAL_BOUNDING_BOX: [[number, number], [number, number]] = [
  [-90, -180],
  [90, 180],
];

// Movement thresholds per tier (nautical miles). A new positions row is only written
// when the vessel has moved at least this far since its last stored point.
export const MOVE_THRESHOLD_NM: Record<string, number> = {
  direct: 0.05,
  local:  0.5,
  global: 5.0,
};

// If a direct-tier vessel reports nonzero speed but its position hasn't changed by more
// than this, we call BS on the speed and treat it as stationary. ~9m — within AIS GPS
// noise for a moored vessel, well below the slowest plausible movement in one scan cycle.
export const PHANTOM_SPEED_THRESHOLD_NM = 0.005;

// How long a stationary vessel can go without a heartbeat last_seen update (ms)
export const HEARTBEAT_MS = 10 * 60 * 1000;

// Max age before a vessel is dropped from the /current response
export const LIVE_TTL_MS = 90 * 60 * 1000;

// Drain windows per tier (ms). Direct cron is every 1 min — leave headroom.
export const DIRECT_DRAIN_MS  = 45_000;
export const LOCAL_DRAIN_MS   = 90_000;
export const GLOBAL_DRAIN_MS  = 30_000;
