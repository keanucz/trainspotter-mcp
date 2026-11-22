/**
 * UK station CRS codes lookup.
 * Every National Rail station in Great Britain, with its position. The data
 * lives in station-data.ts, which has its own licence. No external API calls.
 * Each CRS code appears exactly once.
 */

import { STATION_DATA } from './station-data.js';

export interface StationPosition {
  latitude: number;
  longitude: number;
}

const MAX_STATION_MATCHES = 10;

export const STATIONS: ReadonlyMap<string, string> = new Map(STATION_DATA.map(([crs, name]) => [crs, name]));

const POSITIONS: ReadonlyMap<string, StationPosition> = new Map(
  STATION_DATA.map(([crs, , latitude, longitude]) => [crs, { latitude, longitude }]),
);

/** Where a station is, by its CRS code. */
export function getStationPosition(crs: string): StationPosition | undefined {
  return POSITIONS.get(crs.toUpperCase());
}

export function getStationName(crs: string): string | undefined {
  return STATIONS.get(crs.toUpperCase());
}

export function findStation(
  query: string,
): Array<{ crs: string; name: string }> {
  const lowerQuery = query.toLowerCase();
  const matches: Array<{ crs: string; name: string }> = [];

  for (const [crs, name] of STATIONS) {
    if (name.toLowerCase().includes(lowerQuery)) {
      matches.push({ crs, name });
    }
  }

  // With every station in the table a short query matches many names, so the
  // best ones go first: the station called exactly that, then names that start
  // with the query, then the rest. Alphabetical within each group.
  const rank = (name: string): number => {
    const lowerName = name.toLowerCase();
    if (lowerName === lowerQuery) return 0;
    return lowerName.startsWith(lowerQuery) ? 1 : 2;
  };
  return matches
    .sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name))
    .slice(0, MAX_STATION_MATCHES);
}

export function isValidCrs(crs: string): boolean {
  return STATIONS.has(crs.toUpperCase());
}
