// MCP tool definitions and handlers for the Uber Travel (Omio-backed) search.

import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { formatOmioFares, formatOmioLocations } from './omio-format.js';
import { OMIO_RAILCARDS, getOmioClient, type OmioClient, type OmioFareQuery } from './omio.js';

const SEARCH_TOOL = 'search_omio_fares';
const LOCATIONS_TOOL = 'omio_locations';

export const omioTools: Tool[] = [
  {
    name: SEARCH_TOOL,
    description:
      'Search train and coach prices for one date via Uber Travel (Omio-backed). Unlike search_fares, which lists the fare table, this returns one row per departure with the price currently shown for that train or coach, including advance fares, split tickets and National Express coaches. No API key and no monthly quota, so use it as the second opinion next to search_fares. Trains are returned for at least `hours` hours from `time` (default 4, usually a little more); raise `hours` or search again with a later time for more. Coaches are returned for the rest of the day. Caveats: this is an undocumented API that may break without notice, and prices are list prices at search time, not a booking or a held fare.',
    inputSchema: {
      type: 'object',
      properties: {
        from: {
          type: 'string',
          description: 'Origin: 3-letter CRS code (e.g. LPY) or a station/city name (e.g. "Liverpool")',
        },
        to: {
          type: 'string',
          description: 'Destination: 3-letter CRS code (e.g. EUS) or a station/city name',
        },
        date: {
          type: 'string',
          description: 'Travel date as YYYY-MM-DD (YYYYMMDD is also accepted)',
        },
        time: {
          type: 'string',
          description: 'Earliest departure as HH:MM, UK local time (default 06:00)',
        },
        modes: {
          type: 'array',
          items: { type: 'string', enum: ['train', 'coach'] },
          description: 'Transport modes to search (default both)',
        },
        railcards: {
          type: 'array',
          items: { type: 'string' },
          description: `One railcard code, the same codes search_fares takes: ${Object.keys(OMIO_RAILCARDS).join(', ')}`,
        },
        age: {
          type: 'number',
          description: 'Traveller age in years (default 30)',
        },
        hours: {
          type: 'integer',
          minimum: 1,
          maximum: 12,
          description:
            'How many hours of trains to return from `time`: a whole number from 1 to 12 (default 4). More hours make the search slower, about 2 seconds per extra 1-2 hours',
        },
        direct_only: {
          type: 'boolean',
          description: 'Only show journeys with no changes (default false)',
        },
      },
      required: ['from', 'to', 'date'],
    },
  },
  {
    name: LOCATIONS_TOOL,
    description:
      'Look up the stations, coach stops and cities Uber Travel (Omio) knows for a name. Use it when search_omio_fares cannot resolve a place, or to find the exact name of a coach stop. Undocumented API; may break without notice.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Full or partial place name, e.g. "Liverpool" or "Victoria Coach"',
        },
      },
      required: ['query'],
    },
  },
];

export function isOmioTool(name: string): boolean {
  return name === SEARCH_TOOL || name === LOCATIONS_TOOL;
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`"${key}" is required and must be text`);
  }
  return value;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`"${key}" must be text`);
  return value;
}

function optionalStringList(args: Record<string, unknown>, key: string): string[] | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`"${key}" must be a list of text values`);
  }
  return value as string[];
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number') throw new Error(`"${key}" must be a number`);
  return value;
}

function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw new Error(`"${key}" must be true or false`);
  return value;
}

function readFareQuery(args: Record<string, unknown>): OmioFareQuery {
  return {
    from: requireString(args, 'from'),
    to: requireString(args, 'to'),
    date: requireString(args, 'date'),
    time: optionalString(args, 'time'),
    modes: optionalStringList(args, 'modes'),
    railcards: optionalStringList(args, 'railcards'),
    age: optionalNumber(args, 'age'),
    hours: optionalNumber(args, 'hours'),
  };
}

function textResult(text: string, isError = false): CallToolResult {
  return isError ? { content: [{ type: 'text', text }], isError: true } : { content: [{ type: 'text', text }] };
}

export async function handleOmioTool(
  name: string,
  rawArgs: unknown,
  client: OmioClient = getOmioClient(),
): Promise<CallToolResult> {
  const args = rawArgs !== null && typeof rawArgs === 'object' ? (rawArgs as Record<string, unknown>) : {};
  const label = name === SEARCH_TOOL ? 'Uber Travel fare search error' : 'Uber Travel location search error';

  try {
    if (name === SEARCH_TOOL) {
      const directOnly = optionalBoolean(args, 'direct_only') ?? false;
      const result = await client.searchFares(readFareQuery(args));
      return textResult(formatOmioFares(result, { directOnly }));
    }
    if (name === LOCATIONS_TOOL) {
      const query = requireString(args, 'query');
      return textResult(formatOmioLocations(query, await client.searchLocations(query)));
    }
    return textResult(`Unknown tool: ${name}`, true);
  } catch (error) {
    return textResult(`${label}: ${error instanceof Error ? error.message : String(error)}`, true);
  }
}
