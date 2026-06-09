// All runtime configuration as top-level consts.
// WORKER_URL: replace __account__ after first worker deploy.

export const VIEWSHEDS = [
  {
    id: 'apartment',
    label: 'Apartment',
    home: { lat: 48.429861, lon: -123.362194 }, // 48°25'47.5"N 123°21'43.9"W
    fovDegrees: 120,
    centerBearing: null, // set after M2 viewshed calibration
    maxDistanceNm: 15,
  },
];

// Direct view: vessels visible from the apartment window (matches worker DIRECT_BOUNDING_BOX)
export const DIRECT_BOUNDING_BOX = { sw: [48.070, -123.70], ne: [48.524, -123.02] };

// Local area: Vancouver Island + Puget Sound including Tacoma (matches worker LOCAL_BOUNDING_BOX)
export const LOCAL_BOUNDING_BOX = { sw: [47.0, -128.7], ne: [51.2, -122.0] };

export const WORKER_URL = 'https://vessel-tracker-api.brennan-a53.workers.dev';

export const POLL_INTERVAL_MS = 30_000;

// Speed threshold below which a vessel renders as a dot instead of a directional arrow
export const MOVING_SPEED_KN = 0.5;

// Trail cache TTL — refetch only when older than this
export const TRAIL_TTL_MS = 120_000;

// How long a tier's vessels stay on screen after last_seen.
// Must stay in sync with worker/src/constants.ts LIVE_TTL_*_MS.
export const LIVE_TTL_MS = {
  direct: 6 * 60 * 60 * 1000,
  local:  72 * 60 * 60 * 1000,
  global: 72 * 60 * 60 * 1000,
};

// Time-gap thresholds for trail line behavior per tier.
//   direct: >2h → sever line into two
//   local:  >6h → sever line into two
//   global: >6h → reset curve (straight segment), don't sever
export const TRAIL_GAP_SEVER_MS = {
  direct: 7_200_000,
  local:  21_600_000,
  global: 21_600_000,
};

export const EXTENTS = ['local_boat', 'passing_through', 'distant_visitor'];
export const TIERS   = ['direct', 'local', 'global'];

export const TIER_STYLE = {
  direct: { opacity: 0.25, weight: 1 },
  local:  { opacity: 0.25, weight: 1 },
  global: { opacity: 0.25, weight: 1 },
};

export const DEFAULT_EXTENT_FILTERS = { local_boat: true, passing_through: true, distant_visitor: true };
export const DEFAULT_TRAIL_FILTERS  = { local_boat: true, passing_through: true, distant_visitor: false };
