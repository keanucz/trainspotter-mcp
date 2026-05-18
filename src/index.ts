#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';

import { createDarwinClient } from './darwin.js';
import { createHspClient } from './hsp.js';
import { createFaresClient } from './fares.js';
import { getStationName, findStation, isValidCrs } from './stations.js';
import type { StationBoard, ServiceDetails, HspMetrics, FaresResponse } from './types.js';

const tools: Tool[] = [
  {
    name: 'get_departures',
    description:
      'Get live departure board for a UK station. Returns scheduled/estimated times, platforms, operators, delays, and cancellations. Use 3-letter CRS codes (e.g. KGX=Kings Cross, MAN=Manchester Piccadilly, EDB=Edinburgh). Use get_station_info to look up codes.',
    inputSchema: {
      type: 'object',
      properties: {
        station: {
          type: 'string',
          description: '3-letter CRS station code (e.g. KGX, MAN, EDB)',
        },
        destination: {
          type: 'string',
          description: 'Optional destination CRS code to filter services',
        },
        rows: {
          type: 'number',
          description: 'Number of services to return (default 10, max 150)',
          default: 10,
        },
      },
      required: ['station'],
    },
  },
  {
    name: 'get_arrivals',
    description:
      'Get live arrival board for a UK station. Returns scheduled/estimated arrival times, platforms, origins, delays, and cancellations.',
    inputSchema: {
      type: 'object',
      properties: {
        station: {
          type: 'string',
          description: '3-letter CRS station code',
        },
        origin: {
          type: 'string',
          description: 'Optional origin CRS code to filter services',
        },
        rows: {
          type: 'number',
          description: 'Number of services to return (default 10, max 150)',
          default: 10,
        },
      },
      required: ['station'],
    },
  },
  {
    name: 'get_service_details',
    description:
      'Get full details for a specific train service including all calling points (previous and upcoming stops), estimated/actual times at each stop, platform, and delay/cancellation info. Use a serviceId from departure or arrival board results.',
    inputSchema: {
      type: 'object',
      properties: {
        service_id: {
          type: 'string',
          description: 'Service ID from a departure/arrival board result',
        },
      },
      required: ['service_id'],
    },
  },
  {
    name: 'search_trains',
    description:
      'Find trains between two stations. Returns departure board filtered by destination, showing available services with times, platforms, and delay status.',
    inputSchema: {
      type: 'object',
      properties: {
        from: {
          type: 'string',
          description: 'Departure station CRS code',
        },
        to: {
          type: 'string',
          description: 'Destination station CRS code',
        },
        rows: {
          type: 'number',
          description: 'Number of services to return (default 10)',
          default: 10,
        },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'get_disruptions',
    description:
      'Get current disruption messages (NRCC messages) for a station or all stations in the departure board response. Includes service alerts, engineering works, and general travel advice.',
    inputSchema: {
      type: 'object',
      properties: {
        station: {
          type: 'string',
          description: '3-letter CRS station code',
        },
      },
      required: ['station'],
    },
  },
  {
    name: 'get_delay_history',
    description:
      'Get historical delay/punctuality statistics between two stations using HSP (Historical Service Performance) data. Shows on-time percentage, average delays, and cancellation rates over a configurable period.',
    inputSchema: {
      type: 'object',
      properties: {
        from: {
          type: 'string',
          description: 'Departure station CRS code',
        },
        to: {
          type: 'string',
          description: 'Destination station CRS code',
        },
        days: {
          type: 'number',
          description: 'Number of days of history to analyse (default 28)',
          default: 28,
        },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'get_station_info',
    description:
      'Look up UK station CRS codes by name. Use when you need to find the 3-letter code for a station. Supports fuzzy search by name.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Station name or partial name to search (e.g. "Manchester", "Kings Cross") OR a CRS code to get the station name',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_fares',
    description:
      'Search for train fares between two UK stations. Returns walk-up fares (anytime, off-peak, super off-peak), restricted availability fares (advance), and pay-as-you-go fares. Prices include adult and child. Supports up to 3 railcards (e.g. YNG=16-25, TSU=Two Together, SRN=Senior, FAM=Family & Friends, DIS=Disabled, NGC=Network). Limited to 100 searches per month on free tier.',
    inputSchema: {
      type: 'object',
      properties: {
        from: {
          type: 'string',
          description: 'Origin station CRS code (e.g. MAN, KGX, EDB)',
        },
        to: {
          type: 'string',
          description: 'Destination station CRS code',
        },
        railcards: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Railcard codes to apply (max 3). Common: YNG=16-25, TSU=Two Together, SRN=Senior, FAM=Family & Friends, DIS=Disabled Persons, NGC=Network Railcard, HMF=HM Forces, JCP=Jobcentre Plus',
        },
        date: {
          type: 'string',
          description: 'Date in YYYYMMDD format. If omitted, returns current fares.',
        },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'list_railcards',
    description:
      'List all available railcards and discount codes that can be used with search_fares. Returns code, name, and whether each is available for online purchase.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'list_fare_locations',
    description:
      'List all locations that have fares available in the BR Fares database. Useful for finding NLC codes and verifying station names for fare searches.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

const server = new Server(
  { name: 'trainspotter-mcp', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case 'get_departures': {
      const { station, destination, rows } = args as {
        station: string;
        destination?: string;
        rows?: number;
      };
      const crs = station.toUpperCase();
      if (!isValidCrs(crs)) {
        const suggestions = findStation(station);
        if (suggestions.length > 0) {
          return {
            content: [
              {
                type: 'text',
                text: `Unknown station code "${station}". Did you mean:\n${suggestions.map((s) => `  ${s.crs} — ${s.name}`).join('\n')}`,
              },
            ],
            isError: true,
          };
        }
        return {
          content: [{ type: 'text', text: `Unknown station code: ${station}` }],
          isError: true,
        };
      }

      const darwin = createDarwinClient();
      const board = await darwin.getDepartures(
        crs,
        rows ?? 10,
        destination?.toUpperCase()
      );
      return { content: [{ type: 'text', text: formatBoard(board, 'departures') }] };
    }

    case 'get_arrivals': {
      const { station, origin, rows } = args as {
        station: string;
        origin?: string;
        rows?: number;
      };
      const crs = station.toUpperCase();
      if (!isValidCrs(crs)) {
        const suggestions = findStation(station);
        if (suggestions.length > 0) {
          return {
            content: [
              {
                type: 'text',
                text: `Unknown station code "${station}". Did you mean:\n${suggestions.map((s) => `  ${s.crs} — ${s.name}`).join('\n')}`,
              },
            ],
            isError: true,
          };
        }
        return {
          content: [{ type: 'text', text: `Unknown station code: ${station}` }],
          isError: true,
        };
      }

      const darwin = createDarwinClient();
      const board = await darwin.getArrivals(
        crs,
        rows ?? 10,
        origin?.toUpperCase()
      );
      return { content: [{ type: 'text', text: formatBoard(board, 'arrivals') }] };
    }

    case 'get_service_details': {
      const { service_id } = args as { service_id: string };
      const sid = service_id.replace(/_/g, '/');

      const darwin = createDarwinClient();
      const details = await darwin.getServiceDetails(sid);
      return { content: [{ type: 'text', text: formatServiceDetails(details) }] };
    }

    case 'search_trains': {
      const { from, to, rows } = args as {
        from: string;
        to: string;
        rows?: number;
      };
      const fromCrs = from.toUpperCase();
      const toCrs = to.toUpperCase();

      for (const [code, label] of [
        [fromCrs, 'from'],
        [toCrs, 'to'],
      ] as const) {
        if (!isValidCrs(code)) {
          const suggestions = findStation(code);
          return {
            content: [
              {
                type: 'text',
                text: suggestions.length > 0
                  ? `Unknown ${label} station "${code}". Did you mean:\n${suggestions.map((s) => `  ${s.crs} — ${s.name}`).join('\n')}`
                  : `Unknown ${label} station code: ${code}`,
              },
            ],
            isError: true,
          };
        }
      }

      const darwin = createDarwinClient();
      const board = await darwin.getDepartures(fromCrs, rows ?? 10, toCrs);
      return {
        content: [
          {
            type: 'text',
            text: formatBoard(board, 'departures'),
          },
        ],
      };
    }

    case 'get_disruptions': {
      const { station } = args as { station: string };
      const crs = station.toUpperCase();

      const darwin = createDarwinClient();
      const board = await darwin.getDepartures(crs, 1);

      if (board.nrccMessages.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `No disruption messages for ${board.locationName} (${board.crs})`,
            },
          ],
        };
      }

      const lines = [
        `Disruptions at ${board.locationName} (${board.crs})`,
        '',
        ...board.nrccMessages.map((msg, i) => `${i + 1}. ${msg}`),
      ];

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    case 'get_delay_history': {
      const { from, to, days } = args as {
        from: string;
        to: string;
        days?: number;
      };

      const hsp = createHspClient();
      const metrics = await hsp.getDelayHistory(
        from.toUpperCase(),
        to.toUpperCase(),
        days ?? 28
      );
      return { content: [{ type: 'text', text: formatHspMetrics(metrics) }] };
    }

    case 'get_station_info': {
      const { query } = args as { query: string };
      const upper = query.toUpperCase().trim();

      if (upper.length === 3 && isValidCrs(upper)) {
        const name = getStationName(upper);
        return {
          content: [{ type: 'text', text: `${upper} — ${name}` }],
        };
      }

      const results = findStation(query);
      if (results.length === 0) {
        return {
          content: [
            { type: 'text', text: `No stations found matching "${query}"` },
          ],
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: `Stations matching "${query}":\n${results.map((s) => `  ${s.crs} — ${s.name}`).join('\n')}`,
          },
        ],
      };
    }

    case 'search_fares': {
      const { from, to, railcards, date } = args as {
        from: string;
        to: string;
        railcards?: string[];
        date?: string;
      };

      try {
        const fares = createFaresClient();
        const result = await fares.searchFares(
          from.toUpperCase(),
          to.toUpperCase(),
          railcards?.map((r) => r.toUpperCase()),
          date
        );
        return { content: [{ type: 'text', text: formatFares(result) }] };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes('BRFARES_API_KEY')) {
          return {
            content: [
              {
                type: 'text',
                text: 'BR Fares API not configured. Set BRFARES_API_KEY environment variable.',
              },
            ],
            isError: true,
          };
        }
        return {
          content: [{ type: 'text', text: `Fare search error: ${msg}` }],
          isError: true,
        };
      }
    }

    case 'list_railcards': {
      try {
        const fares = createFaresClient();
        const railcards = await fares.listRailcards();
        const lines = ['Available railcards:', ''];
        for (const rc of railcards) {
          lines.push(`  ${rc.code} — ${rc.name}${rc.online_display ? '' : ' (not available online)'}`);
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : error}` }],
          isError: true,
        };
      }
    }

    case 'list_fare_locations': {
      try {
        const fares = createFaresClient();
        const locations = await fares.listLocations();
        const lines = [`${locations.length} fare locations available. Showing first 50:`, ''];
        for (const loc of locations.slice(0, 50)) {
          lines.push(`  ${loc.crs || loc.nlc} — ${loc.name}`);
        }
        if (locations.length > 50) {
          lines.push(`  ... and ${locations.length - 50} more`);
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : error}` }],
          isError: true,
        };
      }
    }

    default:
      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }
});

function formatBoard(board: StationBoard, type: 'departures' | 'arrivals'): string {
  const title =
    type === 'departures' ? 'Departures from' : 'Arrivals at';
  const filter = board.filterLocationName
    ? ` (${type === 'departures' ? 'to' : 'from'} ${board.filterLocationName})`
    : '';

  const lines = [
    `${title} ${board.locationName} (${board.crs})${filter}`,
    `Generated: ${board.generatedAt}`,
    '',
  ];

  if (board.services.length === 0) {
    lines.push('No services found.');
    return lines.join('\n');
  }

  for (const svc of board.services) {
    const time =
      type === 'departures'
        ? `${svc.std ?? '??:??'} → ${svc.etd ?? ''}`
        : `${svc.sta ?? '??:??'} → ${svc.eta ?? ''}`;

    const dest =
      type === 'departures'
        ? svc.destination.map((d) => d.locationName + (d.via ? ` ${d.via}` : '')).join(', ')
        : svc.origin.map((o) => o.locationName + (o.via ? ` ${o.via}` : '')).join(', ');

    const platform = svc.platform ? `Plat ${svc.platform}` : 'No platform';
    const status =
      svc.status === 'Delayed' && svc.delayMinutes > 0
        ? `DELAYED +${svc.delayMinutes}min`
        : svc.status === 'Cancelled'
          ? `CANCELLED${svc.cancelReason ? ` (${svc.cancelReason})` : ''}`
          : svc.status;

    const delayInfo = svc.delayReason ? ` — ${svc.delayReason}` : '';

    lines.push(
      `${time} | ${dest} | ${svc.operator} | ${platform} | ${status}${delayInfo}`
    );
    lines.push(`  ID: ${svc.serviceIdUrlSafe}${svc.length ? ` | ${svc.length} coaches` : ''}`);
  }

  if (board.nrccMessages.length > 0) {
    lines.push('', 'Messages:');
    for (const msg of board.nrccMessages) {
      lines.push(`  - ${msg}`);
    }
  }

  return lines.join('\n');
}

function formatServiceDetails(details: ServiceDetails): string {
  const lines = [
    `${details.operator} ${details.serviceType} service`,
    `At ${details.locationName} (${details.crs})`,
    '',
  ];

  if (details.std) lines.push(`Scheduled departure: ${details.std}`);
  if (details.etd) lines.push(`Expected departure: ${details.etd}`);
  if (details.sta) lines.push(`Scheduled arrival: ${details.sta}`);
  if (details.eta) lines.push(`Expected arrival: ${details.eta}`);
  if (details.platform) lines.push(`Platform: ${details.platform}`);
  if (details.length) lines.push(`Coaches: ${details.length}`);

  if (details.isCancelled) {
    lines.push(`STATUS: CANCELLED`);
    if (details.cancelReason) lines.push(`Reason: ${details.cancelReason}`);
  } else if (details.delayReason) {
    lines.push(`Delay reason: ${details.delayReason}`);
  }

  if (details.previousCallingPoints.length > 0) {
    lines.push('', 'Previous stops:');
    for (const cp of details.previousCallingPoints) {
      const actual = cp.at ? `(arrived ${cp.at})` : cp.et ? `(exp ${cp.et})` : '';
      const cancelled = cp.isCancelled ? ' [CANCELLED]' : '';
      lines.push(`  ${cp.st} ${cp.locationName} (${cp.crs}) ${actual}${cancelled}`);
    }
  }

  if (details.subsequentCallingPoints.length > 0) {
    lines.push('', 'Upcoming stops:');
    for (const cp of details.subsequentCallingPoints) {
      const estimate = cp.et ? `(exp ${cp.et})` : cp.at ? `(arrived ${cp.at})` : '';
      const cancelled = cp.isCancelled ? ' [CANCELLED]' : '';
      lines.push(`  ${cp.st} ${cp.locationName} (${cp.crs}) ${estimate}${cancelled}`);
    }
  }

  return lines.join('\n');
}

function formatHspMetrics(metrics: HspMetrics): string {
  const lines = [
    `Delay history: ${metrics.fromStation} → ${metrics.toStation}`,
    `(${metrics.fromStationCrs} → ${metrics.toStationCrs})`,
    '',
    `Total trains analysed: ${metrics.totalTrains}`,
    `On time: ${metrics.onTimePercentage.toFixed(1)}%`,
    `Late: ${metrics.latePercentage.toFixed(1)}%`,
    `Cancelled: ${metrics.cancelledPercentage.toFixed(1)}%`,
    `Average delay: ${metrics.averageDelayMinutes.toFixed(1)} minutes`,
  ];

  if (metrics.toleranceData.length > 0) {
    lines.push('', 'Breakdown by lateness:');
    for (const band of metrics.toleranceData) {
      const label =
        band.toleranceMinutes === 0
          ? 'On time or early'
          : `Within ${band.toleranceMinutes} min`;
      lines.push(
        `  ${label}: ${band.numServices} trains (${band.percentageOfServices.toFixed(1)}%)`
      );
    }
  }

  return lines.join('\n');
}

function penceToPounds(pence: number): string {
  return `£${(pence / 100).toFixed(2)}`;
}

function formatFares(result: FaresResponse): string {
  const lines = [
    `Fares: ${result.orig.name} → ${result.dest.name}`,
    `(${result.orig.crs || result.orig.nlc} → ${result.dest.crs || result.dest.nlc})`,
  ];

  if (result.railcards.length > 0) {
    lines.push(`Railcards: ${result.railcards.map((r) => r.name).join(', ')}`);
  }

  lines.push('');

  if (result.walkup.length > 0) {
    lines.push(`Walk-up fares (${result.walkup.length}):`);
    for (const fare of result.walkup) {
      const ticket = fare.ticket;
      const cls = ticket.tclass === 1 ? '1st' : 'Std';
      const type = fare.type === 'SINGLE' ? 'SGL' : 'RTN';
      const route = fare.route?.name && !fare.route.name.includes('any permitted')
        ? ` [${fare.route.name}]`
        : '';

      for (const dg of fare.discount_groups) {
        const adult = dg.adult?.price != null ? penceToPounds(dg.adult.price) : '—';
        const child = dg.child?.price != null ? penceToPounds(dg.child.price) : '—';
        const rcLabel = dg.railcard?.name && dg.railcard.name !== 'PUBLIC'
          ? ` (${dg.railcard.name})`
          : '';
        lines.push(
          `  ${adult} / ${child} child | ${ticket.rspname || ticket.name} | ${cls} ${type}${rcLabel}${route}`
        );
      }
    }
    lines.push('');
  }

  if (result.restricted.length > 0) {
    let restrictedCount = 0;
    for (const group of result.restricted) {
      restrictedCount += group.fares?.length ?? 0;
    }
    lines.push(`Advance/restricted fares (${restrictedCount}):`);
    for (const rg of result.restricted) {
      const type = rg.type === 'SINGLE' ? 'SGL' : 'RTN';
      const cls = rg.tclass === 1 ? '1st' : 'Std';
      const restriction = rg.restriction?.out && rg.restriction.out !== 'Unrestricted'
        ? ` [${rg.restriction.out}]`
        : '';

      for (const fare of rg.fares ?? []) {
        for (const dg of fare.discount_groups) {
          const adult = dg.adult?.price != null ? penceToPounds(dg.adult.price) : '—';
          const child = dg.child?.price != null ? penceToPounds(dg.child.price) : '—';
          const rcLabel = dg.railcard?.name && dg.railcard.name !== 'PUBLIC'
            ? ` (${dg.railcard.name})`
            : '';
          lines.push(
            `  ${adult} / ${child} child | ${fare.ticket.rspname || fare.ticket.name} | ${cls} ${type}${rcLabel}${restriction}`
          );
        }
      }
    }
    lines.push('');
  }

  if (result.payg.length > 0) {
    lines.push(`Pay-as-you-go fares (${result.payg.length}):`);
    for (const fare of result.payg) {
      for (const dg of fare.discount_groups) {
        const adult = dg.adult?.price != null ? penceToPounds(dg.adult.price) : '—';
        lines.push(`  ${adult} | ${fare.ticket.rspname || fare.ticket.name}`);
      }
    }
    lines.push('');
  }

  if (result.walkup.length === 0 && result.restricted.length === 0 && result.payg.length === 0) {
    lines.push('No fares found for this route.');
  }

  return lines.join('\n');
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('trainspotter-mcp server started');
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
