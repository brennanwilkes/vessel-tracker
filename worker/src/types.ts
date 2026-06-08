export interface Env {
  SNAPSHOT_KV: KVNamespace;
  VESSELS_DB: D1Database;
  AISSTREAM_API_KEY: string;
  ALLOWED_ORIGIN: string;
}

export interface Vessel {
  mmsi: number;
  name: string | null;
  lat: number;
  lon: number;
  speed: number | null;
  heading: number | null;
  vesselType: number | null;
  length: number | null;
  destination: string | null;
  updated: number;
}

export interface Snapshot {
  updated: number;
  vessels: Vessel[];
}

export interface VesselRow {
  mmsi: number;
  name: string | null;
  vessel_type: number | null;
  first_seen: number;
  last_seen: number;
  times_seen: number;
  closest_nm: number | null;
  last_destination: string | null;
  enrichment_lat: number | null;
  enrichment_lon: number | null;
  enrichment_ts: number | null;
}

export interface SightingRow {
  id: number;
  mmsi: number;
  entered_at: number;
}
