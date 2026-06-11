export const JSON_CT = 'application/json; charset=utf-8';

// Direct view: vessels visble from the apartment window.
// No size filter — everything in this box gets tracked and rendered.
export const DIRECT_BOUNDING_BOX: [[number, number], [number, number]] = [
  [48.070, -123.70],
  [48.524, -123.02],
];

// Local area: Vancouver Island + Puget Sound including Tacoma.
// Only large vessels (or already-of-interest) are stored from this zone.
export const LOCAL_BOUNDING_BOX: [[number, number], [number, number]] = [
  [47.0, -128.7],
  [51.2, -122.0],
];

// Used by the daily global scan paired with FiltersShipMMSI.
export const GLOBAL_BOUNDING_BOX: [[number, number], [number, number]] = [
  [-90, -180],
  [90, 180],
];

// Trajectory-compression thresholds (MOVE_THRESHOLD_NM, MOVE_PROFILE, MOVING_SPEED_KN,
// COARSE_TYPE_GAP_FACTOR) and the isSignificantMove decision live in `compress.ts` — a
// self-contained, unit-testable module. Re-exported here for back-compat imports.
export { MOVE_THRESHOLD_NM, MOVE_PROFILE, MOVING_SPEED_KN, COARSE_TYPE_GAP_FACTOR } from './compress';
export type { MoveProfile } from './compress';

// Phantom speed detection for direct-tier vessels. Some AIS transponders keep broadcasting
// their last-known speed after anchoring/docking. We call BS when:
//   - reported speed >= PHANTOM_SPEED_MIN_KN
//   - no new position row has been written in >= PHANTOM_STALL_MS
// A genuine 1.5-kn vessel crosses MOVE_THRESHOLD_NM.direct every ~2 min, so 20 min is a
// 10× safety margin — a moving vessel cannot go this long without a position row.
export const PHANTOM_SPEED_MIN_KN = 1.5;
export const PHANTOM_STALL_MS     = 20 * 60 * 1000;

// How long a stationary vessel can go without a heartbeat last_seen update (ms).
// Backoff: the longer a vessel has been parked (no position row), the less often it
// needs a heartbeat — it isn't going anywhere. All intervals stay < the 6h live TTL so
// the vessel never silently drops off /current.
export const HEARTBEAT_MS = 10 * 60 * 1000;
export const HEARTBEAT_BACKOFF: { parkedMs: number; intervalMs: number }[] = [
  { parkedMs: 6 * 60 * 60 * 1000, intervalMs: 60 * 60 * 1000 }, // parked >6h → hourly
  { parkedMs: 1 * 60 * 60 * 1000, intervalMs: 30 * 60 * 1000 }, // parked >1h → every 30 min
];

// Max age before a vessel is dropped from the /current response.
// Direct/local vessels can miss multiple drain windows; keep them visible for a workday.
// Global vessels update hourly; keep them through missed scans.
export const LIVE_TTL_DIRECT_MS = 6 * 60 * 60 * 1000;
export const LIVE_TTL_LOCAL_MS  = 6 * 60 * 60 * 1000;
export const LIVE_TTL_GLOBAL_MS = 72 * 60 * 60 * 1000;

// Drain windows per tier (ms). Direct cron is every 1 min — leave headroom.
export const DIRECT_DRAIN_MS  = 45_000;
export const LOCAL_DRAIN_MS   = 90_000;
export const GLOBAL_DRAIN_MS  = 30_000;

// Global scans target many specific MMSIs. Query in batches and retry misses so
// one quiet drain window doesn't decide the day's global data.
export const GLOBAL_MMSI_CHUNK_SIZE = 75;
export const GLOBAL_SCAN_ATTEMPTS   = 3;
export const GLOBAL_SCAN_BUDGET_MS  = 14 * 60 * 1000;
