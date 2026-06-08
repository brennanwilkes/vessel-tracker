import type { Env, Tier, MaxExtent, Vessel } from './types';
import {
  DIRECT_BOUNDING_BOX, LOCAL_BOUNDING_BOX, GLOBAL_BOUNDING_BOX,
  MOVE_THRESHOLD_NM, HEARTBEAT_MS,
  DIRECT_DRAIN_MS, LOCAL_DRAIN_MS, GLOBAL_DRAIN_MS,
} from './constants';
import { drainAisStream } from './aisstream';
import { pointInBox, isLargeVessel } from './ais';
import {
  loadVesselStates, commitScan, getOfInterestMmsis, widenExtent,
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

function hasMoved(v: Vessel, prev: VesselState | undefined, tier: Tier): boolean {
  if (prev === undefined || prev.last_lat === null || prev.last_lon === null) return true;
  return haversineNm(prev.last_lat, prev.last_lon, v.lat, v.lon) >= MOVE_THRESHOLD_NM[tier];
}

function tierOf(lat: number, lon: number): Tier {
  if (pointInBox(lat, lon, DIRECT_BOUNDING_BOX)) return 'direct';
  if (pointInBox(lat, lon, LOCAL_BOUNDING_BOX)) return 'local';
  return 'global';
}

export async function runDirectScan(env: Env): Promise<void> {
  const start = Date.now();
  console.log('[ingest] direct scan starting');

  const vessels = await drainAisStream({
    apiKey: env.AISSTREAM_API_KEY,
    boundingBox: DIRECT_BOUNDING_BOX,
    drainMs: DIRECT_DRAIN_MS,
  });

  if (vessels.length === 0) {
    console.warn('[ingest] direct scan — 0 vessels heard');
    return;
  }

  const existing = await loadVesselStates(env, vessels.map(v => v.mmsi));
  const nowMs = Date.now();
  const upserts: VesselUpsert[] = [];
  const positions: PositionInsert[] = [];
  let nMoved = 0, nHeartbeat = 0, nSkipped = 0;

  for (const v of vessels) {
    const prev = existing.get(v.mmsi);
    const moved = hasMoved(v, prev, 'direct');
    const heartbeat = !moved && (prev === undefined || nowMs - prev.last_seen >= HEARTBEAT_MS);

    if (!moved && !heartbeat) { nSkipped++; continue; }

    const firstDirect = (prev === undefined || prev.of_interest === 0) ? nowMs : null;

    upserts.push({
      mmsi: v.mmsi,
      name: v.name,
      vessel_type: v.vesselType,
      length: v.length,
      destination: v.destination,
      lat: v.lat,
      lon: v.lon,
      speed: v.speed,
      heading: v.heading,
      ts: nowMs,
      of_interest: 1,
      max_extent: 'direct',
      first_direct_at: firstDirect,
      moved,
      heartbeat,
    });

    if (moved) {
      nMoved++;
      positions.push({ mmsi: v.mmsi, lat: v.lat, lon: v.lon, speed: v.speed, heading: v.heading, ts: nowMs, tier: 'direct' });
    } else {
      nHeartbeat++;
    }
  }

  console.log(`[ingest] direct scan — ${vessels.length} heard | ${nMoved} moved, ${nHeartbeat} heartbeat, ${nSkipped} no-change`);
  await commitScan(env, upserts, positions);
  console.log(`[ingest] direct scan done — ${upserts.length} writes (${positions.length} pos) in ${Date.now() - start}ms`);
}

export async function runLocalScan(env: Env): Promise<void> {
  const start = Date.now();
  console.log('[ingest] local scan starting');

  const vessels = await drainAisStream({
    apiKey: env.AISSTREAM_API_KEY,
    boundingBox: LOCAL_BOUNDING_BOX,
    drainMs: LOCAL_DRAIN_MS,
  });

  if (vessels.length === 0) {
    console.warn('[ingest] local scan — 0 vessels heard');
    return;
  }

  const existing = await loadVesselStates(env, vessels.map(v => v.mmsi));
  const nowMs = Date.now();
  const upserts: VesselUpsert[] = [];
  const positions: PositionInsert[] = [];
  let nFiltered = 0, nMoved = 0, nHeartbeat = 0, nSkipped = 0;
  let nInDirect = 0;

  for (const v of vessels) {
    const prev = existing.get(v.mmsi);

    if (!isLargeVessel(v.vesselType, v.length) && prev === undefined) { nFiltered++; continue; }

    const inDirect = pointInBox(v.lat, v.lon, DIRECT_BOUNDING_BOX);
    if (inDirect) nInDirect++;

    const of_interest = inDirect || (prev !== undefined && prev.of_interest === 1) ? 1 : 0;
    const firstDirect = inDirect && (prev === undefined || prev.of_interest === 0) ? nowMs : null;

    const prevExtent: MaxExtent = prev?.max_extent ?? 'direct';
    const max_extent = inDirect ? prevExtent : widenExtent(prevExtent, 'local');

    const tier: Tier = inDirect ? 'direct' : 'local';
    const moved = hasMoved(v, prev, tier);
    const heartbeat = !moved && (prev === undefined || nowMs - prev.last_seen >= HEARTBEAT_MS);

    if (!moved && !heartbeat) { nSkipped++; continue; }

    upserts.push({
      mmsi: v.mmsi,
      name: v.name,
      vessel_type: v.vesselType,
      length: v.length,
      destination: v.destination,
      lat: v.lat,
      lon: v.lon,
      speed: v.speed,
      heading: v.heading,
      ts: nowMs,
      of_interest,
      max_extent,
      first_direct_at: firstDirect,
      moved,
      heartbeat,
    });

    if (moved) {
      nMoved++;
      positions.push({ mmsi: v.mmsi, lat: v.lat, lon: v.lon, speed: v.speed, heading: v.heading, ts: nowMs, tier });
    } else {
      nHeartbeat++;
    }
  }

  console.log(
    `[ingest] local scan — ${vessels.length} heard | ${nFiltered} filtered (small/untracked), ${nInDirect} in direct box` +
    ` | ${nMoved} moved, ${nHeartbeat} heartbeat, ${nSkipped} no-change`
  );
  await commitScan(env, upserts, positions);
  console.log(`[ingest] local scan done — ${upserts.length} writes (${positions.length} pos) in ${Date.now() - start}ms`);
}

export async function runGlobalScan(env: Env): Promise<void> {
  const start = Date.now();
  console.log('[ingest] global scan starting');

  const mmsis = await getOfInterestMmsis(env);
  if (mmsis.length === 0) {
    console.log('[ingest] global scan skipped — no of-interest vessels yet');
    return;
  }

  console.log(`[ingest] global scan — querying ${mmsis.length} of-interest MMSIs`);

  const vessels = await drainAisStream({
    apiKey: env.AISSTREAM_API_KEY,
    boundingBox: GLOBAL_BOUNDING_BOX,
    mmsis,
    drainMs: GLOBAL_DRAIN_MS,
  });

  if (vessels.length === 0) {
    console.log(`[ingest] global scan — 0 of ${mmsis.length} queried vessels heard (outside coverage or not transmitting)`);
    return;
  }

  const existing = await loadVesselStates(env, vessels.map(v => v.mmsi));
  const nowMs = Date.now();
  const upserts: VesselUpsert[] = [];
  const positions: PositionInsert[] = [];
  let nMoved = 0, nHeartbeat = 0, nSkipped = 0;
  const tierCounts: Record<Tier, number> = { direct: 0, local: 0, global: 0 };

  for (const v of vessels) {
    const prev = existing.get(v.mmsi);
    const tier = tierOf(v.lat, v.lon);
    tierCounts[tier]++;

    const prevExtent: MaxExtent = prev?.max_extent ?? 'direct';
    const max_extent = tier === 'global' ? widenExtent(prevExtent, 'global') : prevExtent;

    const inDirect = tier === 'direct';
    const of_interest = prev !== undefined ? prev.of_interest : (inDirect ? 1 : 0);
    const firstDirect = inDirect && (prev === undefined || prev.of_interest === 0) ? nowMs : null;

    const moved = hasMoved(v, prev, tier);
    const heartbeat = !moved && (prev === undefined || nowMs - prev.last_seen >= HEARTBEAT_MS);

    if (!moved && !heartbeat) { nSkipped++; continue; }

    upserts.push({
      mmsi: v.mmsi,
      name: v.name,
      vessel_type: v.vesselType,
      length: v.length,
      destination: v.destination,
      lat: v.lat,
      lon: v.lon,
      speed: v.speed,
      heading: v.heading,
      ts: nowMs,
      of_interest,
      max_extent,
      first_direct_at: firstDirect,
      moved,
      heartbeat,
    });

    if (moved) {
      nMoved++;
      positions.push({ mmsi: v.mmsi, lat: v.lat, lon: v.lon, speed: v.speed, heading: v.heading, ts: nowMs, tier });
    } else {
      nHeartbeat++;
    }
  }

  console.log(
    `[ingest] global scan — ${vessels.length}/${mmsis.length} heard` +
    ` | by zone: ${tierCounts.direct} direct, ${tierCounts.local} local, ${tierCounts.global} global` +
    ` | ${nMoved} moved, ${nHeartbeat} heartbeat, ${nSkipped} no-change`
  );
  await commitScan(env, upserts, positions);
  console.log(`[ingest] global scan done — ${upserts.length} writes (${positions.length} pos) in ${Date.now() - start}ms`);
}
