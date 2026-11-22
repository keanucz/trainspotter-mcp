// Place names for the Uber Travel (Omio-backed) location search: how a name is
// sent to the search, how its results are matched, and which stations the
// search stores under a different name from the one in the station table.

import type { OmioLocation } from './omio-parse.js';

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

export interface OmioStationAlias extends GeoPoint {
  /** The name the location search stores the station under. */
  name: string;
}

/**
 * Stations the location search stores under another name than the station
 * table, with where each one is. Found by resolving all 815 table entries
 * against the live search (November 2026): these eight did not match by name,
 * and each entry below is the result that sat within 100 metres of the
 * station's real position. "Wharfdale" is the search's own spelling.
 *
 * Some of these names are less exact than the table's ("Bootle" for Bootle
 * (Cumbria)), so a result is only accepted when it is also in the right place.
 */
export const OMIO_STATION_NAMES: Readonly<Record<string, OmioStationAlias>> = {
  ABW: { name: 'Abbey Wood Station', latitude: 51.4908, longitude: 0.1204 },
  BIS: { name: "Bishop's Stortford", latitude: 51.8666, longitude: 0.1649 },
  BOC: { name: 'Bootle', latitude: 54.2914, longitude: -3.3937 },
  BUW: { name: 'Burley-in-Wharfdale', latitude: 53.9081, longitude: -1.7532 },
  CUS: { name: 'Custom House Station', latitude: 51.5099, longitude: 0.0272 },
  MCE: { name: 'Metro Centre', latitude: 54.959, longitude: -1.6654 },
  SYD: { name: 'Sydenham (London)', latitude: 51.4273, longitude: -0.0551 },
  WCH: { name: 'Whitchurch', latitude: 51.2376, longitude: -1.3379 },
};

// How far a result may be from where the station is known to be. Entries of
// the same name that are another place are tens of kilometres away.
const STATION_POSITION_TOLERANCE_KM = 1;
const EARTH_RADIUS_KM = 6371;

export interface OmioStationLookup {
  /** Names to look the station up by, in the order to try them. */
  names: string[];
  /** Where the station is, when known: a result elsewhere is not it. */
  near: GeoPoint | null;
}

/**
 * How to look a station code up. Most stations are stored under the station
 * table's name. For the ones in OMIO_STATION_NAMES the stored name is tried
 * first and the table's name second, so the code keeps resolving if the search
 * is ever brought into line with the table.
 */
export function omioStationLookup(crs: string, tableName: string): OmioStationLookup {
  const alias = OMIO_STATION_NAMES[crs.toUpperCase()];
  if (!alias) return { names: [tableName], near: null };
  return { names: [alias.name, tableName], near: { latitude: alias.latitude, longitude: alias.longitude } };
}

/** Great-circle distance between two points, in kilometres. */
export function distanceKm(a: GeoPoint, b: GeoPoint): number {
  const radians = (degrees: number): number => (degrees * Math.PI) / 180;
  const haversine =
    Math.sin(radians(b.latitude - a.latitude) / 2) ** 2 +
    Math.cos(radians(a.latitude)) *
      Math.cos(radians(b.latitude)) *
      Math.sin(radians(b.longitude - a.longitude) / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(haversine));
}

// A word that may be a possessive written without its apostrophe ("Shepherds"),
// but not one that merely ends in a double s ("Cross").
const POSSESSIVE_CANDIDATE_PATTERN = /^[a-z]{2,}[^s']s$/i;

function nameWords(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/['’.]/g, '')
    .replace(/&/g, ' and ')
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== '');
}

/**
 * The texts to send to the location search for a name, in the order to try
 * them. Two quirks of the live search, both seen in use:
 * - A query containing "&" or "and" finds nothing ("Harrow & Wealdstone" gives
 *   no results, "Harrow" lists it), so only the part before the joining word
 *   is sent.
 * - Apostrophes are kept in some station names and dropped in others
 *   ("Shepherd's Bush" but "Christs Hospital"), and the query has to agree, so
 *   a name with one is tried as written and then without it.
 * Results are still matched against the full name.
 */
export function locationSearchTerms(name: string): string[] {
  // Stored names use the plain apostrophe, so a curly one from a phone keyboard is sent as that.
  const plain = name.replace(/’/g, "'");
  const firstPart = (plain.split(/\s+(?:&|and)\s+/i)[0] ?? plain).trim();
  const asWritten = firstPart === '' ? plain : firstPart;
  const withoutApostrophes = asWritten.replace(/'/g, '');
  return withoutApostrophes === asWritten ? [asWritten] : [asWritten, withoutApostrophes];
}

/** A name reduced to its words: lower case, no punctuation, "&" read as "and". */
export function comparableName(name: string): string {
  return nameWords(name).join(' ');
}

/**
 * A search term with an apostrophe put back, for a name typed or listed
 * without one ("Shepherds Bush" is stored as "Shepherd's Bush", and the search
 * needs the apostrophe). Trying a spelling costs a request, so only one is
 * offered: the first word that could be a possessive. Null when the term has
 * an apostrophe already or no such word.
 */
export function possessiveSearchTerm(term: string): string | null {
  if (/['’]/.test(term)) return null;
  const words = term.split(/\s+/);
  const index = words.findIndex((word) => POSSESSIVE_CANDIDATE_PATTERN.test(word));
  const word = index === -1 ? undefined : words[index];
  if (word === undefined) return null;
  return [...words.slice(0, index), `${word.slice(0, -1)}'s`, ...words.slice(index + 1)].join(' ');
}

/**
 * The British stations among `locations` that a station code looked up as
 * `name` could be: stored under exactly that name and, when `near` is given,
 * standing in that place. A station listed twice counts once.
 */
export function stationCandidates(
  locations: readonly OmioLocation[],
  name: string,
  near: GeoPoint | null = null,
): OmioLocation[] {
  const wanted = comparableName(name);
  const qualifying = locations.filter(
    (location) =>
      location.type === 'station' &&
      location.countryCode === 'GB' &&
      comparableName(location.name) === wanted &&
      (near === null || distanceKm(location, near) <= STATION_POSITION_TOLERANCE_KM),
  );
  return qualifying.filter(
    (location, index) => qualifying.findIndex((other) => other.id === location.id) === index,
  );
}

/**
 * How strictly a SearchLocation result must match what was asked for.
 * - `crs`: the input was a known CRS code, `name` is a name that station
 *   is looked up by (see omioStationLookup).
 * - `exact`: the input must be the exact name of a place.
 * - `free`: free text, where the API's first suggestion is acceptable.
 */
export type LocationMatch = 'crs' | 'exact' | 'free';

/**
 * Chooses the location to search from a SearchLocation result.
 *
 * A CRS code must never silently turn into some other station, so for `crs`
 * only a British rail station with exactly the wanted name is accepted. A
 * longer name is not ("London Waterloo East" is a different station from
 * "London Waterloo"), and neither is a shorter one. The wanted name therefore
 * has to be the full name the search stores: the station table's name, or the
 * entry in OMIO_STATION_NAMES where the two differ. When `near` is given, the
 * station must also be there. And if two stations qualify, neither is taken:
 * they cannot be told apart. The caller passes everything its lookup of that
 * name returned, so the count covers every spelling tried.
 *
 * For `free` text an exact name wins, otherwise the API's own first suggestion
 * is used, which is what the website's autocomplete would offer.
 */
export function pickLocation(
  locations: readonly OmioLocation[],
  name: string,
  match: LocationMatch,
  near: GeoPoint | null = null,
): OmioLocation | null {
  const wanted = comparableName(name);
  const isExact = (location: OmioLocation): boolean => comparableName(location.name) === wanted;
  if (match === 'crs') {
    const candidates = stationCandidates(locations, name, near);
    return candidates.length === 1 ? (candidates[0] ?? null) : null;
  }

  const exactStation = locations.find((location) => location.type === 'station' && isExact(location));
  if (exactStation) return exactStation;

  const exactPlace = locations.find(isExact);
  if (exactPlace) return exactPlace;
  return match === 'free' ? (locations[0] ?? null) : null;
}
