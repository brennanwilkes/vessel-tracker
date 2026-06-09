import type { Env, Tier, MaxExtent, Vessel } from './types';
import {
  DIRECT_BOUNDING_BOX, LOCAL_BOUNDING_BOX, GLOBAL_BOUNDING_BOX,
  MOVE_THRESHOLD_NM, HEARTBEAT_MS,
  DIRECT_DRAIN_MS, LOCAL_DRAIN_MS, GLOBAL_DRAIN_MS,
  PHANTOM_SPEED_MIN_KN, PHANTOM_STALL_MS,
  GLOBAL_MMSI_CHUNK_SIZE, GLOBAL_SCAN_ATTEMPTS, GLOBAL_SCAN_BUDGET_MS,
  LIVE_TTL_LOCAL_MS,
} from './constants';
import { drainAisStream } from './aisstream';
import { pointInBox, isLargeVessel, isConfirmedSmall } from './ais';
import {
  loadVesselStates, commitScan, enrichStaticData, getOfInterestMmsis, widenExtent,
  type VesselUpsert, type PositionInsert, type VesselState,
} from './storage';

const R_NM = 3440.065;

function haversineNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R_NM * Math.asin(Math.sqrt(a));
}

function assessMovement(v: Vessel, prev: VesselState | undefined, tier: Tier, nowMs: number): { moved: boolean; effectiveSpeed: number | null; forceUpsert: boolean } {
  if (prev === undefined || prev.last_lat === null || prev.last_lon === null) {
    return { moved: true, effectiveSpeed: v.speed, forceUpsert: false };
  }
  const dist = haversineNm(prev.last_lat, prev.last_lon, v.lat, v.lon);
  if (tier === 'direct' && v.speed !== null && v.speed >= PHANTOM_SPEED_MIN_KN) {
    // Escape hatch: real displacement past the move threshold always wins, even for a
    // vessel previously flagged phantom. Without this, a phantom flag is permanent —
    // last_pos_ts only advances on a position row (moved=true), but moved stays false
    // while flagged, so posAge grows forever and the vessel can never recover.
    if (dist >= MOVE_THRESHOLD_NM.direct) {
      return { moved: true, effectiveSpeed: v.speed, forceUpsert: false };
    }
    // A genuinely moving vessel at PHANTOM_SPEED_MIN_KN crosses MOVE_THRESHOLD_NM every
    // ~2 min, so no position row in PHANTOM_STALL_MS (20 min = 10× that) means phantom.
    const posAge = prev.last_pos_ts !== null ? nowMs - prev.last_pos_ts : null;
    if (posAge !== null && posAge > PHANTOM_STALL_MS) {
      const alreadyCorrected = prev.last_speed === 0;
      return { moved: false, effectiveSpeed: 0, forceUpsert: !alreadyCorrected };
    }
    return { moved: true, effectiveSpeed: v.speed, forceUpsert: false };
  }
  if (tier === 'direct' && v.speed !== null && v.speed > 0) {
    return { moved: true, effectiveSpeed: v.speed, forceUpsert: false };
  }
  return { moved: dist >= MOVE_THRESHOLD_NM[tier], effectiveSpeed: v.speed, forceUpsert: false };
}

function tierOf(lat: number, lon: number): Tier {
  if (pointInBox(lat, lon, DIRECT_BOUNDING_BOX)) return 'direct';
  if (pointInBox(lat, lon, LOCAL_BOUNDING_BOX)) return 'local';
  return 'global';
}

// Provenance for a brand-new vessel. We default to 'direct' (a local resident), but a large
// vessel (cargo/tanker/>=50m) is always transiting — if its first sighting is already inside
// the direct box, it slipped in between local scans, not because it lives here. Seeding 'local'
// keeps a 250m tanker out of the local-boat bucket. (Vessels typed only after first sighting are
// handled by the matching max_extent upgrade in enrichStaticData.)
function initialExtent(v: Vessel): MaxExtent {
  return isLargeVessel(v.vesselType, v.length) ? 'local' : 'direct';
}

function computeDirectEntryCount(prev: VesselState | undefined, currentTier: Tier): number {
  const prevCount = prev?.direct_entry_count ?? 0;
  if (currentTier !== 'direct') return prevCount;
  const prevInDirect = prev !== undefined && prev.last_lat !== null && prev.last_lon !== null
    && tierOf(prev.last_lat, prev.last_lon) === 'direct';
  return prevInDirect ? prevCount : prevCount + 1;
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

async function drainGlobalMmsis(env: Env, mmsis: number[], startedAt: number): Promise<{ vessels: Vessel[]; staticOnly: Parameters<typeof enrichStaticData>[1]; missed: number[]; attempts: number }> {
  const heard = new Map<number, Vessel>();
  const staticUpdates = new Map<number, Parameters<typeof enrichStaticData>[1][number]>();
  let pending = [...mmsis];
  let attempts = 0;
  const deadline = startedAt + GLOBAL_SCAN_BUDGET_MS;

  for (let round = 1; round <= GLOBAL_SCAN_ATTEMPTS && pending.length > 0; round++) {
    const roundStartCount = pending.length;
    let roundHeard = 0;

    for (const chunk of chunks(pending, GLOBAL_MMSI_CHUNK_SIZE)) {
      if (Date.now() + GLOBAL_DRAIN_MS > deadline) {
        const missed = pending.filter(mmsi => !heard.has(mmsi));
        console.warn(`[ingest] GLOBAL_SCAN_BUDGET_REACHED pending=${missed.length} attempts=${attempts} heard=${heard.size}`);
        return { vessels: [...heard.values()], staticOnly: [...staticUpdates.values()], missed, attempts };
      }

      attempts++;
      const result = await drainAisStream({
        apiKey: env.AISSTREAM_API_KEY,
        boundingBox: GLOBAL_BOUNDING_BOX,
        mmsis: chunk,
        drainMs: GLOBAL_DRAIN_MS,
      });

      for (const v of result.vessels) {
        if (!heard.has(v.mmsi)) roundHeard++;
        heard.set(v.mmsi, v);
      }
      for (const update of result.staticOnly) {
        staticUpdates.set(update.mmsi, update);
      }
    }

    pending = pending.filter(mmsi => !heard.has(mmsi));
    console.log(`[ingest] GLOBAL_SCAN_ROUND round=${round}/${GLOBAL_SCAN_ATTEMPTS} heard=${roundHeard}/${roundStartCount} pending=${pending.length} total_heard=${heard.size}`);
  }

  return { vessels: [...heard.values()], staticOnly: [...staticUpdates.values()], missed: pending, attempts };
}

export async function runDirectScan(env: Env): Promise<void> {
  const start = Date.now();
  console.log('[ingest] direct scan starting');

  const { vessels, staticOnly } = await drainAisStream({
    apiKey: env.AISSTREAM_API_KEY,
    boundingBox: DIRECT_BOUNDING_BOX,
    drainMs: DIRECT_DRAIN_MS,
  });

  if (vessels.length === 0) {
    if (staticOnly.length > 0) await enrichStaticData(env, staticOnly);
    console.warn('[ingest] direct scan — 0 vessels heard');
    return;
  }

  const existing = await loadVesselStates(env, vessels.map(v => v.mmsi));
  const nowMs = Date.now();
  const upserts: VesselUpsert[] = [];
  const positions: PositionInsert[] = [];
  let nMoved = 0, nHeartbeat = 0, nPhantom = 0, nSkipped = 0;

  for (const v of vessels) {
    const prev = existing.get(v.mmsi);
    const { moved, effectiveSpeed, forceUpsert } = assessMovement(v, prev, 'direct', nowMs);
    const heartbeat = !moved && !forceUpsert && (prev === undefined || nowMs - prev.last_seen >= HEARTBEAT_MS);

    if (!moved && !heartbeat && !forceUpsert) { nSkipped++; continue; }

    const firstDirect = (prev === undefined || prev.of_interest === 0) ? nowMs : null;
    const direct_entry_count = computeDirectEntryCount(prev, 'direct');
    const max_extent: MaxExtent = prev?.max_extent ?? initialExtent(v);

    upserts.push({
      mmsi: v.mmsi,
      name: v.name,
      vessel_type: v.vesselType,
      length: v.length,
      destination: v.destination,
      lat: v.lat,
      lon: v.lon,
      speed: effectiveSpeed,
      heading: v.heading,
      ts: nowMs,
      of_interest: 1,
      max_extent,
      first_direct_at: firstDirect,
      direct_entry_count,
      moved,
      heartbeat,
      forceUpsert,
    });

    if (moved) {
      nMoved++;
      positions.push({ mmsi: v.mmsi, lat: v.lat, lon: v.lon, speed: effectiveSpeed, heading: v.heading, ts: nowMs, tier: 'direct' });
    } else if (forceUpsert) {
      nPhantom++;
      console.log(`[ingest] phantom speed: mmsi=${v.mmsi} reported=${v.speed}kn, pos stale ${Math.round((nowMs - (prev!.last_pos_ts ?? 0)) / 60000)}min`);
    } else {
      nHeartbeat++;
    }
  }

  console.log(`[ingest] direct scan — ${vessels.length} heard | ${nMoved} moved, ${nHeartbeat} heartbeat, ${nPhantom} phantom, ${nSkipped} no-change`);
  await commitScan(env, upserts, positions);
  await enrichStaticData(env, staticOnly);
  console.log(`[ingest] direct scan done — ${upserts.length} writes (${positions.length} pos), ${staticOnly.length} static-only enrichments in ${Date.now() - start}ms`);
}

export async function runLocalScan(env: Env): Promise<void> {
  const start = Date.now();
  console.log('[ingest] local scan starting');

  const { vessels, staticOnly } = await drainAisStream({
    apiKey: env.AISSTREAM_API_KEY,
    boundingBox: LOCAL_BOUNDING_BOX,
    drainMs: LOCAL_DRAIN_MS,
  });

  if (vessels.length === 0) {
    if (staticOnly.length > 0) await enrichStaticData(env, staticOnly);
    console.warn('[ingest] local scan — 0 vessels heard');
    return;
  }

  const existing = await loadVesselStates(env, vessels.map(v => v.mmsi));
  const nowMs = Date.now();
  const upserts: VesselUpsert[] = [];
  const positions: PositionInsert[] = [];
  let nFiltered = 0, nMoved = 0, nHeartbeat = 0, nPhantom = 0, nSkipped = 0;
  let nInDirect = 0;

  for (const v of vessels) {
    const prev = existing.get(v.mmsi);

    if (isConfirmedSmall(v.vesselType, v.length) && prev === undefined) { nFiltered++; continue; }

    const inDirect = pointInBox(v.lat, v.lon, DIRECT_BOUNDING_BOX);
    if (inDirect) nInDirect++;

    const of_interest = inDirect || (prev !== undefined && prev.of_interest === 1) ? 1 : 0;
    const firstDirect = inDirect && (prev === undefined || prev.of_interest === 0) ? nowMs : null;

    const prevExtent: MaxExtent = prev?.max_extent ?? initialExtent(v);
    const max_extent = inDirect ? prevExtent : widenExtent(prevExtent, 'local');

    const tier: Tier = inDirect ? 'direct' : 'local';
    const { moved, effectiveSpeed, forceUpsert } = assessMovement(v, prev, tier, nowMs);
    const heartbeat = !moved && !forceUpsert && (prev === undefined || nowMs - prev.last_seen >= HEARTBEAT_MS);

    if (!moved && !heartbeat && !forceUpsert) { nSkipped++; continue; }

    const direct_entry_count = computeDirectEntryCount(prev, tier);

    upserts.push({
      mmsi: v.mmsi,
      name: v.name,
      vessel_type: v.vesselType,
      length: v.length,
      destination: v.destination,
      lat: v.lat,
      lon: v.lon,
      speed: effectiveSpeed,
      heading: v.heading,
      ts: nowMs,
      of_interest,
      max_extent,
      first_direct_at: firstDirect,
      direct_entry_count,
      moved,
      heartbeat,
      forceUpsert,
    });

    if (moved) {
      nMoved++;
      positions.push({ mmsi: v.mmsi, lat: v.lat, lon: v.lon, speed: effectiveSpeed, heading: v.heading, ts: nowMs, tier });
    } else if (forceUpsert) {
      nPhantom++;
      console.log(`[ingest] phantom speed: mmsi=${v.mmsi} reported=${v.speed}kn, pos stale ${Math.round((nowMs - (prev!.last_pos_ts ?? 0)) / 60000)}min`);
    } else {
      nHeartbeat++;
    }
  }

  console.log(
    `[ingest] local scan — ${vessels.length} heard | ${nFiltered} filtered (small/untracked), ${nInDirect} in direct box` +
    ` | ${nMoved} moved, ${nHeartbeat} heartbeat, ${nPhantom} phantom, ${nSkipped} no-change`
  );
  await commitScan(env, upserts, positions);
  await enrichStaticData(env, staticOnly);
  console.log(`[ingest] local scan done — ${upserts.length} writes (${positions.length} pos), ${staticOnly.length} static-only enrichments in ${Date.now() - start}ms`);
}

export async function runGlobalScan(env: Env): Promise<void> {
  const start = Date.now();
  console.log('[ingest] GLOBAL_SCAN_START');

  const staleCutoffMs = start - LIVE_TTL_LOCAL_MS;
  const mmsis = await getOfInterestMmsis(env, staleCutoffMs);
  if (mmsis.length === 0) {
    console.log('[ingest] GLOBAL_SCAN_SKIPPED reason=no_of_interest_vessels');
    return;
  }

  console.log(
    `[ingest] GLOBAL_SCAN_PLAN candidates=${mmsis.length}` +
    ` chunk_size=${GLOBAL_MMSI_CHUNK_SIZE} attempts=${GLOBAL_SCAN_ATTEMPTS}` +
    ` drain_ms=${GLOBAL_DRAIN_MS} budget_ms=${GLOBAL_SCAN_BUDGET_MS}`
  );

  const { vessels, staticOnly, missed, attempts } = await drainGlobalMmsis(env, mmsis, start);

  if (vessels.length === 0) {
    if (staticOnly.length > 0) await enrichStaticData(env, staticOnly);
    console.log(`[ingest] GLOBAL_SCAN_SUMMARY heard=0 candidates=${mmsis.length} drains=${attempts} missed=${missed.length} static_only=${staticOnly.length}`);
    return;
  }

  const existing = await loadVesselStates(env, vessels.map(v => v.mmsi));
  const nowMs = Date.now();
  const upserts: VesselUpsert[] = [];
  const positions: PositionInsert[] = [];
  let nMoved = 0, nHeartbeat = 0, nPhantom = 0, nSkipped = 0;
  const tierCounts: Record<Tier, number> = { direct: 0, local: 0, global: 0 };

  for (const v of vessels) {
    const prev = existing.get(v.mmsi);
    const tier = tierOf(v.lat, v.lon);
    tierCounts[tier]++;

    const prevExtent: MaxExtent = prev?.max_extent ?? initialExtent(v);
    const max_extent = tier === 'global' ? widenExtent(prevExtent, 'global') : prevExtent;

    const inDirect = tier === 'direct';
    const of_interest = prev !== undefined ? prev.of_interest : (inDirect ? 1 : 0);
    const firstDirect = inDirect && (prev === undefined || prev.of_interest === 0) ? nowMs : null;

    const { moved, effectiveSpeed, forceUpsert } = assessMovement(v, prev, tier, nowMs);
    const heartbeat = !moved && !forceUpsert && (prev === undefined || nowMs - prev.last_seen >= HEARTBEAT_MS);

    if (!moved && !heartbeat && !forceUpsert) { nSkipped++; continue; }

    const direct_entry_count = computeDirectEntryCount(prev, tier);

    upserts.push({
      mmsi: v.mmsi,
      name: v.name,
      vessel_type: v.vesselType,
      length: v.length,
      destination: v.destination,
      lat: v.lat,
      lon: v.lon,
      speed: effectiveSpeed,
      heading: v.heading,
      ts: nowMs,
      of_interest,
      max_extent,
      first_direct_at: firstDirect,
      direct_entry_count,
      moved,
      heartbeat,
      forceUpsert,
    });

    if (moved) {
      nMoved++;
      positions.push({ mmsi: v.mmsi, lat: v.lat, lon: v.lon, speed: effectiveSpeed, heading: v.heading, ts: nowMs, tier });
    } else if (forceUpsert) {
      nPhantom++;
      console.log(`[ingest] phantom speed: mmsi=${v.mmsi} reported=${v.speed}kn, pos stale ${Math.round((nowMs - (prev!.last_pos_ts ?? 0)) / 60000)}min`);
    } else {
      nHeartbeat++;
    }
  }

  console.log(
    `[ingest] GLOBAL_SCAN_SUMMARY heard=${vessels.length} candidates=${mmsis.length}` +
    ` drains=${attempts} missed=${missed.length} static_only=${staticOnly.length}` +
    ` zone_direct=${tierCounts.direct} zone_local=${tierCounts.local} zone_global=${tierCounts.global}` +
    ` moved=${nMoved} heartbeat=${nHeartbeat} phantom=${nPhantom} skipped=${nSkipped}`
  );
  await commitScan(env, upserts, positions);
  await enrichStaticData(env, staticOnly);
  console.log(`[ingest] GLOBAL_SCAN_DONE vessel_writes=${upserts.length} position_writes=${positions.length} static_only=${staticOnly.length} duration_ms=${Date.now() - start}`);
}
