import type { Env, VesselRow, PositionRow, StaticUpdate, Tier, MaxExtent } from './types';

const EXTENT_ORDER: Record<MaxExtent, number> = { direct: 0, local: 1, global: 2 };

export function widenExtent(current: MaxExtent, candidate: MaxExtent): MaxExtent {
  return EXTENT_ORDER[candidate] > EXTENT_ORDER[current] ? candidate : current;
}

export interface VesselState {
  mmsi: number;
  last_lat: number | null;
  last_lon: number | null;
  last_speed: number | null;
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
      .prepare(`SELECT mmsi,last_lat,last_lon,last_speed,last_pos_ts,last_seen,of_interest,max_extent,direct_entry_count FROM vessels WHERE mmsi IN (${placeholders})`)
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

export async function getCurrentVessels(env: Env, directTtlMs: number, localTtlMs: number, globalTtlMs: number): Promise<VesselRow[]> {
  const now = Date.now();
  const directCutoff = now - directTtlMs;
  const localCutoff = now - localTtlMs;
  const globalCutoff = now - globalTtlMs;
  const result = await env.VESSELS_DB
    .prepare(
      `SELECT mmsi,name,vessel_type,length,destination,
              last_lat AS lat,last_lon AS lon,last_speed AS speed,last_heading AS heading,
              last_pos_ts,last_seen,
              CASE
                WHEN max_extent = 'local' AND last_seen < ?2 THEN 'global'
                ELSE max_extent
              END AS max_extent,
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

export async function getOfInterestMmsis(env: Env): Promise<number[]> {
  const result = await env.VESSELS_DB
    .prepare(`SELECT mmsi FROM vessels WHERE of_interest = 1`)
    .all<{ mmsi: number }>();
  return result.results.map(r => r.mmsi);
}
