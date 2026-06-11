// Module Web Worker: runs the expensive trail geometry (A* water routing +
// repair) off the main thread so the map never freezes while curves compute.
// It reuses the exact same pure pipeline as the main thread (trail_geometry.js),
// which is why that module is DOM-free. The main thread posts
// {mmsi, allPoints, sig, bounds}; we post back the styled runs (or an error,
// in which case the main thread keeps the instant straight-bridge fallback).
import { computeRuns } from './trail_geometry.js';
import { ensureRegionsForExtent, extentOf } from './region_coast.js';

self.onmessage = async (e) => {
  const { mmsi, allPoints, sig, bounds, vesselLength } = e.data;
  try {
    // Lazily pull in any foreign harbour/river region this trail reaches before routing.
    await ensureRegionsForExtent(extentOf(allPoints));
    const runs = computeRuns(allPoints, true, { vesselLength });
    self.postMessage({ mmsi, sig, bounds, runs });
  } catch (err) {
    self.postMessage({ mmsi, sig, bounds, error: String(err && err.message || err) });
  }
};
