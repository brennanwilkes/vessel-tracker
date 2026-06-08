import type { Vessel } from './types';
import type { BoundingBox } from './aisstream';

export type VesselCategory = 'cargo' | 'tanker' | 'passenger' | 'ferry' | 'tug' | 'fishing' | 'pleasure' | 'unknown';

export function vesselCategory(typeCode: number | null): VesselCategory {
  if (typeCode === null) return 'unknown';
  if (typeCode >= 70 && typeCode <= 79) return 'cargo';
  if (typeCode >= 80 && typeCode <= 89) return 'tanker';
  if (typeCode >= 60 && typeCode <= 69) return 'passenger';
  if (typeCode === 36 || typeCode === 37) return 'pleasure';
  if (typeCode >= 31 && typeCode <= 32) return 'tug';
  if (typeCode === 30) return 'fishing';
  if (typeCode >= 40 && typeCode <= 49) return 'ferry';
  return 'unknown';
}

// Returns true if the point falls inside the box [[sw_lat,sw_lon],[ne_lat,ne_lon]]
export function pointInBox(lat: number, lon: number, box: BoundingBox): boolean {
  return lat >= box[0][0] && lat <= box[1][0] && lon >= box[0][1] && lon <= box[1][1];
}

// Large-vessel gate for the local tier: cargo/tanker, or passenger/cruise >=50m, or any vessel >=50m
export function isLargeVessel(vesselType: number | null, length: number | null): boolean {
  if (vesselType !== null && vesselType >= 70 && vesselType <= 89) return true;
  if (vesselType !== null && vesselType >= 60 && vesselType <= 69 && length !== null && length >= 50) return true;
  if (length !== null && length >= 50) return true;
  return false;
}

// aisstream message shapes — only fields we actually use

export interface AisPositionReport {
  MessageType: 'PositionReport';
  MetaData: { MMSI: number; ShipName: string; latitude: number; longitude: number };
  Message: {
    PositionReport: {
      Sog: number;
      TrueHeading: number;
    };
  };
}

export interface AisShipStaticData {
  MessageType: 'ShipStaticData';
  MetaData: { MMSI: number };
  Message: {
    ShipStaticData: {
      Type: number;
      Dimension: { A: number; B: number };
      Destination: string;
      Name: string;
    };
  };
}

export type AisMessage = AisPositionReport | AisShipStaticData;

export function parsePositionReport(msg: AisPositionReport, nowMs: number): Partial<Vessel> {
  const { MMSI, ShipName, latitude, longitude } = msg.MetaData;
  const { Sog, TrueHeading } = msg.Message.PositionReport;
  return {
    mmsi: MMSI,
    name: ShipName?.trim() || null,
    lat: latitude,
    lon: longitude,
    speed: Sog,
    heading: TrueHeading === 511 ? null : TrueHeading,
    updated: nowMs,
  };
}

export function parseShipStaticData(msg: AisShipStaticData): Partial<Vessel> {
  const { MMSI } = msg.MetaData;
  const { Type, Dimension, Destination, Name } = msg.Message.ShipStaticData;
  const length = Dimension.A + Dimension.B;
  return {
    mmsi: MMSI,
    name: Name?.trim() || null,
    vesselType: Type || null,
    length: length > 0 ? length : null,
    destination: Destination?.trim() || null,
  };
}

export function toCompleteVessels(partials: Map<number, Partial<Vessel>>): Vessel[] {
  const vessels: Vessel[] = [];
  for (const [mmsi, p] of partials) {
    if (p.lat === undefined || p.lon === undefined) continue;
    vessels.push({
      mmsi,
      name: p.name ?? null,
      lat: p.lat,
      lon: p.lon,
      speed: p.speed ?? null,
      heading: p.heading ?? null,
      vesselType: p.vesselType ?? null,
      length: p.length ?? null,
      destination: p.destination ?? null,
      updated: p.updated ?? Date.now(),
    });
  }
  return vessels;
}
