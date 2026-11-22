import { describe, it, expect } from 'vitest'
import { OmioClient, type OmioFareResult } from '../src/omio.js'
import { formatOmioFares } from '../src/omio-format.js'
import { OMIO_STATION_ENTRIES, OMIO_UNLISTED_STATIONS } from '../src/omio-station-names.js'
import { STATIONS } from '../src/stations.js'

// Opt-in: this makes a real search against Uber Travel. Run it with
//   OMIO_LIVE=1 npx vitest run test/omio.live.test.ts
// Optional: OMIO_LIVE_DATE=YYYY-MM-DD (default: four weeks from today).
const live = process.env['OMIO_LIVE'] === '1'

function defaultDate(): string {
  const date = new Date(Date.now() + 28 * 24 * 60 * 60 * 1000)
  return date.toISOString().slice(0, 10)
}

describe.skipIf(!live)('Uber Travel live search', () => {
  it('finds priced Liverpool South Parkway to London Euston trains', async () => {
    const client = new OmioClient()
    const result = await client.searchFares({
      from: 'LPY',
      to: 'EUS',
      date: process.env['OMIO_LIVE_DATE'] ?? defaultDate(),
      time: '10:00',
      modes: ['train'],
    })

    expect(result.origin.name).toBe('Liverpool South Parkway')
    expect(result.destination.name).toBe('London Euston')
    expect(result.journeys.length).toBeGreaterThan(0)
    for (const journey of result.journeys) {
      expect(journey.dep >= `${result.date}T10:00:00`).toBe(true)
      expect(journey.mode).toBe('train')
    }
    expect(result.journeys.some((journey) => journey.pricePence !== null)).toBe(true)
    expect(formatOmioFares(result)).toContain('Liverpool South Parkway → London Euston')
  }, 60_000)
})

// Opt-in, and slow on purpose: looks every station code in the table up against
// Uber Travel, pausing a second after each code (about 43 minutes of pauses for
// some 2,600 codes, plus the time the requests take), to find stations it has
// started to store under another name. Run it now and then with
//   OMIO_LIVE_STATIONS=1 npx vitest run test/omio.live.test.ts
// Optional: OMIO_LIVE_STATION_CODES=ABW,BIS limits the check to those codes.
// The stations listed in OMIO_UNLISTED_STATIONS are known to be missing and are
// left out, unless they are named in OMIO_LIVE_STATION_CODES: that is how to
// find out whether one has since been added.
// A code listed in the failure needs its entry in src/omio-station-names.ts changed: the name
// in OMIO_STATION_NAMES when it does not resolve, or the entry in OMIO_STATION_ENTRIES when it
// comes back twice or no longer resolves to the entry named there.
// The same switch also runs one fare search from each station in OMIO_STATION_ENTRIES, whatever
// OMIO_LIVE_STATION_CODES says, to see that the named entry still has the station's trains.
const liveStations = process.env['OMIO_LIVE_STATIONS'] === '1'
const PAUSE_BETWEEN_LOOKUPS_MS = 1_000
const NOT_FOUND = 'No Uber Travel location found'
const WRONG_ENTRY = 'Resolves to entry'
// For each station with a named entry, a station its trains run to, to search fares to.
const ENTRY_CHECK_DESTINATIONS: Readonly<Record<string, string>> = { HMY: 'GLC' }

/** The codes to check: the ones named in OMIO_LIVE_STATION_CODES, or the whole table. */
function stationsToCheck(): Array<[string, string]> {
  const only = (process.env['OMIO_LIVE_STATION_CODES'] ?? '')
    .split(',')
    .map((code) => code.trim().toUpperCase())
    .filter((code) => code !== '')
  const unknown = only.filter((code) => !STATIONS.has(code))
  if (unknown.length > 0) {
    throw new Error(`OMIO_LIVE_STATION_CODES names codes that are not in the station table: ${unknown.join(', ')}`)
  }
  const all = [...STATIONS]
  return only.length === 0
    ? all.filter(([code]) => !OMIO_UNLISTED_STATIONS.has(code))
    : all.filter(([code]) => only.includes(code))
}

const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, PAUSE_BETWEEN_LOOKUPS_MS))

describe.skipIf(!liveStations)('Uber Travel station names', () => {
  it('finds trains from every station with a named entry', async () => {
    // The named entry is the one that had trains when both entries were tried. If the trains
    // move to the other entry, the code still resolves, and only a fare search shows it.
    const entries = Object.entries(OMIO_STATION_ENTRIES)
    const withoutDestination = entries.map(([code]) => code).filter((code) => !(code in ENTRY_CHECK_DESTINATIONS))
    expect(withoutDestination, 'stations missing from ENTRY_CHECK_DESTINATIONS').toEqual([])

    const client = new OmioClient()
    const inAWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    /** One search. A request that failed (a timeout, say) is tried once more. */
    const search = async (from: string, to: string): Promise<OmioFareResult> => {
      const query = { from, to, date: inAWeek, time: '10:00', modes: ['train'] }
      try {
        return await client.searchFares(query)
      } catch (error) {
        if (error instanceof Error && error.message.startsWith(NOT_FOUND)) throw error
        await pause()
        return client.searchFares(query)
      }
    }
    for (const [code, namedEntry] of entries) {
      const to = ENTRY_CHECK_DESTINATIONS[code] ?? ''
      const result = await search(code, to)
      expect(result.origin.id, code).toBe(namedEntry)
      expect(result.journeys.length, `trains from ${code} to ${to}`).toBeGreaterThan(0)
      await pause()
    }
  }, 5 * 60_000)

  it('resolves every station code in the table', async () => {
    const client = new OmioClient()
    const stations = stationsToCheck()
    expect(stations.length).toBeGreaterThan(0)
    /** The reason a code does not resolve as it should, or null when it does. */
    const problemWith = async (code: string): Promise<string | null> => {
      try {
        const resolved = await client.resolvePlace(code)
        const namedEntry = OMIO_STATION_ENTRIES[code]
        return namedEntry === undefined || resolved.id === namedEntry
          ? null
          : `${WRONG_ENTRY} ${resolved.id}, not the entry named in OMIO_STATION_ENTRIES (${namedEntry})`
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    }
    const isFinding = (problem: string): boolean =>
      problem.startsWith(NOT_FOUND) || problem.startsWith(WRONG_ENTRY)

    // A code the search has no station for, or the wrong entry for, is a finding. A request
    // that failed (a timeout, say) is not: those codes are asked once more at the end.
    const findings: string[] = []
    const requestFailed: string[] = []
    for (const [code, name] of stations) {
      const problem = await problemWith(code)
      if (problem !== null && isFinding(problem)) findings.push(`${code} (${name}): ${problem}`)
      else if (problem !== null) requestFailed.push(code)
      await pause()
    }
    for (const code of requestFailed) {
      const problem = await problemWith(code)
      if (problem !== null) findings.push(`${code} (${STATIONS.get(code)}): ${problem}`)
      await pause()
    }
    expect(findings).toEqual([])
  }, 120 * 60_000)
})
