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
import { getStationName } from './stations.js';

const ENDPOINT = 'https://travel.uber.com/go/travel/graphql';
const SITE_ORIGIN = 'https://travel.uber.com';
// The endpoint rejects requests that carry no CSRF header but accepts any
// value, because there is no session for it to protect. This is not a secret.
const CSRF_PLACEHOLDER = 'x';

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_ERROR_DETAIL_LENGTH = 200;
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

const MAX_POSSESSIVE_TERMS = 2;
// A word that may be a possessive written without its apostrophe ("Shepherds"),
// but not one that merely ends in a double s ("Cross").
const POSSESSIVE_CANDIDATE_PATTERN = /^[a-z]{2,}[^s']s$/i;

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
  const firstPart = (name.split(/\s+(?:&|and)\s+/i)[0] ?? name).trim();
  const asWritten = firstPart === '' ? name : firstPart;
  const withoutApostrophes = asWritten.replace(/['’]/g, '');
  return withoutApostrophes === asWritten ? [asWritten] : [asWritten, withoutApostrophes];
}

function comparableName(name: string): string {
  return nameWords(name).join(' ');
}

/**
 * Spellings of a search term with an apostrophe put back, for a name typed or
 * listed without one ("Shepherds Bush" is stored as "Shepherd's Bush", and the
 * search needs the apostrophe). One word is changed per spelling, and only a
 * few are offered, because each one costs a request.
 */
export function possessiveSearchTerms(term: string): string[] {
  if (/['’]/.test(term)) return [];
  const words = term.split(/\s+/);
  return words
    .flatMap((word, index) =>
      POSSESSIVE_CANDIDATE_PATTERN.test(word)
        ? [[...words.slice(0, index), `${word.slice(0, -1)}'s`, ...words.slice(index + 1)].join(' ')]
        : [],
    )
    .slice(0, MAX_POSSESSIVE_TERMS);
}

/**
 * How strictly a SearchLocation result must match what was asked for.
 * - `crs`: the input was a known CRS code, `name` is that station's name.
 * - `exact`: the input must be the exact name of a place.
 * - `free`: free text, where the API's first suggestion is acceptable.
 */
export type LocationMatch = 'crs' | 'exact' | 'free';

/**
 * Chooses the location to search from a SearchLocation result.
 *
 * A CRS code must never silently turn into some other station, so for `crs`
 * only a British rail station is accepted: one with exactly the station's
 * name, or failing that the single station whose name is that name plus a
 * qualifier ("London St Pancras" to "London St Pancras International"). A
 * shorter name is never accepted ("London Waterloo East" is not "London
 * Waterloo"), and neither is a choice between several longer ones.
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

  if (match === 'crs') {
    const qualified = stations.filter((location) => comparableName(location.name).startsWith(`${wanted} `));
    return qualified.length === 1 ? (qualified[0] ?? null) : null;
  }

  const exactPlace = locations.find(isExact);
  if (exactPlace) return exactPlace;
  return match === 'free' ? (locations[0] ?? null) : null;
}

export class OmioClient {
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly locationCache = new Map<string, CacheEntry<OmioLocation[]>>();
  private readonly searchCache = new Map<string, CacheEntry<OmioFareResult>>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: OmioClientOptions = {}) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
  }

  async searchLocations(query: string): Promise<OmioLocation[]> {
    const name = (query ?? '').trim();
    if (name === '') {
      throw new Error('A location query is required');
    }
    return this.runExclusive(() => this.lookupLocations(name));
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

  private async lookupLocations(name: string): Promise<OmioLocation[]> {
    const cacheKey = name.toLowerCase();
    const cached = this.readCache(this.locationCache, cacheKey);
    if (cached) return cached;

    const body = await this.post('SearchLocation', SEARCH_LOCATION_QUERY, {
      request: { name, locale: 'en-GB' },
    });
    const locations = parseLocations(body);
    if (locations.length > 0) {
      this.writeCache(this.locationCache, cacheKey, locations, LOCATION_CACHE_TTL_MS);
    }
    return locations;
  }

  /**
   * Looks the terms up one after another and stops at the first reply that
   * holds a match for `name`. Also returns every location seen on the way, in
   * reply order, which is what the caller can offer when nothing matched.
   */
  private async lookupFirstMatch(
    terms: readonly string[],
    name: string,
    match: LocationMatch,
  ): Promise<{ picked: OmioLocation | null; seen: OmioLocation[] }> {
    let seen: OmioLocation[] = [];
    for (const term of terms) {
      const locations = await this.lookupLocations(term);
      seen = [...seen, ...locations];
      const picked = pickLocation(locations, name, match);
      if (picked) return { picked, seen };
    }
    return { picked: null, seen };
  }

  private async resolveLocation(input: string): Promise<OmioLocation> {
    const trimmed = input.trim();
    const looksLikeCrs = /^[A-Za-z]{3}$/.test(trimmed);
    const stationName = looksLikeCrs ? getStationName(trimmed) : undefined;
    const name = stationName ?? trimmed;
    const terms = locationSearchTerms(name);
    // A shortened term lists places that merely share a first word, so the
    // first suggestion is no longer a fair reading of what was asked for.
    const shortened = comparableName(terms[0] ?? name) !== comparableName(name);
    // Three letters that are not a code we know may be a typo or a code missing
    // from the station table, so only an exact place name is accepted for them.
    const match: LocationMatch = stationName ? 'crs' : looksLikeCrs || shortened ? 'exact' : 'free';

    // Every spelling is tried for a proper match first. The first suggestion
    // is only a fallback for free text, once none of them matched.
    const strict: LocationMatch = match === 'free' ? 'exact' : match;
    const asGiven = await this.lookupFirstMatch(terms, name, strict);
    // A search that knew nothing at all is what a missing apostrophe looks
    // like. Those spellings are a guess, so only a proper match is taken from them.
    const possessive =
      !asGiven.picked && asGiven.seen.length === 0
        ? await this.lookupFirstMatch(possessiveSearchTerms(terms[0] ?? name), name, strict)
        : { picked: null, seen: [] };
    const picked =
      asGiven.picked ?? possessive.picked ?? (match === 'free' ? (asGiven.seen[0] ?? null) : null);
    if (!picked) {
      const locations = [...asGiven.seen, ...possessive.seen];
      const detail = stationName
        ? ` (${stationName}): no British station with that name came back.`
        : looksLikeCrs
          ? '. It is not a station code this server knows and no place has exactly that name, so pass the full station name.'
          : '.';
      // Naming what did come back saves the caller a second lookup.
      const stationNames = locations
        .filter(
          (location) => location.type === 'station' && (match !== 'crs' || location.countryCode === 'GB'),
        )
        .map((location) => location.name.slice(0, MAX_OFFERED_NAME_LENGTH));
      const offered = [...new Set(stationNames)].slice(0, MAX_OFFERED_LOCATIONS);
      const offer = offered.length > 0 ? ` Uber Travel offers: ${offered.join(', ')}.` : '';
      throw new Error(
        `No Uber Travel location found for "${trimmed}"${detail}${offer} Use omio_locations to see what it knows, then pass that name.`,
      );
    }
    return picked;
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
      // The server answers a query that no longer fits the schema with HTTP 400
      // and a GraphQL error list, and its own failures with HTTP 500 and the same.
      const failure = readGraphqlFailure(body);
      if (failure?.schemaChange) {
        throw new OmioSchemaError(`${operationName} was rejected: ${failure.message}`);
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
