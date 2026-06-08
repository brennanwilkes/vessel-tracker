// Vessel classification — category, color, label — shared by map and list pages.

const CATEGORY_COLORS = {
  ferry:      '#00e5ff',  // bright cyan  — regular commuter/ferry traffic
  cruise:     '#fbbf24',  // amber gold   — large passenger cruise ships
  cargo:      '#4a9eff',  // steel blue   — commercial cargo
  tanker:     '#ff6b35',  // orange       — tankers / bulk carriers
  tug:        '#c084fc',  // purple       — tugs and service vessels
  fishing:    '#86efac',  // light green  — fishing vessels
  pleasure:   '#f9a8d4',  // pink         — private / recreational
  government: '#fb923c',  // amber        — coast guard / government
  unknown:    '#4a5568',  // slate grey   — de-emphasised
};

const CATEGORY_LABELS = {
  ferry:      'Ferry',
  cruise:     'Cruise Ship',
  cargo:      'Cargo',
  tanker:     'Tanker',
  tug:        'Tug / Service',
  fishing:    'Fishing',
  pleasure:   'Pleasure Craft',
  government: 'Government',
  unknown:    'Unknown',
};

// Classify a vessel into a display category using AIS type code first,
// then name/length heuristics for vessels that transmit type=null.
export function classifyVessel(vessel) {
  const name = (vessel.name ?? '').toUpperCase();
  const t = vessel.vesselType;
  const len = vessel.length;

  // Known local ferry operators by name pattern (type often comes back null)
  if (
    name === 'COHO' ||
    name.startsWith('WSF ') ||
    name.startsWith('QUEEN OF') ||
    name.startsWith('SALISH ') ||
    name.startsWith('SPIRIT OF') ||
    name.includes('CLIPPER') ||
    name.includes(' FERRY')
  ) return 'ferry';

  // Cruise lines operating in the Pacific Northwest.
  // Name matching is best-effort — AIS type 60-69 + length > 200 is more reliable
  // and kicks in once a vessel's static data has been received.
  if (
    name.startsWith('MSC ') ||
    name.startsWith('CELEBRITY ') ||
    name.startsWith('CARNIVAL ') ||
    name.startsWith('NORWEGIAN ') ||
    name.startsWith('VIKING ') ||
    name.startsWith('SILVER ') ||
    name.startsWith('SEABOURN ') ||
    name.startsWith('SEVEN SEAS') ||
    name.startsWith('QUEEN ELIZABETH') ||
    name.startsWith('QUEEN VICTORIA') ||
    name.startsWith('QUEEN MARY') ||
    // Holland America (most end in -DAM)
    name.includes('NOORDAM') || name.includes('VOLENDAM') ||
    name.includes('WESTERDAM') || name.includes('ZUIDERDAM') ||
    name.includes('KONINGSDAM') || name.includes('OOSTERDAM') ||
    name.includes('NIEUW') || name.includes('ROTTERDAM') ||
    // Other lines
    name.includes('POESIA') || name.includes('PRINCESS') ||
    name.includes('DISCOVERY') || name.includes('OVATION') ||
    name.includes('RADIANCE') || name.includes('SERENADE') ||
    name.includes('QUANTUM') || name.includes('BLISS') ||
    name.includes('ENCORE') || name.includes('JOY')
  ) return 'cruise';

  if (t === null) return 'unknown';
  if (t >= 70 && t <= 79) return 'cargo';
  if (t >= 80 && t <= 89) return 'tanker';
  if (t >= 60 && t <= 69) return (len !== null && len > 200) ? 'cruise' : 'ferry';
  if (t >= 40 && t <= 49) return 'ferry';
  if (t === 36 || t === 37) return 'pleasure';
  if (t === 30) return 'fishing';
  if (t >= 31 && t <= 35 || t === 52 || t === 53) return 'tug';
  if (t === 35 || (t >= 55 && t <= 58)) return 'government';
  return 'unknown';
}

export function vesselColor(vessel) {
  return CATEGORY_COLORS[classifyVessel(vessel)];
}

export function vesselCategoryLabel(vessel) {
  return CATEGORY_LABELS[classifyVessel(vessel)];
}
