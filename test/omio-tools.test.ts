import { describe, it, expect } from 'vitest'
import { OmioClient, type OmioFareResult } from '../src/omio.js'
import { parseLocations } from '../src/omio-parse.js'
import { formatOmioFares, formatOmioLocations } from '../src/omio-format.js'
import { handleOmioTool, isOmioTool, omioTools } from '../src/omio-tools.js'
import { loadOmioFixture } from './omio-fixtures.js'

/** A client whose every search returns the finished-search fixture. */
function fixtureClient(overrides: Record<string, unknown> = {}): OmioClient {
  const replies: Record<string, unknown> = {
    SearchJourneys: loadOmioFixture('search-journeys-start'),
    GetSearchWithoutQuotes: loadOmioFixture('get-search-done'),
    ExtendSearchWithoutQuotes: loadOmioFixture('extend-search-running'),
    ...overrides,
  }
  const fetchFn = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body))
    if (body.operationName === 'SearchLocation') {
      const name: string = body.variables.request.name
      const fixture =
        name === 'London Euston'
          ? 'search-location-euston'
          : name === 'Liverpool South Parkway'
            ? 'search-location-station'
            : name === 'Liverpool'
              ? 'search-location-city'
              : 'search-location-empty'
      return new Response(JSON.stringify(loadOmioFixture(fixture)))
    }
    const reply = replies[body.operationName]
    return reply instanceof Response ? reply : new Response(JSON.stringify(reply))
  }
  return new OmioClient({ fetchFn, sleep: async () => undefined, now: () => 0 })
}

async function searchFixture(time = '06:00'): Promise<OmioFareResult> {
  return fixtureClient().searchFares({ from: 'LPY', to: 'EUS', date: '2027-01-30', time })
}

function textOf(result: Awaited<ReturnType<typeof handleOmioTool>>): string {
  const first = result.content[0]
  return first && first.type === 'text' ? first.text : ''
}

describe('formatOmioFares', () => {
  it('writes a header naming the resolved places, date and start time', async () => {
    const text = formatOmioFares(await searchFixture('06:30'))
    expect(text.split('\n')[0]).toBe(
      'Uber Travel (Omio) prices: Liverpool South Parkway → London Euston, Sat 30 Jan 2027 from 06:30',
    )
  })

  it('writes one compact row per journey', async () => {
    const text = formatOmioFares(await searchFixture('06:30'))
    expect(text).toContain(
      '06:54→09:04 | Liverpool South Parkway → London Euston | direct | Avanti West Coast | train | £26.00',
    )
  })

  it('names the change station, every operator and the split saving', async () => {
    const text = formatOmioFares(await searchFixture())
    expect(text).toContain(
      '06:19→08:35 | Liverpool South Parkway → London Euston | 1 change at Stafford | West Midlands Trains + Avanti West Coast | train | £50.10 | split ticket, saves £29.70',
    )
  })

  it('does not advertise a split ticket that saves nothing', async () => {
    const body = loadOmioFixture('get-search-done')
    body.data.GetSearchWithoutQuotes.booking.journeys[3].departure.split = { savingCents: 0 }
    const result = await fixtureClient({ GetSearchWithoutQuotes: body }).searchFares({
      from: 'LPY',
      to: 'EUS',
      date: '2027-01-30',
      time: '06:30',
    })
    const row = formatOmioFares(result)
      .split('\n')
      .find((line) => line.startsWith('06:54'))
    expect(row).toBe('06:54→09:04 | Liverpool South Parkway → London Euston | direct | Avanti West Coast | train | £26.00')
  })

  it('marks arrivals on a later day', async () => {
    const text = formatOmioFares(await searchFixture())
    expect(text).toContain('19:30→06:30+1 | Liverpool, One Bus Station, Canning Place → London, Victoria Coach Station')
  })

  it('marks departures that fall on the day after the one searched', async () => {
    const body = loadOmioFixture('get-search-done')
    const overnight = body.data.GetSearchWithoutQuotes.booking.journeys[3].departure
    for (const leg of [overnight, overnight.segments[0]]) {
      leg.departureTime.timestamp = '2027-01-31T00:20:00'
      leg.arrivalTime.timestamp = '2027-01-31T02:30:00'
    }
    const result = await fixtureClient({ GetSearchWithoutQuotes: body }).searchFares({
      from: 'LPY',
      to: 'EUS',
      date: '2027-01-30',
    })
    expect(formatOmioFares(result)).toContain('00:20+1→02:30+1 | Liverpool South Parkway → London Euston')
  })

  it('reports the train window and how to see later trains', async () => {
    const text = formatOmioFares(await searchFixture())
    expect(text).toMatch(/Trains cover departures 06:00-08:22\..*later time/)
  })

  it('points at the hours option for later trains', async () => {
    const text = formatOmioFares(await searchFixture())
    expect(text).toMatch(/later time or a larger hours value/)
  })

  it('says when no trains came back at all instead of blaming the booking horizon alone', async () => {
    const body = loadOmioFixture('get-search-done')
    body.data.GetSearchWithoutQuotes.booking.extensionOptions = []
    const result = await fixtureClient({ GetSearchWithoutQuotes: body }).searchFares({
      from: 'LPY',
      to: 'EUS',
      date: '2027-01-30',
      time: '20:30',
    })
    expect(formatOmioFares(result)).toMatch(/No trains were returned from 20:30: there may be none left that day/)
  })

  it('names the cheapest journey', async () => {
    const text = formatOmioFares(await searchFixture('06:30'))
    expect(text).toContain('Cheapest: £26.00 (06:54 train, Avanti West Coast)')
  })

  it('always says these are list prices from an undocumented source', async () => {
    const text = formatOmioFares(await searchFixture())
    expect(text).toMatch(/list prices/i)
    expect(text).toMatch(/not a booking/i)
  })

  it('shows the railcard and its discount', async () => {
    const client = fixtureClient({ GetSearchWithoutQuotes: loadOmioFixture('get-search-done-railcard') })
    const result = await client.searchFares({ from: 'LPY', to: 'EUS', date: '2027-01-30', railcards: ['YNG'] })
    const text = formatOmioFares(result)
    expect(text).toContain('Railcard: YNG (16-25 Railcard)')
    expect(text).toContain('£33.30 | split ticket, saves £19.80 | railcard saves £16.80')
  })

  it('lists the tickets of a split journey when the API provides them', async () => {
    const body = loadOmioFixture('get-search-done')
    const journeys = body.data.GetSearchWithoutQuotes.booking.journeys
    journeys[3].splitJourneys = [structuredClone(journeys[2]), structuredClone(journeys[4])]
    const result = await fixtureClient({ GetSearchWithoutQuotes: body }).searchFares({
      from: 'LPY',
      to: 'EUS',
      date: '2027-01-30',
      time: '06:30',
    })
    expect(formatOmioFares(result)).toContain(
      'tickets: Liverpool South Parkway → London Euston £50.10 + Liverpool South Parkway → London Euston £27.50',
    )
  })

  it('keeps only direct journeys when asked', async () => {
    const text = formatOmioFares(await searchFixture(), { directOnly: true })
    expect(text).toContain('06:54→09:04')
    expect(text).not.toContain('1 change')
    expect(text).toContain('Direct journeys only')
  })

  it('explains an empty result', async () => {
    const text = formatOmioFares(await searchFixture('23:00'))
    expect(text).toContain('No journeys found')
  })

  it('carries notes about incomplete searches', async () => {
    const result = { ...(await searchFixture()), complete: false, notes: ['Could not load later trains: boom'] }
    expect(formatOmioFares(result)).toContain('Note: Could not load later trains: boom')
  })
})

describe('formatOmioLocations', () => {
  it('lists id, type and country for each match', () => {
    const text = formatOmioLocations('Liverpool', parseLocations(loadOmioFixture('search-location-city')))
    expect(text).toContain('Liverpool South Parkway | station | GB | id 319585')
    expect(text).toContain('Liverpool | location | GB | id 380540')
  })

  it('says when nothing matched', () => {
    expect(formatOmioLocations('Atlantis', [])).toContain('No Uber Travel locations match "Atlantis"')
  })
})

describe('omio tools', () => {
  it('defines search_omio_fares and omio_locations', () => {
    expect(omioTools.map((tool) => tool.name)).toEqual(['search_omio_fares', 'omio_locations'])
    expect(isOmioTool('search_omio_fares')).toBe(true)
    expect(isOmioTool('search_fares')).toBe(false)
  })

  it('warns in the description that the API is unofficial and prices are not bookings', () => {
    const description = omioTools[0]?.description ?? ''
    expect(description).toMatch(/undocumented/i)
    expect(description).toMatch(/not a booking/i)
  })

  it('runs a fare search end to end', async () => {
    const result = await handleOmioTool(
      'search_omio_fares',
      { from: 'LPY', to: 'EUS', date: '2027-01-30', time: '06:30', direct_only: true },
      fixtureClient(),
    )
    expect(result.isError).toBeUndefined()
    expect(textOf(result)).toContain('06:54→09:04')
    expect(textOf(result)).not.toContain('07:03')
  })

  it('offers an hours argument and passes it to the search', async () => {
    const properties = omioTools[0]?.inputSchema.properties as Record<string, unknown>
    expect(properties).toHaveProperty('hours')

    const calls: string[] = []
    const client = fixtureClient()
    const search = client.searchFares.bind(client)
    client.searchFares = async (query) => {
      calls.push(JSON.stringify(query.hours))
      return search(query)
    }
    await handleOmioTool('search_omio_fares', { from: 'LPY', to: 'EUS', date: '2027-01-30', hours: 2 }, client)
    expect(calls).toEqual(['2'])
  })

  it('runs a location search', async () => {
    const result = await handleOmioTool('omio_locations', { query: 'Liverpool' }, fixtureClient())
    expect(textOf(result)).toContain('Liverpool Lime Street | station')
  })

  it('returns an error result for bad arguments instead of throwing', async () => {
    const result = await handleOmioTool('search_omio_fares', { from: 'LPY', to: 'EUS' }, fixtureClient())
    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(/date/)
  })

  it('rejects arguments of the wrong type', async () => {
    const client = fixtureClient()
    const cases: Array<Record<string, unknown>> = [
      { from: 1, to: 'EUS', date: '2027-01-30' },
      { from: 'LPY', to: 'EUS', date: '2027-01-30', modes: 'train' },
      { from: 'LPY', to: 'EUS', date: '2027-01-30', railcards: [1] },
      { from: 'LPY', to: 'EUS', date: '2027-01-30', age: '30' },
      { from: 'LPY', to: 'EUS', date: '2027-01-30', direct_only: 'yes' },
      { from: 'LPY', to: 'EUS', date: '2027-01-30', hours: '6' },
      { from: 'LPY', to: 'EUS', date: '2027-01-30', hours: 24 },
    ]
    for (const args of cases) {
      const result = await handleOmioTool('search_omio_fares', args, client)
      expect(result.isError, JSON.stringify(args)).toBe(true)
    }
  })

  it('labels schema changes clearly', async () => {
    const client = fixtureClient({ GetSearchWithoutQuotes: { data: { GetSearchWithoutQuotes: {} } } })
    const result = await handleOmioTool('search_omio_fares', { from: 'LPY', to: 'EUS', date: '2027-01-30' }, client)
    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(/Uber Travel fare search error: .*undocumented API.*changed/)
  })
})
