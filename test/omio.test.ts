import { describe, it, expect } from 'vitest'
import {
  OMIO_RAILCARDS,
  OmioClient,
  londonWallTimeToUtc,
  normalizeFareQuery,
} from '../src/omio.js'
import {
  chooseStation,
  comparableName,
  distanceKm,
  omioStationLookup,
  pickLocation,
} from '../src/omio-locations.js'
import { OmioSchemaError, parseLocations } from '../src/omio-parse.js'
import { OMIO_STATION_NAMES, OMIO_UNLISTED_STATIONS } from '../src/omio-station-names.js'
import { locationSearchTerms } from '../src/omio-locations.js'
import { STATIONS, getStationPosition } from '../src/stations.js'
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
  /** Moves the fake clock forward without any request being made. */
  advance: (ms: number) => void
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
    advance: (ms: number) => {
      clock += ms
    },
  }
}

const BASE_QUERY = { from: 'LPY', to: 'EUS', date: '2027-01-30', time: '06:00' }

/** One station as the location search would list it, standing where the station of `code` is. */
function stationAt(code: string, name: string, id: string): any {
  const position = getStationPosition(code)
  if (!position) throw new Error(`no position for ${code}`)
  const [location] = loadOmioFixture('search-location-station').data.SearchLocation.locations
  return { ...location, id, name, latitude: position.latitude, longitude: position.longitude }
}

/** A location search reply holding the given stations. */
function replyWith(...locations: any[]): any {
  const reply = loadOmioFixture('search-location-station')
  reply.data.SearchLocation.locations = locations
  return reply
}

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
      hours: 4,
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
    [{ hours: 0 }, /hours/],
    [{ hours: 13 }, /hours/],
    [{ hours: 2.5 }, /hours/],
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

  it('treats "&" and "and" as the same word', () => {
    expect(pickLocation([station('Pontypool and New Inn')], 'Pontypool & New Inn', 'crs')?.name).toBe(
      'Pontypool and New Inn',
    )
    expect(pickLocation([station('Hoveton & Wroxham')], 'Hoveton and Wroxham', 'exact')?.name).toBe(
      'Hoveton & Wroxham',
    )
  })

  it('falls back to the first result for a free-text name', () => {
    expect(pickLocation(city, 'Liverp', 'free')).toMatchObject({ name: 'Liverpool', type: 'location' })
  })

  it('never resolves a CRS code to a station with a longer name, even when it is the only one offered', () => {
    // WAT is London Waterloo; London Waterloo East (WAE) is a different station.
    expect(pickLocation([station('London Waterloo East')], 'London Waterloo', 'crs')).toBeNull()
    // CTR is Chester; Chester-le-Street (CLS) is a different station.
    expect(pickLocation([station('Chester-le-Street')], 'Chester', 'crs')).toBeNull()
    expect(pickLocation(city, 'Liverpool Lime', 'crs')).toBeNull()
    expect(pickLocation([station('London St Pancras International')], 'London St Pancras', 'crs')).toBeNull()
  })

  it('still finds the exact station among longer-named ones', () => {
    const candidates = [station('London Waterloo East'), station('London Waterloo')]
    expect(pickLocation(candidates, 'London Waterloo', 'crs')?.name).toBe('London Waterloo')
  })

  it('never resolves a CRS code to a station with a shorter name', () => {
    // WAE is London Waterloo East; London Waterloo (WAT) is a different station.
    expect(pickLocation([station('London Waterloo')], 'London Waterloo East', 'crs')).toBeNull()
  })

  it('refuses longer-named stations for a CRS code when there are several', () => {
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

  it('can tell every station in the table apart by the name it is looked up by', () => {
    // A code resolves by comparing names in this reduced form, so two stations
    // whose lookup names reduced to the same words could be mistaken for each other.
    const codesByName = new Map<string, string[]>()
    for (const [code, name] of STATIONS) {
      // Every name a code may be looked up by counts, not only the first.
      for (const lookupName of new Set(omioStationLookup(code, name, null).names.map(comparableName))) {
        codesByName.set(lookupName, [...(codesByName.get(lookupName) ?? []), code])
      }
    }
    const clashes = [...codesByName.entries()].filter(([, codes]) => codes.length > 1)
    expect(clashes).toEqual([])
  })

  it('only lists a search name for a station code that exists and whose table name differs', () => {
    for (const [code, storedName] of Object.entries(OMIO_STATION_NAMES)) {
      expect(STATIONS.has(code), code).toBe(true)
      expect(storedName, code).not.toBe(STATIONS.get(code))
      expect(storedName.trim(), code).not.toBe('')
    }
  })

  it('only calls a station unlisted when it is in the table and has no search name', () => {
    for (const code of OMIO_UNLISTED_STATIONS) {
      expect(STATIONS.has(code), code).toBe(true)
      expect(OMIO_STATION_NAMES[code], code).toBeUndefined()
    }
  })

  it('knows where every station in the table is', () => {
    for (const [code] of STATIONS) {
      const position = getStationPosition(code)
      // Somewhere in Great Britain, so a slip of sign or of digits shows up.
      expect(position?.latitude, code).toBeGreaterThan(49.9)
      expect(position?.latitude, code).toBeLessThan(60.9)
      expect(position?.longitude, code).toBeGreaterThan(-7.6)
      expect(position?.longitude, code).toBeLessThan(1.8)
    }
  })

  it('looks most stations up by the table name alone, in their place', () => {
    const position = getStationPosition('LPY') ?? null
    expect(position).not.toBeNull()
    expect(omioStationLookup('lpy', 'Liverpool South Parkway', position)).toEqual({
      names: ['Liverpool South Parkway'],
      near: position,
    })
  })

  it('looks a renamed station up by the stored name first, then the table name', () => {
    const position = getStationPosition('ABW') ?? null
    expect(omioStationLookup('abw', 'Abbey Wood', position)).toEqual({
      names: ['Abbey Wood Station', 'Abbey Wood'],
      near: position,
    })
  })

  it('measures distance well enough to tell a station from its namesake', () => {
    const cumbria = { latitude: 54.2914, longitude: -3.3937 }
    const merseyside = { latitude: 53.4533, longitude: -2.9945 }
    expect(distanceKm(cumbria, cumbria)).toBe(0)
    expect(distanceKm(cumbria, merseyside)).toBeGreaterThan(90)
    expect(distanceKm(cumbria, merseyside)).toBeLessThan(100)
    // About 111 km to a degree of latitude.
    expect(distanceKm({ latitude: 51, longitude: 0 }, { latitude: 52, longitude: 0 })).toBeCloseTo(111.2, 0)
  })

  it('only takes a station for a CRS code when it is where the station should be', () => {
    const here = { latitude: 54.2914, longitude: -3.3937 }
    const right = { ...station('Bootle'), latitude: 54.2912, longitude: -3.3938 }
    const namesake = { ...station('Bootle'), id: 'other', latitude: 53.4533, longitude: -2.9945 }
    expect(pickLocation([right], 'Bootle', 'crs', here)?.id).toBe('Bootle')
    expect(pickLocation([namesake], 'Bootle', 'crs', here)).toBeNull()
    // Two of the same name: the place decides.
    expect(pickLocation([namesake, right], 'Bootle', 'crs', here)?.id).toBe('Bootle')
  })

  it('counts a station that is listed twice as one station', () => {
    const listedTwice = [station('Newport'), station('Newport')] // same id
    expect(pickLocation(listedTwice, 'Newport', 'crs')?.name).toBe('Newport')
  })

  it('takes the clearly nearer of two same-named stations, and neither when they are about as near', () => {
    // Seen live: Hairmyres moved, and is listed at its old site (600 m away) and its new one.
    const here = { latitude: 55.762, longitude: -4.22 }
    const at = (id: string, metresNorth: number) => ({
      ...station('Hairmyres'),
      id,
      latitude: here.latitude + metresNorth / 111_200,
      longitude: here.longitude,
    })
    expect(chooseStation([at('old', 620), at('new', 20)], here)?.id).toBe('new')
    expect(pickLocation([at('old', 620), at('new', 20)], 'Hairmyres', 'crs', here)?.id).toBe('new')
    // 100 m apart is not a clear difference. The line is drawn at 250 m.
    expect(chooseStation([at('a', 50), at('b', 150)], here)).toBeNull()
    expect(chooseStation([at('a', 50), at('b', 290)], here)).toBeNull()
    expect(chooseStation([at('a', 50), at('b', 310)], here)?.id).toBe('a')
    // Without a known place there is nothing to go by.
    expect(chooseStation([at('old', 620), at('new', 20)], null)).toBeNull()
    expect(chooseStation([], here)).toBeNull()
    expect(chooseStation([at('only', 900)], here)?.id).toBe('only')
  })

  it('refuses to choose between two stations of the same name for a CRS code', () => {
    const first = { ...station('Newport'), id: 'one' }
    const second = { ...station('Newport'), id: 'two', latitude: 50.7 }
    expect(pickLocation([first, second], 'Newport', 'crs')).toBeNull()
    // Free text keeps the search's own order.
    expect(pickLocation([first, second], 'Newport', 'exact')?.id).toBe('one')
  })

  it('keeps a bracketed qualifier as part of the name', () => {
    expect(comparableName('Newport (South Wales)')).not.toBe(comparableName('Newport (Essex)'))
    expect(pickLocation([station('Newport (Essex)')], 'Newport (South Wales)', 'crs')).toBeNull()
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

  it.each([
    ['Harrow & Wealdstone', ['Harrow & Wealdstone', 'Harrow'], 'Harrow'],
    ['Shepherds Bush', ['Shepherds Bush', "Shepherd's Bush"], "Shepherd's Bush"],
    ['Christ\u2019s Hospital', ['Christ\u2019s Hospital', "Christ's Hospital", 'Christs Hospital'], 'Christs Hospital'],
  ])('finds "%s" for omio_locations by trying the spellings a fare search would', async (query, asked, answered) => {
    const h = harness({
      SearchLocation: [
        (variables: any) =>
          loadOmioFixture(variables.request.name === answered ? 'search-location-station' : 'search-location-empty'),
      ],
    })
    const locations = await h.client.searchLocations(query)
    expect(h.calls.map((c) => c.variables.request.name)).toEqual(asked)
    expect(locations).toHaveLength(1)
    // Asked again, the search also says which spelling the answer belongs to.
    expect(await h.client.findLocations(query)).toMatchObject({ answeredBy: answered, tried: asked })
  })

  it('asks at most three times for omio_locations about a name nothing is known for', async () => {
    const h = harness({ SearchLocation: [loadOmioFixture('search-location-empty')] })
    expect(await h.client.findLocations('Bishops Nowhere & Kings Nothing')).toEqual({
      locations: [],
      answeredBy: 'Bishops Nowhere & Kings Nothing',
      tried: ['Bishops Nowhere & Kings Nothing', 'Bishops Nowhere', "Bishop's Nowhere"],
    })
    expect(h.calls.map((c) => c.variables.request.name)).toEqual([
      'Bishops Nowhere & Kings Nothing',
      'Bishops Nowhere',
      "Bishop's Nowhere",
    ])
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

  it('polls once a second until the search is done, then asks for later trains until the hours are covered', async () => {
    const h = harness(standardScript())
    // Six hours from 06:00: the 08:22 and 10:22 windows fall short, 12:22 covers it.
    const result = await h.client.searchFares({ ...BASE_QUERY, hours: 6 })

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

  it('asks for four hours of trains by default', async () => {
    const h = harness(standardScript())
    const result = await h.client.searchFares(BASE_QUERY)
    // 08:22 is short of 10:00, the next window (10:22) covers it.
    expect(h.operations().filter((o) => o === 'ExtendSearchWithoutQuotes')).toHaveLength(1)
    expect(result.trainWindow?.end).toBe('10:22')
    expect(result.hours).toBe(4)
    expect(result.complete).toBe(true)
  })

  it('does not ask for later trains when the first window already covers the hours', async () => {
    const h = harness(standardScript())
    const result = await h.client.searchFares({ ...BASE_QUERY, hours: 2 })
    expect(h.operations()).not.toContain('ExtendSearchWithoutQuotes')
    expect(result.trainWindow?.end).toBe('08:22')
    expect(result.complete).toBe(true)
  })

  it('keeps asking until the end of the day when the hours run past midnight', async () => {
    const h = harness({
      ...standardScript(),
      GetSearchWithoutQuotes: [doneWithWindow('21:30'), doneWithWindow('23:10'), doneWithWindow('00:20')],
    })
    const result = await h.client.searchFares({ ...BASE_QUERY, time: '20:00', hours: 12 })
    expect(h.operations().filter((o) => o === 'ExtendSearchWithoutQuotes')).toHaveLength(2)
    expect(result.trainWindow?.end).toBe('00:20')
    expect(result.notes).toEqual([])
  })

  it('treats a window that reaches 23:59 as the end of the day', async () => {
    const h = harness({
      ...standardScript(),
      GetSearchWithoutQuotes: [doneWithWindow('22:10'), doneWithWindow('23:59')],
    })
    const result = await h.client.searchFares({ ...BASE_QUERY, time: '20:00', hours: 12 })
    // The window cannot go further without wrapping, so no second request is made.
    expect(h.operations().filter((o) => o === 'ExtendSearchWithoutQuotes')).toHaveLength(1)
    expect(result.complete).toBe(true)
    expect(result.notes).toEqual([])
  })

  it('does not start a request for later trains it has no time left to finish', async () => {
    // A search that needs its full 20 s to start leaves room for only a few later windows:
    // each one needs a request (up to 10 s) plus a poll before the 35 s budget ends.
    const slowStart = [
      ...Array.from({ length: 19 }, () => loadOmioFixture('get-search-running')),
      doneWithWindow('06:30'),
      doneWithWindow('06:40'),
      doneWithWindow('06:50'),
      doneWithWindow('07:00'),
      doneWithWindow('07:10'),
      doneWithWindow('07:20'),
    ]
    const h = harness({ ...standardScript(), GetSearchWithoutQuotes: slowStart })
    const result = await h.client.searchFares({ ...BASE_QUERY, hours: 12 })
    expect(h.elapsed()).toBeLessThanOrEqual(35000)
    expect(result.complete).toBe(false)
    expect(result.notes.join(' ')).toMatch(/time budget for one search ran out/)
    expect(result.journeys.length).toBeGreaterThan(0)
  })

  it('stops after ten requests for later trains and says so', async () => {
    // Windows that creep forward five minutes at a time never cover twelve hours.
    const creeping = Array.from({ length: 12 }, (_, step) =>
      doneWithWindow(`07:${String(step * 5).padStart(2, '0')}`),
    )
    const h = harness({ ...standardScript(), GetSearchWithoutQuotes: creeping })
    const result = await h.client.searchFares({ ...BASE_QUERY, hours: 12 })
    expect(h.operations().filter((o) => o === 'ExtendSearchWithoutQuotes')).toHaveLength(10)
    expect(result.trainWindow?.end).toBe('07:50')
    expect(result.complete).toBe(false)
    expect(result.notes.join(' ')).toMatch(/Stopped after 10 requests for later trains/)
  })

  it('caches searches for different hours separately', async () => {
    const h = harness(standardScript())
    await h.client.searchFares({ ...BASE_QUERY, hours: 2 })
    const wider = await h.client.searchFares({ ...BASE_QUERY, hours: 4 })
    expect(wider.cached).toBe(false)
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
    const result = await h.client.searchFares({ ...BASE_QUERY, hours: 6 })
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

  it('keeps the first window and says so when an extension fails twice', async () => {
    const h = harness({
      ...standardScript(),
      GetSearchWithoutQuotes: [doneWithWindow('08:22')],
      ExtendSearchWithoutQuotes: [() => new Response('upstream connect error', { status: 503 })],
    })
    const result = await h.client.searchFares(BASE_QUERY)
    expect(result.complete).toBe(false)
    expect(result.trainWindow?.end).toBe('08:22')
    expect(result.notes.join(' ')).toMatch(/later trains.*503/)
    // The failed request is tried once more, and not a third time.
    expect(h.operations().filter((o) => o === 'ExtendSearchWithoutQuotes')).toHaveLength(2)
  })

  it('tries a request once more when the service answers with a gateway error', async () => {
    // What the live service did on one search in thirty: one 503, then business as usual.
    const h = harness({
      ...standardScript(),
      ExtendSearchWithoutQuotes: [
        () =>
          new Response('upstream connect error or disconnect/reset before headers. reset reason: connection timeout', {
            status: 503,
          }),
        loadOmioFixture('extend-search-running'),
      ],
    })
    const withRetry = await h.client.searchFares({ ...BASE_QUERY, hours: 6 })
    expect(withRetry.complete).toBe(true)
    expect(withRetry.notes).toEqual([])
    expect(withRetry.trainWindow?.end).toBe('12:22')
    // Two extensions, the first of which needed its second try.
    expect(h.operations().filter((o) => o === 'ExtendSearchWithoutQuotes')).toHaveLength(3)
    // The second try waits the usual second: 5 s of polling plus 1 s.
    expect(h.elapsed()).toBe(6000)
  })

  it('does not start a second try that could not finish inside the time left', async () => {
    // Nineteen slow polls, then a gateway error on the twentieth, at the 20 s cap for first results.
    const h = harness({
      ...standardScript(),
      GetSearchWithoutQuotes: [
        ...Array.from({ length: 19 }, () => loadOmioFixture('get-search-running')),
        () => new Response('upstream connect error', { status: 503 }),
      ],
    })
    await expect(h.client.searchFares(BASE_QUERY)).rejects.toThrow(
      'Uber Travel request failed (503) for GetSearchWithoutQuotes: upstream connect error',
    )
    expect(h.operations().filter((o) => o === 'GetSearchWithoutQuotes')).toHaveLength(20)
    expect(h.elapsed()).toBe(20000)
  })

  it('does not try an extension again when its first try used up the time left', async () => {
    // First results arrive at the 20 s cap, so the extension starts with 15 s to go.
    // Its first try takes 9 s to fail: a second could no longer finish inside the 35 s.
    const state: { advance?: (ms: number) => void } = {}
    const h = harness({
      ...standardScript(),
      GetSearchWithoutQuotes: [
        ...Array.from({ length: 19 }, () => loadOmioFixture('get-search-running')),
        doneWithWindow('08:22'),
      ],
      ExtendSearchWithoutQuotes: [
        () => {
          state.advance?.(9000)
          return new Response('upstream connect error', { status: 503 })
        },
      ],
    })
    state.advance = h.advance
    const result = await h.client.searchFares(BASE_QUERY)
    expect(h.operations().filter((o) => o === 'ExtendSearchWithoutQuotes')).toHaveLength(1)
    expect(result.notes.join(' ')).toMatch(/Could not load later trains.*503/)
    expect(result.trainWindow?.end).toBe('08:22')
  })

  it.each([502, 503, 504])('gives up after a second HTTP %i and reports it', async (status) => {
    const h = harness({
      ...standardScript(),
      SearchJourneys: [() => new Response('bad gateway', { status })],
    })
    await expect(h.client.searchFares(BASE_QUERY)).rejects.toThrow(
      `Uber Travel request failed (${status}) for SearchJourneys: bad gateway`,
    )
    expect(h.operations().filter((o) => o === 'SearchJourneys')).toHaveLength(2)
  })

  it('does not try again after any other kind of failure', async () => {
    for (const status of [400, 403, 404, 429, 500]) {
      const h = harness({
        ...standardScript(),
        SearchJourneys: [() => new Response('no', { status })],
      })
      await expect(h.client.searchFares(BASE_QUERY)).rejects.toThrow(`(${status})`)
      expect(h.operations().filter((o) => o === 'SearchJourneys'), String(status)).toHaveLength(1)
    }
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
      /No Uber Travel location found for "WAE" \(London Waterloo East\).*Uber Travel offers: London Waterloo\./,
    )
    expect(h.operations()).not.toContain('SearchJourneys')
  })

  // The live location search finds nothing for a query containing "&" or "and", and
  // wants an apostrophe exactly where its own station name has one.
  it.each([
    ['HXM', ['Hoveton'], 'Hoveton & Wroxham'],
    ['CHH', ["Christ's Hospital", 'Christs Hospital'], 'Christs Hospital'],
    ['SPB', ["Shepherd's Bush"], "Shepherd's Bush"],
    ['Harrow and Wealdstone', ['Harrow'], 'Harrow & Wealdstone'],
  ])('searches for %s with terms the location search can answer', async (input, terms, uberName) => {
    // A station code is only accepted where its station is; free text has no such check.
    const found = replyWith(stationAt(STATIONS.has(input) ? input : 'HRW', uberName, '777'))
    const answered = terms[terms.length - 1]
    const h = harness({
      ...standardScript(),
      SearchLocation: [
        (variables: any) => (variables.request.name === answered ? found : locationResponder(variables)),
      ],
    })
    const result = await h.client.searchFares({ ...BASE_QUERY, from: input })
    const lookups = h.calls.filter((c) => c.operationName === 'SearchLocation').map((c) => c.variables.request.name)
    expect(lookups).toEqual([...terms, 'London Euston'])
    expect(result.origin).toMatchObject({ id: '777', name: uberName })
  })

  it('tries every spelling before settling for a first suggestion', async () => {
    const exact = loadOmioFixture('search-location-station')
    exact.data.SearchLocation.locations[0].name = 'Bishops Stortford'
    exact.data.SearchLocation.locations[0].id = '888'
    const h = harness({
      ...standardScript(),
      SearchLocation: [
        (variables: any) =>
          variables.request.name === 'Bishops Stortford'
            ? exact
            : variables.request.name === "Bishop's Stortford"
              ? loadOmioFixture('search-location-city') // unrelated suggestions
              : locationResponder(variables),
      ],
    })
    const result = await h.client.searchFares({ ...BASE_QUERY, from: "Bishop's Stortford" })
    expect(result.origin).toMatchObject({ id: '888', name: 'Bishops Stortford' })
  })

  it('tries the possessive spelling when a name without an apostrophe finds nothing', async () => {
    const found = loadOmioFixture('search-location-station')
    found.data.SearchLocation.locations[0].name = "Shepherd's Bush"
    found.data.SearchLocation.locations[0].id = '999'
    const h = harness({
      ...standardScript(),
      SearchLocation: [
        (variables: any) => (variables.request.name === "Shepherd's Bush" ? found : locationResponder(variables)),
      ],
    })
    const result = await h.client.searchFares({ ...BASE_QUERY, from: 'Shepherds Bush' })
    const lookups = h.calls.filter((c) => c.operationName === 'SearchLocation').map((c) => c.variables.request.name)
    expect(lookups).toEqual(['Shepherds Bush', "Shepherd's Bush", 'London Euston'])
    expect(result.origin).toMatchObject({ id: '999', name: "Shepherd's Bush" })
  })

  it('does not try possessive spellings when the search already returned places', async () => {
    const h = harness({ ...standardScript(), SearchLocation: [loadOmioFixture('search-location-city')] })
    // Nothing is called this, but the search answered, so its first suggestion is used as before.
    const result = await h.client.searchFares({
      ...BASE_QUERY,
      from: 'Liverpools Docks',
      to: 'Liverpool South Parkway',
    })
    const lookups = h.calls.filter((c) => c.operationName === 'SearchLocation').map((c) => c.variables.request.name)
    expect(lookups).toEqual(['Liverpools Docks', 'Liverpool South Parkway'])
    expect(result.origin).toMatchObject({ name: 'Liverpool', type: 'location' })
  })

  it('spends one extra request at most on a possessive spelling', async () => {
    const h = harness(standardScript())
    await expect(h.client.searchFares({ ...BASE_QUERY, from: 'Bishops Abbots Kings' })).rejects.toThrow(
      /No Uber Travel location found/,
    )
    const lookups = h.calls.filter((c) => c.operationName === 'SearchLocation').map((c) => c.variables.request.name)
    expect(lookups).toEqual(['Bishops Abbots Kings', "Bishop's Abbots Kings"])
  })

  it('does not treat a word ending in a double s as a possessive', async () => {
    const h = harness(standardScript())
    await expect(h.client.searchFares({ ...BASE_QUERY, from: 'Nowhere Cross' })).rejects.toThrow(
      /No Uber Travel location found/,
    )
    const lookups = h.calls.filter((c) => c.operationName === 'SearchLocation').map((c) => c.variables.request.name)
    expect(lookups).toEqual(['Nowhere Cross'])
  })

  it('finds a possessive in capital letters too', async () => {
    const h = harness(standardScript())
    await expect(h.client.searchFares({ ...BASE_QUERY, from: 'NOWHERE BISHOPS' })).rejects.toThrow(
      /No Uber Travel location found/,
    )
    const lookups = h.calls.filter((c) => c.operationName === 'SearchLocation').map((c) => c.variables.request.name)
    expect(lookups).toEqual(['NOWHERE BISHOPS', "NOWHERE BISHOP's"])
  })

  it('does not look a name that found nothing up again for a minute', async () => {
    const h = harness(standardScript())
    const search = () => h.client.searchFares({ ...BASE_QUERY, from: 'Atlantis' }).catch(() => undefined)
    await search()
    const afterFirst = h.calls.length
    expect(afterFirst).toBe(2) // as given, then the one possessive spelling

    h.advance(50 * 1000)
    await search()
    expect(h.calls).toHaveLength(afterFirst)

    h.advance(20 * 1000)
    await search()
    expect(h.calls).toHaveLength(afterFirst * 2)
  })

  it('asks again for omio_locations about a name a fare search just remembered as unknown', async () => {
    const h = harness(standardScript())
    await h.client.searchFares({ ...BASE_QUERY, from: 'Atlantis' }).catch(() => undefined)
    const before = h.calls.length
    expect(await h.client.searchLocations('Atlantis')).toEqual([])
    // As given, then the one possessive spelling: both asked again, neither taken from memory.
    expect(h.calls.slice(before).map((c) => c.variables.request.name)).toEqual(['Atlantis', "Atlanti's"])
  })

  it('does not let an empty omio_locations reply hide a place from the next fare search', async () => {
    const known = loadOmioFixture('search-location-station')
    known.data.SearchLocation.locations[0].name = 'Atlantis'
    const h = harness({
      ...standardScript(),
      // Empty once (a passing fault), known from then on.
      SearchLocation: [
        loadOmioFixture('search-location-empty'),
        (variables: any) => (variables.request.name === 'Atlantis' ? known : locationResponder(variables)),
      ],
    })
    expect(await h.client.searchLocations('Atlantis')).toEqual([])
    const result = await h.client.searchFares({ ...BASE_QUERY, from: 'Atlantis' })
    expect(result.origin.name).toBe('Atlantis')
  })

  it('prefers a known result over a remembered unknown', async () => {
    const known = loadOmioFixture('search-location-station')
    known.data.SearchLocation.locations[0].name = 'Atlantis'
    const h = harness({
      ...standardScript(),
      // Unknown on the first two lookups (as given, possessive), known from then on.
      SearchLocation: [
        loadOmioFixture('search-location-empty'),
        loadOmioFixture('search-location-empty'),
        (variables: any) => (variables.request.name === 'Atlantis' ? known : locationResponder(variables)),
      ],
    })
    await h.client.searchFares({ ...BASE_QUERY, from: 'Atlantis' }).catch(() => undefined)
    expect(await h.client.searchLocations('Atlantis')).toHaveLength(1)
    const result = await h.client.searchFares({ ...BASE_QUERY, from: 'Atlantis' })
    expect(result.origin.name).toBe('Atlantis')
  })

  it('does not let a run of unknown names push known places out of the cache', async () => {
    const h = harness(standardScript())
    await h.client.searchLocations('London Euston')
    for (let index = 0; index < 60; index++) {
      await h.client.searchFares({ ...BASE_QUERY, from: `Nowhere${index}` }).catch(() => undefined)
    }
    const before = h.calls.length
    await h.client.searchLocations('London Euston')
    expect(h.calls).toHaveLength(before)
  })

  it('takes the fallback suggestion from the name as typed when that search answered', async () => {
    const stripped = loadOmioFixture('search-location-station') // Liverpool South Parkway
    const h = harness({
      ...standardScript(),
      SearchLocation: [
        (variables: any) =>
          variables.request.name === "King's Nowhere"
            ? loadOmioFixture('search-location-city') // first suggestion: Liverpool
            : variables.request.name === 'Kings Nowhere'
              ? stripped
              : locationResponder(variables),
      ],
    })
    const result = await h.client.searchFares({ ...BASE_QUERY, from: "King's Nowhere" })
    expect(result.origin).toMatchObject({ name: 'Liverpool', type: 'location' })
  })

  it('takes the fallback suggestion from the spelling without the apostrophe when the typed one found nothing', async () => {
    const stripped = loadOmioFixture('search-location-station')
    stripped.data.SearchLocation.locations[0].name = 'Kings Norton'
    const h = harness({
      ...standardScript(),
      SearchLocation: [
        (variables: any) => (variables.request.name === 'Kings Nowhere' ? stripped : locationResponder(variables)),
      ],
    })
    const result = await h.client.searchFares({ ...BASE_QUERY, from: "King's Nowhere" })
    expect(result.origin.name).toBe('Kings Norton')
  })

  it('takes only a proper match from a possessive spelling, never its first suggestion', async () => {
    const other = loadOmioFixture('search-location-station')
    other.data.SearchLocation.locations[0].name = "Shepherd's Well"
    const h = harness({
      ...standardScript(),
      SearchLocation: [
        (variables: any) => (variables.request.name === "Shepherd's Bush" ? other : locationResponder(variables)),
      ],
    })
    await expect(h.client.searchFares({ ...BASE_QUERY, from: 'Shepherds Bush' })).rejects.toThrow(
      /No Uber Travel location found for "Shepherds Bush"\. Uber Travel offers: Shepherd's Well\./,
    )
    expect(h.operations()).not.toContain('SearchJourneys')
  })

  it('tries the possessive spelling for a station code too, and still demands the right station', async () => {
    // SAC is "St Albans City" in the station table.
    const stored = replyWith(stationAt('SAC', "St Alban's City", '555'))
    const answer = (name: string, reply: unknown) => (variables: any) =>
      variables.request.name === name ? reply : locationResponder(variables)

    const right = harness({ ...standardScript(), SearchLocation: [answer("St Alban's City", stored)] })
    const result = await right.client.searchFares({ ...BASE_QUERY, from: 'SAC' })
    expect(result.origin).toMatchObject({ id: '555', name: "St Alban's City" })

    const wrongStation = replyWith(stationAt('SAC', "St Alban's", '556'))
    const wrong = harness({ ...standardScript(), SearchLocation: [answer("St Alban's City", wrongStation)] })
    await expect(wrong.client.searchFares({ ...BASE_QUERY, from: 'SAC' })).rejects.toThrow(
      /No Uber Travel location found for "SAC" \(St Albans City\): no British station with that name came back in the right place\. Uber Travel offers: St Alban's\./,
    )
  })

  it('names only British stations when a station code does not resolve', async () => {
    const mixed = loadOmioFixture('search-location-city')
    mixed.data.SearchLocation.locations = [
      { ...mixed.data.SearchLocation.locations[1], name: 'Waterloo', type: 'station', countryCode: 'BE' },
      { ...mixed.data.SearchLocation.locations[1], name: 'London Waterloo', type: 'station', countryCode: 'GB' },
    ]
    const h = harness({ ...standardScript(), SearchLocation: [mixed] })
    const failure = await h.client.searchFares({ ...BASE_QUERY, from: 'WAE' }).catch((thrown: unknown) => thrown)
    expect((failure as Error).message).toContain('Uber Travel offers: London Waterloo.')
  })

  it('does not settle for the first suggestion when the search term was shortened', async () => {
    const h = harness({
      ...standardScript(),
      SearchLocation: [loadOmioFixture('search-location-city')],
    })
    // "Liverpool" is searched, but nothing is called "Liverpool & Nowhere".
    await expect(h.client.searchFares({ ...BASE_QUERY, from: 'Liverpool & Nowhere' })).rejects.toThrow(
      /No Uber Travel location found for "Liverpool & Nowhere"/,
    )
    expect(h.operations()).not.toContain('SearchJourneys')
  })

  it('refuses a station code when only a longer-named station comes back', async () => {
    // WAT is London Waterloo. If the exact station were missing from the reply,
    // London Waterloo East must not be taken in its place.
    const east = loadOmioFixture('search-location-euston')
    east.data.SearchLocation.locations[0].name = 'London Waterloo East'
    const h = harness({ ...standardScript(), SearchLocation: [east] })
    await expect(h.client.searchFares({ ...BASE_QUERY, from: 'WAT' })).rejects.toThrow(
      /No Uber Travel location found for "WAT" \(London Waterloo\).*Uber Travel offers: London Waterloo East\./,
    )
    expect(h.operations()).not.toContain('SearchJourneys')
  })

  // These three were once listed under a shortened name. A code resolves by exact
  // name only, so each needs the full name the location search stores.
  it.each([
    ['STP', 'London St Pancras International', 'London St Pancras International'],
    ['SRG', 'Seer Green', 'Seer Green & Jordans'],
    ['RAV', 'Ravenglass for Eskdale', 'Ravenglass for Eskdale'],
  ])('resolves %s by searching "%s" and matching "%s" exactly', async (code, term, storedName) => {
    const stored = replyWith(stationAt(code, storedName, '321'))
    const h = harness({
      ...standardScript(),
      SearchLocation: [(variables: any) => (variables.request.name === term ? stored : locationResponder(variables))],
    })
    const result = await h.client.searchFares({ ...BASE_QUERY, from: code })
    expect(h.calls[0]?.variables.request.name).toBe(term)
    expect(result.origin).toMatchObject({ id: '321', name: storedName })
  })

  // Eight of the stations the location search stores under another name than the
  // station table (the first ones found). Each row: code, the text sent, the stored
  // name it must match. Every entry of the list is covered by the test after this one.
  it.each([
    ['ABW', 'Abbey Wood Station', 'Abbey Wood Station'],
    ['BIS', "Bishop's Stortford", "Bishop's Stortford"],
    ['BOC', 'Bootle', 'Bootle'],
    ['BUW', 'Burley-in-Wharfdale', 'Burley-in-Wharfdale'],
    ['CUS', 'Custom House Station', 'Custom House Station'],
    ['MCE', 'Metro Centre', 'Metro Centre'],
    ['SYD', 'Sydenham (London)', 'Sydenham (London)'],
    ['WCH', 'Whitchurch', 'Whitchurch'],
  ])('looks %s up as "%s"', async (code, term, storedName) => {
    const stored = replyWith(stationAt(code, storedName, '432'))
    const h = harness({
      ...standardScript(),
      SearchLocation: [(variables: any) => (variables.request.name === term ? stored : locationResponder(variables))],
    })
    const result = await h.client.searchFares({ ...BASE_QUERY, from: code })
    expect(h.calls[0]?.variables.request.name).toBe(term)
    expect(result.origin).toMatchObject({ id: '432', name: storedName })
  })

  it('resolves every station that is stored under another name, by that name and in its place', async () => {
    for (const [code, storedName] of Object.entries(OMIO_STATION_NAMES)) {
      const terms = locationSearchTerms(storedName)
      const h = harness({
        ...standardScript(),
        SearchLocation: [
          (variables: any) =>
            terms.includes(variables.request.name)
              ? replyWith(stationAt(code, storedName, `id-${code}`))
              : locationResponder(variables),
        ],
      })
      const place = await h.client.resolvePlace(code)
      expect(place, code).toMatchObject({ id: `id-${code}`, name: storedName })
      // Found on the first name tried: one request, or two when the name has an apostrophe.
      expect(h.calls.length, code).toBeLessThanOrEqual(terms.length)
    }
  })

  it('still matches a station with another search name exactly, not its longer-named neighbours', async () => {
    // WCH is looked up as "Whitchurch". The search also knows Whitchurch (Shropshire)
    // and Whitchurch (Cardiff), which must not be taken when the plain one is missing.
    const others = loadOmioFixture('search-location-city')
    others.data.SearchLocation.locations = ['Whitchurch (Shropshire)', 'Whitchurch (Cardiff)'].map((name) => ({
      ...others.data.SearchLocation.locations[1],
      name,
      type: 'station',
      countryCode: 'GB',
    }))
    const h = harness({ ...standardScript(), SearchLocation: [others] })
    await expect(h.client.searchFares({ ...BASE_QUERY, from: 'WCH' })).rejects.toThrow(
      /No Uber Travel location found for "WCH" \(Whitchurch \(Hampshire\), also searched as "Whitchurch"\): no British station with that name came back in the right place\. Uber Travel offers: Whitchurch \(Shropshire\), Whitchurch \(Cardiff\)\./,
    )
    expect(h.operations()).not.toContain('SearchJourneys')
  })

  it('says so when a station code is refused because two stations share its name', async () => {
    const twins = replyWith(stationAt('WAT', 'London Waterloo', '111'), stationAt('WAT', 'London Waterloo', '222'))
    const h = harness({ ...standardScript(), SearchLocation: [twins] })
    await expect(h.client.searchFares({ ...BASE_QUERY, from: 'WAT' })).rejects.toThrow(
      /No Uber Travel location found for "WAT" \(London Waterloo\): more than one British station with that name came back, and they cannot be told apart\./,
    )
    expect(h.operations()).not.toContain('SearchJourneys')
  })

  it('does not call two namesakes elsewhere a choice between stations', async () => {
    // BOC is looked up as "Bootle" in Cumbria. Two stations of that name on Merseyside
    // are both in the wrong place, so nothing qualified: that is what the error must say.
    const namesakes = loadOmioFixture('search-location-city')
    namesakes.data.SearchLocation.locations = ['801', '802'].map((id) => ({
      ...namesakes.data.SearchLocation.locations[1],
      id,
      name: 'Bootle',
      type: 'station',
      countryCode: 'GB',
      latitude: 53.4533,
      longitude: -2.9945,
    }))
    const h = harness({
      ...standardScript(),
      SearchLocation: [
        (variables: any) => (variables.request.name === 'Bootle' ? namesakes : locationResponder(variables)),
      ],
    })
    const failure = await h.client.searchFares({ ...BASE_QUERY, from: 'BOC' }).catch((thrown: unknown) => thrown)
    expect((failure as Error).message).toContain('no British station with that name came back in the right place.')
    expect((failure as Error).message).not.toContain('more than one')
  })

  it('keeps refusing two same-named stations when another spelling returns only one of them', async () => {
    // SPB is "Shepherd's Bush": looked up with its apostrophe, then without.
    const entry = (id: string) => stationAt('SPB', "Shepherd's Bush", id)
    const both = replyWith(entry('one'), entry('two'))
    const single = replyWith(entry('one'))
    const h = harness({
      ...standardScript(),
      SearchLocation: [
        (variables: any) =>
          variables.request.name === "Shepherd's Bush"
            ? both
            : variables.request.name === 'Shepherds Bush'
              ? single
              : locationResponder(variables),
      ],
    })
    await expect(h.client.searchFares({ ...BASE_QUERY, from: 'SPB' })).rejects.toThrow(
      /more than one British station with that name came back, and they cannot be told apart/,
    )
    const lookups = h.calls.filter((c) => c.operationName === 'SearchLocation').map((c) => c.variables.request.name)
    expect(lookups).toEqual(["Shepherd's Bush", 'Shepherds Bush'])
  })

  it('resolves a station that moved to the entry at its present site', async () => {
    const position = getStationPosition('HMY')
    if (!position) throw new Error('no position for HMY')
    const oldSite = { ...stationAt('HMY', 'Hairmyres', '319214'), latitude: position.latitude + 0.0056 }
    const h = harness({
      ...standardScript(),
      SearchLocation: [
        (variables: any) =>
          variables.request.name === 'Hairmyres'
            ? replyWith(oldSite, stationAt('HMY', 'Hairmyres', '17446119'))
            : locationResponder(variables),
      ],
    })
    const result = await h.client.searchFares({ ...BASE_QUERY, from: 'HMY' })
    expect(result.origin.id).toBe('17446119')
  })

  it('finds a renamed station in the reply to its other name', async () => {
    // ADL is stored as "Adlington (Lancs)". Here that query finds nothing, but the
    // table's "Adlington (Lancashire)" does bring the station back, under its stored name.
    const h = harness({
      ...standardScript(),
      SearchLocation: [
        (variables: any) =>
          variables.request.name === 'Adlington (Lancashire)'
            ? replyWith(stationAt('ADL', 'Adlington (Lancs)', '909'))
            : locationResponder(variables),
      ],
    })
    const result = await h.client.searchFares({ ...BASE_QUERY, from: 'ADL' })
    const lookups = h.calls.filter((c) => c.operationName === 'SearchLocation').map((c) => c.variables.request.name)
    expect(lookups).toEqual(['Adlington (Lancs)', 'Adlington (Lancashire)', 'London Euston'])
    expect(result.origin).toMatchObject({ id: '909', name: 'Adlington (Lancs)' })
  })

  it('says when a station it cannot find was missing from Uber Travel at the last full check', async () => {
    const h = harness(standardScript())
    await expect(h.client.searchFares({ ...BASE_QUERY, from: 'ASL' })).rejects.toThrow(
      /No Uber Travel location found for "ASL" \(Ashington\): no British station with that name came back in the right place, and Uber Travel had no station there when all stations were last checked\./,
    )
  })

  it('falls back to the table name when the search stops using its own name for a station', async () => {
    // BUW is stored as "Burley-in-Wharfdale" today. Should that spelling be corrected,
    // the stored name finds nothing and the table's "Burley-in-Wharfedale" does.
    const corrected = loadOmioFixture('search-location-station')
    Object.assign(corrected.data.SearchLocation.locations[0], {
      name: 'Burley-in-Wharfedale',
      id: '700',
      latitude: 53.9081,
      longitude: -1.7533,
    })
    const h = harness({
      ...standardScript(),
      SearchLocation: [
        (variables: any) =>
          variables.request.name === 'Burley-in-Wharfedale' ? corrected : locationResponder(variables),
      ],
    })
    const result = await h.client.searchFares({ ...BASE_QUERY, from: 'BUW' })
    const lookups = h.calls.filter((c) => c.operationName === 'SearchLocation').map((c) => c.variables.request.name)
    expect(lookups).toEqual(['Burley-in-Wharfdale', 'Burley-in-Wharfedale', 'London Euston'])
    expect(result.origin).toMatchObject({ id: '700', name: 'Burley-in-Wharfedale' })
  })

  it('does not take a namesake elsewhere for a renamed station', async () => {
    // BOC is looked up as "Bootle". A station of that name on Merseyside is not it.
    const namesake = loadOmioFixture('search-location-station')
    Object.assign(namesake.data.SearchLocation.locations[0], {
      name: 'Bootle',
      id: '701',
      latitude: 53.4533,
      longitude: -2.9945,
    })
    const h = harness({
      ...standardScript(),
      SearchLocation: [
        (variables: any) => (variables.request.name === 'Bootle' ? namesake : locationResponder(variables)),
      ],
    })
    await expect(h.client.searchFares({ ...BASE_QUERY, from: 'BOC' })).rejects.toThrow(
      /No Uber Travel location found for "BOC" \(Bootle \(Cumbria\), also searched as "Bootle"\): no British station with that name came back in the right place\. Uber Travel offers: Bootle\./,
    )
    expect(h.operations()).not.toContain('SearchJourneys')
  })

  it('resolves a single place on request, the way a fare search would', async () => {
    const h = harness(standardScript())
    expect(await h.client.resolvePlace('LPY')).toMatchObject({ id: '319585', name: 'Liverpool South Parkway' })
    expect(await h.client.resolvePlace(' Liverpool ')).toMatchObject({ name: 'Liverpool', type: 'location' })
    await expect(h.client.resolvePlace('  ')).rejects.toThrow(/A place is required/)
    await expect(h.client.resolvePlace('QQQ')).rejects.toThrow(/not a station code this server knows/)
    expect(h.operations().every((operation) => operation === 'SearchLocation')).toBe(true)
  })

  it('sends a curly apostrophe as a plain one', async () => {
    const stored = loadOmioFixture('search-location-station')
    stored.data.SearchLocation.locations[0].name = "Shepherd's Bush"
    stored.data.SearchLocation.locations[0].id = '654'
    const h = harness({
      ...standardScript(),
      SearchLocation: [
        (variables: any) => (variables.request.name === "Shepherd's Bush" ? stored : locationResponder(variables)),
      ],
    })
    const result = await h.client.searchFares({ ...BASE_QUERY, from: 'Shepherd\u2019s Bush' })
    expect(h.calls[0]?.variables.request.name).toBe("Shepherd's Bush")
    expect(result.origin.id).toBe('654')
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

  // The bodies below are what the live endpoint answered to deliberately broken requests.
  it.each([
    [
      'a field the schema no longer has',
      {
        message: 'Cannot query field "nonexistentField" on type "SearchLocation".',
        locations: [{ line: 1, column: 109 }],
        extensions: { code: 'GRAPHQL_VALIDATION_FAILED' },
      },
    ],
    [
      'variables that no longer fit the input type',
      {
        message:
          'Variable "$request" got invalid value { name: 123, bogus: true }; Field "bogus" is not defined by type "SearchLocation__Input".',
        locations: [{ line: 1, column: 22 }],
        extensions: { code: 'BAD_USER_INPUT' },
      },
    ],
    [
      'a query the server cannot parse',
      { message: 'Syntax Error: Expected Name, found <EOF>.', extensions: { code: 'GRAPHQL_PARSE_FAILED' } },
    ],
    [
      'a server that only accepts its own stored queries',
      { message: 'PersistedQueryNotFound', extensions: { code: 'PERSISTED_QUERY_NOT_FOUND' } },
    ],
  ])('treats an HTTP 400 for %s as a schema change', async (_label, error) => {
    const body = JSON.stringify({ errors: [error] })
    const h = harness({ ...standardScript(), SearchJourneys: [new Response(body, { status: 400 })] })
    const failure = await h.client.searchFares(BASE_QUERY).catch((thrown: unknown) => thrown)
    expect(failure).toBeInstanceOf(OmioSchemaError)
    expect((failure as Error).message).toContain(error.message.slice(0, 40))
  })

  // The first two are live replies to requests the server turned down before
  // running them. Their wording is recognised by itself (see omio-parse.test.ts),
  // so they would pass without the status rule. The third is made up: nothing but
  // the HTTP status marks it, so it is the one that proves that rule.
  it.each([
    ['an enum value the schema lacks', { message: 'Invalid GraphQL query', extensions: {} }],
    [
      'a missing request, filed under the internal-error code',
      {
        message: 'Variable "$request" of non-null type "SearchQuotes__Input!" must not be null.',
        locations: [{ line: 1, column: 25 }],
        extensions: { code: 'INTERNAL_SERVER_ERROR' },
      },
    ],
    ['a rejection worded in a way never seen before', { message: 'Request refused', extensions: { code: 'NEW_CODE' } }],
  ])('treats an HTTP 400 for %s as a schema change', async (_label, error) => {
    const body = JSON.stringify({ errors: [error] })
    const h = harness({ ...standardScript(), SearchJourneys: [new Response(body, { status: 400 })] })
    const failure = await h.client.searchFares(BASE_QUERY).catch((thrown: unknown) => thrown)
    expect(failure).toBeInstanceOf(OmioSchemaError)
    expect((failure as Error).message).toContain(error.message.slice(0, 30))
  })

  it('goes by the HTTP status for a turned-down location lookup and a turned-down poll too', async () => {
    const refused = (): Response =>
      new Response(JSON.stringify({ errors: [{ message: 'Request refused', extensions: { code: 'NEW_CODE' } }] }), {
        status: 400,
      })

    const lookup = harness({ ...standardScript(), SearchLocation: [refused()] })
    const lookupFailure = await lookup.client.searchLocations('Leeds').catch((thrown: unknown) => thrown)
    expect(lookupFailure).toBeInstanceOf(OmioSchemaError)
    expect((lookupFailure as Error).message).toMatch(/turned the request down.*SearchLocation: Request refused/)

    const poll = harness({ ...standardScript(), GetSearchWithoutQuotes: [refused()] })
    const pollFailure = await poll.client.searchFares(BASE_QUERY).catch((thrown: unknown) => thrown)
    expect(pollFailure).toBeInstanceOf(OmioSchemaError)
    expect((pollFailure as Error).message).toMatch(/GetSearchWithoutQuotes: Request refused/)
  })

  it('words a turned-down request differently from a reply of the wrong shape', async () => {
    const turnedDown = harness({
      ...standardScript(),
      SearchJourneys: [{ errors: [{ message: 'Cannot query field "searchId" on type "Booking".' }] }],
    })
    await expect(turnedDown.client.searchFares(BASE_QUERY)).rejects.toThrow(
      /turned the request down before running it \(SearchJourneys: Cannot query field/,
    )

    const wrongShape = harness({
      ...standardScript(),
      GetSearchWithoutQuotes: [{ data: { GetSearchWithoutQuotes: { booking: { status: 'SEARCH_STATUS_DONE' } } } }],
    })
    await expect(wrongShape.client.searchFares(BASE_QUERY)).rejects.toThrow(/did not match the expected shape/)
  })

  // Bodies below are live replies, one broken request each, to the three other operations.
  it('treats the live HTTP 400 replies of the location search as schema changes', async () => {
    const replies = [
      // An argument the field does not have.
      {
        errors: [
          {
            message: 'Unknown argument "input" on field "Query.SearchLocation".',
            extensions: { code: 'GRAPHQL_VALIDATION_FAILED' },
          },
          {
            message:
              'Field "SearchLocation" argument "request" of type "SearchLocation__Input!" is required, but it was not provided.',
            extensions: { code: 'GRAPHQL_VALIDATION_FAILED' },
          },
        ],
      },
      // An input type, or an operation, the schema does not have.
      { errors: [{ message: 'Invalid GraphQL query', extensions: {} }] },
    ]
    for (const reply of replies) {
      const h = harness({ SearchLocation: [new Response(JSON.stringify(reply), { status: 400 })] })
      await expect(h.client.searchLocations('Leeds')).rejects.toThrow(OmioSchemaError)
    }
  })

  it('treats the live HTTP 400 replies to a poll and to an extension as schema changes', async () => {
    const wrongShape = (path: string, type: string) => ({
      errors: [
        {
          message: `Variable "$request" got invalid value 7 at "request.${path}"; ${type} cannot represent a non string value: 7`,
          extensions: { code: 'BAD_USER_INPUT' },
        },
        {
          message:
            'Variable "$request" got invalid value { searchId: 7 }; Field "direction" of required type "String!" was not provided.',
          extensions: { code: 'BAD_USER_INPUT' },
        },
      ],
    })
    const poll = harness({
      ...standardScript(),
      GetSearchWithoutQuotes: [new Response(JSON.stringify(wrongShape('searchId', 'String')), { status: 400 })],
    })
    await expect(poll.client.searchFares(BASE_QUERY)).rejects.toThrow(OmioSchemaError)

    // During an extension a schema change is not downgraded to a note about later trains.
    const extend = harness({
      ...standardScript(),
      GetSearchWithoutQuotes: [doneWithWindow('08:22')],
      ExtendSearchWithoutQuotes: [
        new Response(JSON.stringify(wrongShape('extendDirection', 'String')), { status: 400 }),
      ],
    })
    await expect(extend.client.searchFares(BASE_QUERY)).rejects.toThrow(OmioSchemaError)
  })

  it('reports the live HTTP 500 replies as plain failures', async () => {
    const internal = (operation: string) =>
      new Response(
        JSON.stringify({
          errors: [
            {
              message: `Query ${operation} failed`,
              path: [operation],
              extensions: { code: 'INTERNAL_SERVER_ERROR', exception: { message: `Query ${operation} failed` } },
            },
          ],
          data: null,
        }),
        { status: 500 },
      )

    // An unknown or expired search id while polling.
    const poll = harness({ ...standardScript(), GetSearchWithoutQuotes: [internal('GetSearchWithoutQuotes')] })
    const pollFailure = await poll.client.searchFares(BASE_QUERY).catch((thrown: unknown) => thrown)
    expect(pollFailure).not.toBeInstanceOf(OmioSchemaError)
    expect((pollFailure as Error).message).toBe(
      'Uber Travel request failed (500) for GetSearchWithoutQuotes: Query GetSearchWithoutQuotes failed',
    )

    // An empty or far too long name in the location search.
    const lookup = harness({ SearchLocation: [internal('SearchLocation')] })
    const lookupFailure = await lookup.client.searchLocations('Leeds').catch((thrown: unknown) => thrown)
    expect(lookupFailure).not.toBeInstanceOf(OmioSchemaError)
    expect((lookupFailure as Error).message).toContain('(500) for SearchLocation')

    // An extension the server cannot run becomes a note; the first window is kept.
    const extend = harness({
      ...standardScript(),
      GetSearchWithoutQuotes: [doneWithWindow('08:22')],
      ExtendSearchWithoutQuotes: [internal('ExtendSearchWithoutQuotes')],
    })
    const result = await extend.client.searchFares(BASE_QUERY)
    expect(result.complete).toBe(false)
    expect(result.notes.join(' ')).toMatch(/Could not load later trains.*500/)
  })

  it('reports the live non-GraphQL HTTP 400 replies as plain failures', async () => {
    for (const text of ['Bad Request', 'Must provide query string.']) {
      const h = harness({ ...standardScript(), SearchJourneys: [new Response(text, { status: 400 })] })
      const failure = await h.client.searchFares(BASE_QUERY).catch((thrown: unknown) => thrown)
      expect(failure).not.toBeInstanceOf(OmioSchemaError)
      expect((failure as Error).message).toBe(`Uber Travel request failed (400) for SearchJourneys: ${text}`)
    }
  })

  it('reports an internal server error with its message, not as a schema change', async () => {
    const body = JSON.stringify({
      errors: [
        {
          message: 'Query SearchJourneys failed',
          path: ['SearchJourneys'],
          extensions: { code: 'INTERNAL_SERVER_ERROR', exception: { message: 'Query SearchJourneys failed' } },
        },
      ],
      data: null,
    })
    const h = harness({ ...standardScript(), SearchJourneys: [new Response(body, { status: 500 })] })
    const failure = await h.client.searchFares(BASE_QUERY).catch((thrown: unknown) => thrown)
    expect(failure).not.toBeInstanceOf(OmioSchemaError)
    expect((failure as Error).message).toBe(
      'Uber Travel request failed (500) for SearchJourneys: Query SearchJourneys failed',
    )
  })

  it('does not call a rejected search value a schema change', async () => {
    const h = harness({
      ...standardScript(),
      SearchJourneys: [
        { errors: [{ message: 'Departure time is in the past', extensions: { code: 'BAD_USER_INPUT' } }] },
      ],
    })
    const failure = await h.client.searchFares(BASE_QUERY).catch((thrown: unknown) => thrown)
    expect(failure).not.toBeInstanceOf(OmioSchemaError)
    expect((failure as Error).message).toContain('Departure time is in the past')
  })

  it('validates input before making any request', async () => {
    const h = harness(standardScript())
    await expect(h.client.searchFares({ ...BASE_QUERY, railcards: ['NOPE'] })).rejects.toThrow(/Unknown railcard/)
    await expect(h.client.searchFares({ ...BASE_QUERY, from: ' ' })).rejects.toThrow(/from/)
    expect(h.calls).toHaveLength(0)
  })
})
