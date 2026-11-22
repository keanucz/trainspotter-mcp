// Place names for the Uber Travel (Omio-backed) location search: how a name is
// sent to the search and how its results are matched. The stations the search
// stores under a different name from the station table are in omio-station-names.ts.

import type { OmioLocation } from './omio-parse.js';
import { OMIO_STATION_ENTRIES, OMIO_STATION_NAMES } from './omio-station-names.js';

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

// How far a result may be from where the station is known to be. Stations sit
// within about 300 metres of their listed position; a namesake that is another
// place is tens of kilometres away.
const STATION_POSITION_TOLERANCE_KM = 1;
const EARTH_RADIUS_KM = 6371;

export interface OmioStationLookup {
  /** Names to look the station up by, in the order to try them. */
  names: string[];
  /** Where the station is, when known: a result elsewhere is not it. */
  near: GeoPoint | null;
  /** Which entry to take when the station is listed more than once there, when known. */
  entryId: string | null;
}

/**
 * How to look a station code up. Most stations are stored by the location
 * search under the station table's name. For the ones in OMIO_STATION_NAMES
 * the stored name is tried first and the table's name second, so the code
 * keeps resolving if the search is ever brought into line with the table.
 * Either way a result only counts when it stands at `position`. For a station
 * the search lists twice there, OMIO_STATION_ENTRIES says which entry to use.
 */
export function omioStationLookup(crs: string, tableName: string, position: GeoPoint | null): OmioStationLookup {
  const storedName = OMIO_STATION_NAMES[crs.toUpperCase()];
  const names = storedName === undefined || storedName === tableName ? [tableName] : [storedName, tableName];
  return { names, near: position, entryId: OMIO_STATION_ENTRIES[crs.toUpperCase()] ?? null };
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
 * The one station among the candidates that a station code stands for, or null
 * when they cannot be told apart. A single candidate is it. Of several, only
 * the entry known to be the one to search from (`entryId`) is taken. Nothing
 * in a search result says which of two entries has the trains, and the nearer
 * one is no guide: seen live, the entry at a moved station's present site had
 * none. So without a known entry, or when it is not among them, none is taken.
 */
export function chooseStation(candidates: readonly OmioLocation[], entryId: string | null): OmioLocation | null {
  if (candidates.length <= 1) return candidates[0] ?? null;
  if (entryId === null) return null;
  return candidates.find((candidate) => candidate.id === entryId) ?? null;
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
 * station must also be there. And if two stations qualify, only the entry
 * named by `entryId` is taken, and neither when there is no such entry (see
 * chooseStation). The caller passes everything its lookup of that name
 * returned, so the count covers every spelling tried.
 *
 * For `free` text an exact name wins, otherwise the API's own first suggestion
 * is used, which is what the website's autocomplete would offer.
 */
export function pickLocation(
  locations: readonly OmioLocation[],
  name: string,
  match: LocationMatch,
  near: GeoPoint | null = null,
  entryId: string | null = null,
): OmioLocation | null {
  const wanted = comparableName(name);
  const isExact = (location: OmioLocation): boolean => comparableName(location.name) === wanted;
  if (match === 'crs') return chooseStation(stationCandidates(locations, name, near), entryId);

  const exactStation = locations.find((location) => location.type === 'station' && isExact(location));
  if (exactStation) return exactStation;

  const exactPlace = locations.find(isExact);
  if (exactPlace) return exactPlace;
  return match === 'free' ? (locations[0] ?? null) : null;
}
