import type { Env, Tier, MaxExtent, Vessel } from './types';
import {
  DIRECT_BOUNDING_BOX, LOCAL_BOUNDING_BOX, GLOBAL_BOUNDING_BOX,
  HEARTBEAT_MS, HEARTBEAT_BACKOFF,
  DIRECT_DRAIN_MS, LOCAL_DRAIN_MS, GLOBAL_DRAIN_MS,
  PHANTOM_SPEED_MIN_KN, PHANTOM_STALL_MS,
  GLOBAL_MMSI_CHUNK_SIZE, GLOBAL_SCAN_ATTEMPTS, GLOBAL_SCAN_BUDGET_MS,
  LIVE_TTL_LOCAL_MS, ZONE_VISIT_THROTTLE_MS,
  FOREIGN_DRAIN_MS, FOREIGN_SCAN_BOX_BATCH, FOREIGN_REFRESH_MS, FOREIGN_MAX_NEW_PER_SCAN, FOREIGN_RELEVANCE,
  FOREIGN_POSITION_THROTTLE_MS, FOREIGN_MAX_POSITIONS_PER_SCAN,
} from './constants';
import { isSignificantMove } from './compress';
import { drainAisStream } from './aisstream';
import { pointInBox, isLargeVessel, isConfirmedSmall } from './ais';
import { zoneOf, ZONES } from './zones';
import {
  loadVesselStates, commitScan, enrichStaticData, getOfInterestMmsis, widenExtent,
  commitZoneVisits, loadForeignStates, loadZoneVisitKeys, getScanCursor, setScanCursor,
  type VesselUpsert, type PositionInsert, type VesselState, type ZoneObservation,
} from './storage';

// Stationary vessels heartbeat less often the longer they've been parked.
function heartbeatIntervalMs(prev: VesselState | undefined, nowMs: number): number {
  if (prev === undefined || prev.last_pos_ts === null) return HEARTBEAT_MS;
  const parkedMs = nowMs - prev.last_pos_ts;
  for (const step of HEARTBEAT_BACKOFF) {
    if (parkedMs > step.parkedMs) return step.intervalMs;
  }
  return HEARTBEAT_MS;
}

function assessMovement(v: Vessel, prev: VesselState | undefined, tier: Tier, nowMs: number): { moved: boolean; effectiveSpeed: number | null; forceUpsert: boolean } {
  if (prev === undefined || prev.last_lat === null || prev.last_lon === null) {
    return { moved: true, effectiveSpeed: v.speed, forceUpsert: false };
  }
  if (tier === 'direct' && v.speed !== null && v.speed >= PHANTOM_SPEED_MIN_KN) {
    // Escape hatch: a significant real move always wins, even for a vessel previously
    // flagged phantom — otherwise the flag is permanent (last_pos_ts only advances on a
    // position row). MOVE_PROFILE.direct.maxGapMs (3 min) < PHANTOM_STALL_MS (20 min),
    // so a straight-moving vessel emits — and refreshes last_pos_ts — well before it
    // could be mistaken for phantom.
    if (isSignificantMove(v, prev, tier, nowMs)) {
      return { moved: true, effectiveSpeed: v.speed, forceUpsert: false };
    }
    const posAge = prev.last_pos_ts !== null ? nowMs - prev.last_pos_ts : null;
    if (posAge !== null && posAge > PHANTOM_STALL_MS) {
      // alreadyCorrected reads vessels.last_speed (the phantom flag a prior forceUpsert
      // set to 0), NOT prev.last_speed — which is now the positions-sourced last emitted
      // speed and would never be 0 here, re-firing the correction every scan.
      const alreadyCorrected = prev.vessel_last_speed === 0;
      return { moved: false, effectiveSpeed: 0, forceUpsert: !alreadyCorrected };
    }
    return { moved: false, effectiveSpeed: v.speed, forceUpsert: false };
  }
  return { moved: isSignificantMove(v, prev, tier, nowMs), effectiveSpeed: v.speed, forceUpsert: false };
}

// A moved vessel no longer writes a vessels row on every emit — its position goes to the
// `positions` table and the movement reference is read back from there (loadVesselStates).
// We still write the vessels row when METADATA changed or a heartbeat is due, so
// last_seen / of_interest / max_extent / direct_entry_count stay current and the vessel
// keeps its TTL on /current. A steady mover with stable metadata writes positions only —
// that's the write saving (decoupling the per-move vessels upsert).
function vesselRowNeedsWrite(prev: VesselState | undefined, of_interest: number, max_extent: MaxExtent, firstDirect: number | null, direct_entry_count: number, nowMs: number): boolean {
  if (prev === undefined) return true;
  if (of_interest !== prev.of_interest) return true;
  if (max_extent !== prev.max_extent) return true;
  if (firstDirect !== null) return true;
  if (direct_entry_count !== prev.direct_entry_count) return true;
  return (nowMs - prev.last_seen) >= heartbeatIntervalMs(prev, nowMs);
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

  // Named-destination attribution — record every heard vessel that's inside a zone,
  // regardless of movement/tier. Local zones are covered for free here; of-interest
  // vessels heard worldwide by the global scan also get foreign attribution for free.
  const zoneObs: ZoneObservation[] = [];
  for (const zv of vessels) {
    const zid = zoneOf(zv.lat, zv.lon);
    if (zid !== null) zoneObs.push({ mmsi: zv.mmsi, zone_id: zid, lat: zv.lat, lon: zv.lon, ts: nowMs });
  }
  const upserts: VesselUpsert[] = [];
  const positions: PositionInsert[] = [];
  let nMoved = 0, nHeartbeat = 0, nPhantom = 0, nSkipped = 0;

  for (const v of vessels) {
    const prev = existing.get(v.mmsi);
    const { moved, effectiveSpeed, forceUpsert } = assessMovement(v, prev, 'direct', nowMs);

    const firstDirect = (prev === undefined || prev.of_interest === 0) ? nowMs : null;
    const direct_entry_count = computeDirectEntryCount(prev, 'direct');
    const max_extent: MaxExtent = prev?.max_extent ?? initialExtent(v);
    const writeVessel = forceUpsert || vesselRowNeedsWrite(prev, 1, max_extent, firstDirect, direct_entry_count, nowMs);

    if (!moved && !writeVessel) { nSkipped++; continue; }

    if (moved) {
      nMoved++;
      positions.push({ mmsi: v.mmsi, lat: v.lat, lon: v.lon, speed: effectiveSpeed, heading: v.heading, ts: nowMs, tier: 'direct' });
    } else if (forceUpsert) {
      nPhantom++;
      console.log(`[ingest] phantom speed: mmsi=${v.mmsi} reported=${v.speed}kn, pos stale ${Math.round((nowMs - (prev!.last_pos_ts ?? 0)) / 60000)}min`);
    } else {
      nHeartbeat++;
    }

    if (writeVessel) {
      upserts.push({
        mmsi: v.mmsi, name: v.name, vessel_type: v.vesselType, length: v.length, destination: v.destination,
        lat: v.lat, lon: v.lon, speed: effectiveSpeed, heading: v.heading, ts: nowMs,
        of_interest: 1, max_extent, first_direct_at: firstDirect, direct_entry_count,
        moved, heartbeat: !moved && !forceUpsert, forceUpsert,
      });
    }
  }

  console.log(`[ingest] direct scan — ${vessels.length} heard | ${nMoved} moved, ${nHeartbeat} heartbeat, ${nPhantom} phantom, ${nSkipped} no-change`);
  await commitScan(env, upserts, positions);
  await commitZoneVisits(env, zoneObs, ZONE_VISIT_THROTTLE_MS);
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

  // Named-destination attribution — record every heard vessel that's inside a zone,
  // regardless of movement/tier. Local zones are covered for free here; of-interest
  // vessels heard worldwide by the global scan also get foreign attribution for free.
  const zoneObs: ZoneObservation[] = [];
  for (const zv of vessels) {
    const zid = zoneOf(zv.lat, zv.lon);
    if (zid !== null) zoneObs.push({ mmsi: zv.mmsi, zone_id: zid, lat: zv.lat, lon: zv.lon, ts: nowMs });
  }
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
    const direct_entry_count = computeDirectEntryCount(prev, tier);
    const writeVessel = forceUpsert || vesselRowNeedsWrite(prev, of_interest, max_extent, firstDirect, direct_entry_count, nowMs);

    if (!moved && !writeVessel) { nSkipped++; continue; }

    if (moved) {
      nMoved++;
      positions.push({ mmsi: v.mmsi, lat: v.lat, lon: v.lon, speed: effectiveSpeed, heading: v.heading, ts: nowMs, tier });
    } else if (forceUpsert) {
      nPhantom++;
      console.log(`[ingest] phantom speed: mmsi=${v.mmsi} reported=${v.speed}kn, pos stale ${Math.round((nowMs - (prev!.last_pos_ts ?? 0)) / 60000)}min`);
    } else {
      nHeartbeat++;
    }

    if (writeVessel) {
      upserts.push({
        mmsi: v.mmsi, name: v.name, vessel_type: v.vesselType, length: v.length, destination: v.destination,
        lat: v.lat, lon: v.lon, speed: effectiveSpeed, heading: v.heading, ts: nowMs,
        of_interest, max_extent, first_direct_at: firstDirect, direct_entry_count,
        moved, heartbeat: !moved && !forceUpsert, forceUpsert,
      });
    }
  }

  console.log(
    `[ingest] local scan — ${vessels.length} heard | ${nFiltered} filtered (small/untracked), ${nInDirect} in direct box` +
    ` | ${nMoved} moved, ${nHeartbeat} heartbeat, ${nPhantom} phantom, ${nSkipped} no-change`
  );
  await commitScan(env, upserts, positions);
  await commitZoneVisits(env, zoneObs, ZONE_VISIT_THROTTLE_MS);
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

  // Named-destination attribution — record every heard vessel that's inside a zone,
  // regardless of movement/tier. Local zones are covered for free here; of-interest
  // vessels heard worldwide by the global scan also get foreign attribution for free.
  const zoneObs: ZoneObservation[] = [];
  for (const zv of vessels) {
    const zid = zoneOf(zv.lat, zv.lon);
    if (zid !== null) zoneObs.push({ mmsi: zv.mmsi, zone_id: zid, lat: zv.lat, lon: zv.lon, ts: nowMs });
  }
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
    const direct_entry_count = computeDirectEntryCount(prev, tier);
    const writeVessel = forceUpsert || vesselRowNeedsWrite(prev, of_interest, max_extent, firstDirect, direct_entry_count, nowMs);

    if (!moved && !writeVessel) { nSkipped++; continue; }

    if (moved) {
      nMoved++;
      positions.push({ mmsi: v.mmsi, lat: v.lat, lon: v.lon, speed: effectiveSpeed, heading: v.heading, ts: nowMs, tier });
    } else if (forceUpsert) {
      nPhantom++;
      console.log(`[ingest] phantom speed: mmsi=${v.mmsi} reported=${v.speed}kn, pos stale ${Math.round((nowMs - (prev!.last_pos_ts ?? 0)) / 60000)}min`);
    } else {
      nHeartbeat++;
    }

    if (writeVessel) {
      upserts.push({
        mmsi: v.mmsi, name: v.name, vessel_type: v.vesselType, length: v.length, destination: v.destination,
        lat: v.lat, lon: v.lon, speed: effectiveSpeed, heading: v.heading, ts: nowMs,
        of_interest, max_extent, first_direct_at: firstDirect, direct_entry_count,
        moved, heartbeat: !moved && !forceUpsert, forceUpsert,
      });
    }
  }

  console.log(
    `[ingest] GLOBAL_SCAN_SUMMARY heard=${vessels.length} candidates=${mmsis.length}` +
    ` drains=${attempts} missed=${missed.length} static_only=${staticOnly.length}` +
    ` zone_direct=${tierCounts.direct} zone_local=${tierCounts.local} zone_global=${tierCounts.global}` +
    ` moved=${nMoved} heartbeat=${nHeartbeat} phantom=${nPhantom} skipped=${nSkipped}`
  );
  await commitScan(env, upserts, positions);
  await commitZoneVisits(env, zoneObs, ZONE_VISIT_THROTTLE_MS);
  await enrichStaticData(env, staticOnly);
  console.log(`[ingest] GLOBAL_SCAN_DONE vessel_writes=${upserts.length} position_writes=${positions.length} static_only=${staticOnly.length} duration_ms=${Date.now() - start}`);
}

const FOREIGN_SCAN_CURSOR = 'foreign_scan_cursor';
const FOREIGN_ZONES = ZONES.filter(z => z.reach === 'foreign');

// Is a vessel at a foreign port plausibly bound for the local viewshed (so worth
// pre-seeding)? Size is the primary signal — a ≥bigLenM ship anywhere on the Pacific
// rim is ocean-going and could route here. A smaller-but-still-large vessel qualifies
// only if its AIS destination names a NA-Pacific-NW port; the type clause keeps the
// destination case to passenger/cargo/tanker (60–89) so an unknown-length workboat with
// a coincidental destination string isn't tracked.
function isForeignInbound(type: number | null, len: number | null, dest: string | null): boolean {
  if (len !== null && len >= FOREIGN_RELEVANCE.bigLenM) return true;
  const destMatch = dest !== null && FOREIGN_RELEVANCE.destPatterns.some(p => dest.toUpperCase().includes(p));
  if (!destMatch) return false;
  if (len !== null && len >= FOREIGN_RELEVANCE.midLenM) return true;
  return type !== null && type >= 60 && type <= 89; // unknown length, but inbound + ocean-going type
}

// Rotating foreign scan — see constants.ts "Rotating foreign scan". Drains a rotating
// slice of distant port boxes in one connection (no MMSI filter), then ingests only
// large/plausibly-inbound vessels frugally: of-interest + a zone visit + a single anchor
// position on first entry to a port. Functions like the local scan (skip confirmed-small
// new vessels, keep an initial row for unknown types to enrich+reclassify later).
export async function runForeignScan(env: Env): Promise<void> {
  const start = Date.now();
  if (FOREIGN_ZONES.length === 0) { console.log('[ingest] FOREIGN_SCAN_SKIPPED reason=no_foreign_zones'); return; }

  const cursor = await getScanCursor(env, FOREIGN_SCAN_CURSOR);
  const startIdx = cursor % FOREIGN_ZONES.length;
  const slice: typeof FOREIGN_ZONES = [];
  for (let i = 0; i < FOREIGN_SCAN_BOX_BATCH && i < FOREIGN_ZONES.length; i++) {
    slice.push(FOREIGN_ZONES[(startIdx + i) % FOREIGN_ZONES.length]);
  }
  const nextCursor = (startIdx + slice.length) % FOREIGN_ZONES.length;
  console.log(`[ingest] FOREIGN_SCAN_START ports=${slice.map(z => z.id).join(',')} cursor=${startIdx}->${nextCursor}`);

  const { vessels } = await drainAisStream({
    apiKey: env.AISSTREAM_API_KEY,
    boundingBoxes: slice.map(z => z.box),
    drainMs: FOREIGN_DRAIN_MS,
  });

  // Advance the cursor regardless of yield so a quiet port can't stall the rotation.
  await setScanCursor(env, FOREIGN_SCAN_CURSOR, nextCursor);

  if (vessels.length === 0) {
    console.log(`[ingest] FOREIGN_SCAN_SUMMARY heard=0 ports=${slice.length} duration_ms=${Date.now() - start}`);
    return;
  }

  const mmsis = vessels.map(v => v.mmsi);
  const fstates = await loadForeignStates(env, mmsis);
  const visitKeys = await loadZoneVisitKeys(env, mmsis);
  const nowMs = Date.now();

  const upserts: VesselUpsert[] = [];
  const positions: PositionInsert[] = [];
  const zoneObs: ZoneObservation[] = [];
  const heardByPort: Record<string, number> = {};
  let nRelevant = 0, nInitial = 0, nFilteredSmall = 0, nSkipped = 0, nPositions = 0;

  for (const v of vessels) {
    const zid = zoneOf(v.lat, v.lon);
    if (zid === null) continue; // heard just outside a port box edge
    heardByPort[zid] = (heardByPort[zid] ?? 0) + 1;

    const fs = fstates.get(v.mmsi);
    const isNew = fs === undefined;
    const type = v.vesselType ?? fs?.vessel_type ?? null;
    const len = v.length ?? fs?.length ?? null;
    const alreadyOI = fs?.of_interest === 1;

    // Known-small new vessel → never track (same gate as the local scan).
    if (!alreadyOI && isNew && isConfirmedSmall(type, len)) { nFilteredSmall++; continue; }

    if (alreadyOI || isForeignInbound(type, len, v.destination)) {
      nRelevant++;
      zoneObs.push({ mmsi: v.mmsi, zone_id: zid, lat: v.lat, lon: v.lon, ts: nowMs });
      const newZone = !visitKeys.has(`${v.mmsi}|${zid}`);
      const refresh = isNew || (nowMs - fs!.last_seen) >= FOREIGN_REFRESH_MS;

      // Sparse port-dwell track: a position on first zone entry, then at most one per
      // FOREIGN_POSITION_THROTTLE_MS while the vessel stays in the zone. last_pos_ts comes
      // from the latest positions row, so each write self-advances the throttle. The
      // per-scan cap is the hard ceiling on daily foreign writes (96 scans × cap).
      const posStale = !isNew && fs!.last_pos_ts !== null && (nowMs - fs!.last_pos_ts) >= FOREIGN_POSITION_THROTTLE_MS;
      const writePos = (newZone || posStale) && nPositions < FOREIGN_MAX_POSITIONS_PER_SCAN;

      if (refresh || writePos) {
        upserts.push({
          mmsi: v.mmsi, name: v.name, vessel_type: v.vesselType, length: v.length, destination: v.destination,
          lat: v.lat, lon: v.lon, speed: v.speed, heading: v.heading, ts: nowMs,
          of_interest: 1, max_extent: 'global', first_direct_at: null, direct_entry_count: 0,
          moved: false, heartbeat: true, forceUpsert: false,
        });
      }
      if (writePos) {
        positions.push({ mmsi: v.mmsi, lat: v.lat, lon: v.lon, speed: v.speed, heading: v.heading, ts: nowMs, tier: 'global' });
        nPositions++;
      }
    } else if (isNew && nInitial < FOREIGN_MAX_NEW_PER_SCAN) {
      // Unknown type/length (not confirmed small, not yet relevant): one initial row so a
      // later ping can enrich its static data and reclassify it. No zone visit, no position.
      nInitial++;
      upserts.push({
        mmsi: v.mmsi, name: v.name, vessel_type: v.vesselType, length: v.length, destination: v.destination,
        lat: v.lat, lon: v.lon, speed: v.speed, heading: v.heading, ts: nowMs,
        of_interest: 0, max_extent: 'global', first_direct_at: null, direct_entry_count: 0,
        moved: false, heartbeat: true, forceUpsert: false,
      });
    } else {
      nSkipped++; // re-seen unknown (already has a row), or the per-scan initial-row cap was hit
    }
  }

  await commitScan(env, upserts, positions);
  await commitZoneVisits(env, zoneObs, ZONE_VISIT_THROTTLE_MS);

  const portBreakdown = Object.entries(heardByPort).map(([z, n]) => `${z}:${n}`).join(' ');
  console.log(
    `[ingest] FOREIGN_SCAN_SUMMARY heard=${vessels.length} ports=${slice.length}` +
    ` | relevant=${nRelevant} initial_rows=${nInitial} small_filtered=${nFilteredSmall} skipped=${nSkipped}` +
    ` | vessel_writes=${upserts.length} positions=${nPositions} zone_obs=${zoneObs.length}` +
    ` | by_port: ${portBreakdown} | duration_ms=${Date.now() - start}`
  );
}
