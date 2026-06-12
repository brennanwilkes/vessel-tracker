import type { Env, VesselRow, PositionRow, InferredRow, StaticUpdate, Tier, MaxExtent } from './types';

const EXTENT_ORDER: Record<MaxExtent, number> = { direct: 0, local: 1, global: 2 };

export function widenExtent(current: MaxExtent, candidate: MaxExtent): MaxExtent {
  return EXTENT_ORDER[candidate] > EXTENT_ORDER[current] ? candidate : current;
}

export interface VesselState {
  mmsi: number;
  last_lat: number | null;
  last_lon: number | null;
  last_speed: number | null;
  last_heading: number | null;
  last_pos_ts: number | null;
  last_seen: number;
  of_interest: number;
  max_extent: MaxExtent;
  direct_entry_count: number;
}

export interface VesselUpsert {
  mmsi: number;
  name: string | null;
  vessel_type: number | null;
  length: number | null;
  destination: string | null;
  lat: number;
  lon: number;
  speed: number | null;
  heading: number | null;
  ts: number;
  of_interest: number;
  max_extent: MaxExtent;
  first_direct_at: number | null;
  direct_entry_count: number;
  moved: boolean;
  heartbeat: boolean;
  forceUpsert: boolean;
}

export interface PositionInsert {
  mmsi: number;
  lat: number;
  lon: number;
  speed: number | null;
  heading: number | null;
  ts: number;
  tier: Tier;
}

const MMSI_CHUNK = 99; // D1 caps bound parameters per statement at 100

export async function loadVesselStates(env: Env, mmsis: number[]): Promise<Map<number, VesselState>> {
  if (mmsis.length === 0) return new Map();

  const chunks: number[][] = [];
  for (let i = 0; i < mmsis.length; i += MMSI_CHUNK) {
    chunks.push(mmsis.slice(i, i + MMSI_CHUNK));
  }

  const stmts = chunks.map(chunk => {
    const placeholders = chunk.map((_, i) => `?${i + 1}`).join(',');
    return env.VESSELS_DB
      .prepare(`SELECT mmsi,last_lat,last_lon,last_speed,last_heading,last_pos_ts,last_seen,of_interest,max_extent,direct_entry_count FROM vessels WHERE mmsi IN (${placeholders})`)
      .bind(...chunk);
  });

  const results = await env.VESSELS_DB.batch<VesselState>(stmts);
  const map = new Map<number, VesselState>();
  for (const result of results) {
    for (const row of result.results) {
      map.set(row.mmsi, row);
    }
  }
  return map;
}

export async function commitScan(env: Env, vessels: VesselUpsert[], positions: PositionInsert[]): Promise<void> {
  const stmts: D1PreparedStatement[] = [];

  for (const v of vessels) {
    if (v.moved) {
      stmts.push(
        env.VESSELS_DB.prepare(
          `INSERT INTO vessels (mmsi,name,vessel_type,length,destination,last_lat,last_lon,last_speed,last_heading,last_pos_ts,last_seen,first_seen,of_interest,max_extent,first_direct_at,direct_entry_count,times_seen)
           VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?10,?10,?11,?12,?13,?14,1)
           ON CONFLICT(mmsi) DO UPDATE SET
             name                = COALESCE(?2, name),
             vessel_type         = COALESCE(?3, vessel_type),
             length              = COALESCE(?4, length),
             destination         = COALESCE(?5, destination),
             last_lat            = ?6,
             last_lon            = ?7,
             last_speed          = ?8,
             last_heading        = ?9,
             last_pos_ts         = ?10,
             last_seen           = ?10,
             of_interest         = MAX(of_interest, ?11),
             max_extent          = ?12,
             first_direct_at     = COALESCE(first_direct_at, ?13),
             direct_entry_count  = MAX(direct_entry_count, ?14),
             times_seen          = times_seen + 1`
        ).bind(
          v.mmsi, v.name, v.vessel_type, v.length, v.destination,
          v.lat, v.lon, v.speed, v.heading, v.ts,
          v.of_interest, v.max_extent, v.first_direct_at, v.direct_entry_count
        )
      );
    } else if (v.heartbeat) {
      stmts.push(
        env.VESSELS_DB.prepare(
          `INSERT INTO vessels (mmsi,name,vessel_type,length,destination,last_lat,last_lon,last_speed,last_heading,last_seen,first_seen,of_interest,max_extent,first_direct_at,direct_entry_count,times_seen)
           VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?10,?11,?12,?13,?14,1)
           ON CONFLICT(mmsi) DO UPDATE SET
             name               = COALESCE(?2, name),
             vessel_type        = COALESCE(?3, vessel_type),
             length             = COALESCE(?4, length),
             destination        = COALESCE(?5, destination),
             last_lat           = ?6,
             last_lon           = ?7,
             last_speed         = ?8,
             last_heading       = ?9,
             last_seen          = ?10,
             of_interest        = MAX(of_interest, ?11),
             max_extent         = ?12,
             first_direct_at    = COALESCE(first_direct_at, ?13),
             direct_entry_count = MAX(direct_entry_count, ?14),
             times_seen         = times_seen + 1`
        ).bind(
          v.mmsi, v.name, v.vessel_type, v.length, v.destination,
          v.lat, v.lon, v.speed, v.heading, v.ts,
          v.of_interest, v.max_extent, v.first_direct_at, v.direct_entry_count
        )
      );
    } else if (v.forceUpsert) {
      stmts.push(
        env.VESSELS_DB.prepare(
          `UPDATE vessels SET last_speed = ?2, last_seen = ?3, times_seen = times_seen + 1 WHERE mmsi = ?1`
        ).bind(v.mmsi, v.speed, v.ts)
      );
    }
  }

  for (const p of positions) {
    stmts.push(
      env.VESSELS_DB.prepare(
        `INSERT INTO positions (mmsi,lat,lon,speed,heading,ts,tier) VALUES (?1,?2,?3,?4,?5,?6,?7)`
      ).bind(p.mmsi, p.lat, p.lon, p.speed, p.heading, p.ts, p.tier)
    );
  }

  if (stmts.length > 0) {
    await env.VESSELS_DB.batch(stmts);
  }
}

// Only updates rows that already exist AND are still missing static fields — avoids
// burning write quota on rows that are already fully enriched.
// Also promotes of_interest=1 if the vessel now qualifies as large (cargo/tanker/>=50m),
// so it gets included in the global scan even if static data arrived after first position.
export async function enrichStaticData(env: Env, updates: StaticUpdate[]): Promise<void> {
  if (updates.length === 0) return;
  const stmts = updates.map(u =>
    env.VESSELS_DB.prepare(
      `UPDATE vessels SET
         name        = COALESCE(?2, name),
         vessel_type = COALESCE(?3, vessel_type),
         length      = COALESCE(?4, length),
         destination = COALESCE(?5, destination),
         of_interest = CASE
           WHEN of_interest = 1 THEN 1
           WHEN (?3 >= 70 AND ?3 <= 89) THEN 1
           WHEN (?3 >= 60 AND ?3 <= 69 AND COALESCE(?4, length) >= 50) THEN 1
           WHEN COALESCE(?4, length) >= 50 THEN 1
           ELSE of_interest
         END,
         max_extent = CASE
           WHEN max_extent = 'direct' AND (
             (?3 >= 70 AND ?3 <= 89)
             OR (?3 >= 60 AND ?3 <= 69 AND COALESCE(?4, length) >= 50)
             OR COALESCE(?4, length) >= 50
           ) THEN 'local'
           ELSE max_extent
         END
       WHERE mmsi = ?1
         AND (vessel_type IS NULL OR length IS NULL OR destination IS NULL)`
    ).bind(u.mmsi, u.name, u.vesselType, u.length, u.destination)
  );
  await env.VESSELS_DB.batch(stmts);
}

export interface ZoneObservation {
  mmsi: number;
  zone_id: string;
  lat: number;
  lon: number;
  ts: number;
}

// Record "vessel was in named zone" events (saturating: one row per (mmsi, zone_id)).
// New (mmsi, zone) → INSERT (first_ts=last_ts). Already present → bump last_ts/lat/lon
// only if the throttle window elapsed since the last write (a parked ship doesn't
// re-write every scan). Never deletes; growth is bounded by the vessel×zone matrix.
export async function commitZoneVisits(env: Env, obs: ZoneObservation[], throttleMs: number): Promise<void> {
  if (obs.length === 0) return;

  const mmsis = [...new Set(obs.map(o => o.mmsi))];
  const lastSeenInZone = new Map<string, number>(); // `${mmsi}|${zone_id}` -> last_ts
  for (let i = 0; i < mmsis.length; i += MMSI_CHUNK) {
    const chunk = mmsis.slice(i, i + MMSI_CHUNK);
    const placeholders = chunk.map((_, k) => `?${k + 1}`).join(',');
    const res = await env.VESSELS_DB
      .prepare(`SELECT mmsi,zone_id,last_ts FROM zone_visits WHERE mmsi IN (${placeholders})`)
      .bind(...chunk)
      .all<{ mmsi: number; zone_id: string; last_ts: number }>();
    for (const r of res.results) lastSeenInZone.set(`${r.mmsi}|${r.zone_id}`, r.last_ts);
  }

  const stmts: D1PreparedStatement[] = [];
  for (const o of obs) {
    const prev = lastSeenInZone.get(`${o.mmsi}|${o.zone_id}`);
    if (prev === undefined) {
      stmts.push(
        env.VESSELS_DB
          .prepare(`INSERT INTO zone_visits (mmsi,zone_id,first_ts,last_ts,lat,lon) VALUES (?1,?2,?3,?3,?4,?5)
                    ON CONFLICT(mmsi,zone_id) DO UPDATE SET last_ts=?3, lat=?4, lon=?5`)
          .bind(o.mmsi, o.zone_id, o.ts, o.lat, o.lon)
      );
    } else if (o.ts - prev >= throttleMs) {
      stmts.push(
        env.VESSELS_DB
          .prepare(`UPDATE zone_visits SET last_ts=?3, lat=?4, lon=?5 WHERE mmsi=?1 AND zone_id=?2`)
          .bind(o.mmsi, o.zone_id, o.ts, o.lat, o.lon)
      );
    }
  }
  if (stmts.length > 0) await env.VESSELS_DB.batch(stmts);
}

export async function getCurrentVessels(env: Env, directTtlMs: number, localTtlMs: number, globalTtlMs: number): Promise<VesselRow[]> {
  const now = Date.now();
  const directCutoff = now - directTtlMs;
  const localCutoff = now - localTtlMs;
  const globalCutoff = now - globalTtlMs;
  const result = await env.VESSELS_DB
    .prepare(
      `SELECT mmsi,name,vessel_type,length,destination,
              last_lat AS lat,last_lon AS lon,last_speed AS speed,last_heading AS heading,
              last_pos_ts,last_seen,max_extent,
              first_direct_at,direct_entry_count
       FROM vessels WHERE of_interest = 1 AND first_direct_at IS NOT NULL
         AND (
           (max_extent = 'direct' AND last_seen >= ?1)
           OR (max_extent = 'local' AND last_seen >= ?3)
           OR (max_extent = 'global' AND last_seen >= ?3)
         )
       ORDER BY last_seen DESC`
    )
    .bind(directCutoff, localCutoff, globalCutoff)
    .all<VesselRow>();
  return result.results;
}

export async function getTrack(env: Env, mmsi: number, tiers: Tier[], limit: number): Promise<PositionRow[]> {
  if (tiers.length === 0) {
    const result = await env.VESSELS_DB
      .prepare(`SELECT * FROM positions WHERE mmsi=?1 ORDER BY ts DESC LIMIT ?2`)
      .bind(mmsi, limit)
      .all<PositionRow>();
    return result.results;
  }
  const placeholders = tiers.map((_, i) => `?${i + 2}`).join(',');
  const result = await env.VESSELS_DB
    .prepare(`SELECT * FROM positions WHERE mmsi=?1 AND tier IN (${placeholders}) ORDER BY ts DESC LIMIT ?${tiers.length + 2}`)
    .bind(mmsi, ...tiers, limit)
    .all<PositionRow>();
  return result.results;
}

// Precomputed inferred waypoints for a vessel, optionally filtered to tiers
// (a fake inherits its bracketing reals' tier so the client tier filter works).
export async function getInferredTrack(env: Env, mmsi: number, tiers: Tier[]): Promise<InferredRow[]> {
  if (tiers.length === 0) {
    const result = await env.VESSELS_DB
      .prepare(`SELECT lat,lon,t,tier,dashed FROM inferred_positions WHERE mmsi=?1 ORDER BY t ASC`)
      .bind(mmsi)
      .all<InferredRow>();
    return result.results;
  }
  const placeholders = tiers.map((_, i) => `?${i + 2}`).join(',');
  const result = await env.VESSELS_DB
    .prepare(`SELECT lat,lon,t,tier,dashed FROM inferred_positions WHERE mmsi=?1 AND tier IN (${placeholders}) ORDER BY t ASC`)
    .bind(mmsi, ...tiers)
    .all<InferredRow>();
  return result.results;
}

export interface ZoneVisitRow {
  zone_id: string;
  first_ts: number;
  last_ts: number;
  lat: number;
  lon: number;
}

export async function getZoneVisits(env: Env, mmsi: number): Promise<ZoneVisitRow[]> {
  const res = await env.VESSELS_DB
    .prepare(`SELECT zone_id,first_ts,last_ts,lat,lon FROM zone_visits WHERE mmsi=?1 ORDER BY last_ts DESC`)
    .bind(mmsi)
    .all<ZoneVisitRow>();
  return res.results;
}

export async function getOfInterestMmsis(env: Env, staleCutoffMs?: number): Promise<number[]> {
  if (staleCutoffMs !== undefined) {
    const result = await env.VESSELS_DB
      .prepare(
        `SELECT mmsi FROM vessels
         WHERE of_interest = 1
         ORDER BY
           CASE
             WHEN max_extent = 'global' THEN 0
             WHEN max_extent = 'local' AND last_seen < ?1 THEN 1
             WHEN max_extent = 'direct' AND last_seen < ?1 THEN 2
             WHEN max_extent = 'local' THEN 3
             WHEN max_extent = 'direct' THEN 4
             ELSE 5
           END,
           last_seen ASC`
      )
      .bind(staleCutoffMs)
      .all<{ mmsi: number }>();
    return result.results.map(r => r.mmsi);
  }

  const result = await env.VESSELS_DB
    .prepare(`SELECT mmsi FROM vessels WHERE of_interest = 1 ORDER BY last_seen ASC`)
    .all<{ mmsi: number }>();
  return result.results.map(r => r.mmsi);
}

// ── Rotating foreign scan support ────────────────────────────────────────────
// The foreign scan classifies relevance from a vessel's stored type/length (the
// current drain often carries only a PositionReport, not the ShipStaticData), so it
// needs those fields — but unlike the live scans it does NOT need the full position
// reference. A dedicated lightweight loader keeps it separate from loadVesselStates.
export interface ForeignVesselState {
  mmsi: number;
  vessel_type: number | null;
  length: number | null;
  of_interest: number;
  last_seen: number;
}

export async function loadForeignStates(env: Env, mmsis: number[]): Promise<Map<number, ForeignVesselState>> {
  if (mmsis.length === 0) return new Map();
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < mmsis.length; i += MMSI_CHUNK) {
    const chunk = mmsis.slice(i, i + MMSI_CHUNK);
    const placeholders = chunk.map((_, k) => `?${k + 1}`).join(',');
    stmts.push(
      env.VESSELS_DB
        .prepare(`SELECT mmsi,vessel_type,length,of_interest,last_seen FROM vessels WHERE mmsi IN (${placeholders})`)
        .bind(...chunk)
    );
  }
  const results = await env.VESSELS_DB.batch<ForeignVesselState>(stmts);
  const map = new Map<number, ForeignVesselState>();
  for (const result of results) for (const row of result.results) map.set(row.mmsi, row);
  return map;
}

// Tiny key/value cursor in scan_meta (used by the rotating foreign scan to remember
// which slice of foreign ports to drain next). Missing key → 0.
export async function getScanCursor(env: Env, key: string): Promise<number> {
  const row = await env.VESSELS_DB
    .prepare(`SELECT value FROM scan_meta WHERE key=?1`)
    .bind(key)
    .first<{ value: number }>();
  return row?.value ?? 0;
}

export async function setScanCursor(env: Env, key: string, value: number): Promise<void> {
  await env.VESSELS_DB
    .prepare(`INSERT INTO scan_meta (key,value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=?2`)
    .bind(key, value)
    .run();
}

// Which (mmsi, zone_id) pairs already have a zone_visits row, for the heard MMSIs.
// The foreign scan drops a single anchor position only on a vessel's FIRST entry to a
// zone (so the precompute can draw the ocean crossing) — not on every rotation.
export async function loadZoneVisitKeys(env: Env, mmsis: number[]): Promise<Set<string>> {
  const keys = new Set<string>();
  if (mmsis.length === 0) return keys;
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < mmsis.length; i += MMSI_CHUNK) {
    const chunk = mmsis.slice(i, i + MMSI_CHUNK);
    const placeholders = chunk.map((_, k) => `?${k + 1}`).join(',');
    stmts.push(
      env.VESSELS_DB
        .prepare(`SELECT mmsi,zone_id FROM zone_visits WHERE mmsi IN (${placeholders})`)
        .bind(...chunk)
    );
  }
  const results = await env.VESSELS_DB.batch<{ mmsi: number; zone_id: string }>(stmts);
  for (const result of results) for (const row of result.results) keys.add(`${row.mmsi}|${row.zone_id}`);
  return keys;
}
