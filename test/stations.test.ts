import { describe, it, expect } from 'vitest';
import { STATIONS, getStationName, findStation, isValidCrs } from '../src/stations.js';

describe('STATIONS map', () => {
  it('should be a ReadonlyMap', () => {
    expect(STATIONS).toBeInstanceOf(Map);
  });

  it('should contain at least 500 stations', () => {
    expect(STATIONS.size).toBeGreaterThanOrEqual(500);
  });

  it('should have string keys and string values', () => {
    for (const [crs, name] of STATIONS) {
      expect(typeof crs).toBe('string');
      expect(typeof name).toBe('string');
      expect(crs.length).toBe(3);
      expect(name.length).toBeGreaterThan(0);
    }
  });

  it('should have all CRS codes in uppercase', () => {
    for (const [crs] of STATIONS) {
      expect(crs).toBe(crs.toUpperCase());
    }
  });
});

describe('London terminals', () => {
  const londonTerminals: Array<[string, string]> = [
    ['KGX', 'London Kings Cross'],
    ['STP', 'London St Pancras'],
    ['PAD', 'London Paddington'],
    ['VIC', 'London Victoria'],
    ['WAT', 'London Waterloo'],
    ['LST', 'London Liverpool Street'],
    ['EUS', 'London Euston'],
    ['CHX', 'London Charing Cross'],
    ['LBG', 'London Bridge'],
    ['FST', 'London Fenchurch Street'],
    ['MYB', 'London Marylebone'],
    ['BFR', 'London Blackfriars'],
    ['CST', 'London Cannon Street'],
  ];

  it.each(londonTerminals)('should contain %s (%s)', (crs, name) => {
    expect(STATIONS.get(crs)).toBe(name);
  });
});

describe('Major city stations', () => {
  const majorStations: Array<[string, string]> = [
    ['MAN', 'Manchester Piccadilly'],
    ['MCO', 'Manchester Oxford Road'],
    ['MCV', 'Manchester Victoria'],
    ['BHM', 'Birmingham New Street'],
    ['LDS', 'Leeds'],
    ['SHF', 'Sheffield'],
    ['LIV', 'Liverpool Lime Street'],
    ['LPY', 'Liverpool South Parkway'],
    ['NCL', 'Newcastle'],
    ['BRI', 'Bristol Temple Meads'],
    ['EDB', 'Edinburgh Waverley'],
    ['GLC', 'Glasgow Central'],
    ['GLQ', 'Glasgow Queen Street'],
    ['CDF', 'Cardiff Central'],
    ['NRW', 'Norwich'],
    ['NOT', 'Nottingham'],
    ['OXF', 'Oxford'],
    ['CBG', 'Cambridge'],
    ['YRK', 'York'],
    ['PLY', 'Plymouth'],
    ['SOT', 'Southampton Central'],
    ['RDG', 'Reading'],
    ['PBO', 'Peterborough'],
    ['DHM', 'Durham'],
    ['DON', 'Doncaster'],
    ['CRE', 'Crewe'],
  ];

  it.each(majorStations)('should contain %s (%s)', (crs, name) => {
    expect(STATIONS.get(crs)).toBe(name);
  });
});

describe('Airport stations', () => {
  const airports: Array<[string, string]> = [
    ['STN', 'Stansted Airport'],
    ['LGW', 'Gatwick Airport'],
    ['LTN', 'Luton Airport Parkway'],
    ['BHI', 'Birmingham International'],
    ['MIA', 'Manchester Airport'],
  ];

  it.each(airports)('should contain %s (%s)', (crs, name) => {
    expect(STATIONS.get(crs)).toBe(name);
  });
});

describe('getStationName', () => {
  it('should return station name for valid CRS', () => {
    expect(getStationName('KGX')).toBe('London Kings Cross');
    expect(getStationName('MAN')).toBe('Manchester Piccadilly');
  });

  it('should return undefined for invalid CRS', () => {
    expect(getStationName('ZZZ')).toBeUndefined();
    expect(getStationName('')).toBeUndefined();
  });

  it('should be case-insensitive', () => {
    expect(getStationName('kgx')).toBe('London Kings Cross');
    expect(getStationName('Kgx')).toBe('London Kings Cross');
  });
});

describe('isValidCrs', () => {
  it('should return true for valid CRS codes', () => {
    expect(isValidCrs('KGX')).toBe(true);
    expect(isValidCrs('MAN')).toBe(true);
    expect(isValidCrs('EDB')).toBe(true);
  });

  it('should return false for invalid CRS codes', () => {
    expect(isValidCrs('ZZZ')).toBe(false);
    expect(isValidCrs('')).toBe(false);
    expect(isValidCrs('KGXX')).toBe(false);
  });

  it('should be case-insensitive', () => {
    expect(isValidCrs('kgx')).toBe(true);
    expect(isValidCrs('man')).toBe(true);
  });
});

describe('findStation', () => {
  it('should find stations by name substring', () => {
    const results = findStation('Kings Cross');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some(r => r.crs === 'KGX')).toBe(true);
  });

  it('should be case-insensitive', () => {
    const results = findStation('kings cross');
    expect(results.some(r => r.crs === 'KGX')).toBe(true);
  });

  it('should return up to 10 results', () => {
    const results = findStation('London');
    expect(results.length).toBeLessThanOrEqual(10);
  });

  it('should return results sorted alphabetically by name', () => {
    const results = findStation('London');
    const names = results.map(r => r.name);
    const sorted = [...names].sort();
    expect(names).toEqual(sorted);
  });

  it('should return empty array for no matches', () => {
    const results = findStation('xyznonexistent');
    expect(results).toEqual([]);
  });

  it('should return results with correct shape', () => {
    const results = findStation('Manchester');
    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(result).toHaveProperty('crs');
      expect(result).toHaveProperty('name');
      expect(typeof result.crs).toBe('string');
      expect(typeof result.name).toBe('string');
    }
  });

  it('should find partial matches', () => {
    const results = findStation('Piccadilly');
    expect(results.some(r => r.crs === 'MAN')).toBe(true);
  });
});
