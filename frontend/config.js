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

// AIS ingest bounding box — matches worker/src/constants.ts LOCAL_BOUNDING_BOX
export const LOCAL_BOUNDING_BOX = { sw: [48.0, -123.9], ne: [48.7, -122.4] };

export const WORKER_URL = 'https://vessel-tracker-api.brennan-a53.workers.dev';

export const POLL_INTERVAL_MS = 30_000;
