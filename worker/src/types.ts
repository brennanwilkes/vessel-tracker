export interface Env {
  VESSELS_DB: D1Database;
  AISSTREAM_API_KEY: string;
  ALLOWED_ORIGIN: string;
}

export type Tier = 'direct' | 'local' | 'global';
export type MaxExtent = 'direct' | 'local' | 'global';

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

export interface VesselRow {
  mmsi: number;
  name: string | null;
  vessel_type: number | null;
  length: number | null;
  destination: string | null;
  last_lat: number | null;
  last_lon: number | null;
  last_speed: number | null;
  last_heading: number | null;
  last_pos_ts: number | null;
  last_seen: number;
  first_seen: number;
  of_interest: number;
  max_extent: MaxExtent;
  first_direct_at: number | null;
  times_seen: number;
}

export interface PositionRow {
  id: number;
  mmsi: number;
  lat: number;
  lon: number;
  speed: number | null;
  heading: number | null;
  ts: number;
  tier: Tier;
}
