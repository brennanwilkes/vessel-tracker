import { TRAIL_TTL_MS } from '../config.js';
import { fetchTrack } from './api.js';

// mmsi → { points, tiersFetched: Set, fetchedAt, inflight: Promise|null }
const cache = new Map();

function cacheEntry(mmsi) {
  return cache.get(mmsi) ?? { points: [], tiersFetched: new Set(), fetchedAt: 0, inflight: null };
}

function isStale(entry) {
  return Date.now() - entry.fetchedAt > TRAIL_TTL_MS;
}

function hasAllTiers(entry, wantedTiers) {
  return wantedTiers.every(t => entry.tiersFetched.has(t));
}

export async function getTrail(mmsi, wantedTiers) {
  if (wantedTiers.length === 0) return [];

  let entry = cacheEntry(mmsi);
  const needsFetch = isStale(entry) || !hasAllTiers(entry, wantedTiers);

  if (needsFetch) {
    if (entry.inflight !== null) {
      await entry.inflight;
      entry = cacheEntry(mmsi);
    } else {
      // Fetch the union of already-cached tiers plus wanted tiers so the cache widens monotonically
      const toFetch = [...new Set([...entry.tiersFetched, ...wantedTiers])];

      const promise = fetchTrack(mmsi, toFetch).then(points => {
        cache.set(mmsi, {
          points,
          tiersFetched: new Set(toFetch),
          fetchedAt: Date.now(),
          inflight: null,
        });
      }).catch(err => {
        console.warn(`[trails] fetch failed for ${mmsi}:`, err);
        const current = cache.get(mmsi);
        if (current !== undefined) current.inflight = null;
      });

      cache.set(mmsi, { ...entry, inflight: promise });
      await promise;
      entry = cacheEntry(mmsi);
    }
  }

  return entry.points.filter(p => wantedTiers.includes(p.tier));
}

export function pruneTrails(liveMmsiSet) {
  for (const mmsi of cache.keys()) {
    if (!liveMmsiSet.has(mmsi)) cache.delete(mmsi);
  }
}
