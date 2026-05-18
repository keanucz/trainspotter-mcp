import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { FaresClient, createFaresClient } from '../src/fares.js'
import type { FaresResponse, RailcardInfo, FareLocationInfo } from '../src/types.js'

const BRFARES_BASE_URL = 'https://api1.raildata.org.uk/1080-easy-fares-api-v1'

function buildMockFaresResponse(): FaresResponse {
  return {
    orig: {
      nlc: '2968',
      crs: 'MAN',
      code: 'MAN',
      name: 'Manchester Piccadilly',
      ticketname: 'MANCHESTER PIC',
    },
    dest: {
      nlc: '8487',
      crs: 'LDS',
      code: 'LDS',
      name: 'Leeds',
      ticketname: 'LEEDS',
    },
    railcards: [
      { code: 'YNG', name: '16-25 Railcard' },
    ],
    walkup: [
      {
        type: 'RETURN',
        orig: {
          nlc: '2968',
          crs: 'MAN',
          code: 'MAN',
          name: 'Manchester Piccadilly',
        },
        dest: {
          nlc: '8487',
          crs: 'LDS',
          code: 'LDS',
          name: 'Leeds',
        },
        route: {
          code: '00000',
          name: 'Travel is allowed via any permitted route.',
        },
        cross_london: false,
        ticket: {
          code: 'SOR',
          tclass: 2,
          name: 'Anytime Return',
        },
        restriction: {
          code: '  ',
          desc: '',
          out: 'Unrestricted',
          rtn: 'Unrestricted',
        },
        fare_setter: {
          code: 'TPE',
          name: 'TRANSPENNINE EXPRESS',
        },
        discount_groups: [
          {
            railcard: { code: '   ', name: 'PUBLIC' },
            adult: { status_code: '000', price: 9100 },
            child: { status_code: '001', price: 4550 },
          },
        ],
      },
    ],
    payg: [],
    restricted: [],
    unavailable: [],
  }
}

function buildMockRailcardsResponse(): { railcards: RailcardInfo[] } {
  return {
    railcards: [
      {
        code: 'YNG',
        name: '16-25 Railcard',
        online_display: true,
        unattended_retail: true,
      },
      {
        code: 'SRN',
        name: 'Senior Railcard',
        online_display: true,
        unattended_retail: true,
      },
    ],
  }
}

function buildMockLocationsResponse(): { locations: FareLocationInfo[] } {
  return {
    locations: [
      {
        nlc: '2968',
        crs: 'MAN',
        code: 'MAN',
        name: 'Manchester Piccadilly',
        orig: true,
        dest: true,
      },
      {
        nlc: '8487',
        crs: 'LDS',
        code: 'LDS',
        name: 'Leeds',
        orig: true,
        dest: false,
      },
    ],
  }
}

function mockFetchJson(data: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(data),
    })
  )
}

function mockFetchError(status: number, statusText: string, body?: string): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: false,
      status,
      statusText,
      text: () => Promise.resolve(body ?? statusText),
    })
  )
}

const TEST_API_KEY = 'test-brfares-api-key-123'

describe('FaresClient', () => {
  beforeEach(() => {
    vi.stubEnv('BRFARES_API_KEY', TEST_API_KEY)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  describe('constructor and createFaresClient', () => {
    it('creates client with explicit API key', () => {
      const client = new FaresClient('my-key')
      expect(client).toBeInstanceOf(FaresClient)
    })

    it('creates client from env var via factory', () => {
      const client = createFaresClient()
      expect(client).toBeInstanceOf(FaresClient)
    })

    it('throws when BRFARES_API_KEY is missing', () => {
      vi.stubEnv('BRFARES_API_KEY', '')
      expect(() => createFaresClient()).toThrow(
        'BRFARES_API_KEY environment variable is required'
      )
    })

    it('throws when BRFARES_API_KEY is undefined', () => {
      vi.unstubAllEnvs()
      delete process.env['BRFARES_API_KEY']
      expect(() => createFaresClient()).toThrow(
        'BRFARES_API_KEY environment variable is required'
      )
    })
  })

  describe('searchFares', () => {
    it('returns typed fare response for valid stations', async () => {
      const mockData = buildMockFaresResponse()
      mockFetchJson(mockData)

      const client = new FaresClient(TEST_API_KEY)
      const result = await client.searchFares('MAN', 'LDS')

      expect(result.orig.crs).toBe('MAN')
      expect(result.orig.name).toBe('Manchester Piccadilly')
      expect(result.dest.crs).toBe('LDS')
      expect(result.dest.name).toBe('Leeds')
      expect(result.walkup).toHaveLength(1)
      expect(result.payg).toEqual([])
      expect(result.restricted).toEqual([])
      expect(result.unavailable).toEqual([])
    })

    it('sends correct URL with required params', async () => {
      mockFetchJson(buildMockFaresResponse())

      const client = new FaresClient(TEST_API_KEY)
      await client.searchFares('MAN', 'LDS')

      const fetchCall = vi.mocked(fetch).mock.calls[0]
      const url = fetchCall[0] as string
      expect(url).toContain(`${BRFARES_BASE_URL}/easy_fares`)
      expect(url).toContain('orig=MAN')
      expect(url).toContain('dest=LDS')
    })

    it('sends x-apikey header', async () => {
      mockFetchJson(buildMockFaresResponse())

      const client = new FaresClient(TEST_API_KEY)
      await client.searchFares('MAN', 'LDS')

      const fetchCall = vi.mocked(fetch).mock.calls[0]
      const options = fetchCall[1] as RequestInit
      expect(
        (options.headers as Record<string, string>)['x-apikey']
      ).toBe(TEST_API_KEY)
    })

    it('uppercases station codes', async () => {
      mockFetchJson(buildMockFaresResponse())

      const client = new FaresClient(TEST_API_KEY)
      await client.searchFares('man', 'lds')

      const fetchCall = vi.mocked(fetch).mock.calls[0]
      const url = fetchCall[0] as string
      expect(url).toContain('orig=MAN')
      expect(url).toContain('dest=LDS')
    })

    it('includes railcard params when provided', async () => {
      mockFetchJson(buildMockFaresResponse())

      const client = new FaresClient(TEST_API_KEY)
      await client.searchFares('MAN', 'LDS', ['YNG', 'SRN'])

      const fetchCall = vi.mocked(fetch).mock.calls[0]
      const url = fetchCall[0] as string
      expect(url).toContain('rlc=YNG%2CSRN')
    })

    it('includes date param when provided', async () => {
      mockFetchJson(buildMockFaresResponse())

      const client = new FaresClient(TEST_API_KEY)
      await client.searchFares('MAN', 'LDS', undefined, '20260601')

      const fetchCall = vi.mocked(fetch).mock.calls[0]
      const url = fetchCall[0] as string
      expect(url).toContain('date=20260601')
    })

    it('omits optional params when not provided', async () => {
      mockFetchJson(buildMockFaresResponse())

      const client = new FaresClient(TEST_API_KEY)
      await client.searchFares('MAN', 'LDS')

      const fetchCall = vi.mocked(fetch).mock.calls[0]
      const url = fetchCall[0] as string
      expect(url).not.toContain('rlc=')
      expect(url).not.toContain('date=')
    })

    it('preserves prices in pence as integers', async () => {
      mockFetchJson(buildMockFaresResponse())

      const client = new FaresClient(TEST_API_KEY)
      const result = await client.searchFares('MAN', 'LDS')

      const fare = result.walkup[0]
      const publicGroup = fare.discount_groups[0]
      expect(publicGroup.adult?.price).toBe(9100)
      expect(publicGroup.child?.price).toBe(4550)
    })

    it('throws on HTTP error', async () => {
      mockFetchError(403, 'Forbidden', 'Invalid API key')

      const client = new FaresClient(TEST_API_KEY)
      await expect(
        client.searchFares('MAN', 'LDS')
      ).rejects.toThrow('BR Fares API request failed (403)')
    })

    it('throws when orig is empty', async () => {
      const client = new FaresClient(TEST_API_KEY)
      await expect(
        client.searchFares('', 'LDS')
      ).rejects.toThrow('orig station code is required')
    })

    it('throws when dest is empty', async () => {
      const client = new FaresClient(TEST_API_KEY)
      await expect(
        client.searchFares('MAN', '')
      ).rejects.toThrow('dest station code is required')
    })

    it('detects invalid station when API returns empty orig', async () => {
      const mockData = {
        ...buildMockFaresResponse(),
        orig: {},
      }
      mockFetchJson(mockData)

      const client = new FaresClient(TEST_API_KEY)
      await expect(
        client.searchFares('ZZZ', 'LDS')
      ).rejects.toThrow('Invalid origin station code')
    })

    it('detects invalid station when API returns empty dest', async () => {
      const mockData = {
        ...buildMockFaresResponse(),
        dest: {},
      }
      mockFetchJson(mockData)

      const client = new FaresClient(TEST_API_KEY)
      await expect(
        client.searchFares('MAN', 'ZZZ')
      ).rejects.toThrow('Invalid destination station code')
    })

    it('limits railcards to max 3', async () => {
      const client = new FaresClient(TEST_API_KEY)
      await expect(
        client.searchFares('MAN', 'LDS', ['YNG', 'SRN', 'NEW', 'FAM'])
      ).rejects.toThrow('Maximum 3 railcards allowed')
    })

    it('handles restricted fare groups', async () => {
      const mockData: FaresResponse = {
        ...buildMockFaresResponse(),
        restricted: [
          {
            type: 'SINGLE',
            orig: { nlc: '2968', crs: 'MAN', code: 'MAN', name: 'Manchester Piccadilly' },
            dest: { nlc: '8487', crs: 'LDS', code: 'LDS', name: 'Leeds' },
            route: { code: '00452', name: 'AWC only' },
            cross_london: false,
            restriction: { code: 'VR', desc: 'AWC ADVANCE', out: 'VALID ON DATE SHOWN', rtn: '' },
            fare_setter: { code: 'IWC', name: 'AVANTI WEST COAST' },
            tclass: 2,
            min_price: 4150,
            max_price: 10280,
            fares: [
              {
                ticket: { code: 'V2B', tclass: 2, name: 'Advance Single' },
                discount_groups: [
                  {
                    railcard: { code: '   ', name: 'PUBLIC' },
                    adult: { status_code: '000', price: 10280 },
                    child: { status_code: '001', price: 5140 },
                  },
                ],
              },
            ],
          },
        ],
      }
      mockFetchJson(mockData)

      const client = new FaresClient(TEST_API_KEY)
      const result = await client.searchFares('MAN', 'LDS')

      expect(result.restricted).toHaveLength(1)
      const group = result.restricted[0]
      expect(group.tclass).toBe(2)
      expect(group.min_price).toBe(4150)
      expect(group.max_price).toBe(10280)
      expect(group.fares).toHaveLength(1)
      expect(group.fares![0].ticket.code).toBe('V2B')
    })

    it('uses GET method', async () => {
      mockFetchJson(buildMockFaresResponse())

      const client = new FaresClient(TEST_API_KEY)
      await client.searchFares('MAN', 'LDS')

      const fetchCall = vi.mocked(fetch).mock.calls[0]
      const options = fetchCall[1] as RequestInit
      expect(options.method).toBe('GET')
    })
  })

  describe('listRailcards', () => {
    it('returns list of railcards', async () => {
      mockFetchJson(buildMockRailcardsResponse())

      const client = new FaresClient(TEST_API_KEY)
      const result = await client.listRailcards()

      expect(result).toHaveLength(2)
      expect(result[0].code).toBe('YNG')
      expect(result[0].name).toBe('16-25 Railcard')
      expect(result[1].code).toBe('SRN')
      expect(result[1].name).toBe('Senior Railcard')
    })

    it('sends correct URL', async () => {
      mockFetchJson(buildMockRailcardsResponse())

      const client = new FaresClient(TEST_API_KEY)
      await client.listRailcards()

      const fetchCall = vi.mocked(fetch).mock.calls[0]
      const url = fetchCall[0] as string
      expect(url).toBe(`${BRFARES_BASE_URL}/easy_railcards`)
    })

    it('sends x-apikey header', async () => {
      mockFetchJson(buildMockRailcardsResponse())

      const client = new FaresClient(TEST_API_KEY)
      await client.listRailcards()

      const fetchCall = vi.mocked(fetch).mock.calls[0]
      const options = fetchCall[1] as RequestInit
      expect(
        (options.headers as Record<string, string>)['x-apikey']
      ).toBe(TEST_API_KEY)
    })

    it('throws on HTTP error', async () => {
      mockFetchError(500, 'Internal Server Error')

      const client = new FaresClient(TEST_API_KEY)
      await expect(client.listRailcards()).rejects.toThrow(
        'BR Fares API request failed (500)'
      )
    })
  })

  describe('listLocations', () => {
    it('returns list of fare locations', async () => {
      mockFetchJson(buildMockLocationsResponse())

      const client = new FaresClient(TEST_API_KEY)
      const result = await client.listLocations()

      expect(result).toHaveLength(2)
      expect(result[0].crs).toBe('MAN')
      expect(result[0].name).toBe('Manchester Piccadilly')
      expect(result[0].orig).toBe(true)
      expect(result[0].dest).toBe(true)
      expect(result[1].crs).toBe('LDS')
      expect(result[1].dest).toBe(false)
    })

    it('sends correct URL', async () => {
      mockFetchJson(buildMockLocationsResponse())

      const client = new FaresClient(TEST_API_KEY)
      await client.listLocations()

      const fetchCall = vi.mocked(fetch).mock.calls[0]
      const url = fetchCall[0] as string
      expect(url).toBe(`${BRFARES_BASE_URL}/easy_locations`)
    })

    it('sends x-apikey header', async () => {
      mockFetchJson(buildMockLocationsResponse())

      const client = new FaresClient(TEST_API_KEY)
      await client.listLocations()

      const fetchCall = vi.mocked(fetch).mock.calls[0]
      const options = fetchCall[1] as RequestInit
      expect(
        (options.headers as Record<string, string>)['x-apikey']
      ).toBe(TEST_API_KEY)
    })

    it('throws on HTTP error', async () => {
      mockFetchError(401, 'Unauthorized')

      const client = new FaresClient(TEST_API_KEY)
      await expect(client.listLocations()).rejects.toThrow(
        'BR Fares API request failed (401)'
      )
    })
  })
})
