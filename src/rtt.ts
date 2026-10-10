const RTT_BASE = 'https://data.rtt.io';
const RTT_CREDIT = 'Data: Realtime Trains, https://www.realtimetrains.co.uk';
// Refresh the access token slightly early so a request never goes out with one about to expire.
const TOKEN_EXPIRY_MARGIN_MS = 60_000;

export interface RttDeparture {
  identity: string;
  departureDate: string;
  scheduled: string;
  expected?: string;
  operator: string;
  platform?: string;
  destination: string;
  destinationArrival?: string;
  isCancelled: boolean;
}

export interface RttBoard {
  locationName: string;
  crs: string;
  filterName?: string;
  timeFrom?: string;
  timeTo?: string;
  services: RttDeparture[];
}

export interface RttCall {
  name: string;
  crs?: string;
  arrival?: string;
  departure?: string;
  platform?: string;
  stops: boolean;
  isCancelled: boolean;
}

export interface RttService {
  identity: string;
  departureDate: string;
  operator: string;
  calls: RttCall[];
}

export interface RttDepartureQuery {
  station: string;
  destination?: string;
  from?: string;
  to?: string;
}

interface RawTime {
  scheduleAdvertised?: string;
  scheduleInternal?: string;
  realtimeForecast?: string;
  realtimeActual?: string;
  isCancelled?: boolean;
}

interface RawLocation {
  description?: string;
  shortCodes?: string[];
  longCodes?: string[];
}

interface RawPlatform {
  planned?: string;
  forecast?: string;
  actual?: string;
}

interface RawScheduleMetadata {
  identity?: string;
  departureDate?: string;
  operator?: { code?: string; name?: string };
}

interface RawEndpoint {
  location?: RawLocation;
  temporalData?: RawTime;
}

interface RawLineUpService {
  temporalData?: { departure?: RawTime; arrival?: RawTime };
  locationMetadata?: { platform?: RawPlatform };
  scheduleMetadata?: RawScheduleMetadata;
  destination?: RawEndpoint[];
}

interface RawLineUp {
  query?: {
    location?: RawLocation;
    filterTo?: RawLocation;
    timeFrom?: string;
    timeTo?: string;
  };
  services?: RawLineUpService[];
}

interface RawServiceLocation {
  temporalData?: {
    arrival?: RawTime;
    departure?: RawTime;
    scheduledCallType?: string;
  };
  locationMetadata?: { platform?: RawPlatform };
  location?: RawLocation;
}

interface RawServiceResponse {
  service?: {
    scheduleMetadata?: RawScheduleMetadata;
    locations?: RawServiceLocation[];
  };
}

interface RawAccessToken {
  token?: string;
  validUntil?: string;
}

function clock(iso?: string): string | undefined {
  const match = iso?.match(/T(\d{2}:\d{2})/);
  return match ? match[1] : undefined;
}

function pickPlatform(platform?: RawPlatform): string | undefined {
  return platform?.actual ?? platform?.forecast ?? platform?.planned;
}

function parseDeparture(raw: RawLineUpService): RttDeparture {
  const departure = raw.temporalData?.departure;
  const scheduled = clock(departure?.scheduleAdvertised ?? departure?.scheduleInternal) ?? '??:??';
  const live = clock(departure?.realtimeActual ?? departure?.realtimeForecast);
  const finalStop = raw.destination?.[raw.destination.length - 1];

  return {
    identity: raw.scheduleMetadata?.identity ?? '',
    departureDate: raw.scheduleMetadata?.departureDate ?? '',
    scheduled,
    expected: live && live !== scheduled ? live : undefined,
    operator: raw.scheduleMetadata?.operator?.name ?? 'Unknown',
    platform: pickPlatform(raw.locationMetadata?.platform),
    destination: finalStop?.location?.description ?? 'Unknown',
    destinationArrival: clock(finalStop?.temporalData?.scheduleAdvertised),
    isCancelled: departure?.isCancelled ?? false,
  };
}

function parseCall(raw: RawServiceLocation): RttCall {
  const arrival = raw.temporalData?.arrival;
  const departure = raw.temporalData?.departure;

  return {
    name: raw.location?.description ?? 'Unknown',
    crs: raw.location?.shortCodes?.[0],
    arrival: clock(arrival?.scheduleAdvertised),
    departure: clock(departure?.scheduleAdvertised),
    platform: pickPlatform(raw.locationMetadata?.platform),
    // A passing point has no advertised arrival or departure: the train does not stop there.
    stops: Boolean(arrival?.scheduleAdvertised ?? departure?.scheduleAdvertised),
    isCancelled: Boolean(arrival?.isCancelled ?? departure?.isCancelled),
  };
}

export class RttClient {
  private readonly refreshToken: string;
  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;

  constructor(refreshToken: string) {
    this.refreshToken = refreshToken;
  }

  async getDepartures(query: RttDepartureQuery): Promise<RttBoard> {
    const station = query.station.toUpperCase();
    const params = new URLSearchParams({ code: station });
    if (query.destination) params.set('filterTo', query.destination.toUpperCase());
    if (query.from) params.set('timeFrom', query.from);
    if (query.to) params.set('timeTo', query.to);

    const data = await this.request<RawLineUp>('/gb-nr/location', params);

    return {
      locationName: data?.query?.location?.description ?? station,
      crs: data?.query?.location?.shortCodes?.[0] ?? station,
      filterName: data?.query?.filterTo?.description,
      timeFrom: data?.query?.timeFrom,
      timeTo: data?.query?.timeTo,
      services: (data?.services ?? []).map(parseDeparture),
    };
  }

  async getService(identity: string, departureDate: string): Promise<RttService> {
    const params = new URLSearchParams({ identity: identity.toUpperCase(), departureDate });
    const data = await this.request<RawServiceResponse>('/gb-nr/service', params);
    const service = data?.service;
    if (!service) {
      throw new Error(`Realtime Trains returned no service for ${identity} on ${departureDate}`);
    }

    return {
      identity: service.scheduleMetadata?.identity ?? identity,
      departureDate: service.scheduleMetadata?.departureDate ?? departureDate,
      operator: service.scheduleMetadata?.operator?.name ?? 'Unknown',
      calls: (service.locations ?? []).map(parseCall),
    };
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt - TOKEN_EXPIRY_MARGIN_MS) {
      return this.accessToken;
    }

    const response = await fetch(`${RTT_BASE}/api/get_access_token`, {
      headers: { Authorization: `Bearer ${this.refreshToken}` },
    });
    if (!response.ok) {
      throw new Error(`Realtime Trains token request failed (${response.status})`);
    }

    const data = (await response.json()) as RawAccessToken;
    if (!data.token) {
      throw new Error('Realtime Trains token response did not include a token');
    }

    this.accessToken = data.token;
    this.accessTokenExpiresAt = data.validUntil ? Date.parse(data.validUntil) : 0;
    return data.token;
  }

  private async request<T>(path: string, params: URLSearchParams): Promise<T | null> {
    const token = await this.getAccessToken();
    const response = await fetch(`${RTT_BASE}${path}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (response.status === 204) return null;

    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After') ?? 'unknown';
      throw new Error(`Realtime Trains rate limit reached, retry after ${retryAfter} seconds`);
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Realtime Trains request failed (${response.status}): ${text.slice(0, 200)}`);
    }

    return (await response.json()) as T;
  }
}

export function createRttClient(): RttClient {
  const token = process.env['RTT_API_TOKEN'];
  if (!token) {
    throw new Error('RTT_API_TOKEN environment variable is required for Realtime Trains lookups');
  }
  return new RttClient(token);
}

export function formatRttDepartures(board: RttBoard): string {
  const lines = [
    `Realtime Trains: ${board.locationName} (${board.crs})${board.filterName ? ` → ${board.filterName}` : ''}`,
    `Window: ${board.timeFrom ?? 'now'} to ${board.timeTo ?? '+60 min'}`,
    '',
  ];

  if (board.services.length === 0) {
    lines.push('No services found in this window.');
  }

  for (const svc of board.services) {
    const arrival = svc.destinationArrival ? ` (arr ${svc.destinationArrival})` : '';
    const parts = [`${svc.scheduled} → ${svc.destination}${arrival}`, svc.operator];
    if (svc.platform) parts.push(`Plat ${svc.platform}`);
    parts.push(svc.identity);
    if (svc.isCancelled) parts.push('CANCELLED');
    else if (svc.expected) parts.push(`exp ${svc.expected}`);
    lines.push(`  ${parts.join(' | ')}`);
  }

  if (board.filterName) {
    lines.push(
      '',
      `"arr" is the arrival at the train's final destination. For the arrival at ${board.filterName} on a train that continues beyond it, use get_rtt_service.`,
    );
  }
  lines.push('', RTT_CREDIT);
  return lines.join('\n');
}

export function formatRttService(service: RttService): string {
  const lines = [
    `Realtime Trains service ${service.identity} on ${service.departureDate} | ${service.operator}`,
    '',
  ];

  for (const call of service.calls.filter((c) => c.stops)) {
    const times = [call.arrival ? `arr ${call.arrival}` : '', call.departure ? `dep ${call.departure}` : '']
      .filter(Boolean)
      .join(' ');
    const parts = [`${call.name}${call.crs ? ` (${call.crs})` : ''}`, times];
    if (call.platform) parts.push(`Plat ${call.platform}`);
    if (call.isCancelled) parts.push('CANCELLED');
    lines.push(`  ${parts.join(' | ')}`);
  }

  lines.push('', RTT_CREDIT);
  return lines.join('\n');
}
