import type { Env, Vessel, Snapshot, VesselRow, PingRow } from './types';
import { SNAPSHOT_KEY, STALE_THRESHOLD_MS } from './constants';

export async function writeSnapshot(env: Env, vessels: Vessel[]): Promise<void> {
  const snapshot: Snapshot = { updated: Date.now(), vessels };
  await env.SNAPSHOT_KV.put(SNAPSHOT_KEY, JSON.stringify(snapshot));
}

export async function readFreshVessels(env: Env): Promise<Vessel[]> {
  const raw = await env.SNAPSHOT_KV.get(SNAPSHOT_KEY);
  if (!raw) return [];
  const snapshot: Snapshot = JSON.parse(raw);
  const cutoff = Date.now() - STALE_THRESHOLD_MS;
  return snapshot.vessels.filter(v => v.updated >= cutoff);
}

export async function upsertVessels(env: Env, vessels: Vessel[]): Promise<void> {
  if (vessels.length === 0) return;
  // D1 batch: one statement per vessel
  const stmts = vessels.map(v =>
    env.VESSELS_DB.prepare(
      `INSERT INTO vessels (mmsi, name, vessel_type, first_seen, last_seen, times_seen, last_destination)
       VALUES (?1, ?2, ?3, ?4, ?4, 1, ?5)
       ON CONFLICT(mmsi) DO UPDATE SET
         name = COALESCE(?2, name),
         vessel_type = COALESCE(?3, vessel_type),
         last_seen = ?4,
         times_seen = times_seen + 1,
         last_destination = COALESCE(?5, last_destination)`
    ).bind(v.mmsi, v.name, v.vesselType, v.updated, v.destination)
  );
  await env.VESSELS_DB.batch(stmts);
}

export async function insertPings(
  env: Env,
  vessels: Vessel[],
  source: 'live' | 'enrichment'
): Promise<void> {
  if (vessels.length === 0) return;
  const stmts = vessels.map(v =>
    env.VESSELS_DB.prepare(
      `INSERT INTO vessel_pings (mmsi, lat, lon, ts, source) VALUES (?1, ?2, ?3, ?4, ?5)`
    ).bind(v.mmsi, v.lat, v.lon, v.updated, source)
  );
  await env.VESSELS_DB.batch(stmts);
}

export async function getVesselRow(env: Env, mmsi: number): Promise<VesselRow | null> {
  const result = await env.VESSELS_DB
    .prepare(`SELECT * FROM vessels WHERE mmsi = ?1`)
    .bind(mmsi)
    .first<VesselRow>();
  return result ?? null;
}

export async function getRecentPings(env: Env, mmsi: number, limit = 200): Promise<PingRow[]> {
  const result = await env.VESSELS_DB
    .prepare(`SELECT * FROM vessel_pings WHERE mmsi = ?1 ORDER BY ts DESC LIMIT ?2`)
    .bind(mmsi, limit)
    .all<PingRow>();
  return result.results;
}

export async function getAllKnownMmsis(env: Env): Promise<number[]> {
  const result = await env.VESSELS_DB
    .prepare(`SELECT mmsi FROM vessels`)
    .all<{ mmsi: number }>();
  return result.results.map(r => r.mmsi);
}
