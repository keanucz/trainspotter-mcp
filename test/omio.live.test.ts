import { describe, it, expect } from 'vitest'
import { OmioClient } from '../src/omio.js'
import { formatOmioFares } from '../src/omio-format.js'
import { OMIO_UNLISTED_STATIONS } from '../src/omio-station-names.js'
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
// A code listed in the failure needs an entry in OMIO_STATION_NAMES (src/omio-station-names.ts).
const liveStations = process.env['OMIO_LIVE_STATIONS'] === '1'
const PAUSE_BETWEEN_LOOKUPS_MS = 1_000

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

describe.skipIf(!liveStations)('Uber Travel station names', () => {
  it('resolves every station code in the table', async () => {
    const client = new OmioClient()
    const stations = stationsToCheck()
    expect(stations.length).toBeGreaterThan(0)
    const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, PAUSE_BETWEEN_LOOKUPS_MS))
    /** The reason a code does not resolve, or null when it does. */
    const problemWith = async (code: string): Promise<string | null> => {
      try {
        await client.resolvePlace(code)
        return null
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    }

    // A code the search has no station for is a finding. A request that failed
    // (a timeout, say) is not: those codes are asked once more at the end.
    const notFound: string[] = []
    const requestFailed: string[] = []
    for (const [code, name] of stations) {
      const problem = await problemWith(code)
      if (problem?.startsWith('No Uber Travel location found')) notFound.push(`${code} (${name}): ${problem}`)
      else if (problem !== null) requestFailed.push(code)
      await pause()
    }
    for (const code of requestFailed) {
      const problem = await problemWith(code)
      if (problem !== null) notFound.push(`${code} (${STATIONS.get(code)}): ${problem}`)
      await pause()
    }
    expect(notFound).toEqual([])
  }, 120 * 60_000)
})
