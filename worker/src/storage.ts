import type { Env, Vessel, Snapshot, VesselRow, SightingRow } from './types';
import { SNAPSHOT_KEY, STALE_THRESHOLD_MS } from './constants';

export async function readSnapshot(env: Env): Promise<Vessel[]> {
  const raw = await env.SNAPSHOT_KV.get(SNAPSHOT_KEY);
  if (!raw) return [];
  const snapshot: Snapshot = JSON.parse(raw);
  const cutoff = Date.now() - STALE_THRESHOLD_MS;
  return snapshot.vessels.filter(v => v.updated >= cutoff);
}

// Takes the already-read existing vessels to avoid a second KV read.
// Merges fresh positions in, drops entries older than STALE_THRESHOLD_MS, writes back.
export async function mergeSnapshot(env: Env, existing: Vessel[], fresh: Vessel[]): Promise<void> {
  const byMmsi = new Map(existing.map(v => [v.mmsi, v]));
  for (const v of fresh) byMmsi.set(v.mmsi, v);

  const cutoff = Date.now() - STALE_THRESHOLD_MS;
  const merged = [...byMmsi.values()].filter(v => v.updated >= cutoff);

  const snapshot: Snapshot = { updated: Date.now(), vessels: merged };
  await env.SNAPSHOT_KV.put(SNAPSHOT_KEY, JSON.stringify(snapshot));
}

// Only called for vessels not already in the KV snapshot (true new arrivals).
export async function upsertVessels(env: Env, vessels: Vessel[]): Promise<void> {
  if (vessels.length === 0) return;
  const stmts = vessels.map(v =>
    env.VESSELS_DB.prepare(
      `INSERT INTO vessels (mmsi, name, vessel_type, first_seen, last_seen, times_seen, last_destination)
       VALUES (?1, ?2, ?3, ?4, ?4, 1, ?5)
       ON CONFLICT(mmsi) DO UPDATE SET
         name             = COALESCE(?2, name),
         vessel_type      = COALESCE(?3, vessel_type),
         last_seen        = ?4,
         times_seen       = times_seen + 1,
         last_destination = COALESCE(?5, last_destination)`
    ).bind(v.mmsi, v.name, v.vesselType, v.updated, v.destination)
  );
  await env.VESSELS_DB.batch(stmts);
}

// Records one arrival event per new vessel. FK on mmsi requires upsertVessels first.
export async function insertSightings(env: Env, vessels: Vessel[]): Promise<void> {
  if (vessels.length === 0) return;
  const nowMs = Date.now();
  const stmts = vessels.map(v =>
    env.VESSELS_DB.prepare(
      `INSERT INTO vessel_sightings (mmsi, entered_at) VALUES (?1, ?2)`
    ).bind(v.mmsi, nowMs)
  );
  await env.VESSELS_DB.batch(stmts);
}

export async function updateEnrichmentPositions(env: Env, vessels: Vessel[]): Promise<void> {
  if (vessels.length === 0) return;
  const stmts = vessels.map(v =>
    env.VESSELS_DB.prepare(
      `UPDATE vessels SET enrichment_lat = ?1, enrichment_lon = ?2, enrichment_ts = ?3 WHERE mmsi = ?4`
    ).bind(v.lat, v.lon, v.updated, v.mmsi)
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

export async function getVesselSightings(env: Env, mmsi: number, limit = 50): Promise<SightingRow[]> {
  const result = await env.VESSELS_DB
    .prepare(`SELECT * FROM vessel_sightings WHERE mmsi = ?1 ORDER BY entered_at DESC LIMIT ?2`)
    .bind(mmsi, limit)
    .all<SightingRow>();
  return result.results;
}

export async function getAllKnownMmsis(env: Env): Promise<number[]> {
  const result = await env.VESSELS_DB
    .prepare(`SELECT mmsi FROM vessels`)
    .all<{ mmsi: number }>();
  return result.results.map(r => r.mmsi);
}
