import { describe, it, expect } from 'vitest'
import {
  OMIO_RAILCARDS,
  OmioClient,
  londonWallTimeToUtc,
  normalizeFareQuery,
  pickLocation,
} from '../src/omio.js'
import { OmioSchemaError, parseLocations } from '../src/omio-parse.js'
import { loadOmioFixture } from './omio-fixtures.js'

type Responder = unknown | ((variables: any) => unknown)

interface RecordedCall {
  url: string
  operationName: string
  variables: any
  headers: Record<string, string>
}

interface Harness {
  client: OmioClient
  calls: RecordedCall[]
  operations: () => string[]
  elapsed: () => number
}

const LOCATION_BY_NAME: Record<string, string> = {
  'Liverpool South Parkway': 'search-location-station',
  'London Euston': 'search-location-euston',
  Liverpool: 'search-location-city',
}

function locationResponder(variables: any): unknown {
  const fixture = LOCATION_BY_NAME[variables.request.name]
  return loadOmioFixture(fixture ?? 'search-location-empty')
}

/** A finished search whose train window is `start`-`end`. */
function doneWithWindow(end: string, moreLater = true): any {
  const body = loadOmioFixture('get-search-done')
  const option = body.data.GetSearchWithoutQuotes.booking.extensionOptions[0]
  option.currentIntervals.outbound[0].end = end
  option.outboundLater = moreLater
  return body
}

/**
 * Builds a client over a scripted fetch and a fake clock. Each operation has a
 * queue of replies; the last one repeats. A reply may be a function of the
 * request variables or a Response for non-JSON cases.
 */
function harness(script: Record<string, Responder[]>, options: { status?: number } = {}): Harness {
  const calls: RecordedCall[] = []
  const queues: Record<string, Responder[]> = { SearchLocation: [locationResponder], ...script }
  let clock = 0

  const fetchFn = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body))
    calls.push({
      url: String(url),
      operationName: body.operationName,
      variables: body.variables,
      headers: init?.headers as Record<string, string>,
    })
    const queue = queues[body.operationName]
    if (!queue || queue.length === 0) throw new Error(`unexpected operation ${body.operationName}`)
    const next = queue.length > 1 ? queue.shift() : queue[0]
    const payload = typeof next === 'function' ? next(body.variables) : next
    if (payload instanceof Response) return payload
    return new Response(JSON.stringify(payload), { status: options.status ?? 200 })
  }

  const client = new OmioClient({
    fetchFn,
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms
    },
  })

  return {
    client,
    calls,
    operations: () => calls.map((c) => c.operationName),
    elapsed: () => clock,
  }
}

const BASE_QUERY = { from: 'LPY', to: 'EUS', date: '2027-01-30', time: '06:00' }

function standardScript(): Record<string, Responder[]> {
  return {
    SearchJourneys: [loadOmioFixture('search-journeys-start')],
    GetSearchWithoutQuotes: [
      loadOmioFixture('get-search-running'),
      doneWithWindow('08:22'),
      loadOmioFixture('get-search-running'),
      doneWithWindow('10:22'),
      doneWithWindow('12:22'),
    ],
    ExtendSearchWithoutQuotes: [loadOmioFixture('extend-search-running')],
  }
}

describe('normalizeFareQuery', () => {
  it('applies defaults', () => {
    expect(normalizeFareQuery({ from: 'LPY', to: 'EUS', date: '2027-01-30' })).toEqual({
      date: '2027-01-30',
      time: '06:00',
      modes: ['train', 'coach'],
      railcard: null,
      age: 30,
    })
  })

  it('accepts the compact date format search_fares uses', () => {
    expect(normalizeFareQuery({ ...BASE_QUERY, date: '20270130' }).date).toBe('2027-01-30')
  })

  it('accepts bus as another word for coach and removes duplicates', () => {
    expect(normalizeFareQuery({ ...BASE_QUERY, modes: ['bus', 'Coach'] }).modes).toEqual(['coach'])
  })

  it('upper-cases a railcard code', () => {
    expect(normalizeFareQuery({ ...BASE_QUERY, railcards: ['yng'] }).railcard).toBe('YNG')
  })

  it.each([
    [{ date: '30/01/2027' }, /date/],
    [{ date: '2027-02-30' }, /date/],
    [{ time: '10am' }, /time/],
    [{ time: '24:00' }, /time/],
    [{ modes: ['plane'] }, /mode/],
    [{ modes: [] }, /mode/],
    [{ railcards: ['XXX'] }, /Unknown railcard "XXX"/],
    [{ railcards: ['YNG', 'SRN'] }, /one railcard/],
    [{ age: -1 }, /age/],
    [{ age: 17.5 }, /age/],
  ])('rejects %j', (override, message) => {
    expect(() => normalizeFareQuery({ ...BASE_QUERY, ...override })).toThrow(message)
  })
})

describe('OMIO_RAILCARDS', () => {
  it('only lists codes Uber Travel offers as UK railcards', () => {
    const cards = loadOmioFixture('discount-cards').data.GetDiscountCards.discountCards
    const offered = new Map<string, string>(
      cards.filter((c: any) => c.provider === 'assertis').map((c: any) => [c.id, c.discountName]),
    )
    expect(Object.keys(OMIO_RAILCARDS).sort()).toEqual([...offered.keys()].sort())
    for (const [code, name] of Object.entries(OMIO_RAILCARDS)) {
      expect(offered.get(code)).toBe(name)
    }
  })
})

describe('londonWallTimeToUtc', () => {
  it('leaves winter times unchanged', () => {
    expect(londonWallTimeToUtc('2027-01-30', '10:00')).toBe('2027-01-30T10:00:00.000Z')
  })

  it('converts British Summer Time to UTC', () => {
    expect(londonWallTimeToUtc('2027-07-10', '10:00')).toBe('2027-07-10T09:00:00.000Z')
    expect(londonWallTimeToUtc('2027-07-10', '00:30')).toBe('2027-07-09T23:30:00.000Z')
  })

  it('is right on both sides of the clocks going forward (28 Mar 2027, 01:00 UTC)', () => {
    expect(londonWallTimeToUtc('2027-03-28', '00:59')).toBe('2027-03-28T00:59:00.000Z')
    expect(londonWallTimeToUtc('2027-03-28', '02:00')).toBe('2027-03-28T01:00:00.000Z')
    expect(londonWallTimeToUtc('2027-03-28', '10:00')).toBe('2027-03-28T09:00:00.000Z')
  })

  it('is right on both sides of the clocks going back (25 Oct 2026, 01:00 UTC)', () => {
    expect(londonWallTimeToUtc('2026-10-25', '00:30')).toBe('2026-10-24T23:30:00.000Z')
    expect(londonWallTimeToUtc('2026-10-25', '02:00')).toBe('2026-10-25T02:00:00.000Z')
    expect(londonWallTimeToUtc('2026-10-25', '10:00')).toBe('2026-10-25T10:00:00.000Z')
  })

  it('never moves a time that does not exist or exists twice by more than an hour', () => {
    // 01:30 on 28 Mar 2027 is skipped; 01:30 on 25 Oct 2026 happens twice.
    expect(londonWallTimeToUtc('2027-03-28', '01:30')).toBe('2027-03-28T00:30:00.000Z')
    expect(londonWallTimeToUtc('2026-10-25', '01:30')).toBe('2026-10-25T01:30:00.000Z')
  })
})

describe('pickLocation', () => {
  const city = parseLocations(loadOmioFixture('search-location-city'))

  const station = (name: string, countryCode = 'GB') => ({
    id: name,
    name,
    type: 'station',
    countryCode,
    latitude: 51.5,
    longitude: -0.1,
  })

  it('prefers the station with exactly the requested name', () => {
    expect(pickLocation(city, 'Liverpool South Parkway', 'crs')?.id).toBe('319585')
  })

  it('ignores case and punctuation when matching names', () => {
    expect(pickLocation(city, "liverpool  south-parkway", 'free')?.id).toBe('319585')
    expect(pickLocation([station("London King's Cross")], 'London Kings Cross', 'crs')?.name).toBe(
      "London King's Cross",
    )
  })

  it('falls back to the first result for a free-text name', () => {
    expect(pickLocation(city, 'Liverp', 'free')).toMatchObject({ name: 'Liverpool', type: 'location' })
  })

  it('accepts the one station whose name adds a qualifier, for a CRS code', () => {
    expect(pickLocation(city, 'Liverpool Lime', 'crs')).toMatchObject({
      name: 'Liverpool Lime Street',
      type: 'station',
    })
    expect(
      pickLocation([station('London St Pancras International')], 'London St Pancras', 'crs')?.name,
    ).toBe('London St Pancras International')
  })

  it('never resolves a CRS code to a station with a shorter name', () => {
    // WAE is London Waterloo East; London Waterloo (WAT) is a different station.
    expect(pickLocation([station('London Waterloo')], 'London Waterloo East', 'crs')).toBeNull()
  })

  it('refuses to choose between several longer-named stations for a CRS code', () => {
    const candidates = [station('Edinburgh Park'), station('Edinburgh Gateway')]
    expect(pickLocation(candidates, 'Edinburgh', 'crs')).toBeNull()
    expect(pickLocation(city, 'Liverpool', 'crs')).toBeNull()
  })

  it('refuses to guess a station for a CRS code when no name is close', () => {
    expect(pickLocation(city, 'Liverpool Sth Parkway', 'crs')).toBeNull()
    // A shared leading fragment is not enough: "Liver" must not become Liverpool Central.
    expect(pickLocation(city, 'Liver', 'crs')).toBeNull()
    const noStations = city.filter((l) => l.type !== 'station')
    expect(pickLocation(noStations, 'Liverpool', 'crs')).toBeNull()
  })

  it('only accepts British stations for a CRS code', () => {
    expect(pickLocation([station('Bray', 'IE')], 'Bray', 'crs')).toBeNull()
  })

  it('accepts only an exact name in exact mode', () => {
    expect(pickLocation(city, 'Liverpool', 'exact')).toMatchObject({ name: 'Liverpool', type: 'location' })
    expect(pickLocation(city, 'Liv', 'exact')).toBeNull()
  })

  it('returns null for no results', () => {
    expect(pickLocation([], 'Nowhere', 'free')).toBeNull()
  })
})

describe('OmioClient.searchLocations', () => {
  it('posts to the Uber Travel endpoint with the CSRF header and no cookies', async () => {
    const h = harness({})
    const locations = await h.client.searchLocations('London Euston')

    expect(locations[0]).toMatchObject({ id: '319631', name: 'London Euston' })
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]?.url).toBe('https://travel.uber.com/go/travel/graphql')
    expect(h.calls[0]?.variables).toEqual({ request: { name: 'London Euston', locale: 'en-GB' } })
    const headerNames = Object.keys(h.calls[0]?.headers ?? {}).map((n) => n.toLowerCase())
    expect(headerNames).toContain('x-csrf-token')
    expect(headerNames).toContain('origin')
    expect(headerNames).not.toContain('cookie')
    expect(headerNames).not.toContain('authorization')
  })

  it('caches lookups', async () => {
    const h = harness({})
    await h.client.searchLocations('London Euston')
    await h.client.searchLocations('  london euston ')
    expect(h.calls).toHaveLength(1)
  })

  it('rejects an empty query without calling the API', async () => {
    const h = harness({})
    await expect(h.client.searchLocations('  ')).rejects.toThrow(/query/)
    expect(h.calls).toHaveLength(0)
  })
})

describe('OmioClient.searchFares', () => {
  it('resolves CRS codes and starts a search with the documented request shape', async () => {
    const h = harness(standardScript())
    await h.client.searchFares({ ...BASE_QUERY, time: '10:00', railcards: ['YNG'], age: 22 })

    const lookups = h.calls.filter((c) => c.operationName === 'SearchLocation')
    expect(lookups.map((c) => c.variables.request.name)).toEqual([
      'Liverpool South Parkway',
      'London Euston',
    ])

    const start = h.calls.find((c) => c.operationName === 'SearchJourneys')
    expect(start?.variables.request).toEqual({
      origin: { id: '319585', latitude: 53.35784539507004, longitude: -2.889499696572898, countryCode: 'GB' },
      destination: { id: '319631', latitude: 51.52809902784242, longitude: -0.13317672404014, countryCode: 'GB' },
      departureTime: '2027-01-30T10:00:00.000Z',
      travelModes: ['TRAVEL_MODE_TRAIN', 'TRAVEL_MODE_BUS'],
      travelers: [{ age: 22, discountCards: [{ id: 'YNG', provider: 'assertis' }], disabilityCards: [] }],
      locale: 'en-GB',
      currency: 'CURRENCY_GBP',
      isReplacementSearch: false,
      mode: 'SEARCH_MODE_INCREMENTAL',
      userGeoipCountry: 'GB',
      abTestParameters: [],
    })
  })

  it('polls once a second until the search is done, then asks for later trains twice', async () => {
    const h = harness(standardScript())
    const result = await h.client.searchFares(BASE_QUERY)

    expect(h.operations().slice(2)).toEqual([
      'SearchJourneys',
      'GetSearchWithoutQuotes',
      'GetSearchWithoutQuotes',
      'ExtendSearchWithoutQuotes',
      'GetSearchWithoutQuotes',
      'GetSearchWithoutQuotes',
      'ExtendSearchWithoutQuotes',
      'GetSearchWithoutQuotes',
    ])
    expect(h.elapsed()).toBe(5000)
    expect(result.complete).toBe(true)
    expect(result.notes).toEqual([])
    expect(result.trainWindow).toEqual({ start: '06:00', end: '12:22', moreLater: true })

    const poll = h.calls.find((c) => c.operationName === 'GetSearchWithoutQuotes')
    expect(poll?.variables.request).toEqual({
      searchId: 'TEST00000000000000000000000000001',
      direction: 'SEGMENT_DIRECTION_DEPARTURE',
      outboundId: '',
      isReplacementSearch: false,
    })
    const extend = h.calls.find((c) => c.operationName === 'ExtendSearchWithoutQuotes')
    expect(extend?.variables.request).toEqual({
      searchId: 'TEST00000000000000000000000000001',
      extendDirection: 'outbound',
      extendTo: 'later',
      mode: 'SEARCH_MODE_INCREMENTAL',
    })
  })

  it('drops journeys that leave before the requested time and sorts the rest', async () => {
    const h = harness(standardScript())
    const result = await h.client.searchFares({ ...BASE_QUERY, time: '06:30' })
    expect(result.journeys.map((j) => j.dep.slice(11, 16))).toEqual(['06:54', '07:03', '19:30'])
    expect(result.origin.name).toBe('Liverpool South Parkway')
    expect(result.destination.name).toBe('London Euston')
  })

  it('stops extending when no later trains are on offer', async () => {
    const h = harness({
      ...standardScript(),
      GetSearchWithoutQuotes: [doneWithWindow('08:22', false)],
    })
    await h.client.searchFares(BASE_QUERY)
    expect(h.operations()).not.toContain('ExtendSearchWithoutQuotes')
  })

  it('stops extending and says so when the train window never moves', async () => {
    const h = harness({
      ...standardScript(),
      GetSearchWithoutQuotes: [doneWithWindow('08:22')],
    })
    const result = await h.client.searchFares(BASE_QUERY)
    expect(h.operations().filter((o) => o === 'ExtendSearchWithoutQuotes')).toHaveLength(1)
    // One poll for the search, then three for the extension before the unchanged window is believed.
    expect(h.operations().filter((o) => o === 'GetSearchWithoutQuotes')).toHaveLength(4)
    expect(result.complete).toBe(false)
    expect(result.notes.join(' ')).toMatch(/nothing new/)
  })

  it('does not mistake a stale finished snapshot for the result of an extension', async () => {
    const h = harness({
      ...standardScript(),
      GetSearchWithoutQuotes: [
        doneWithWindow('08:22'),
        doneWithWindow('08:22'), // stale: the extension has not been picked up yet
        doneWithWindow('10:22'),
        doneWithWindow('10:22'), // stale again after the second extension
        doneWithWindow('12:22'),
      ],
    })
    const result = await h.client.searchFares(BASE_QUERY)
    expect(result.trainWindow?.end).toBe('12:22')
    expect(result.complete).toBe(true)
    expect(result.notes).toEqual([])
  })

  it('keeps the whole search inside the total time budget when an extension hangs', async () => {
    const h = harness({
      ...standardScript(),
      GetSearchWithoutQuotes: [doneWithWindow('08:22'), loadOmioFixture('get-search-running')],
    })
    const result = await h.client.searchFares(BASE_QUERY)
    expect(h.elapsed()).toBe(35000)
    expect(result.complete).toBe(false)
    expect(result.trainWindow?.end).toBe('08:22')
    expect(result.journeys.length).toBeGreaterThan(0)
    expect(result.notes.join(' ')).toMatch(/did not finish in time/)
  })

  it('sends modes in a fixed order so equal searches share a cache entry', async () => {
    const h = harness(standardScript())
    await h.client.searchFares({ ...BASE_QUERY, modes: ['coach', 'train'] })
    const start = h.calls.find((c) => c.operationName === 'SearchJourneys')
    expect(start?.variables.request.travelModes).toEqual(['TRAVEL_MODE_TRAIN', 'TRAVEL_MODE_BUS'])
    const second = await h.client.searchFares({ ...BASE_QUERY, modes: ['train', 'coach'] })
    expect(second.cached).toBe(true)
  })

  it('stops extending once the train window runs past midnight', async () => {
    const h = harness({
      ...standardScript(),
      GetSearchWithoutQuotes: [doneWithWindow('00:40')],
    })
    await h.client.searchFares(BASE_QUERY)
    expect(h.operations()).not.toContain('ExtendSearchWithoutQuotes')
  })

  it('does not ask for later trains on a coach-only search', async () => {
    const h = harness(standardScript())
    await h.client.searchFares({ ...BASE_QUERY, modes: ['coach'] })
    const start = h.calls.find((c) => c.operationName === 'SearchJourneys')
    expect(start?.variables.request.travelModes).toEqual(['TRAVEL_MODE_BUS'])
    expect(h.operations()).not.toContain('ExtendSearchWithoutQuotes')
  })

  it('gives up after the polling cap when the search never finishes', async () => {
    const h = harness({
      ...standardScript(),
      GetSearchWithoutQuotes: [loadOmioFixture('get-search-running')],
    })
    await expect(h.client.searchFares(BASE_QUERY)).rejects.toThrow(/did not finish within 20 s/)
    expect(h.operations().filter((o) => o === 'GetSearchWithoutQuotes')).toHaveLength(20)
    expect(h.elapsed()).toBe(20000)
  })

  it('returns partial results with a note when journeys arrived but the search is still running', async () => {
    const stillRunning = doneWithWindow('08:22')
    stillRunning.data.GetSearchWithoutQuotes.booking.status = 'SEARCH_STATUS_RUNNING'
    const h = harness({ ...standardScript(), GetSearchWithoutQuotes: [stillRunning] })

    const result = await h.client.searchFares(BASE_QUERY)
    expect(result.complete).toBe(false)
    expect(result.journeys.length).toBeGreaterThan(0)
    expect(result.notes.join(' ')).toMatch(/still running/)
    expect(h.operations()).not.toContain('ExtendSearchWithoutQuotes')
  })

  it('keeps the first window and says so when an extension fails', async () => {
    const h = harness({
      ...standardScript(),
      GetSearchWithoutQuotes: [doneWithWindow('08:22')],
      ExtendSearchWithoutQuotes: [new Response('upstream connect error', { status: 503 })],
    })
    const result = await h.client.searchFares(BASE_QUERY)
    expect(result.complete).toBe(false)
    expect(result.trainWindow?.end).toBe('08:22')
    expect(result.notes.join(' ')).toMatch(/later trains.*503/)
    expect(h.operations().filter((o) => o === 'ExtendSearchWithoutQuotes')).toHaveLength(1)
  })

  it('serves an identical search from the cache', async () => {
    const h = harness(standardScript())
    const first = await h.client.searchFares(BASE_QUERY)
    const callsAfterFirst = h.calls.length
    const second = await h.client.searchFares({ ...BASE_QUERY, from: 'lpy', date: '20270130' })

    expect(h.calls).toHaveLength(callsAfterFirst)
    expect(first.cached).toBe(false)
    expect(second.cached).toBe(true)
    expect(second.journeys).toEqual(first.journeys)
  })

  it('does not cache incomplete results', async () => {
    const stillRunning = doneWithWindow('08:22')
    stillRunning.data.GetSearchWithoutQuotes.booking.status = 'SEARCH_STATUS_RUNNING'
    const h = harness({ ...standardScript(), GetSearchWithoutQuotes: [stillRunning] })
    await h.client.searchFares(BASE_QUERY)
    const second = await h.client.searchFares(BASE_QUERY)
    expect(second.cached).toBe(false)
  })

  it('runs one search at a time', async () => {
    const h = harness({
      ...standardScript(),
      GetSearchWithoutQuotes: [doneWithWindow('08:22', false)],
    })
    await Promise.all([
      h.client.searchFares({ ...BASE_QUERY, time: '06:00' }),
      h.client.searchFares({ ...BASE_QUERY, time: '07:00' }),
    ])
    expect(h.operations().slice(2)).toEqual([
      'SearchJourneys',
      'GetSearchWithoutQuotes',
      'SearchJourneys',
      'GetSearchWithoutQuotes',
    ])
  })

  it('keeps working after a failed search', async () => {
    const h = harness({
      ...standardScript(),
      SearchJourneys: [new Response('Missing csrf token.', { status: 403 }), loadOmioFixture('search-journeys-start')],
    })
    await expect(h.client.searchFares(BASE_QUERY)).rejects.toThrow(/403/)
    await expect(h.client.searchFares(BASE_QUERY)).resolves.toMatchObject({ complete: true })
  })

  it('reports HTTP failures with the status and does not retry', async () => {
    const h = harness({
      ...standardScript(),
      SearchJourneys: [new Response('Missing csrf token.', { status: 403 })],
    })
    await expect(h.client.searchFares(BASE_QUERY)).rejects.toThrow(
      'Uber Travel request failed (403) for SearchJourneys: Missing csrf token.',
    )
    expect(h.operations().filter((o) => o === 'SearchJourneys')).toHaveLength(1)
  })

  it('raises a schema error when the response shape changes', async () => {
    const h = harness({
      ...standardScript(),
      GetSearchWithoutQuotes: [{ data: { GetSearchWithoutQuotes: { booking: { status: 'SEARCH_STATUS_DONE' } } } }],
    })
    await expect(h.client.searchFares(BASE_QUERY)).rejects.toThrow(OmioSchemaError)
  })

  it('raises a schema error when the reply is not JSON', async () => {
    const h = harness({
      ...standardScript(),
      SearchJourneys: [new Response('<html>blocked</html>', { status: 200 })],
    })
    await expect(h.client.searchFares(BASE_QUERY)).rejects.toThrow(OmioSchemaError)
  })

  it('raises a schema error when prices come back in another currency', async () => {
    const euros = doneWithWindow('08:22', false)
    euros.data.GetSearchWithoutQuotes.booking.currency = 'CURRENCY_EUR'
    const h = harness({ ...standardScript(), GetSearchWithoutQuotes: [euros] })
    await expect(h.client.searchFares(BASE_QUERY)).rejects.toThrow(/currency/)
  })

  it('explains when a place cannot be found', async () => {
    const h = harness(standardScript())
    await expect(h.client.searchFares({ ...BASE_QUERY, to: 'Atlantis' })).rejects.toThrow(
      /No Uber Travel location found for "Atlantis".*omio_locations/,
    )
    expect(h.operations()).not.toContain('SearchJourneys')
  })

  it('does not guess a place for three letters that are not a known station code', async () => {
    const h = harness({
      ...standardScript(),
      SearchLocation: [loadOmioFixture('search-location-city')],
    })
    await expect(h.client.searchFares({ ...BASE_QUERY, from: 'QQQ' })).rejects.toThrow(
      /"QQQ"\. It is not a station code this server knows/,
    )
    expect(h.operations()).not.toContain('SearchJourneys')
  })

  it('refuses a CRS code when Uber Travel only offers a different station', async () => {
    const waterloo = loadOmioFixture('search-location-euston')
    waterloo.data.SearchLocation.locations[0].name = 'London Waterloo'
    const h = harness({ ...standardScript(), SearchLocation: [waterloo] })
    await expect(h.client.searchFares({ ...BASE_QUERY, from: 'WAE' })).rejects.toThrow(
      /No Uber Travel location found for "WAE" \(London Waterloo East\)/,
    )
    expect(h.operations()).not.toContain('SearchJourneys')
  })

  it('rejects a search from a place to itself', async () => {
    const h = harness(standardScript())
    await expect(h.client.searchFares({ ...BASE_QUERY, to: 'Liverpool South Parkway' })).rejects.toThrow(
      /both resolve to Liverpool South Parkway/,
    )
    expect(h.operations()).not.toContain('SearchJourneys')
  })

  it('reports a server-side GraphQL error as it is, not as a schema change', async () => {
    const h = harness({
      ...standardScript(),
      SearchJourneys: [{ errors: [{ message: 'Departure time is in the past' }] }],
    })
    const failure = await h.client.searchFares(BASE_QUERY).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect(failure).not.toBeInstanceOf(OmioSchemaError)
    expect((failure as Error).message).toBe(
      'Uber Travel returned an error from SearchJourneys: Departure time is in the past',
    )
  })

  it('treats an HTTP 400 that rejects the query as a schema change', async () => {
    const body = JSON.stringify({ errors: [{ message: 'Cannot query field "searchId" on type "Booking".' }] })
    const h = harness({ ...standardScript(), SearchJourneys: [new Response(body, { status: 400 })] })
    await expect(h.client.searchFares(BASE_QUERY)).rejects.toThrow(OmioSchemaError)
  })

  it('validates input before making any request', async () => {
    const h = harness(standardScript())
    await expect(h.client.searchFares({ ...BASE_QUERY, railcards: ['NOPE'] })).rejects.toThrow(/Unknown railcard/)
    await expect(h.client.searchFares({ ...BASE_QUERY, from: ' ' })).rejects.toThrow(/from/)
    expect(h.calls).toHaveLength(0)
  })
})
