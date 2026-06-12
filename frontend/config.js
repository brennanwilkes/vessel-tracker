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

// Fade window for marker opacity (independent of display TTL).
//   The marker fades from 1.0 → floor over this window, then holds at floor.
export const FADE_TTL_MS = {
  direct: 2 * 60 * 60 * 1000,
  local:  24 * 60 * 60 * 1000,
  global: 24 * 60 * 60 * 1000,
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

// Land-avoidance: across a data GAP whose straight line crosses land, the
// water router (geo.js) invents a water-only path that the trail spline follows.
export const LAND_AVOIDANCE = {
  // A pair of consecutive fixes is a data GAP worth routing across (vs normal
  // dense tracking, drawn as-is) when either threshold is exceeded.
  gapMinMs: 20 * 60 * 1000, // 20 min
  gapMinKm: 5,
  dashArray: '4 4',         // SVG dash pattern for inferred (water-routed) trail portions
  fadeRatio: 0.7,           // opacity multiplier for inferred segments vs the tier's normal opacity
};

// Inferred (A*-routed) waypoints are sparse and angular — A* + string-pull is a
// shortest water path with no notion of a vessel's turning radius, so spliced
// raw it produces sharp corners where it meets the real track. A real boat can't
// turn on a dime, so the inferred path is densified to ~uniform spacing then
// relaxed (Laplacian) with the endpoints pinned and every moved point land-
// checked: corners round out as much as the surrounding water allows, and stay
// sharp ONLY where the channel genuinely forces the turn. See trail_geometry
// `smoothRoute`. targetPoints caps densification so long continental gaps don't
// explode the control-point count.
export const ROUTE_SMOOTHING = { minStepKm: 1, targetPoints: 16, passes: 12, factor: 0.5 };

// Per-vessel narrow-channel routing penalty (routeWater `narrowWeight`). Large
// ships hold the main channel (e.g. the Fraser) even when slower; small craft are
// free to cut through tight Gulf Island passages. Linearly interpolated by length
// between [minLenM → small] and [maxLenM → large]; null/unknown length → default.
export const NARROW_WEIGHT = { minLenM: 20, maxLenM: 120, small: 0.5, large: 7, default: 3 };

// Server-side precompute (worker/scripts/precompute-trails.mjs) stores only the
// inferred waypoints of each routed segment, reduced by `simplifyForSpline`
// (trail_spline.js) to the FEWEST control points whose Catmull-Rom spline still
// reproduces the full curve within `tolKm` and stays off land. Smaller tol = more
// fidelity but more stored points (D1 write budget); ~30 m is visually identical.
export const TRAIL_SIMPLIFY = { tolKm: 0.03 };

export const DEFAULT_EXTENT_FILTERS = { local_boat: true, passing_through: true, distant_visitor: true };
export const DEFAULT_TRAIL_FILTERS  = { local_boat: true, passing_through: true, distant_visitor: false };

export const VESSEL_TYPE_KEYS = ['cargo', 'tanker', 'cruise', 'ferry', 'military', 'fishing', 'government', 'pleasure', 'tug', 'unknown'];
export const DEFAULT_VESSEL_TYPE_FILTERS = { cargo: true, tanker: true, cruise: true, ferry: true, military: true, fishing: true, government: true, pleasure: true, tug: true, unknown: true };
