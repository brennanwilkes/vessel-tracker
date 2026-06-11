import { pointInBox } from './ais';
import type { BoundingBox } from './aisstream';

// Named "visited destinations". `zoneOf` runs in every scan, so LOCAL/nearby zones are
// attributed for free from the direct/local boxes we already drain — no new cron, no
// extra aisstream traffic. Distant zones (added later) are reached by the rotating
// foreign scan; until then they simply never match (their positions aren't streamed).
//
// Boxes are tight first-draft approximations of the navigable approach/basin — refine
// against the map. Each box is [[swLat, swLon], [neLat, neLon]].
export type ZoneKind = 'port' | 'river' | 'chokepoint' | 'cruise';

export interface Zone {
  id: string;
  name: string;
  kind: ZoneKind;
  /** 'local' = covered by the existing direct/local scans; 'foreign' = needs the rotating scan. */
  reach: 'local' | 'foreign';
  box: BoundingBox;
}

export const ZONES: Zone[] = [
  // ── Local / nearby — inside LOCAL_BOUNDING_BOX, attributed for free by the existing
  //    direct + local scans (no rotating scan needed). ──
  { id: 'victoria-harbour',  name: 'Victoria Harbour',          kind: 'port',  reach: 'local', box: [[48.40, -123.41], [48.44, -123.35]] },
  { id: 'esquimalt',         name: 'Esquimalt',                 kind: 'port',  reach: 'local', box: [[48.42, -123.46], [48.46, -123.41]] },
  { id: 'vancouver-burrard', name: 'Vancouver (Burrard Inlet)', kind: 'port',  reach: 'local', box: [[49.27, -123.16], [49.32, -122.93]] },
  { id: 'roberts-bank',      name: 'Roberts Bank / Deltaport',  kind: 'port',  reach: 'local', box: [[48.98, -123.20], [49.04, -123.09]] },
  { id: 'fraser-newwest',    name: 'Fraser / New Westminster',  kind: 'river', reach: 'local', box: [[49.15, -122.96], [49.23, -122.84]] },
  { id: 'nanaimo',           name: 'Nanaimo',                   kind: 'port',  reach: 'local', box: [[49.15, -123.98], [49.21, -123.89]] },
  { id: 'bellingham',        name: 'Bellingham',                kind: 'port',  reach: 'local', box: [[48.69, -122.54], [48.78, -122.45]] },
  { id: 'anacortes',         name: 'Anacortes',                 kind: 'port',  reach: 'local', box: [[48.49, -122.64], [48.54, -122.57]] },
  { id: 'port-angeles',      name: 'Port Angeles',              kind: 'port',  reach: 'local', box: [[48.10, -123.50], [48.16, -123.40]] },
  { id: 'everett',           name: 'Everett',                   kind: 'port',  reach: 'local', box: [[47.96, -122.27], [48.02, -122.18]] },
  { id: 'seattle-elliott',   name: 'Seattle (Elliott Bay)',     kind: 'port',  reach: 'local', box: [[47.58, -122.40], [47.64, -122.33]] },
  { id: 'bremerton',         name: 'Bremerton',                 kind: 'port',  reach: 'local', box: [[47.53, -122.66], [47.58, -122.58]] },
  { id: 'tacoma',            name: 'Tacoma (Commencement Bay)', kind: 'port',  reach: 'local', box: [[47.25, -122.46], [47.30, -122.38]] },

  // ── Foreign / distant — reached only by the (future) rotating foreign scan.
  //    Boxes are tight approximations; refine during the per-port geometry build. ──

  // Chokepoints / canals
  { id: 'unimak-pass',       name: 'Unimak Pass',               kind: 'chokepoint', reach: 'foreign', box: [[54.20, -165.10], [54.45, -164.60]] },
  { id: 'dixon-entrance',    name: 'Dixon Entrance',            kind: 'chokepoint', reach: 'foreign', box: [[54.10, -132.80], [54.55, -132.00]] },
  { id: 'golden-gate',       name: 'Golden Gate',               kind: 'chokepoint', reach: 'foreign', box: [[37.79, -122.50], [37.84, -122.44]] },
  { id: 'panama-pacific',    name: 'Panama Canal (Pacific)',    kind: 'chokepoint', reach: 'foreign', box: [[8.85, -79.60], [8.98, -79.45]] },

  // Alaska / northern BC
  { id: 'prince-rupert',     name: 'Prince Rupert',             kind: 'port',   reach: 'foreign', box: [[54.25, -130.40], [54.36, -130.20]] },
  { id: 'ketchikan',         name: 'Ketchikan',                 kind: 'cruise', reach: 'foreign', box: [[55.30, -131.70], [55.40, -131.58]] },
  { id: 'juneau',            name: 'Juneau',                    kind: 'cruise', reach: 'foreign', box: [[58.26, -134.46], [58.34, -134.34]] },
  { id: 'glacier-bay',       name: 'Glacier Bay',               kind: 'cruise', reach: 'foreign', box: [[58.40, -136.30], [58.75, -135.80]] },
  { id: 'skagway',           name: 'Skagway',                   kind: 'cruise', reach: 'foreign', box: [[59.43, -135.36], [59.48, -135.28]] },
  { id: 'anchorage',         name: 'Anchorage / Cook Inlet',    kind: 'port',   reach: 'foreign', box: [[61.18, -150.05], [61.28, -149.80]] },
  { id: 'dutch-harbor',      name: 'Dutch Harbor / Unalaska',   kind: 'port',   reach: 'foreign', box: [[53.85, -166.62], [53.96, -166.44]] },

  // US West coast (south of the local box)
  { id: 'astoria-columbia',  name: 'Astoria / Columbia mouth',  kind: 'river',  reach: 'foreign', box: [[46.15, -123.95], [46.27, -123.74]] },
  { id: 'portland',          name: 'Portland (Columbia/Willamette)', kind: 'river', reach: 'foreign', box: [[45.50, -122.78], [45.65, -122.58]] },
  { id: 'coos-bay',          name: 'Coos Bay',                  kind: 'port',   reach: 'foreign', box: [[43.34, -124.26], [43.44, -124.14]] },
  { id: 'sf-bay-oakland',    name: 'Oakland / SF Bay',          kind: 'port',   reach: 'foreign', box: [[37.72, -122.38], [37.84, -122.22]] },
  { id: 'la-long-beach',     name: 'LA / Long Beach',           kind: 'port',   reach: 'foreign', box: [[33.70, -118.30], [33.79, -118.13]] },
  { id: 'san-diego',         name: 'San Diego',                 kind: 'port',   reach: 'foreign', box: [[32.66, -117.26], [32.75, -117.12]] },

  // Mexico / Central America
  { id: 'ensenada',          name: 'Ensenada',                  kind: 'port',   reach: 'foreign', box: [[31.82, -116.66], [31.89, -116.58]] },
  { id: 'cabo-san-lucas',    name: 'Cabo San Lucas',            kind: 'cruise', reach: 'foreign', box: [[22.85, -109.96], [22.92, -109.86]] },
  { id: 'manzanillo',        name: 'Manzanillo',                kind: 'port',   reach: 'foreign', box: [[19.01, -104.36], [19.11, -104.26]] },
  { id: 'lazaro-cardenas',   name: 'Lázaro Cárdenas',           kind: 'port',   reach: 'foreign', box: [[17.90, -102.26], [17.99, -102.14]] },

  // Hawaii
  { id: 'honolulu',          name: 'Honolulu',                  kind: 'port',   reach: 'foreign', box: [[21.28, -157.91], [21.35, -157.83]] },
  { id: 'hilo',              name: 'Hilo',                      kind: 'port',   reach: 'foreign', box: [[19.71, -155.10], [19.77, -155.02]] },
  { id: 'kahului',           name: 'Kahului (Maui)',            kind: 'cruise', reach: 'foreign', box: [[20.88, -156.50], [20.93, -156.44]] },

  // Japan
  { id: 'tokyo-bay',         name: 'Tokyo Bay',                 kind: 'port',   reach: 'foreign', box: [[35.30, 139.70], [35.70, 140.05]] },
  { id: 'nagoya',            name: 'Nagoya',                    kind: 'port',   reach: 'foreign', box: [[34.95, 136.78], [35.12, 136.96]] },
  { id: 'osaka-kobe',        name: 'Osaka / Kobe',              kind: 'port',   reach: 'foreign', box: [[34.58, 135.18], [34.76, 135.52]] },
  { id: 'kitakyushu',        name: 'Kitakyushu / Moji',         kind: 'port',   reach: 'foreign', box: [[33.85, 130.80], [33.97, 131.02]] },

  // Korea / China / Taiwan
  { id: 'busan',             name: 'Busan',                     kind: 'port',   reach: 'foreign', box: [[35.04, 128.98], [35.16, 129.14]] },
  { id: 'shanghai-yangshan', name: 'Shanghai (Yangshan)',       kind: 'port',   reach: 'foreign', box: [[30.55, 121.95], [30.72, 122.18]] },
  { id: 'ningbo-zhoushan',   name: 'Ningbo-Zhoushan',           kind: 'port',   reach: 'foreign', box: [[29.82, 121.92], [30.08, 122.24]] },
  { id: 'qingdao',           name: 'Qingdao',                   kind: 'port',   reach: 'foreign', box: [[35.98, 120.18], [36.14, 120.42]] },
  { id: 'tianjin',           name: 'Tianjin',                   kind: 'port',   reach: 'foreign', box: [[38.88, 117.58], [39.06, 117.88]] },
  { id: 'hong-kong',         name: 'Hong Kong / Shenzhen',      kind: 'port',   reach: 'foreign', box: [[22.24, 114.02], [22.42, 114.28]] },
  { id: 'kaohsiung',         name: 'Kaohsiung',                 kind: 'port',   reach: 'foreign', box: [[22.54, 120.24], [22.66, 120.36]] },
  { id: 'keelung',           name: 'Keelung (Taipei)',          kind: 'port',   reach: 'foreign', box: [[25.09, 121.70], [25.18, 121.79]] },

  // SE Asia / Oceania
  { id: 'singapore',         name: 'Singapore',                 kind: 'port',   reach: 'foreign', box: [[1.18, 103.62], [1.34, 103.92]] },
  { id: 'port-klang',        name: 'Port Klang',                kind: 'port',   reach: 'foreign', box: [[2.94, 101.28], [3.06, 101.46]] },
  { id: 'manila',            name: 'Manila',                    kind: 'port',   reach: 'foreign', box: [[14.54, 120.84], [14.66, 121.00]] },
  { id: 'sydney',            name: 'Sydney',                    kind: 'port',   reach: 'foreign', box: [[-33.92, 151.14], [-33.82, 151.30]] },
  { id: 'auckland',          name: 'Auckland',                  kind: 'port',   reach: 'foreign', box: [[-36.90, 174.70], [-36.80, 174.86]] },
];

// First matching zone id, or null. Zones are tight and effectively non-overlapping.
export function zoneOf(lat: number, lon: number): string | null {
  for (const z of ZONES) if (pointInBox(lat, lon, z.box)) return z.id;
  return null;
}

const ZONE_BY_ID = new Map(ZONES.map(z => [z.id, z]));

// Display metadata for a zone id (null for a stale id no longer in the registry).
export function zoneMeta(id: string): Zone | null {
  return ZONE_BY_ID.get(id) ?? null;
}
