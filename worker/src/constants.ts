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

// Zone-visit write throttle: while a vessel sits in a named zone, only bump its
// zone_visits row this often (else a parked ship would re-write every scan). First
// sighting in a zone always inserts.
export const ZONE_VISIT_THROTTLE_MS = 30 * 60 * 1000;

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

// ── Rotating foreign scan ────────────────────────────────────────────────────
// The worldwide global scan above rarely hears its MMSI-filtered targets (a 30 s
// window over the whole planet seldom catches a specific vessel mid-broadcast). The
// foreign scan instead drains a rotating SLICE of distant port boxes (zones.ts, no
// MMSI filter) — dense, so it reliably hears everything there. It functions like the
// local scan (skip confirmed-small new vessels, create an initial row for unknown
// types so a later ping can enrich+classify them) but adds two data-frugality
// conditionals so a busy world port can't blow the free-tier write cap:
//   1. RELEVANCE gate — only a large, plausibly-inbound vessel becomes of-interest
//      (a ≥150 m ship anywhere on the Pacific rim, or ≥100 m bound for a NA-Pacific-NW
//      port per its AIS destination). Already-of-interest vessels always qualify.
//   2. LOW RESOLUTION — a relevant vessel gets one zone_visit (saturating/throttled)
//      and a single anchor position on first entry to a port, NOT a position track.
//      Full-resolution tracking only begins if it actually reaches the home box.
// Cron is FOREIGN_SCAN_CRON (also add it to wrangler.toml [triggers]).
export const FOREIGN_SCAN_CRON      = '*/15 * * * *';
export const FOREIGN_DRAIN_MS       = 60_000;
export const FOREIGN_SCAN_BOX_BATCH = 6;                      // boxes per connection (aisstream cap unknown → conservative)
export const FOREIGN_REFRESH_MS     = 6 * 60 * 60 * 1000;     // re-upsert a parked foreign vessel at most this often
export const FOREIGN_MAX_NEW_PER_SCAN = 200;                  // cap initial rows/scan so a first run can't exhaust the write cap
export const FOREIGN_RELEVANCE = {
  bigLenM: 150,   // any ≥150 m vessel at a Pacific-rim port is plausibly trans-Pacific → track
  midLenM: 100,   // 100–150 m only when its destination is a NA-Pacific-NW port
  // AIS destination tokens (UPPERCASE substrings) for ports in/inbound to the viewshed.
  // Free-text + UN/LOCODE; deliberately PNW-weighted. Tune after measuring real writes.
  destPatterns: [
    'VANCOUVER', 'CAVAN', 'PRINCE RUPERT', 'CAPRR', 'VICTORIA', 'CAVIC', 'NANAIMO', 'CANAN',
    'SEATTLE', 'USSEA', 'TACOMA', 'USTIW', 'EVERETT', 'USEVR', 'BELLINGHAM', 'ANACORTES',
    'PORTLAND', 'USPDX', 'CHERRY POINT', 'PUGET', 'SALISH',
  ],
};

// Trail precompute runs as a GitHub Actions cron. The global scan triggers it on
// completion (most new land-crossing gaps appear after the hourly global data
// lands) via workflow_dispatch; the workflow also keeps its own hourly fallback.
export const GITHUB_REPO = 'brennanwilkes/vessel-tracker';
export const PRECOMPUTE_WORKFLOW_FILE = 'precompute-trails.yml';
