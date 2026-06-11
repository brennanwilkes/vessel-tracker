// Vessel classification — category, color, label, flag — shared by map and list pages.

// ITU Maritime Identification Digit (first 3 digits of MMSI) → ISO 3166-1 alpha-2
const MID_TO_ISO2 = {
  201:'AL',203:'AT',204:'PT',205:'BE',207:'BG',209:'CY',210:'CY',
  211:'DE',212:'CY',213:'GE',215:'MT',218:'DE',219:'DK',220:'DK',
  224:'ES',225:'ES',226:'FR',227:'FR',228:'FR',229:'MT',230:'FI',
  231:'FO',232:'GB',233:'GB',234:'GB',235:'GB',236:'GI',237:'GR',
  238:'HR',239:'HR',240:'HR',241:'GR',242:'MA',244:'NL',245:'NL',
  246:'IT',247:'IT',248:'MT',249:'MT',250:'IE',251:'IS',255:'PT',
  256:'MT',257:'NO',258:'NO',259:'NO',261:'PL',262:'ME',263:'PT',
  264:'RO',265:'SE',266:'SE',267:'SK',269:'CH',271:'TR',272:'UA',
  273:'RU',275:'LV',276:'EE',277:'LT',278:'SI',279:'RS',
  303:'US',304:'AG',305:'AG',308:'BS',309:'BS',310:'BM',311:'BS',
  312:'BZ',314:'BB',316:'CA',319:'KY',321:'CR',323:'CU',325:'DM',
  327:'DO',330:'GD',332:'GT',334:'HN',336:'HT',338:'US',339:'JM',
  341:'KN',343:'LC',345:'MX',350:'NI',351:'PA',352:'PA',353:'PA',
  354:'PA',355:'PA',356:'PA',357:'PA',362:'TT',366:'US',367:'US',
  368:'US',369:'US',370:'PA',371:'PA',372:'PA',373:'PA',374:'PA',
  375:'VC',376:'VC',377:'VC',378:'VG',379:'VI',
  401:'AF',403:'SA',405:'BD',410:'CN',412:'CN',413:'CN',416:'TW',
  422:'IR',423:'AZ',425:'IQ',428:'IL',431:'JP',432:'JP',434:'TM',
  436:'KZ',438:'JO',440:'KR',441:'KR',445:'KP',447:'KW',450:'LB',
  453:'MO',455:'MV',457:'MN',461:'OM',462:'OM',463:'PK',466:'QA',
  467:'QA',468:'SY',469:'SY',470:'AE',471:'AE',472:'UZ',473:'VN',
  474:'VN',475:'VN',477:'HK',478:'YE',
  501:'ZA',503:'AU',506:'MM',508:'BN',509:'PG',511:'NZ',512:'NZ',
  514:'KH',515:'KH',520:'FJ',525:'ID',529:'KI',531:'LA',533:'MY',
  536:'MP',538:'MH',540:'NC',548:'PH',557:'SB',559:'AS',561:'WS',
  563:'SG',564:'SG',565:'SG',566:'SG',567:'TH',570:'TO',574:'VN',576:'VU',
  601:'ZA',603:'AO',605:'DZ',609:'BI',610:'BJ',611:'BW',612:'CF',
  613:'CM',615:'CG',616:'KM',617:'CV',619:'CI',620:'KM',621:'DJ',
  622:'EG',624:'ET',625:'ER',626:'GA',627:'GH',629:'GM',630:'GW',
  631:'GQ',632:'GN',634:'KE',636:'LR',637:'LR',638:'SS',641:'MG',
  642:'MW',644:'MU',645:'MR',649:'MZ',650:'UG',654:'NE',655:'NG',
  656:'NA',659:'RW',660:'SD',661:'SN',662:'SC',663:'SO',664:'SL',
  666:'ST',668:'TD',669:'TG',670:'TN',671:'TZ',674:'ZM',675:'ZW',
  676:'TZ',677:'MA',
  701:'AR',710:'BR',720:'BO',725:'CL',730:'CO',735:'EC',740:'FK',
  750:'GY',755:'PY',760:'PE',765:'SR',770:'UY',775:'VE',
};

export const CATEGORY_COLORS = {
  cargo:      '#ea580c',  // orange-600  — deeper rust, distinct from cruise gold
  tanker:     '#dc2626',  // red-600     — deeper red, same warm shipping family
  cruise:     '#facc15',  // yellow-400  — bright gold, luxury/passenger
  ferry:      '#06b6d4',  // cyan-500    — cool contrast, dependable commuter
  military:   '#3b82f6',  // blue-500    — navy / military association
  fishing:    '#22c55e',  // green-500   — fishing vessels
  government: '#8b5cf6',  // violet-500  — coast guard / government
  pleasure:   '#ec4899',  // pink-500    — private / recreational
  tug:        '#78716c',  // neutral-500 — de-emphasised, low interest
  unknown:    '#525252',  // neutral-600 — de-emphasised
};

export const CATEGORY_LABELS = {
  ferry:      'Ferry',
  cruise:     'Cruise Ship',
  cargo:      'Cargo',
  tanker:     'Tanker',
  tug:        'Tug / Service',
  fishing:    'Fishing',
  pleasure:   'Pleasure Craft',
  government: 'Government',
  military:   'Military',
  unknown:    'Unknown',
};

// Classify a vessel into a display category using AIS type code first,
// then name/length heuristics for vessels that transmit type=null.
export function classifyVessel(vessel) {
  const name = (vessel.name ?? '').toUpperCase();
  const t = vessel.vessel_type ?? vessel.vesselType ?? null;
  const len = vessel.length;

  // Known local ferries by MMSI (type code may come back null for these)
  const knownFerryMmsi = [366929710, 311001249]; // COHO, VICTORIA CLIPPER V
  if (knownFerryMmsi.includes(vessel.mmsi)) return 'ferry';

  // Known local ferry operators by name pattern (type often comes back null)
  if (
    name.startsWith('WSF ') ||
    name.startsWith('QUEEN OF') ||
    name.startsWith('SALISH ') ||
    name.includes(' FERRY')
  ) return 'ferry';

  // Cruise lines operating in the Pacific Northwest.
  // Name matching is best-effort — AIS type 60-69 + length > 200 is more reliable
  // and kicks in once a vessel's static data has been received.
  // Only apply name heuristics when type is null (no static data yet) or passenger type,
  // so that non-passenger type codes (fishing 30, cargo 70-79, tanker 80-89, etc.)
  // take precedence.
  if (
    (t === null || (t >= 60 && t <= 69)) && (
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
      name.includes('POESIA') || name.includes('OVATION') ||
      name.includes('RADIANCE') || name.includes('SERENADE') ||
      name.includes('QUANTUM') ||
      name.includes('ENCORE') || name.includes('JOY')
    )
  ) return 'cruise';

  if (t === null) {
    if (len !== null && len > 150) return 'cargo';
    if (
      name.startsWith('CCGS ') ||
      name.startsWith('USCGC ') ||
      name.startsWith('CDN WARSHIP') ||
      name.startsWith('YDT ') ||
      name.startsWith('RV ') ||
      name.startsWith('R/V ') ||
      name.startsWith('CG')
    ) return 'government';
    return 'unknown';
  }
  if (t >= 70 && t <= 79) return 'cargo';
  if (t >= 80 && t <= 89) return 'tanker';
  if (t >= 60 && t <= 69) return (len !== null && len > 200) ? 'cruise' : 'ferry';
  if (t >= 40 && t <= 49) return 'ferry';
  if (t === 35) return 'military';
  if (t === 36 || t === 37) return 'pleasure';
  if (t === 30) return 'fishing';
  if ((t >= 31 && t <= 32) || t === 52 || t === 53) return 'tug';
  if ((t >= 33 && t <= 34) || (t >= 50 && t <= 51) || t === 54 || (t >= 55 && t <= 59)) return 'government';
  if (t >= 90 && t <= 99) return 'government';
  return 'unknown';
}

export function vesselColor(vessel) {
  return CATEGORY_COLORS[classifyVessel(vessel)];
}

export function vesselCategoryLabel(vessel) {
  return CATEGORY_LABELS[classifyVessel(vessel)];
}

export function vesselCountryCode(vessel) {
  if (vessel.mmsi === null || vessel.mmsi === undefined) return null;
  const mid = Math.floor(vessel.mmsi / 1_000_000);
  return MID_TO_ISO2[mid] ?? null;
}

export function vesselFlag(vessel) {
  const iso2 = vesselCountryCode(vessel);
  if (!iso2) return null;
  return String.fromCodePoint(
    0x1F1E6 + iso2.charCodeAt(0) - 65,
    0x1F1E6 + iso2.charCodeAt(1) - 65,
  );
}
