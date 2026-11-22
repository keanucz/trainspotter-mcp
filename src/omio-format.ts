// Text output for the Uber Travel (Omio-backed) tools.

import type { OmioJourney, OmioLocation } from './omio-parse.js';
import { OMIO_RAILCARDS, type OmioFareResult } from './omio.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface OmioFormatOptions {
  directOnly?: boolean;
}

export function formatPence(pence: number): string {
  return `£${(pence / 100).toFixed(2)}`;
}

function clock(timestamp: string): string {
  return timestamp.slice(11, 16);
}

/** Counts whole calendar days from the date part only, so no time is converted. */
function dayNumber(timestamp: string): number {
  const [year, month, day] = timestamp.slice(0, 10).split('-').map(Number) as [number, number, number];
  return Date.UTC(year, month - 1, day) / MS_PER_DAY;
}

/** HH:MM, with +N when the time falls N days after the reference date. */
function clockOnDay(timestamp: string, referenceDate: string): string {
  const daysLater = dayNumber(timestamp) - dayNumber(referenceDate);
  return daysLater > 0 ? `${clock(timestamp)}+${daysLater}` : clock(timestamp);
}

function describeChanges(journey: OmioJourney): string {
  if (journey.changes === 0) return 'direct';
  const noun = journey.changes === 1 ? 'change' : 'changes';
  return `${journey.changes} ${noun} at ${journey.changeStations.join(', ')}`;
}

function describePrice(journey: OmioJourney): string {
  return journey.pricePence === null ? 'price n/a' : formatPence(journey.pricePence);
}

function describeMode(journey: OmioJourney): string {
  return journey.mode === 'other' ? 'mixed' : journey.mode;
}

/**
 * One row per journey. `searchDate` (YYYY-MM-DD) is the day the +N markers
 * count from; it defaults to the journey's own departure day.
 */
export function formatJourneyRow(journey: OmioJourney, searchDate: string = journey.dep.slice(0, 10)): string {
  const columns = [
    `${clockOnDay(journey.dep, searchDate)}→${clockOnDay(journey.arr, searchDate)}`,
    `${journey.origin} → ${journey.destination}`,
    describeChanges(journey),
    journey.operators.join(' + '),
    describeMode(journey),
    describePrice(journey),
  ];
  if (journey.splitSavingPence !== null) {
    columns.push(`split ticket, saves ${formatPence(journey.splitSavingPence)}`);
  }
  if (journey.splitJourneys.length > 0) {
    const tickets = journey.splitJourneys.map(
      (ticket) => `${ticket.origin} → ${ticket.destination} ${describePrice(ticket)}`,
    );
    columns.push(`tickets: ${tickets.join(' + ')}`);
  }
  if (journey.railcardDiscountPence > 0) {
    columns.push(`railcard saves ${formatPence(journey.railcardDiscountPence)}`);
  }
  return columns.join(' | ');
}

function formatDate(date: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
    .format(new Date(`${date}T00:00:00Z`))
    .replace(',', '');
}

function cheapestLine(journeys: readonly OmioJourney[]): string | null {
  const priced = journeys.filter((journey) => journey.pricePence !== null);
  const cheapest = priced.reduce<OmioJourney | null>(
    (best, journey) => (best === null || (journey.pricePence ?? 0) < (best.pricePence ?? 0) ? journey : best),
    null,
  );
  if (!cheapest) return null;
  return `Cheapest: ${describePrice(cheapest)} (${clock(cheapest.dep)} ${describeMode(cheapest)}, ${cheapest.operators.join(' + ')})`;
}

function coverageLine(result: OmioFareResult): string | null {
  if (!result.modes.includes('train')) return null;
  if (!result.trainWindow) {
    return 'No train window was returned: trains may not be on sale for this date yet.';
  }
  const { start, end, moreLater } = result.trainWindow;
  const more = moreLater ? ' Search again with a later time for later trains.' : '';
  const coaches = result.modes.includes('coach') ? ' Coaches cover the rest of the day.' : '';
  return `Trains cover departures ${start}-${end}.${more}${coaches}`;
}

export function formatOmioFares(result: OmioFareResult, options: OmioFormatOptions = {}): string {
  const journeys = options.directOnly
    ? result.journeys.filter((journey) => journey.changes === 0)
    : result.journeys;
  const timezone = journeys[0]?.timezone;

  const header = [
    `Uber Travel (Omio) prices: ${result.origin.name} → ${result.destination.name}, ${formatDate(result.date)} from ${result.time}`,
    result.railcard ? `Railcard: ${result.railcard} (${OMIO_RAILCARDS[result.railcard] ?? 'unknown'})` : null,
    coverageLine(result),
    options.directOnly ? 'Direct journeys only.' : null,
    timezone ? `Times are local (UTC${timezone}).` : null,
  ];

  const body =
    journeys.length > 0
      ? [
          '',
          'dep→arr | from → to | changes | operator | mode | price',
          ...journeys.map((journey) => formatJourneyRow(journey, result.date)),
          '',
        ]
      : ['', `No journeys found from ${result.time}.`, ''];

  const footer = [
    cheapestLine(journeys),
    ...result.notes.map((note) => `Note: ${note}`),
    ...result.disclaimers.map((disclaimer) => `Uber notice: ${disclaimer}`),
    'These are list prices shown by Uber Travel (Omio) at search time, not a booking or a held fare. ' +
      'The source is an undocumented API, so treat it as a second opinion.',
  ];

  return [...header, ...body, ...footer].filter((line): line is string => line !== null).join('\n');
}

export function formatOmioLocations(query: string, locations: readonly OmioLocation[]): string {
  if (locations.length === 0) {
    return `No Uber Travel locations match "${query}". Try a shorter or differently spelled name.`;
  }
  return [
    `Uber Travel locations matching "${query}":`,
    '',
    ...locations.map(
      (location) => `${location.name} | ${location.type} | ${location.countryCode} | id ${location.id}`,
    ),
    '',
    'Pass a name from this list as from/to in search_omio_fares.',
  ].join('\n');
}
