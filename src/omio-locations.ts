// Place names for the Uber Travel (Omio-backed) location search: how a name is
// sent to the search, how its results are matched, and which stations the
// search stores under a different name from the one in the station table.

import type { OmioLocation } from './omio-parse.js';

/**
 * The name the location search stores for a station, where it differs from
 * the name in the station table. Found by resolving all 815 table entries
 * against the live search (November 2026): these eight did not match by name,
 * and each name below belongs to the result that sits within 100 metres of
 * the station's real position. "Wharfdale" is the search's own spelling.
 */
export const OMIO_STATION_NAMES: Readonly<Record<string, string>> = {
  ABW: 'Abbey Wood Station',
  BIS: "Bishop's Stortford",
  BOC: 'Bootle',
  BUW: 'Burley-in-Wharfdale',
  CUS: 'Custom House Station',
  MCE: 'Metro Centre',
  SYD: 'Sydenham (London)',
  WCH: 'Whitchurch',
};

/** The name to look a station code up by: its own entry above, else the station table's name. */
export function omioStationName(crs: string, tableName: string): string {
  return OMIO_STATION_NAMES[crs.toUpperCase()] ?? tableName;
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
 * How strictly a SearchLocation result must match what was asked for.
 * - `crs`: the input was a known CRS code, `name` is the name that station
 *   is looked up by (see omioStationName).
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
 * entry in OMIO_STATION_NAMES where the two differ.
 *
 * For `free` text an exact name wins, otherwise the API's own first suggestion
 * is used, which is what the website's autocomplete would offer.
 */
export function pickLocation(
  locations: readonly OmioLocation[],
  name: string,
  match: LocationMatch,
): OmioLocation | null {
  const wanted = comparableName(name);
  const isExact = (location: OmioLocation): boolean => comparableName(location.name) === wanted;
  const stations = locations.filter(
    (location) => location.type === 'station' && (match !== 'crs' || location.countryCode === 'GB'),
  );

  const exactStation = stations.find(isExact);
  if (exactStation) return exactStation;

  if (match === 'crs') return null;

  const exactPlace = locations.find(isExact);
  if (exactPlace) return exactPlace;
  return match === 'free' ? (locations[0] ?? null) : null;
}
