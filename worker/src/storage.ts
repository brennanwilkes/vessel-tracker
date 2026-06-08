import type { Env, VesselRow, PositionRow, Tier, MaxExtent } from './types';

const EXTENT_ORDER: Record<MaxExtent, number> = { direct: 0, local: 1, global: 2 };

export function widenExtent(current: MaxExtent, candidate: MaxExtent): MaxExtent {
  return EXTENT_ORDER[candidate] > EXTENT_ORDER[current] ? candidate : current;
}

export interface VesselState {
  mmsi: number;
  last_lat: number | null;
  last_lon: number | null;
  last_pos_ts: number | null;
  last_seen: number;
  of_interest: number;
  max_extent: MaxExtent;
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
  moved: boolean;
  heartbeat: boolean;
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

export async function loadVesselStates(env: Env, mmsis: number[]): Promise<Map<number, VesselState>> {
  if (mmsis.length === 0) return new Map();
  const placeholders = mmsis.map((_, i) => `?${i + 1}`).join(',');
  const result = await env.VESSELS_DB
    .prepare(`SELECT mmsi,last_lat,last_lon,last_pos_ts,last_seen,of_interest,max_extent FROM vessels WHERE mmsi IN (${placeholders})`)
    .bind(...mmsis)
    .all<VesselState>();
  return new Map(result.results.map(r => [r.mmsi, r]));
}

export async function commitScan(env: Env, vessels: VesselUpsert[], positions: PositionInsert[]): Promise<void> {
  const stmts: D1PreparedStatement[] = [];

  for (const v of vessels) {
    if (v.moved) {
      stmts.push(
        env.VESSELS_DB.prepare(
          `INSERT INTO vessels (mmsi,name,vessel_type,length,destination,last_lat,last_lon,last_speed,last_heading,last_pos_ts,last_seen,first_seen,of_interest,max_extent,first_direct_at,times_seen)
           VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?10,?10,?11,?12,?13,1)
           ON CONFLICT(mmsi) DO UPDATE SET
             name            = COALESCE(?2, name),
             vessel_type     = COALESCE(?3, vessel_type),
             length          = COALESCE(?4, length),
             destination     = COALESCE(?5, destination),
             last_lat        = ?6,
             last_lon        = ?7,
             last_speed      = ?8,
             last_heading    = ?9,
             last_pos_ts     = ?10,
             last_seen       = ?10,
             of_interest     = MAX(of_interest, ?11),
             max_extent      = ?12,
             first_direct_at = COALESCE(first_direct_at, ?13),
             times_seen      = times_seen + 1`
        ).bind(
          v.mmsi, v.name, v.vessel_type, v.length, v.destination,
          v.lat, v.lon, v.speed, v.heading, v.ts,
          v.of_interest, v.max_extent, v.first_direct_at
        )
      );
    } else if (v.heartbeat) {
      stmts.push(
        env.VESSELS_DB.prepare(
          `INSERT INTO vessels (mmsi,name,vessel_type,length,destination,last_seen,first_seen,of_interest,max_extent,times_seen)
           VALUES (?1,?2,?3,?4,?5,?6,?6,?7,?8,1)
           ON CONFLICT(mmsi) DO UPDATE SET
             name            = COALESCE(?2, name),
             vessel_type     = COALESCE(?3, vessel_type),
             length          = COALESCE(?4, length),
             destination     = COALESCE(?5, destination),
             last_seen       = ?6,
             of_interest     = MAX(of_interest, ?7),
             max_extent      = ?8,
             first_direct_at = COALESCE(first_direct_at, ?9),
             times_seen      = times_seen + 1`
        ).bind(
          v.mmsi, v.name, v.vessel_type, v.length, v.destination,
          v.ts, v.of_interest, v.max_extent, v.first_direct_at
        )
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

export async function getCurrentVessels(env: Env, ttlMs: number): Promise<VesselRow[]> {
  const cutoff = Date.now() - ttlMs;
  const result = await env.VESSELS_DB
    .prepare(
      `SELECT mmsi,name,vessel_type,length,destination,
              last_lat AS lat,last_lon AS lon,last_speed AS speed,last_heading AS heading,
              last_pos_ts,last_seen,max_extent,first_direct_at
       FROM vessels WHERE of_interest = 1 AND last_seen >= ?1
       ORDER BY last_seen DESC`
    )
    .bind(cutoff)
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
