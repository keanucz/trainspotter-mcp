// Parsing and validation for Uber Travel (Omio-backed) GraphQL responses.
//
// The API is undocumented, so every response is treated as untrusted input and
// narrowed field by field. Anything unexpected raises OmioSchemaError with the
// path that failed, so a schema change upstream is obvious instead of silent.

export class OmioSchemaError extends Error {
  constructor(detail: string) {
    super(
      `Uber Travel response did not match the expected shape (${detail}). ` +
        'This is an undocumented API and it has probably changed; the omio tools need updating.',
    );
    this.name = 'OmioSchemaError';
  }
}

export type OmioMode = 'train' | 'coach' | 'other';

export interface OmioLocation {
  id: string;
  name: string;
  type: string;
  countryCode: string;
  latitude: number;
  longitude: number;
}

export interface OmioSegment {
  from: string;
  to: string;
  dep: string;
  arr: string;
  mode: OmioMode;
  operator: string;
  transportId: string | null;
}

export interface OmioJourney {
  id: string;
  /** Local wall-clock timestamp exactly as the API gave it, e.g. 2027-01-30T12:54:00. */
  dep: string;
  arr: string;
  /** UTC offset the API reported for the departure, e.g. +00:00. */
  timezone: string;
  origin: string;
  destination: string;
  changes: number;
  changeStations: string[];
  operators: string[];
  mode: OmioMode;
  pricePence: number | null;
  railcardDiscountPence: number;
  /** Saving against the through fare when the price is a split ticket. */
  splitSavingPence: number | null;
  splitJourneys: OmioJourney[];
  alternativeStation: boolean;
  segments: OmioSegment[];
}

export interface OmioTrainWindow {
  /** First and last departure time the returned trains cover, as HH:MM. */
  start: string;
  end: string;
  moreLater: boolean;
}

export type OmioSearchStatus = 'running' | 'done';

export interface OmioBooking {
  searchId: string;
  status: OmioSearchStatus;
  currency: string;
  journeys: OmioJourney[];
  trainWindow: OmioTrainWindow | null;
  disclaimers: string[];
}

export interface OmioSearchStart {
  searchId: string;
  status: OmioSearchStatus;
}

type Json = Record<string, unknown>;

const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
const CLOCK_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const STATUS_BY_WIRE_VALUE: Readonly<Record<string, OmioSearchStatus>> = {
  SEARCH_STATUS_RUNNING: 'running',
  SEARCH_STATUS_DONE: 'done',
};
const MODE_BY_WIRE_VALUE: Readonly<Record<string, OmioMode>> = {
  TRAVEL_MODE_TRAIN: 'train',
  TRAVEL_MODE_BUS: 'coach',
};

function asObject(value: unknown, path: string): Json {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new OmioSchemaError(`${path} is not an object`);
  }
  return value as Json;
}

function asArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new OmioSchemaError(`${path} is not a list`);
  }
  return value;
}

function asString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new OmioSchemaError(`${path} is not a non-empty string`);
  }
  return value;
}

function asNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new OmioSchemaError(`${path} is not a number`);
  }
  return value;
}

/** A wall-clock time as HH:MM, the form train windows use. */
function asClock(value: unknown, path: string): string {
  const clock = asString(value, path);
  if (!CLOCK_PATTERN.test(clock)) {
    throw new OmioSchemaError(`${path} "${clock}" is not an HH:MM time`);
  }
  return clock;
}

function asOptionalList(value: unknown, path: string): unknown[] {
  return value === null || value === undefined ? [] : asArray(value, path);
}

// Error codes the live endpoint attaches (`extensions.code`) when our query no
// longer fits what the server accepts: an unknown field, an unparseable query,
// or a server that has moved to accepting only its own stored queries.
const SCHEMA_ERROR_CODES: ReadonlySet<string> = new Set([
  'GRAPHQL_VALIDATION_FAILED',
  'GRAPHQL_PARSE_FAILED',
  'PERSISTED_QUERY_NOT_FOUND',
  'PERSISTED_QUERY_NOT_SUPPORTED',
]);
// The server uses this code both for variables that no longer fit the input
// type (a schema change) and for values it rejects. Only the first kind names
// the variable.
const BAD_INPUT_CODE = 'BAD_USER_INPUT';
const VARIABLE_MISMATCH_PATTERN = /^Variable "\$/;
// Fallback for a reply with no error code: the wording GraphQL servers use
// when a query no longer fits their schema.
const GRAPHQL_VALIDATION_PATTERN =
  /Cannot query field|Unknown (argument|type|field|fragment)|is not defined by type|of required type|Expected (value of )?type|got invalid value/i;
const MAX_ERROR_MESSAGE_LENGTH = 200;

export interface GraphqlFailure {
  message: string;
  /** True when the error says our query or variables no longer fit the schema. */
  schemaChange: boolean;
}

function describeGraphqlError(raw: unknown): GraphqlFailure {
  const error = raw !== null && typeof raw === 'object' ? (raw as Json) : {};
  const message = (typeof error['message'] === 'string' ? error['message'] : JSON.stringify(raw)).slice(
    0,
    MAX_ERROR_MESSAGE_LENGTH,
  );
  const extensions = error['extensions'];
  const code =
    extensions !== null && typeof extensions === 'object' ? (extensions as Json)['code'] : undefined;

  if (typeof code !== 'string') {
    return { message, schemaChange: GRAPHQL_VALIDATION_PATTERN.test(message) };
  }
  const schemaChange =
    SCHEMA_ERROR_CODES.has(code) || (code === BAD_INPUT_CODE && VARIABLE_MISMATCH_PATTERN.test(message));
  return { message, schemaChange };
}

/**
 * Reads the `errors` list of a GraphQL reply. Returns null when there is none.
 * A schema error anywhere in the list wins, because that is the one that
 * needs the code to be updated; otherwise the first error is reported.
 */
export function readGraphqlFailure(body: unknown): GraphqlFailure | null {
  if (body === null || typeof body !== 'object') return null;
  const errors = (body as Json)['errors'];
  if (!Array.isArray(errors) || errors.length === 0) return null;
  const failures = errors.map(describeGraphqlError);
  return failures.find((failure) => failure.schemaChange) ?? failures[0] ?? null;
}

/**
 * Unwraps `{ data: { <operation>: ... } }`, surfacing GraphQL errors first.
 * Only errors about the query itself count as a schema change; anything else
 * the server reports (a rejected search, an internal error) is passed on as it is.
 */
export function unwrapOperation(body: unknown, operation: string): Json {
  const root = asObject(body, 'response');
  const failure = readGraphqlFailure(root);
  if (failure) {
    if (failure.schemaChange) {
      throw new OmioSchemaError(`GraphQL validation error from ${operation}: ${failure.message}`);
    }
    throw new Error(`Uber Travel returned an error from ${operation}: ${failure.message}`);
  }
  const data = asObject(root['data'], 'data');
  return asObject(data[operation], `data.${operation}`);
}

function parseStatus(value: unknown, path: string): OmioSearchStatus {
  const wire = asString(value, path);
  const status = STATUS_BY_WIRE_VALUE[wire];
  if (!status) {
    // FAILED, EXPIRED and friends are a real answer, not a schema change.
    throw new Error(`Uber Travel search ended with status ${wire}`);
  }
  return status;
}

function parseMode(value: unknown, path: string): OmioMode {
  return MODE_BY_WIRE_VALUE[asString(value, path)] ?? 'other';
}

function parseTimestamp(value: unknown, path: string): string {
  const timestamp = asString(asObject(value, path)['timestamp'], `${path}.timestamp`);
  if (!TIMESTAMP_PATTERN.test(timestamp)) {
    throw new OmioSchemaError(`${path}.timestamp "${timestamp}" is not a local YYYY-MM-DDTHH:MM:SS time`);
  }
  return timestamp;
}

export function parseLocations(body: unknown): OmioLocation[] {
  const operation = unwrapOperation(body, 'SearchLocation');
  return asArray(operation['locations'], 'SearchLocation.locations').map((raw, index) => {
    const path = `SearchLocation.locations[${index}]`;
    const location = asObject(raw, path);
    return {
      id: asString(location['id'], `${path}.id`),
      name: asString(location['name'], `${path}.name`),
      type: asString(location['type'], `${path}.type`),
      countryCode: asString(location['countryCode'], `${path}.countryCode`),
      latitude: asNumber(location['latitude'], `${path}.latitude`),
      longitude: asNumber(location['longitude'], `${path}.longitude`),
    };
  });
}

/** Parses the `booking { searchId status }` reply of SearchJourneys and ExtendSearchWithoutQuotes. */
export function parseSearchStart(body: unknown, operation: string): OmioSearchStart {
  const booking = asObject(unwrapOperation(body, operation)['booking'], `${operation}.booking`);
  return {
    searchId: asString(booking['searchId'], `${operation}.booking.searchId`),
    status: parseStatus(booking['status'], `${operation}.booking.status`),
  };
}

function parseSegment(raw: unknown, path: string, carriers: ReadonlyMap<string, string>): OmioSegment {
  const segment = asObject(raw, path);
  const carrierId = typeof segment['carrierId'] === 'string' ? segment['carrierId'] : '';
  const transportId = segment['transportId'];
  return {
    from: asString(asObject(segment['departure'], `${path}.departure`)['name'], `${path}.departure.name`),
    to: asString(asObject(segment['arrival'], `${path}.arrival`)['name'], `${path}.arrival.name`),
    dep: parseTimestamp(segment['departureTime'], `${path}.departureTime`),
    arr: parseTimestamp(segment['arrivalTime'], `${path}.arrivalTime`),
    mode: parseMode(segment['travelMode'], `${path}.travelMode`),
    operator: carriers.get(carrierId) ?? (carrierId ? `carrier ${carrierId}` : 'unknown operator'),
    transportId: typeof transportId === 'string' && transportId !== '' ? transportId : null,
  };
}

function parsePrice(value: unknown, path: string): number | null {
  if (value === null || value === undefined) return null;
  const pence = asNumber(value, path);
  return pence > 0 ? pence : null;
}

function sumDiscounts(value: unknown, path: string): number {
  return asOptionalList(value, path).reduce<number>((total, raw, index) => {
    const discount = asObject(raw, `${path}[${index}]`);
    return total + asNumber(discount['totalValueInCents'], `${path}[${index}].totalValueInCents`);
  }, 0);
}

function journeyMode(segments: readonly OmioSegment[]): OmioMode {
  const modes = new Set(segments.map((segment) => segment.mode));
  if (modes.size !== 1) return 'other';
  return segments[0]?.mode ?? 'other';
}

function parseJourney(raw: unknown, path: string, carriers: ReadonlyMap<string, string>): OmioJourney {
  const journey = asObject(raw, path);
  const leg = asObject(journey['departure'], `${path}.departure`);
  const segments = asArray(leg['segments'], `${path}.departure.segments`).map((segment, index) =>
    parseSegment(segment, `${path}.departure.segments[${index}]`, carriers),
  );
  const first = segments[0];
  const last = segments[segments.length - 1];
  if (!first || !last) {
    throw new OmioSchemaError(`${path}.departure.segments is empty`);
  }

  const departureTime = asObject(leg['departureTime'], `${path}.departure.departureTime`);
  const split = leg['split'];
  const splitSaving =
    split === null || split === undefined
      ? null
      : asNumber(asObject(split, `${path}.departure.split`)['savingCents'], `${path}.departure.split.savingCents`);

  return {
    id: asString(journey['id'], `${path}.id`),
    dep: parseTimestamp(leg['departureTime'], `${path}.departure.departureTime`),
    arr: parseTimestamp(leg['arrivalTime'], `${path}.departure.arrivalTime`),
    timezone: typeof departureTime['timezone'] === 'string' ? departureTime['timezone'] : '',
    origin: first.from,
    destination: last.to,
    changes: segments.length - 1,
    changeStations: segments.slice(0, -1).map((segment) => segment.to),
    operators: [...new Set(segments.map((segment) => segment.operator))],
    mode: journeyMode(segments),
    pricePence: parsePrice(journey['cheapestPriceCents'], `${path}.cheapestPriceCents`),
    railcardDiscountPence: sumDiscounts(journey['discounts'], `${path}.discounts`),
    splitSavingPence: splitSaving,
    splitJourneys: asOptionalList(journey['splitJourneys'], `${path}.splitJourneys`).map((child, index) =>
      parseJourney(child, `${path}.splitJourneys[${index}]`, carriers),
    ),
    alternativeStation: leg['isAlternativeDeparture'] === true || leg['isAlternativeArrival'] === true,
    segments,
  };
}

function parseCarriers(value: unknown, path: string): ReadonlyMap<string, string> {
  return new Map(
    asOptionalList(value, path).map((raw, index): [string, string] => {
      const carrier = asObject(raw, `${path}[${index}]`);
      return [asString(carrier['id'], `${path}[${index}].id`), asString(carrier['name'], `${path}[${index}].name`)];
    }),
  );
}

function parseTrainWindow(value: unknown, path: string): OmioTrainWindow | null {
  for (const [index, raw] of asOptionalList(value, path).entries()) {
    const option = asObject(raw, `${path}[${index}]`);
    if (option['travelMode'] !== 'TRAVEL_MODE_TRAIN') continue;
    const intervals = asObject(option['currentIntervals'], `${path}[${index}].currentIntervals`);
    const outbound = asOptionalList(intervals['outbound'], `${path}[${index}].currentIntervals.outbound`);
    const interval = outbound[0];
    if (interval === undefined) return null;
    const intervalPath = `${path}[${index}].currentIntervals.outbound[0]`;
    const parsed = asObject(interval, intervalPath);
    return {
      start: asClock(parsed['start'], `${intervalPath}.start`),
      end: asClock(parsed['end'], `${intervalPath}.end`),
      moreLater: option['outboundLater'] === true,
    };
  }
  return null;
}

export function parseBooking(body: unknown): OmioBooking {
  const operation = 'GetSearchWithoutQuotes';
  const booking = asObject(unwrapOperation(body, operation)['booking'], `${operation}.booking`);
  const carriers = parseCarriers(booking['carriers'], 'booking.carriers');

  return {
    searchId: asString(booking['searchId'], 'booking.searchId'),
    status: parseStatus(booking['status'], 'booking.status'),
    currency: asString(booking['currency'], 'booking.currency'),
    journeys: asArray(booking['journeys'], 'booking.journeys').map((journey, index) =>
      parseJourney(journey, `booking.journeys[${index}]`, carriers),
    ),
    trainWindow: parseTrainWindow(booking['extensionOptions'], 'booking.extensionOptions'),
    disclaimers: asOptionalList(booking['searchDisclaimers'], 'booking.searchDisclaimers').flatMap((raw) => {
      const message = raw !== null && typeof raw === 'object' ? (raw as Json)['message'] : undefined;
      return typeof message === 'string' && message !== '' ? [message] : [];
    }),
  };
}
