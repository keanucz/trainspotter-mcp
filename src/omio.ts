// Client for the Uber Travel (Omio-backed) train and coach search.
//
// This is the search API behind travel.uber.com. It is undocumented and may
// change or disappear without notice. It needs no account, cookie or API key.
// The client is deliberately gentle: one search at a time, bounded polling,
// a short cache, and no retries.

import {
  EXTEND_SEARCH_QUERY,
  GET_SEARCH_QUERY,
  SEARCH_JOURNEYS_MUTATION,
  SEARCH_LOCATION_QUERY,
} from './omio-queries.js';
import {
  OmioSchemaError,
  parseBooking,
  parseLocations,
  parseSearchStart,
  readGraphqlFailure,
  type OmioBooking,
  type OmioJourney,
  type OmioLocation,
  type OmioTrainWindow,
} from './omio-parse.js';
import {
  comparableName,
  locationSearchTerms,
  omioStationLookup,
  pickLocation,
  possessiveSearchTerm,
  stationCandidates,
  type GeoPoint,
  type LocationMatch,
} from './omio-locations.js';
import { getStationName } from './stations.js';

const ENDPOINT = 'https://travel.uber.com/go/travel/graphql';
const SITE_ORIGIN = 'https://travel.uber.com';
// The endpoint rejects requests that carry no CSRF header but accepts any
// value, because there is no session for it to protect. This is not a secret.
const CSRF_PLACEHOLDER = 'x';

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_ERROR_DETAIL_LENGTH = 200;
const HTTP_BAD_REQUEST = 400;
// An empty location reply is remembered for a moment, so a search that is
// retried straight away does not look a name that does not exist up again.
// Kept short, because an empty reply may also be a passing fault on the
// server's side. omio_locations neither reads nor writes this memory.
const EMPTY_LOCATION_CACHE_TTL_MS = 60 * 1000;
const POLL_INTERVAL_MS = 1_000;
const POLL_CAP_MS = 20_000;
const TOTAL_BUDGET_MS = 35_000;
// Each extension adds one to two more hours of trains to the first window. How
// many are asked for depends on `hours`; this is the ceiling for one search.
const MAX_EXTENSIONS = 10;
// After an extension, this many finished-but-unchanged replies are treated as
// stale. Defensive: in live use the reply after an extension was either still
// running or already showed the longer window, never the old one.
const STALE_SNAPSHOT_POLLS = 2;
// Location names offered in an error when a station code does not resolve.
const MAX_OFFERED_LOCATIONS = 5;
const MAX_OFFERED_NAME_LENGTH = 60;

const LOCATION_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 50;

const DEFAULT_TIME = '06:00';
const DEFAULT_AGE = 30;
const MAX_AGE = 120;
const DEFAULT_HOURS = 4;
const MAX_HOURS = 12;
const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;
const RAILCARD_PROVIDER = 'assertis';
const EXPECTED_CURRENCY = 'CURRENCY_GBP';

/**
 * UK railcards Uber Travel accepts. The ids are the National Rail railcard
 * codes, the same ones search_fares takes, so no translation is needed.
 */
export const OMIO_RAILCARDS: Readonly<Record<string, string>> = {
  YNG: '16-25 Railcard',
  TST: '26-30 Railcard',
  TSU: '16-17 Saver',
  SRN: 'Senior Railcard',
  '2TR': 'Two Together Railcard',
  FAM: 'Family & Friends Railcard',
  DIS: 'Disabled Persons Railcard',
  DIC: 'Disabled Child Railcard',
  HMF: 'HM Forces Railcard',
  VET: 'Veterans Railcard',
  NEW: 'Network Railcard',
  NGC: 'Gold Card',
  JCP: 'Jobcentre Plus Travel Discount Card',
};

export type OmioSearchMode = 'train' | 'coach';

const WIRE_MODE: Readonly<Record<OmioSearchMode, string>> = {
  train: 'TRAVEL_MODE_TRAIN',
  coach: 'TRAVEL_MODE_BUS',
};
const MODE_ALIASES: Readonly<Record<string, OmioSearchMode>> = {
  train: 'train',
  rail: 'train',
  coach: 'coach',
  bus: 'coach',
};

export interface OmioFareQuery {
  /** CRS code or place name. */
  from: string;
  to: string;
  /** YYYY-MM-DD or YYYYMMDD. */
  date: string;
  /** Earliest departure as HH:MM, UK local time. */
  time?: string;
  modes?: string[];
  railcards?: string[];
  age?: number;
  /** How many hours of trains to return from `time`. */
  hours?: number;
}

export interface NormalizedFareQuery {
  date: string;
  time: string;
  modes: OmioSearchMode[];
  railcard: string | null;
  age: number;
  hours: number;
}

export interface OmioFareResult extends NormalizedFareQuery {
  origin: OmioLocation;
  destination: OmioLocation;
  journeys: OmioJourney[];
  trainWindow: OmioTrainWindow | null;
  /** False when the search or an extension did not finish; see notes. */
  complete: boolean;
  notes: string[];
  disclaimers: string[];
  cached: boolean;
}

export interface OmioLocationSearch {
  locations: OmioLocation[];
  /** The text whose lookup gave these locations: the query, or another spelling of it. The query itself when nothing was found. */
  answeredBy: string;
  /** Every text that was looked up, in order, starting with the query. */
  tried: string[];
}

export interface OmioClientOptions {
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Parses JSON, giving undefined (which JSON itself never yields) for anything else. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function normalizeDate(input: string): string {
  const trimmed = (input ?? '').trim();
  const match = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(trimmed);
  if (!match) {
    throw new Error(`Invalid date "${input}": expected YYYY-MM-DD`);
  }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new Error(`Invalid date "${input}": no such day`);
  }
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function normalizeTime(input: string | undefined): string {
  if (input === undefined) return DEFAULT_TIME;
  const trimmed = input.trim();
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(trimmed)) {
    throw new Error(`Invalid time "${input}": expected HH:MM (24-hour)`);
  }
  return trimmed;
}

function normalizeModes(input: string[] | undefined): OmioSearchMode[] {
  if (input === undefined) return ['train', 'coach'];
  const modes = input.map((raw) => {
    const mode = MODE_ALIASES[String(raw).trim().toLowerCase()];
    if (!mode) {
      throw new Error(`Unknown mode "${raw}": use "train" and/or "coach"`);
    }
    return mode;
  });
  if (modes.length === 0) {
    throw new Error('At least one mode is required: "train" and/or "coach"');
  }
  // Canonical order, so the same set of modes always makes the same request and cache key.
  return (['train', 'coach'] as const).filter((mode) => modes.includes(mode));
}

function normalizeRailcard(input: string[] | undefined): string | null {
  if (input === undefined || input.length === 0) return null;
  if (input.length > 1) {
    throw new Error('Uber Travel accepts one railcard per traveller; pass a single code');
  }
  const code = String(input[0]).trim().toUpperCase();
  if (!(code in OMIO_RAILCARDS)) {
    throw new Error(`Unknown railcard "${code}". Known codes: ${Object.keys(OMIO_RAILCARDS).join(', ')}`);
  }
  return code;
}

function normalizeAge(input: number | undefined): number {
  if (input === undefined) return DEFAULT_AGE;
  if (!Number.isInteger(input) || input < 0 || input > MAX_AGE) {
    throw new Error(`Invalid age "${input}": expected a whole number from 0 to ${MAX_AGE}`);
  }
  return input;
}

function normalizeHours(input: number | undefined): number {
  if (input === undefined) return DEFAULT_HOURS;
  if (!Number.isInteger(input) || input < 1 || input > MAX_HOURS) {
    throw new Error(`Invalid hours "${input}": expected a whole number from 1 to ${MAX_HOURS}`);
  }
  return input;
}

/** Minutes since midnight for an HH:MM time. */
function clockMinutes(clock: string): number {
  const [hour, minute] = clock.split(':').map(Number) as [number, number];
  return hour * MINUTES_PER_HOUR + minute;
}

export function normalizeFareQuery(query: OmioFareQuery): NormalizedFareQuery {
  for (const field of ['from', 'to'] as const) {
    if (typeof query[field] !== 'string' || query[field].trim() === '') {
      throw new Error(`"${field}" is required: a CRS code or a place name`);
    }
  }
  return {
    date: normalizeDate(query.date),
    time: normalizeTime(query.time),
    modes: normalizeModes(query.modes),
    railcard: normalizeRailcard(query.railcards),
    age: normalizeAge(query.age),
    hours: normalizeHours(query.hours),
  };
}

function londonOffsetMs(instant: number): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(instant));
  const part = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute')) - instant;
}

/**
 * Turns a UK wall-clock date and time into the UTC instant the search request
 * takes. Only the request needs this; times in responses are already local and
 * are passed through untouched.
 */
export function londonWallTimeToUtc(date: string, time: string): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const [hour, minute] = time.split(':').map(Number) as [number, number];
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  return new Date(wallAsUtc - londonOffsetMs(wallAsUtc)).toISOString();
}

/** The error for a place that did not resolve. Naming what did come back saves the caller a second lookup. */
function locationNotFound(input: string, detail: string, seen: readonly OmioLocation[]): Error {
  const stationNames = seen
    .filter((location) => location.type === 'station')
    .map((location) => location.name.slice(0, MAX_OFFERED_NAME_LENGTH));
  const offered = [...new Set(stationNames)].slice(0, MAX_OFFERED_LOCATIONS);
  const offer = offered.length > 0 ? ` Uber Travel offers: ${offered.join(', ')}.` : '';
  return new Error(
    `No Uber Travel location found for "${input}"${detail}${offer} Use omio_locations to see what it knows, then pass that name.`,
  );
}

export class OmioClient {
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly locationCache = new Map<string, CacheEntry<OmioLocation[]>>();
  private readonly emptyLocationCache = new Map<string, CacheEntry<true>>();
  private readonly searchCache = new Map<string, CacheEntry<OmioFareResult>>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: OmioClientOptions = {}) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
  }

  async searchLocations(query: string): Promise<OmioLocation[]> {
    return (await this.findLocations(query)).locations;
  }

  /** Resolves a station code or a place name to the location a fare search would use for it. */
  async resolvePlace(input: string): Promise<OmioLocation> {
    if (typeof input !== 'string' || input.trim() === '') {
      throw new Error('A place is required: a CRS code or a place name');
    }
    return this.runExclusive(() => this.resolveLocation(input));
  }

  /** Like searchLocations, and also says which spelling of the query the result belongs to. */
  async findLocations(query: string): Promise<OmioLocationSearch> {
    const name = (query ?? '').trim();
    if (name === '') {
      throw new Error('A location query is required');
    }
    // The query is asked as given first. If the search knows nothing, the same
    // spellings a fare search would try are asked, so that a name copied from an
    // error ("Harrow & Wealdstone") or typed without its apostrophe still finds
    // something. A remembered "nothing" is not good enough for the tool whose
    // job is to say what the service knows, and its own empty replies are not
    // remembered.
    return this.runExclusive(async () => {
      const spellings = locationSearchTerms(name);
      const guess = possessiveSearchTerm(spellings[0] ?? name);
      const terms = [name, ...spellings, ...(guess === null ? [] : [guess])];
      const distinct = terms.filter(
        (term, index) => terms.findIndex((other) => other.toLowerCase() === term.toLowerCase()) === index,
      );
      for (const [index, term] of distinct.entries()) {
        const locations = await this.lookupLocations(term, { rememberEmpty: false });
        if (locations.length > 0) return { locations, answeredBy: term, tried: distinct.slice(0, index + 1) };
      }
      return { locations: [], answeredBy: name, tried: distinct };
    });
  }

  async searchFares(query: OmioFareQuery): Promise<OmioFareResult> {
    const normalized = normalizeFareQuery(query);
    return this.runExclusive(async () => {
      const origin = await this.resolveLocation(query.from);
      const destination = await this.resolveLocation(query.to);
      if (origin.id === destination.id) {
        throw new Error(`"from" and "to" both resolve to ${origin.name}`);
      }

      const cacheKey = JSON.stringify([origin.id, destination.id, normalized]);
      const cached = this.readCache(this.searchCache, cacheKey);
      if (cached) return { ...cached, cached: true };

      const result = await this.runSearch(origin, destination, normalized);
      if (result.complete) {
        this.writeCache(this.searchCache, cacheKey, result, SEARCH_CACHE_TTL_MS);
      }
      return result;
    });
  }

  /** Runs tasks strictly one after another, whether or not earlier ones failed. */
  private runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async lookupLocations(
    name: string,
    options: { rememberEmpty: boolean } = { rememberEmpty: true },
  ): Promise<OmioLocation[]> {
    // The live search ignores letter case ("LONDON EUSTON" finds London Euston), so the key can too.
    const cacheKey = name.toLowerCase();
    // A known result is read first, so it always wins over a remembered "nothing".
    const cached = this.readCache(this.locationCache, cacheKey);
    if (cached) return cached;
    if (options.rememberEmpty && this.readCache(this.emptyLocationCache, cacheKey)) return [];

    const body = await this.post('SearchLocation', SEARCH_LOCATION_QUERY, {
      request: { name, locale: 'en-GB' },
    });
    const locations = parseLocations(body);
    if (locations.length > 0) {
      this.writeCache(this.locationCache, cacheKey, locations, LOCATION_CACHE_TTL_MS);
    } else if (options.rememberEmpty) {
      // Kept apart from real results, so a run of unknown names cannot push those out.
      this.writeCache(this.emptyLocationCache, cacheKey, true, EMPTY_LOCATION_CACHE_TTL_MS);
    }
    return locations;
  }

  /**
   * Looks the terms up one after another and stops as soon as the replies so
   * far hold a match for `name`. The match is chosen from everything seen, not
   * from the latest reply alone, so two same-named stations refused for a
   * station code stay refused when a later spelling returns only one of them.
   * Also returns every location seen, in reply order, which is what the caller
   * can offer when nothing matched.
   */
  private async lookupFirstMatch(
    terms: readonly string[],
    name: string,
    match: LocationMatch,
    near: GeoPoint | null,
  ): Promise<{ picked: OmioLocation | null; seen: OmioLocation[] }> {
    let seen: OmioLocation[] = [];
    for (const term of terms) {
      const locations = await this.lookupLocations(term);
      seen = [...seen, ...locations];
      const picked = pickLocation(seen, name, match, near);
      if (picked) return { picked, seen };
    }
    return { picked: null, seen };
  }

  /**
   * Looks one name up under every spelling worth trying and returns a proper
   * match for it, if there is one: first the name as given (see
   * locationSearchTerms), then, only when the search knew nothing at all, one
   * possessive spelling. `asGiven` holds what the first step saw, `seen`
   * everything.
   */
  private async matchByName(
    name: string,
    match: LocationMatch,
    near: GeoPoint | null,
  ): Promise<{ picked: OmioLocation | null; asGiven: OmioLocation[]; seen: OmioLocation[] }> {
    const terms = locationSearchTerms(name);
    const asGiven = await this.lookupFirstMatch(terms, name, match, near);
    if (asGiven.picked) return { picked: asGiven.picked, asGiven: asGiven.seen, seen: asGiven.seen };
    // A search that knew nothing at all is what a missing apostrophe looks
    // like. That spelling is a guess, so only a proper match is taken from it.
    const guess = asGiven.seen.length === 0 ? possessiveSearchTerm(terms[0] ?? name) : null;
    if (guess === null) return { picked: null, asGiven: asGiven.seen, seen: asGiven.seen };
    const possessive = await this.lookupFirstMatch([guess], name, match, near);
    return { picked: possessive.picked, asGiven: asGiven.seen, seen: [...asGiven.seen, ...possessive.seen] };
  }

  private async resolveLocation(input: string): Promise<OmioLocation> {
    const trimmed = input.trim();
    const looksLikeCrs = /^[A-Za-z]{3}$/.test(trimmed);
    const stationName = looksLikeCrs ? getStationName(trimmed) : undefined;
    if (stationName !== undefined) return this.resolveStation(trimmed, stationName);

    // Every spelling is tried for a proper match first.
    const found = await this.matchByName(trimmed, 'exact', null);
    if (found.picked) return found.picked;

    // The search's first suggestion is a fallback for free text only, and only
    // from the name as given. It is not offered for three letters that are not
    // a code we know (a typo, or a code missing from the station table), nor
    // when the search term had to be shortened: that list holds places that
    // merely share a first word with what was asked for.
    const shortened = comparableName(locationSearchTerms(trimmed)[0] ?? trimmed) !== comparableName(trimmed);
    const suggestion = looksLikeCrs || shortened ? undefined : found.asGiven[0];
    if (suggestion) return suggestion;

    const detail = looksLikeCrs
      ? '. It is not a station code this server knows and no place has exactly that name, so pass the full station name.'
      : '.';
    throw locationNotFound(trimmed, detail, found.seen);
  }

  /**
   * Resolves a station code this server knows. Only a British station stored
   * under a name the code is looked up by is accepted, never a suggestion.
   */
  private async resolveStation(code: string, stationName: string): Promise<OmioLocation> {
    const lookup = omioStationLookup(code, stationName);
    let seen: OmioLocation[] = [];
    for (const name of lookup.names) {
      const found = await this.matchByName(name, 'crs', lookup.near);
      if (found.picked) return found.picked;
      seen = [...seen, ...found.seen];
    }
    // Say what else was searched when the search knows the station by another name.
    const otherNames = lookup.names.filter((name) => name !== stationName).map((name) => `"${name}"`);
    const alsoSearched = otherNames.length > 0 ? `, also searched as ${otherNames.join(' and ')}` : '';
    const british = seen.filter((location) => location.countryCode === 'GB');
    // Two different stations that both qualified were refused, not missing: say so.
    const qualifying = (name: string): number => stationCandidates(seen, name, lookup.near).length;
    const where = lookup.near ? ' in the right place' : '';
    const reason = lookup.names.some((name) => qualifying(name) > 1)
      ? 'more than one British station with that name came back, and they cannot be told apart'
      : `no British station with that name came back${where}`;
    throw locationNotFound(code, ` (${stationName}${alsoSearched}): ${reason}.`, british);
  }

  private async runSearch(
    origin: OmioLocation,
    destination: OmioLocation,
    query: NormalizedFareQuery,
  ): Promise<OmioFareResult> {
    const startedAt = this.now();
    const deadline = startedAt + TOTAL_BUDGET_MS;
    const endpoint = (location: OmioLocation) => ({
      id: location.id,
      latitude: location.latitude,
      longitude: location.longitude,
      countryCode: location.countryCode,
    });

    const startBody = await this.post('SearchJourneys', SEARCH_JOURNEYS_MUTATION, {
      request: {
        origin: endpoint(origin),
        destination: endpoint(destination),
        departureTime: londonWallTimeToUtc(query.date, query.time),
        travelModes: query.modes.map((mode) => WIRE_MODE[mode]),
        travelers: [
          {
            age: query.age,
            discountCards: query.railcard ? [{ id: query.railcard, provider: RAILCARD_PROVIDER }] : [],
            disabilityCards: [],
          },
        ],
        locale: 'en-GB',
        currency: 'CURRENCY_GBP',
        isReplacementSearch: false,
        mode: 'SEARCH_MODE_INCREMENTAL',
        userGeoipCountry: 'GB',
        abTestParameters: [],
      },
    });
    const { searchId } = parseSearchStart(startBody, 'SearchJourneys');

    const first = await this.pollUntilDone(searchId, startedAt + POLL_CAP_MS);
    if (first.status !== 'done') {
      if (first.journeys.length === 0) {
        throw new Error(
          `Uber Travel search did not finish within ${POLL_CAP_MS / 1000} s and returned nothing. Try again in a minute.`,
        );
      }
      return this.buildResult(origin, destination, query, first, [
        `The search was still running after ${POLL_CAP_MS / 1000} s, so some journeys may be missing.`,
      ]);
    }

    const extended = query.modes.includes('train')
      ? await this.extendLater(searchId, first, deadline, query)
      : { booking: first, notes: [] };
    return this.buildResult(origin, destination, query, extended.booking, extended.notes);
  }

  /**
   * Asks for later train windows until the trains cover `query.hours` from
   * `query.time` or the day ends, a bounded number of times and within the
   * time budget.
   */
  private async extendLater(
    searchId: string,
    initial: OmioBooking,
    deadline: number,
    query: NormalizedFareQuery,
  ): Promise<{ booking: OmioBooking; notes: string[] }> {
    // Hours that run past midnight mean "to the end of the day": windows are
    // plain HH:MM times, so the last one a window can end on is 23:59.
    const coverUntil = Math.min(
      clockMinutes(query.time) + query.hours * MINUTES_PER_HOUR,
      MINUTES_PER_DAY - 1,
    );
    let booking = initial;
    for (let extension = 0; ; extension++) {
      const window = booking.trainWindow;
      // An end before the start means the window already runs past midnight.
      if (!window || !window.moreLater || window.end < window.start) break;
      if (clockMinutes(window.end) >= coverUntil) break;
      if (extension >= MAX_EXTENSIONS) {
        return {
          booking,
          notes: [
            `Stopped after ${MAX_EXTENSIONS} requests for later trains, before covering the hours asked for. Search again with a later time for the rest.`,
          ],
        };
      }
      // An extension is one request and at least one poll, so leave room for both.
      if (this.now() + REQUEST_TIMEOUT_MS + POLL_INTERVAL_MS > deadline) {
        return { booking, notes: ['Stopped asking for later trains: the time budget for one search ran out.'] };
      }

      try {
        const reply = await this.post('ExtendSearchWithoutQuotes', EXTEND_SEARCH_QUERY, {
          request: { searchId, extendDirection: 'outbound', extendTo: 'later', mode: 'SEARCH_MODE_INCREMENTAL' },
        });
        parseSearchStart(reply, 'ExtendSearchWithoutQuotes');
        const next = await this.pollUntilDone(searchId, deadline, window.end);
        if (next.status !== 'done') {
          // A running snapshot can hold fewer journeys than the last finished one, so keep that.
          return { booking, notes: ['A request for later trains did not finish in time, so later trains are missing.'] };
        }
        if (next.trainWindow?.end === window.end) {
          return {
            booking: next,
            notes: ['A request for later trains returned nothing new, so later trains may be missing.'],
          };
        }
        booking = next;
      } catch (error) {
        // A schema change is reported loudly even here: partial results from an API that changed shape are not trustworthy.
        if (error instanceof OmioSchemaError) throw error;
        return { booking, notes: [`Could not load later trains: ${errorMessage(error)}`] };
      }
    }
    return { booking, notes: [] };
  }

  /**
   * Polls at a fixed interval until the search is done or the deadline passes.
   *
   * After an extension the first replies can still be the previous finished
   * snapshot. `staleWindowEnd` is the train window end before the extension: a
   * finished reply that still ends there is not trusted for the first few polls.
   */
  private async pollUntilDone(
    searchId: string,
    deadline: number,
    staleWindowEnd?: string,
  ): Promise<OmioBooking> {
    const maxPolls = Math.ceil(TOTAL_BUDGET_MS / POLL_INTERVAL_MS);
    let latest: OmioBooking | null = null;
    for (let poll = 0; poll < maxPolls; poll++) {
      await this.sleep(POLL_INTERVAL_MS);
      const body = await this.post('GetSearchWithoutQuotes', GET_SEARCH_QUERY, {
        request: {
          searchId,
          direction: 'SEGMENT_DIRECTION_DEPARTURE',
          outboundId: '',
          isReplacementSearch: false,
        },
      });
      latest = parseBooking(body);
      const outOfTime = this.now() + POLL_INTERVAL_MS > deadline;
      const maybeStale =
        staleWindowEnd !== undefined &&
        poll < STALE_SNAPSHOT_POLLS &&
        latest.trainWindow?.end === staleWindowEnd;
      if (outOfTime || (latest.status === 'done' && !maybeStale)) break;
    }
    if (!latest) {
      throw new Error('Uber Travel search was never polled');
    }
    return latest;
  }

  private buildResult(
    origin: OmioLocation,
    destination: OmioLocation,
    query: NormalizedFareQuery,
    booking: OmioBooking,
    notes: string[],
  ): OmioFareResult {
    if (booking.currency !== EXPECTED_CURRENCY) {
      throw new OmioSchemaError(`booking.currency is ${booking.currency}, expected ${EXPECTED_CURRENCY}`);
    }
    // Both sides are local wall-clock strings in the same format, so comparing
    // them as text avoids converting, and therefore shifting, any time.
    const earliest = `${query.date}T${query.time}:00`;
    const journeys = booking.journeys
      .filter((journey) => journey.dep >= earliest)
      .sort((a, b) => a.dep.localeCompare(b.dep) || a.arr.localeCompare(b.arr));

    return {
      ...query,
      origin,
      destination,
      journeys,
      trainWindow: booking.trainWindow,
      complete: booking.status === 'done' && notes.length === 0,
      notes,
      disclaimers: booking.disclaimers,
      cached: false,
    };
  }

  private async post(operationName: string, query: string, variables: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchFn(ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': CSRF_PLACEHOLDER,
          origin: SITE_ORIGIN,
          referer: `${SITE_ORIGIN}/`,
        },
        body: JSON.stringify({ operationName, variables, query }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new Error(`Uber Travel request failed for ${operationName}: ${errorMessage(error)}`);
    }

    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      throw new Error(`Uber Travel reply for ${operationName} could not be read: ${errorMessage(error)}`);
    }
    const body = parseJson(text);
    if (!response.ok) {
      // The server turns down a request that does not fit its schema with HTTP
      // 400 and a GraphQL error list, before running anything. A search it ran
      // and could not finish comes back as HTTP 500 with the same kind of list.
      // The status is the server's own verdict, so a 400 with such a list counts
      // as a schema change even when its wording is new.
      const failure = readGraphqlFailure(body);
      if (failure && (failure.schemaChange || response.status === HTTP_BAD_REQUEST)) {
        throw new OmioSchemaError(`${operationName}: ${failure.message}`, 'request');
      }
      const detail = (failure?.message ?? text).slice(0, MAX_ERROR_DETAIL_LENGTH);
      throw new Error(`Uber Travel request failed (${response.status}) for ${operationName}: ${detail}`);
    }
    if (body === undefined) {
      throw new OmioSchemaError(`${operationName} reply was not JSON`);
    }
    return body;
  }

  private readCache<T>(cache: Map<string, CacheEntry<T>>, key: string): T | undefined {
    const entry = cache.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      cache.delete(key);
      return undefined;
    }
    return entry.value;
  }

  private writeCache<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T, ttlMs: number): void {
    cache.delete(key);
    // Every entry of one cache lives equally long, so the oldest is also the
    // first to go out of date and the right one to drop.
    if (cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, { value, expiresAt: this.now() + ttlMs });
  }
}

let sharedClient: OmioClient | null = null;

/** One client per process, so the queue and caches are shared by every tool call. */
export function getOmioClient(): OmioClient {
  sharedClient ??= new OmioClient();
  return sharedClient;
}
