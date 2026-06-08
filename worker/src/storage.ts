import type { Env, Vessel, Snapshot, VesselRow, SightingRow } from './types';
import { SNAPSHOT_KEY, STALE_THRESHOLD_MS } from './constants';

// Merge new positions into the existing snapshot rather than overwriting.
// Vessels not heard this run stay until they age past STALE_THRESHOLD_MS.
export async function mergeSnapshot(env: Env, freshVessels: Vessel[]): Promise<void> {
  const raw = await env.SNAPSHOT_KV.get(SNAPSHOT_KEY);
  const existing: Vessel[] = raw ? (JSON.parse(raw) as Snapshot).vessels : [];

  const byMmsi = new Map(existing.map(v => [v.mmsi, v]));
  for (const v of freshVessels) byMmsi.set(v.mmsi, v);

  const cutoff = Date.now() - STALE_THRESHOLD_MS;
  const merged = [...byMmsi.values()].filter(v => v.updated >= cutoff);

  const snapshot: Snapshot = { updated: Date.now(), vessels: merged };
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

// Diff current vessels against active sightings and emit enter/continue/exit events.
// Generates UPDATEs for continuing/exiting vessels and INSERTs for new arrivals —
// all in one D1 batch, so row count stays proportional to unique vessels, not poll count.
export async function updateSightings(env: Env, vessels: Vessel[]): Promise<void> {
  const nowMs = Date.now();

  const active = await env.VESSELS_DB
    .prepare(`SELECT id, mmsi FROM vessel_sightings WHERE exited_at IS NULL`)
    .all<{ id: number; mmsi: number }>();

  const activeById = new Map(active.results.map(r => [r.mmsi, r.id]));
  const currentMmsis = new Set(vessels.map(v => v.mmsi));

  const stmts: D1PreparedStatement[] = [];

  for (const vessel of vessels) {
    const existingId = activeById.get(vessel.mmsi);
    if (existingId !== undefined) {
      // Vessel still visible — update last_seen_at, no new row
      stmts.push(
        env.VESSELS_DB.prepare(
          `UPDATE vessel_sightings SET last_seen_at = ?1 WHERE id = ?2`
        ).bind(nowMs, existingId)
      );
    } else {
      // New arrival — open a sighting
      stmts.push(
        env.VESSELS_DB.prepare(
          `INSERT INTO vessel_sightings (mmsi, entered_at, last_seen_at) VALUES (?1, ?2, ?2)`
        ).bind(vessel.mmsi, nowMs)
      );
    }
  }

  // Close sightings for vessels no longer in the snapshot
  for (const [mmsi, id] of activeById) {
    if (!currentMmsis.has(mmsi)) {
      stmts.push(
        env.VESSELS_DB.prepare(
          `UPDATE vessel_sightings SET exited_at = ?1 WHERE id = ?2`
        ).bind(nowMs, id)
      );
    }
  }

  if (stmts.length > 0) await env.VESSELS_DB.batch(stmts);
}

// Update the last-known enrichment position for vessels heard by the weekly cron.
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
