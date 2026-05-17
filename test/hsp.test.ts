import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { HspClient, createHspClient } from '../src/hsp.js'
import type { HspServiceMetricsResponse } from '../src/types.js'

function buildMockResponse(
  overrides?: Partial<HspServiceMetricsResponse>
): HspServiceMetricsResponse {
  return {
    header: {
      from_location: 'MAN',
      to_location: 'LDS',
    },
    Services: [
      {
        serviceAttributesMetrics: {
          origin_location: 'MAN',
          destination_location: 'LDS',
          gbtt_ptd: '0700',
          gbtt_pta: '0745',
          toc_code: 'TP',
          matched_services: '100',
          rids: ['rid1', 'rid2'],
        },
        Metrics: [
          {
            tolerance_value: '-1',
            num_not_tolerance: '97',
            num_tolerance: '3',
            percent_tolerance: '3',
            global_tolerance: false,
          },
          {
            tolerance_value: '0',
            num_not_tolerance: '30',
            num_tolerance: '70',
            percent_tolerance: '70',
            global_tolerance: false,
          },
          {
            tolerance_value: '5',
            num_not_tolerance: '10',
            num_tolerance: '90',
            percent_tolerance: '90',
            global_tolerance: false,
          },
          {
            tolerance_value: '10',
            num_not_tolerance: '5',
            num_tolerance: '95',
            percent_tolerance: '95',
            global_tolerance: false,
          },
        ],
      },
    ],
    ...overrides,
  }
}

function mockFetchSuccess(data: HspServiceMetricsResponse): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(data),
    })
  )
}

const TEST_CREDENTIALS = {
  username: 'testuser',
  password: 'testpass',
}

describe('HspClient', () => {
  beforeEach(() => {
    vi.stubEnv('OPENRAIL_USERNAME', 'envuser')
    vi.stubEnv('OPENRAIL_PASSWORD', 'envpass')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  describe('constructor and createHspClient', () => {
    it('creates client with explicit credentials', () => {
      const client = new HspClient(TEST_CREDENTIALS)
      expect(client).toBeInstanceOf(HspClient)
    })

    it('creates client from env vars via factory', () => {
      const client = createHspClient()
      expect(client).toBeInstanceOf(HspClient)
    })

    it('throws when OPENRAIL_USERNAME is missing', () => {
      vi.stubEnv('OPENRAIL_USERNAME', '')
      expect(() => createHspClient()).toThrow(
        'OPENRAIL_USERNAME environment variable is not set'
      )
    })

    it('throws when OPENRAIL_PASSWORD is missing', () => {
      vi.stubEnv('OPENRAIL_PASSWORD', '')
      expect(() => createHspClient()).toThrow(
        'OPENRAIL_PASSWORD environment variable is not set'
      )
    })
  })

  describe('getDelayHistory', () => {
    it('returns aggregated metrics for a valid response', async () => {
      const mockData = buildMockResponse()
      mockFetchSuccess(mockData)

      const client = new HspClient(TEST_CREDENTIALS)
      const result = await client.getDelayHistory('MAN', 'LDS')

      expect(result.fromStation).toBe('MAN')
      expect(result.toStation).toBe('LDS')
      expect(result.totalTrains).toBe(100)
      expect(result.onTimePercentage).toBe(70)
      expect(result.cancelledPercentage).toBe(3)
      expect(result.latePercentage).toBe(27)
      expect(result.toleranceData).toHaveLength(4)
    })

    it('sends correct request to HSP API', async () => {
      const mockData = buildMockResponse()
      mockFetchSuccess(mockData)

      const client = new HspClient(TEST_CREDENTIALS)
      await client.getDelayHistory('man', 'lds', 7)

      const fetchCall = vi.mocked(fetch).mock.calls[0]
      expect(fetchCall[0]).toBe(
        'https://hsp-prod.rockshore.net/api/v1/serviceMetrics'
      )

      const options = fetchCall[1] as RequestInit
      expect(options.method).toBe('POST')
      expect(
        (options.headers as Record<string, string>)['Content-Type']
      ).toBe('application/json')

      const expectedAuth = `Basic ${Buffer.from('testuser:testpass').toString('base64')}`
      expect(
        (options.headers as Record<string, string>).Authorization
      ).toBe(expectedAuth)

      const body = JSON.parse(options.body as string)
      expect(body.from_loc).toBe('MAN')
      expect(body.to_loc).toBe('LDS')
      expect(body.from_time).toBe('0600')
      expect(body.to_time).toBe('2200')
      expect(body.days).toBe('WEEKDAY')
    })

    it('calculates average delay from tolerance bands', async () => {
      const mockData = buildMockResponse()
      mockFetchSuccess(mockData)

      const client = new HspClient(TEST_CREDENTIALS)
      const result = await client.getDelayHistory('MAN', 'LDS')

      // weighted avg: (0*70 + 5*90 + 10*95) / 100 = (0+450+950)/100 = 14
      // But that uses num_tolerance which is cumulative-style
      // Our code sums: tolerance_minutes * num_tolerance for non-negative bands
      // 0*70 + 5*90 + 10*95 = 0 + 450 + 950 = 1400 / 100 = 14
      expect(result.averageDelayMinutes).toBe(14)
    })

    it('returns empty metrics when no services found', async () => {
      const mockData: HspServiceMetricsResponse = {
        header: { from_location: 'MAN', to_location: 'LDS' },
        Services: [],
      }
      mockFetchSuccess(mockData)

      const client = new HspClient(TEST_CREDENTIALS)
      const result = await client.getDelayHistory('MAN', 'LDS')

      expect(result.totalTrains).toBe(0)
      expect(result.onTimePercentage).toBe(0)
      expect(result.latePercentage).toBe(0)
      expect(result.cancelledPercentage).toBe(0)
      expect(result.averageDelayMinutes).toBe(0)
      expect(result.toleranceData).toEqual([])
    })

    it('aggregates across multiple services', async () => {
      const mockData: HspServiceMetricsResponse = {
        header: { from_location: 'MAN', to_location: 'LDS' },
        Services: [
          {
            serviceAttributesMetrics: {
              origin_location: 'MAN',
              destination_location: 'LDS',
              gbtt_ptd: '0700',
              gbtt_pta: '0745',
              toc_code: 'TP',
              matched_services: '50',
              rids: ['rid1'],
            },
            Metrics: [
              {
                tolerance_value: '0',
                num_not_tolerance: '10',
                num_tolerance: '40',
                percent_tolerance: '80',
                global_tolerance: false,
              },
            ],
          },
          {
            serviceAttributesMetrics: {
              origin_location: 'MAN',
              destination_location: 'LDS',
              gbtt_ptd: '0800',
              gbtt_pta: '0845',
              toc_code: 'TP',
              matched_services: '50',
              rids: ['rid2'],
            },
            Metrics: [
              {
                tolerance_value: '0',
                num_not_tolerance: '20',
                num_tolerance: '30',
                percent_tolerance: '60',
                global_tolerance: false,
              },
            ],
          },
        ],
      }
      mockFetchSuccess(mockData)

      const client = new HspClient(TEST_CREDENTIALS)
      const result = await client.getDelayHistory('MAN', 'LDS')

      expect(result.totalTrains).toBe(100)
      // on time: (40 + 30) / 100 = 70%
      expect(result.onTimePercentage).toBe(70)
      expect(result.toleranceData).toHaveLength(1)
      expect(result.toleranceData[0].numServices).toBe(70)
    })

    it('throws on HTTP error response', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 401,
          statusText: 'Unauthorized',
        })
      )

      const client = new HspClient(TEST_CREDENTIALS)
      await expect(
        client.getDelayHistory('MAN', 'LDS')
      ).rejects.toThrow('HSP API request failed: 401 Unauthorized')
    })

    it('throws when fromCrs is empty', async () => {
      const client = new HspClient(TEST_CREDENTIALS)
      await expect(
        client.getDelayHistory('', 'LDS')
      ).rejects.toThrow(
        'Both fromCrs and toCrs station codes are required'
      )
    })

    it('throws when toCrs is empty', async () => {
      const client = new HspClient(TEST_CREDENTIALS)
      await expect(
        client.getDelayHistory('MAN', '')
      ).rejects.toThrow(
        'Both fromCrs and toCrs station codes are required'
      )
    })

    it('throws when days is out of range', async () => {
      const client = new HspClient(TEST_CREDENTIALS)
      await expect(
        client.getDelayHistory('MAN', 'LDS', 0)
      ).rejects.toThrow('days must be between 1 and 365')
      await expect(
        client.getDelayHistory('MAN', 'LDS', 400)
      ).rejects.toThrow('days must be between 1 and 365')
    })

    it('defaults to 28 days when not specified', async () => {
      const mockData = buildMockResponse()
      mockFetchSuccess(mockData)

      const client = new HspClient(TEST_CREDENTIALS)
      await client.getDelayHistory('MAN', 'LDS')

      const body = JSON.parse(
        (vi.mocked(fetch).mock.calls[0][1] as RequestInit)
          .body as string
      )

      const fromDate = new Date(body.from_date)
      const toDate = new Date(body.to_date)
      const diffMs = toDate.getTime() - fromDate.getTime()
      const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24))

      expect(diffDays).toBe(28)
    })

    it('sorts tolerance bands by tolerance minutes', async () => {
      const mockData = buildMockResponse()
      mockFetchSuccess(mockData)

      const client = new HspClient(TEST_CREDENTIALS)
      const result = await client.getDelayHistory('MAN', 'LDS')

      for (let i = 1; i < result.toleranceData.length; i++) {
        expect(
          result.toleranceData[i].toleranceMinutes
        ).toBeGreaterThanOrEqual(
          result.toleranceData[i - 1].toleranceMinutes
        )
      }
    })
  })
})
