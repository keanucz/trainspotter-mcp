import type {
  HspMetrics,
  HspServiceMetricsResponse,
  ToleranceBand,
} from './types.js'

const HSP_BASE_URL = 'https://hsp-prod.rockshore.net/api/v1'
const DEFAULT_DAYS = 28
const DEFAULT_FROM_TIME = '0600'
const DEFAULT_TO_TIME = '2200'

interface HspCredentials {
  readonly username: string
  readonly password: string
}

function loadCredentials(): HspCredentials {
  const username = process.env.OPENRAIL_USERNAME
  const password = process.env.OPENRAIL_PASSWORD

  if (!username) {
    throw new Error(
      'OPENRAIL_USERNAME environment variable is not set'
    )
  }
  if (!password) {
    throw new Error(
      'OPENRAIL_PASSWORD environment variable is not set'
    )
  }

  return { username, password }
}

function formatDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function buildDateRange(days: number): {
  readonly fromDate: string
  readonly toDate: string
} {
  const toDate = new Date()
  const fromDate = new Date()
  fromDate.setDate(fromDate.getDate() - days)

  return {
    fromDate: formatDate(fromDate),
    toDate: formatDate(toDate),
  }
}

function buildAuthHeader(credentials: HspCredentials): string {
  const encoded = Buffer.from(
    `${credentials.username}:${credentials.password}`
  ).toString('base64')
  return `Basic ${encoded}`
}

function aggregateToleranceBands(
  services: HspServiceMetricsResponse['Services']
): ToleranceBand[] {
  const bandMap = new Map<number, number>()
  let totalServices = 0

  for (const service of services) {
    const matched = parseInt(
      service.serviceAttributesMetrics.matched_services,
      10
    )
    totalServices += matched

    for (const metric of service.Metrics) {
      const tolerance = parseInt(metric.tolerance_value, 10)
      const count = parseInt(metric.num_tolerance, 10)
      const existing = bandMap.get(tolerance) ?? 0
      bandMap.set(tolerance, existing + count)
    }
  }

  const bands: ToleranceBand[] = []
  for (const [toleranceMinutes, numServices] of bandMap) {
    bands.push({
      toleranceMinutes,
      numServices,
      percentageOfServices:
        totalServices > 0
          ? (numServices / totalServices) * 100
          : 0,
    })
  }

  return bands.sort((a, b) => a.toleranceMinutes - b.toleranceMinutes)
}

function computeMetrics(
  response: HspServiceMetricsResponse
): HspMetrics {
  const services = response.Services ?? []

  const totalTrains = services.reduce(
    (sum, s) =>
      sum +
      parseInt(s.serviceAttributesMetrics.matched_services, 10),
    0
  )

  const toleranceData = aggregateToleranceBands(services)

  const onTimeBand = toleranceData.find(
    (b) => b.toleranceMinutes === 0
  )
  const cancelledBand = toleranceData.find(
    (b) => b.toleranceMinutes === -1
  )

  const onTimePercentage =
    totalTrains > 0
      ? ((onTimeBand?.numServices ?? 0) / totalTrains) * 100
      : 0

  const cancelledPercentage =
    totalTrains > 0
      ? ((cancelledBand?.numServices ?? 0) / totalTrains) * 100
      : 0

  const latePercentage = Math.max(
    0,
    100 - onTimePercentage - cancelledPercentage
  )

  const averageDelayMinutes = computeAverageDelay(
    toleranceData,
    totalTrains
  )

  return {
    fromStation: response.header.from_location,
    toStation: response.header.to_location,
    fromStationCrs: response.header.from_location,
    toStationCrs: response.header.to_location,
    totalTrains,
    onTimePercentage: round(onTimePercentage, 1),
    latePercentage: round(latePercentage, 1),
    cancelledPercentage: round(cancelledPercentage, 1),
    averageDelayMinutes: round(averageDelayMinutes, 1),
    toleranceData,
  }
}

function computeAverageDelay(
  toleranceData: readonly ToleranceBand[],
  totalTrains: number
): number {
  if (totalTrains === 0) return 0

  let weightedSum = 0
  for (const band of toleranceData) {
    if (band.toleranceMinutes >= 0) {
      weightedSum += band.toleranceMinutes * band.numServices
    }
  }

  return weightedSum / totalTrains
}

function round(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals)
  return Math.round(value * factor) / factor
}

export class HspClient {
  private readonly credentials: HspCredentials

  constructor(credentials?: HspCredentials) {
    this.credentials = credentials ?? loadCredentials()
  }

  async getDelayHistory(
    fromCrs: string,
    toCrs: string,
    days: number = DEFAULT_DAYS
  ): Promise<HspMetrics> {
    if (!fromCrs || !toCrs) {
      throw new Error(
        'Both fromCrs and toCrs station codes are required'
      )
    }
    if (days < 1 || days > 365) {
      throw new Error('days must be between 1 and 365')
    }

    const { fromDate, toDate } = buildDateRange(days)

    const body = {
      from_loc: fromCrs.toUpperCase(),
      to_loc: toCrs.toUpperCase(),
      from_time: DEFAULT_FROM_TIME,
      to_time: DEFAULT_TO_TIME,
      from_date: fromDate,
      to_date: toDate,
      days: 'WEEKDAY',
    }

    const response = await fetch(
      `${HSP_BASE_URL}/serviceMetrics`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: buildAuthHeader(this.credentials),
        },
        body: JSON.stringify(body),
      }
    )

    if (!response.ok) {
      throw new Error(
        `HSP API request failed: ${response.status} ${response.statusText}`
      )
    }

    const data =
      (await response.json()) as HspServiceMetricsResponse

    if (!data.Services || data.Services.length === 0) {
      return {
        fromStation: fromCrs.toUpperCase(),
        toStation: toCrs.toUpperCase(),
        fromStationCrs: fromCrs.toUpperCase(),
        toStationCrs: toCrs.toUpperCase(),
        totalTrains: 0,
        onTimePercentage: 0,
        latePercentage: 0,
        cancelledPercentage: 0,
        averageDelayMinutes: 0,
        toleranceData: [],
      }
    }

    return computeMetrics(data)
  }
}

export function createHspClient(
  credentials?: HspCredentials
): HspClient {
  return new HspClient(credentials)
}
