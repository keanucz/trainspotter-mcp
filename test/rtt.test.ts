import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RttClient, createRttClient, formatRttDepartures, formatRttService } from '../src/rtt.js'

const RTT_BASE_URL = 'https://data.rtt.io'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function buildAccessToken(validUntil = '2099-01-01T00:00:00+00:00') {
  return { token: 'access-token', entitlements: [], validUntil }
}

function buildLineUp() {
  return {
    systemStatus: { realtimeNetworkRail: 'OK', rttCore: 'OK' },
    query: {
      location: { namespace: 'gb-nr', description: 'London Kings Cross', shortCodes: ['KGX'], longCodes: ['KNGX'] },
      timeFrom: '2026-11-06T19:00:00+00:00',
      timeTo: '2026-11-06T21:00:00+00:00',
      filterTo: { namespace: 'gb-nr', description: 'Edinburgh', shortCodes: ['EDB'], longCodes: ['EDINBUR'] },
    },
    services: [
      {
        temporalData: {
          departure: {
            scheduleInternal: '2026-11-06T19:30:00',
            scheduleAdvertised: '2026-11-06T19:30:00',
            isCancelled: false,
          },
          displayAs: 'CALL',
        },
        locationMetadata: { platform: { forecast: '7' } },
        scheduleMetadata: {
          uniqueIdentity: 'gb-nr:G80273:2026-11-06',
          identity: 'G80273',
          departureDate: '2026-11-06',
          operator: { code: 'GR', name: 'LNER' },
          inPassengerService: true,
        },
        origin: [{ location: { description: 'London Kings Cross', longCodes: ['KNGX'] } }],
        destination: [
          {
            location: { description: 'Edinburgh', longCodes: ['EDINBUR'] },
            temporalData: { scheduleAdvertised: '2026-11-06T23:39:00' },
          },
        ],
      },
      {
        temporalData: {
          departure: {
            scheduleAdvertised: '2026-11-06T20:00:00',
            realtimeForecast: '2026-11-06T20:07:00',
            isCancelled: true,
          },
          displayAs: 'CANCELLED',
        },
        locationMetadata: { platform: { planned: '3', actual: '1' } },
        scheduleMetadata: {
          uniqueIdentity: 'gb-nr:G80299:2026-11-06',
          identity: 'G80299',
          departureDate: '2026-11-06',
          operator: { code: 'GR', name: 'LNER' },
          inPassengerService: true,
        },
        origin: [{ location: { description: 'London Kings Cross', longCodes: ['KNGX'] } }],
        destination: [
          {
            location: { description: 'Aberdeen', longCodes: ['ABRDEEN'] },
            temporalData: { scheduleAdvertised: '2026-11-07T03:10:00' },
          },
        ],
      },
    ],
  }
}

function buildService() {
  return {
    service: {
      scheduleMetadata: {
        uniqueIdentity: 'gb-nr:G80273:2026-11-06',
        identity: 'G80273',
        departureDate: '2026-11-06',
        operator: { code: 'GR', name: 'LNER' },
      },
      locations: [
        {
          temporalData: {
            departure: { scheduleAdvertised: '2026-11-06T19:30:00', isCancelled: false },
            scheduledCallType: 'ADVERTISED_PICK_UP',
          },
          locationMetadata: { platform: { planned: '7' } },
          location: { description: 'London Kings Cross', shortCodes: ['KGX'], longCodes: ['KNGX'] },
        },
        {
          temporalData: {
            pass: { scheduleInternal: '2026-11-06T20:15:00' },
            scheduledCallType: 'PASS',
          },
          locationMetadata: {},
          location: { description: 'Peterborough', shortCodes: ['PBO'], longCodes: ['PBRO'] },
        },
        {
          temporalData: {
            arrival: { scheduleAdvertised: '2026-11-06T21:17:00', isCancelled: false },
            departure: { scheduleAdvertised: '2026-11-06T21:21:00', isCancelled: false },
            scheduledCallType: 'ADVERTISED_OPEN',
          },
          locationMetadata: { platform: { planned: '10' } },
          location: { description: 'York', shortCodes: ['YRK'], longCodes: ['YORK'] },
        },
        {
          temporalData: {
            arrival: { scheduleAdvertised: '2026-11-06T23:39:00', isCancelled: false },
            scheduledCallType: 'ADVERTISED_SET_DOWN',
          },
          locationMetadata: { platform: { planned: '2' } },
          location: { description: 'Edinburgh', shortCodes: ['EDB'], longCodes: ['EDINBUR'] },
        },
      ],
    },
  }
}

describe('RttClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env['RTT_API_TOKEN']
  })

  it('exchanges the refresh token once and reuses the access token', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(buildAccessToken()))
      .mockResolvedValueOnce(jsonResponse(buildLineUp()))
      .mockResolvedValueOnce(jsonResponse(buildLineUp()))

    const client = new RttClient('refresh-token')
    await client.getDepartures({ station: 'KGX', from: '2026-11-06T19:00:00' })
    await client.getDepartures({ station: 'KGX', from: '2026-11-06T19:00:00' })

    expect(fetchMock).toHaveBeenCalledTimes(3)
    const [tokenUrl, tokenInit] = fetchMock.mock.calls[0]
    expect(String(tokenUrl)).toBe(`${RTT_BASE_URL}/api/get_access_token`)
    expect(tokenInit.headers.Authorization).toBe('Bearer refresh-token')
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer access-token')
  })

  it('requests a new access token once the old one has expired', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(buildAccessToken('2000-01-01T00:00:00+00:00')))
      .mockResolvedValueOnce(jsonResponse(buildLineUp()))
      .mockResolvedValueOnce(jsonResponse(buildAccessToken()))
      .mockResolvedValueOnce(jsonResponse(buildLineUp()))

    const client = new RttClient('refresh-token')
    await client.getDepartures({ station: 'KGX' })
    await client.getDepartures({ station: 'KGX' })

    expect(String(fetchMock.mock.calls[2][0])).toBe(`${RTT_BASE_URL}/api/get_access_token`)
  })

  it('builds the location query with bare CRS codes and a time window', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(buildAccessToken()))
      .mockResolvedValueOnce(jsonResponse(buildLineUp()))

    const client = new RttClient('refresh-token')
    await client.getDepartures({
      station: 'kgx',
      destination: 'edb',
      from: '2026-11-06T19:00:00',
      to: '2026-11-06T21:00:00',
    })

    const url = new URL(String(fetchMock.mock.calls[1][0]))
    expect(url.origin + url.pathname).toBe(`${RTT_BASE_URL}/gb-nr/location`)
    expect(url.searchParams.get('code')).toBe('KGX')
    expect(url.searchParams.get('filterTo')).toBe('EDB')
    expect(url.searchParams.get('timeFrom')).toBe('2026-11-06T19:00:00')
    expect(url.searchParams.get('timeTo')).toBe('2026-11-06T21:00:00')
  })

  it('parses departures, platforms, cancellations and final destination times', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(buildAccessToken()))
      .mockResolvedValueOnce(jsonResponse(buildLineUp()))

    const client = new RttClient('refresh-token')
    const board = await client.getDepartures({ station: 'KGX', destination: 'EDB' })

    expect(board.locationName).toBe('London Kings Cross')
    expect(board.filterName).toBe('Edinburgh')
    expect(board.services).toHaveLength(2)
    expect(board.services[0]).toMatchObject({
      identity: 'G80273',
      departureDate: '2026-11-06',
      scheduled: '19:30',
      operator: 'LNER',
      platform: '7',
      destination: 'Edinburgh',
      destinationArrival: '23:39',
      isCancelled: false,
    })
    expect(board.services[1]).toMatchObject({
      scheduled: '20:00',
      expected: '20:07',
      platform: '1',
      destination: 'Aberdeen',
      isCancelled: true,
    })
  })

  it('returns an empty board on 204 (valid query, no services)', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(buildAccessToken()))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))

    const client = new RttClient('refresh-token')
    const board = await client.getDepartures({ station: 'KGX' })

    expect(board.services).toEqual([])
  })

  it('reports rate limiting with the retry delay', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(buildAccessToken()))
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '42' } }))

    const client = new RttClient('refresh-token')

    await expect(client.getDepartures({ station: 'KGX' })).rejects.toThrow(/rate limit.*42/i)
  })

  it('surfaces the API error message on a bad request', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(buildAccessToken()))
      .mockResolvedValueOnce(
        jsonResponse({ error: 'issue with one or more requested locations', errcode: 400 }, 400),
      )

    const client = new RttClient('refresh-token')

    await expect(client.getDepartures({ station: 'ZZZ' })).rejects.toThrow(
      /issue with one or more requested locations/,
    )
  })

  it('fetches a service and marks passing points as non-stops', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(buildAccessToken()))
      .mockResolvedValueOnce(jsonResponse(buildService()))

    const client = new RttClient('refresh-token')
    const service = await client.getService('G80273', '2026-11-06')

    const url = new URL(String(fetchMock.mock.calls[1][0]))
    expect(url.pathname).toBe('/gb-nr/service')
    expect(url.searchParams.get('identity')).toBe('G80273')
    expect(url.searchParams.get('departureDate')).toBe('2026-11-06')

    expect(service.operator).toBe('LNER')
    expect(service.calls.map((c) => c.crs)).toEqual(['KGX', 'PBO', 'YRK', 'EDB'])
    expect(service.calls[1].stops).toBe(false)
    expect(service.calls[2]).toMatchObject({ arrival: '21:17', departure: '21:21', platform: '10', stops: true })
    expect(service.calls[3]).toMatchObject({ arrival: '23:39', stops: true })
  })
})

describe('createRttClient', () => {
  afterEach(() => {
    delete process.env['RTT_API_TOKEN']
  })

  it('throws a clear error when RTT_API_TOKEN is missing', () => {
    delete process.env['RTT_API_TOKEN']
    expect(() => createRttClient()).toThrow(/RTT_API_TOKEN/)
  })

  it('creates a client when RTT_API_TOKEN is set', () => {
    process.env['RTT_API_TOKEN'] = 'refresh-token'
    expect(createRttClient()).toBeInstanceOf(RttClient)
  })
})

describe('formatters', () => {
  it('formats a departure board with arrival and credit line', () => {
    const text = formatRttDepartures({
      locationName: 'London Kings Cross',
      crs: 'KGX',
      filterName: 'Edinburgh',
      timeFrom: '2026-11-06T19:00:00+00:00',
      timeTo: '2026-11-06T21:00:00+00:00',
      services: [
        {
          identity: 'G80273',
          departureDate: '2026-11-06',
          scheduled: '19:30',
          operator: 'LNER',
          platform: '7',
          destination: 'Edinburgh',
          destinationArrival: '23:39',
          isCancelled: false,
        },
      ],
    })

    expect(text).toContain('London Kings Cross (KGX) → Edinburgh')
    expect(text).toContain('19:30 → Edinburgh (arr 23:39) | LNER | Plat 7 | G80273')
    expect(text).toContain('realtimetrains.co.uk')
  })

  it('formats a service and hides passing points', () => {
    const text = formatRttService({
      identity: 'G80273',
      departureDate: '2026-11-06',
      operator: 'LNER',
      calls: [
        { name: 'London Kings Cross', crs: 'KGX', departure: '19:30', platform: '7', stops: true, isCancelled: false },
        { name: 'Peterborough', crs: 'PBO', stops: false, isCancelled: false },
        { name: 'Edinburgh', crs: 'EDB', arrival: '23:39', stops: true, isCancelled: false },
      ],
    })

    expect(text).toContain('London Kings Cross (KGX)')
    expect(text).toContain('Edinburgh (EDB)')
    expect(text).not.toContain('Peterborough')
  })
})
