// Trajectory compression — the pure decision "is this fix worth a new positions row?".
// Self-contained (type-only imports) so it can be unit-tested in plain node without
// pulling in the Cloudflare/worker dependency graph. See tests/compress.test.mjs.
import type { Vessel, Tier } from './types';

// The slice of a vessel's stored state the compressor compares against — the last
// EMITTED point. Structurally satisfied by storage.VesselState.
export interface LastFix {
  last_lat: number | null;
  last_lon: number | null;
  last_speed: number | null;
  last_heading: number | null;
  last_pos_ts: number | null;
}

// Jitter floor (nm): a vessel must have moved at least this far before a new row is
// even considered.
export const MOVE_THRESHOLD_NM: Record<string, number> = {
  direct: 0.05,
  local:  0.5,
  global: 5.0,
};

// Speed (kn) above which a vessel counts as "moving" (for start/stop detection).
export const MOVING_SPEED_KN = 0.5;

// Past the jitter floor, a positions row is written only when the track meaningfully
// changes vs the last emitted point — a turn, a speed change, a moving<->stopped flip,
// or a bounded max gap. Straight runs collapse to their endpoints; turns/maneuvering
// are kept by construction (they trip turnDeg).
//   turnDeg  — heading change (deg) that forces a point
//   speedKn  — speed change (kn) that forces a point
//   maxGapNm — emit at least this often by distance (bounds dead-reckoning error)
//   maxGapMs — emit at least this often by time (MUST stay < PHANTOM_STALL_MS for
//              direct, so a straight-moving vessel emits before it can be mistaken for
//              phantom)
// Direct is deliberately gentle: it backs the live window view, so the denormalized
// last_* (and thus the live dot) stays fresh. Local/global compress aggressively —
// those are approach/transit tracks where a slightly stale live position is fine.
export interface MoveProfile {
  turnDeg: number;
  speedKn: number;
  maxGapNm: number;
  maxGapMs: number;
}
export const MOVE_PROFILE: Record<string, MoveProfile> = {
  direct: { turnDeg: 15, speedKn: 1.0, maxGapNm: 0.15, maxGapMs:  3 * 60 * 1000 },
  local:  { turnDeg: 25, speedKn: 2.0, maxGapNm: 3.0,  maxGapMs: 30 * 60 * 1000 },
  global: { turnDeg: 30, speedKn: 3.0, maxGapNm: 25.0, maxGapMs: 120 * 60 * 1000 },
};

// Low-value resident types (tugs 31/32/52, pleasure 36/37, fishing 30) loiter locally
// and nobody watches their exact wiggles — coarsen their gaps.
export const COARSE_TYPE_GAP_FACTOR = 2;

const R_NM = 3440.065;

export function haversineNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R_NM * Math.asin(Math.sqrt(a));
}

export function headingDeltaDeg(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null;
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

export function isLowValueResident(type: number | null): boolean {
  return type === 30 || type === 31 || type === 32 || type === 36 || type === 37 || type === 52;
}

function moveProfileFor(tier: Tier, vesselType: number | null): MoveProfile {
  const p = MOVE_PROFILE[tier];
  if (!isLowValueResident(vesselType)) return p;
  return { turnDeg: p.turnDeg, speedKn: p.speedKn, maxGapNm: p.maxGapNm * COARSE_TYPE_GAP_FACTOR, maxGapMs: p.maxGapMs * COARSE_TYPE_GAP_FACTOR };
}

// Is this fix worth a new positions row vs the last emitted point? Caller guarantees
// prev has a stored position (last_lat/last_lon non-null).
export function isSignificantMove(v: Vessel, prev: LastFix, tier: Tier, nowMs: number): boolean {
  const dist = haversineNm(prev.last_lat!, prev.last_lon!, v.lat, v.lon);
  if (dist < MOVE_THRESHOLD_NM[tier]) return false;
  const p = moveProfileFor(tier, v.vesselType);
  if (dist >= p.maxGapNm) return true;
  if (prev.last_pos_ts !== null && nowMs - prev.last_pos_ts >= p.maxGapMs) return true;
  const dh = headingDeltaDeg(prev.last_heading, v.heading);
  if (dh !== null && dh >= p.turnDeg) return true;
  if (Math.abs((v.speed ?? 0) - (prev.last_speed ?? 0)) >= p.speedKn) return true;
  const wasMoving = (prev.last_speed ?? 0) > MOVING_SPEED_KN;
  const nowMoving = (v.speed ?? 0) > MOVING_SPEED_KN;
  return wasMoving !== nowMoving;
}
