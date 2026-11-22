import { describe, it, expect } from 'vitest'
import {
  OmioSchemaError,
  parseBooking,
  parseLocations,
  parseSearchStart,
} from '../src/omio-parse.js'
import { loadOmioFixture } from './omio-fixtures.js'

describe('parseLocations', () => {
  it('reads a single station', () => {
    expect(parseLocations(loadOmioFixture('search-location-station'))).toEqual([
      {
        id: '319585',
        name: 'Liverpool South Parkway',
        type: 'station',
        countryCode: 'GB',
        latitude: 53.35784539507004,
        longitude: -2.889499696572898,
      },
    ])
  })

  it('keeps the API order and the location types for a city query', () => {
    const locations = parseLocations(loadOmioFixture('search-location-city'))
    expect(locations).toHaveLength(13)
    expect(locations[0]).toMatchObject({ name: 'Liverpool', type: 'location' })
    expect(locations.map((l) => l.type)).toContain('station')
  })

  it('returns an empty list when nothing matches', () => {
    expect(parseLocations(loadOmioFixture('search-location-empty'))).toEqual([])
  })

  it('raises a schema error when a location loses a field', () => {
    const body = loadOmioFixture('search-location-station')
    delete body.data.SearchLocation.locations[0].latitude
    expect(() => parseLocations(body)).toThrow(OmioSchemaError)
    expect(() => parseLocations(body)).toThrow(/locations\[0\]\.latitude/)
  })
})

describe('parseSearchStart', () => {
  it('reads the search id and running status', () => {
    expect(parseSearchStart(loadOmioFixture('search-journeys-start'), 'SearchJourneys')).toEqual({
      searchId: 'TEST00000000000000000000000000001',
      status: 'running',
    })
  })

  it('reads the reply to an extension request', () => {
    expect(
      parseSearchStart(loadOmioFixture('extend-search-running'), 'ExtendSearchWithoutQuotes').status,
    ).toBe('running')
  })

  it('reports a query the server no longer accepts as a schema error', () => {
    const body = { errors: [{ message: 'Cannot query field "searchId" on type "Booking".' }] }
    expect(() => parseSearchStart(body, 'SearchJourneys')).toThrow(OmioSchemaError)
    expect(() => parseSearchStart(body, 'SearchJourneys')).toThrow(/Cannot query field/)
  })

  it('goes by the error code the server sends when there is one', () => {
    const validation = {
      errors: [{ message: 'Something new and unfamiliar', extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } }],
    }
    expect(() => parseSearchStart(validation, 'SearchJourneys')).toThrow(OmioSchemaError)

    // The wording looks like a validation error, but the server says it failed internally.
    const internal = {
      errors: [{ message: 'Cannot query field upstream', extensions: { code: 'INTERNAL_SERVER_ERROR' } }],
    }
    expect(() => parseSearchStart(internal, 'SearchJourneys')).not.toThrow(OmioSchemaError)
    expect(() => parseSearchStart(internal, 'SearchJourneys')).toThrow(/Cannot query field upstream/)
  })

  // Each error below is what the live endpoint answered to a request whose
  // variables did not have the shape its schema wants. The server turns such a
  // request down before running anything, and always names the variable.
  it.each([
    [
      'a number where text is wanted',
      'Variable "$request" got invalid value 319585 at "request.origin.id"; String cannot represent a non string value: 319585',
      'BAD_USER_INPUT',
    ],
    [
      'text where a whole number is wanted',
      'Variable "$request" got invalid value "30" at "request.travelers[0].age"; Int cannot represent non-integer value: "30"',
      'BAD_USER_INPUT',
    ],
    [
      'a missing required field',
      'Variable "$request" got invalid value { origin: { id: "319585" } }; Field "currency" of required type "Currency!" was not provided.',
      'BAD_USER_INPUT',
    ],
    [
      'a field the input type does not have',
      'Variable "$request" got invalid value { bogus: true }; Field "bogus" is not defined by type "SearchQuotes__Input".',
      'BAD_USER_INPUT',
    ],
    [
      'text where an object is wanted',
      'Variable "$request" got invalid value "Liverpool" at "request.origin"; Expected type "LocationQuery__Input" to be an object.',
      'BAD_USER_INPUT',
    ],
    [
      // The server files this one under its internal-error code, so the code alone cannot be trusted.
      'nothing where the request is wanted',
      'Variable "$request" of non-null type "SearchQuotes__Input!" must not be null.',
      'INTERNAL_SERVER_ERROR',
    ],
  ])('calls variables rejected for %s a schema change', (_label, message, code) => {
    const body = { errors: [{ message, extensions: { code } }] }
    expect(() => parseSearchStart(body, 'SearchJourneys')).toThrow(OmioSchemaError)
  })

  it('calls the codeless "Invalid GraphQL query" reply a schema change', () => {
    // The live answer to an enum value the schema does not have.
    const body = { errors: [{ message: 'Invalid GraphQL query', extensions: {} }] }
    expect(() => parseSearchStart(body, 'SearchJourneys')).toThrow(OmioSchemaError)
  })

  it('does not call a search the server ran and could not finish a schema change', () => {
    // The live answer to an age of -1, and to a departure time that is not a date.
    const body = {
      errors: [
        {
          message: 'Mutation SearchJourneys failed',
          path: ['SearchJourneys'],
          extensions: { code: 'INTERNAL_SERVER_ERROR', exception: { message: 'Mutation SearchJourneys failed' } },
        },
      ],
      data: null,
    }
    expect(() => parseSearchStart(body, 'SearchJourneys')).not.toThrow(OmioSchemaError)
    expect(() => parseSearchStart(body, 'SearchJourneys')).toThrow(/Mutation SearchJourneys failed/)
  })

  it('does not call a refusal raised while running the search a schema change', () => {
    // Not seen live: a server that uses this code for a value it dislikes, without naming a variable.
    const body = { errors: [{ message: 'Age must be between 0 and 120', extensions: { code: 'BAD_USER_INPUT' } }] }
    expect(() => parseSearchStart(body, 'SearchJourneys')).not.toThrow(OmioSchemaError)
  })

  it('finds a schema error behind another error in the same reply', () => {
    const body = {
      errors: [
        { message: 'Query SearchJourneys failed', extensions: { code: 'INTERNAL_SERVER_ERROR' } },
        { message: 'Unknown argument "request"', extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } },
      ],
    }
    expect(() => parseSearchStart(body, 'SearchJourneys')).toThrow(/Unknown argument "request"/)
    expect(() => parseSearchStart(body, 'SearchJourneys')).toThrow(OmioSchemaError)
  })

  it('passes any other GraphQL error through without calling it a schema change', () => {
    const body = { errors: [{ message: 'Internal server error' }], data: null }
    expect(() => parseSearchStart(body, 'SearchJourneys')).toThrow(
      'Uber Travel returned an error from SearchJourneys: Internal server error',
    )
    expect(() => parseSearchStart(body, 'SearchJourneys')).not.toThrow(OmioSchemaError)
  })
})

describe('parseBooking', () => {
  it('reads a search that is still running with no journeys', () => {
    const booking = parseBooking(loadOmioFixture('get-search-running'))
    expect(booking).toMatchObject({ status: 'running', journeys: [], trainWindow: null })
  })

  it('reads every journey of a finished search', () => {
    const booking = parseBooking(loadOmioFixture('get-search-done'))
    expect(booking.status).toBe('done')
    expect(booking.currency).toBe('CURRENCY_GBP')
    expect(booking.journeys.map((j) => `${j.dep.slice(11, 16)} ${j.mode}`)).toEqual([
      '01:45 coach',
      '02:30 coach',
      '06:19 train',
      '06:54 train',
      '07:03 train',
      '19:30 coach',
    ])
  })

  it('keeps timestamps exactly as given, without shifting them', () => {
    const direct = parseBooking(loadOmioFixture('get-search-done')).journeys[3]
    expect(direct).toMatchObject({
      dep: '2027-01-30T06:54:00',
      arr: '2027-01-30T09:04:00',
      timezone: '+00:00',
    })
  })

  it('describes a direct train', () => {
    const direct = parseBooking(loadOmioFixture('get-search-done')).journeys[3]
    expect(direct).toMatchObject({
      origin: 'Liverpool South Parkway',
      destination: 'London Euston',
      changes: 0,
      changeStations: [],
      operators: ['Avanti West Coast'],
      mode: 'train',
      pricePence: 2600,
      splitSavingPence: null,
      splitJourneys: [],
      alternativeStation: false,
    })
    expect(direct?.segments[0]?.transportId).toBe('G05211')
  })

  it('describes a split ticket with a change and two operators', () => {
    const split = parseBooking(loadOmioFixture('get-search-done')).journeys[2]
    expect(split).toMatchObject({
      changes: 1,
      changeStations: ['Stafford'],
      operators: ['West Midlands Trains', 'Avanti West Coast'],
      pricePence: 5010,
      splitSavingPence: 2970,
    })
  })

  it('flags coaches that leave from a different stop than the one searched', () => {
    const coach = parseBooking(loadOmioFixture('get-search-done')).journeys[0]
    expect(coach).toMatchObject({
      origin: 'Liverpool, One Bus Station, Canning Place',
      destination: 'London, Victoria Coach Station',
      operators: ['National Express'],
      alternativeStation: true,
    })
  })

  it('reads the train window and whether later trains can be requested', () => {
    expect(parseBooking(loadOmioFixture('get-search-done')).trainWindow).toEqual({
      start: '06:00',
      end: '08:22',
      moreLater: true,
    })
    expect(parseBooking(loadOmioFixture('get-search-extended')).trainWindow?.end).toBe('11:54')
  })

  it('raises a schema error when the train window is not a pair of HH:MM times', () => {
    const body = loadOmioFixture('get-search-done')
    body.data.GetSearchWithoutQuotes.booking.extensionOptions[0].currentIntervals.outbound[0].end =
      '2027-01-30T08:22:00'
    expect(() => parseBooking(body)).toThrow(OmioSchemaError)
    expect(() => parseBooking(body)).toThrow(/outbound\[0\]\.end/)
  })

  it('sums railcard discounts', () => {
    const journeys = parseBooking(loadOmioFixture('get-search-done-railcard')).journeys
    expect(journeys[0]).toMatchObject({ pricePence: 3330, railcardDiscountPence: 1680 })
  })

  it('parses nested split journeys with the same rules', () => {
    const body = loadOmioFixture('get-search-done')
    const journeys = body.data.GetSearchWithoutQuotes.booking.journeys
    journeys[3].splitJourneys = [structuredClone(journeys[2]), structuredClone(journeys[4])]
    const direct = parseBooking(body).journeys[3]
    expect(direct?.splitJourneys.map((j) => j.pricePence)).toEqual([5010, 2750])
  })

  it('treats a zero price as unknown', () => {
    const body = loadOmioFixture('get-search-done')
    body.data.GetSearchWithoutQuotes.booking.journeys[3].cheapestPriceCents = 0
    expect(parseBooking(body).journeys[3]?.pricePence).toBeNull()
  })

  it('raises a schema error naming the path when journeys disappear', () => {
    const body = loadOmioFixture('get-search-done')
    delete body.data.GetSearchWithoutQuotes.booking.journeys
    expect(() => parseBooking(body)).toThrow(OmioSchemaError)
    expect(() => parseBooking(body)).toThrow(/booking\.journeys is not a list/)
  })

  it('raises a schema error when a timestamp changes format', () => {
    const body = loadOmioFixture('get-search-done')
    body.data.GetSearchWithoutQuotes.booking.journeys[0].departure.departureTime.timestamp =
      '2027-01-30T01:45:00Z'
    expect(() => parseBooking(body)).toThrow(/departureTime\.timestamp/)
  })

  it('raises a schema error when the operation is missing', () => {
    expect(() => parseBooking({ data: {} })).toThrow(OmioSchemaError)
  })

  it('reports a failed search as a plain error, not a schema change', () => {
    const body = loadOmioFixture('get-search-running')
    body.data.GetSearchWithoutQuotes.booking.status = 'SEARCH_STATUS_FAILED'
    expect(() => parseBooking(body)).toThrow('Uber Travel search ended with status SEARCH_STATUS_FAILED')
    expect(() => parseBooking(body)).not.toThrow(OmioSchemaError)
  })
})
