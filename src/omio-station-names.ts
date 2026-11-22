// What the Uber Travel (Omio-backed) location search calls the stations it
// stores under another name than the station table, and which stations it does
// not have at all.
//
// Found in November 2026 by looking every station in the table up against the
// live search, by name and by position. A name below is the name of the result
// that stood within 300 metres of the station where no result carried the
// table's own name. Some are abbreviations ("Adlington (Lancs)"), some longer
// forms ("Cark & Cartmel"), some drop or add a qualifier, one is the search's
// own misspelling ("Burley-in-Wharfdale"), and three recently opened stations
// are stored as "town, station" ("Walsall, Darlaston"); trains were found from
// those three, so they are stations and not coach stops.
//
// This is a snapshot of someone else's data. The opt-in check in
// test/omio.live.test.ts looks every station up again and lists the ones that
// no longer resolve, which is how to find what to change here.

/** Station code to the name the location search stores that station under. */
export const OMIO_STATION_NAMES: Readonly<Record<string, string>> = {
  ABW: 'Abbey Wood Station',
  ADL: 'Adlington (Lancs)',
  BDS: 'Bond Street Station',
  BIP: 'Bishopstone',
  BIS: "Bishop's Stortford",
  BLE: 'Bramley (West Yorks)',
  BOC: 'Bootle',
  BTD: 'Bolton-upon-Dearne',
  BTY: 'Bentley (Hants)',
  BUW: 'Burley-in-Wharfdale',
  CAK: 'Cark & Cartmel',
  CBK: 'Cranbrook',
  COE: 'Coombe Junction Halt',
  CPN: 'Chapelton',
  CUS: 'Custom House Station',
  CWX: 'Canary Wharf (Elizabeth Line)',
  DAS: 'Walsall, Darlaston',
  DLS: 'Dalston',
  DYC: 'Dyce (Aberdeen Airport)',
  ECC: 'Eccles (Manchester)',
  FSB: 'Fishbourne (Sussex)',
  GNH: 'Greenhithe',
  HAF: 'Heathrow Terminal 4',
  HIG: 'Highbridge & Burnham-on-Sea',
  HST: 'High Street (Glasgow)',
  HWV: 'Heathrow Terminal 5',
  HXX: 'Heathrow Terminals 2 & 3',
  HYH: 'Hythe (Essex)',
  JCH: 'James Cook Hospital',
  LIH: 'Leigh',
  LVJ: 'Liverpool James Street',
  MCE: 'Metro Centre',
  MLB: 'Millbrook (Beds)',
  MOV: 'Birmingham, Moseley Village',
  MSL: 'Mossley',
  NTN: 'Newton (Lanark)',
  NUM: 'Northumberland Park',
  OKI: 'Okehampton, Okehampton Interchange',
  PYE: 'Pye Corner Railway Station',
  RDF: 'Radcliffe (Notts)',
  RHM: 'Reedham',
  RIA: 'Rhoose Cardiff International Airport',
  SKN: 'St Keyne Wishing Well Halt',
  SUO: 'Sutton',
  SUY: 'Sudbury',
  SWN: 'Swinton (South Yorkshire)',
  SYD: 'Sydenham (London)',
  TCR: 'Tottenham Court Road Station',
  UNI: 'University',
  WCH: 'Whitchurch',
  WNE: 'Wilnecote (Staffs)',
};

/**
 * Station codes the location search had no station for: stations opened
 * recently, and a few stops with no regular service.
 */
export const OMIO_UNLISTED_STATIONS: ReadonlySet<string> = new Set([
  'ASL', // Ashington
  'BEJ', // Bedlington
  'DCT', // Danescourt
  'HRE', // Horden
  'KIH', // Kings Heath
  'MUF', // Manchester United Football Club
  'NOP', // Northumberland Park (Tyne and Wear)
  'PIR', // Pineapple Road
  'SEJ', // Seaton Delaval
  'STQ', // Southampton Town Quay
  'TEA', // Teesside Airport
]);
