import { XMLParser } from 'fast-xml-parser';
import type {
  StationBoard,
  ServiceDetails,
  Service,
  Location,
  CallingPoint,
} from './types.js';

const DARWIN_URL =
  'https://lite.realtime.nationalrail.co.uk/OpenLDBWS/ldb12.asmx';

const SOAP_ENVELOPE = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"
xmlns:typ="http://thalesgroup.com/RTTI/2013-11-28/Token/types"
xmlns:ldb="http://thalesgroup.com/RTTI/2021-11-01/ldb/">
   <soap:Header>
      <typ:AccessToken>
         <typ:TokenValue>{{TOKEN}}</typ:TokenValue>
      </typ:AccessToken>
   </soap:Header>
   <soap:Body>
      {{BODY}}
   </soap:Body>
</soap:Envelope>`;

const xmlParser = new XMLParser({
  removeNSPrefix: true,
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: true,
  isArray: (tagName: string) => {
    const arrayTags = new Set([
      'service',
      'location',
      'message',
      'callingPoint',
      'callingPointList',
    ]);
    return arrayTags.has(tagName);
  },
});

function stripHtmlTags(html: string): string {
  return html.replace(/<[^>]*>/g, '').trim();
}

function determineStatus(
  etd: string | undefined,
  eta: string | undefined,
  isCancelled: boolean,
): 'On Time' | 'Delayed' | 'Cancelled' {
  if (isCancelled) {
    return 'Cancelled';
  }

  const estimated = etd || eta || '';

  if (estimated === 'On time') {
    return 'On Time';
  }
  if (estimated === 'Delayed' || estimated.includes(':')) {
    return 'Delayed';
  }
  return 'On Time';
}

function calculateDelay(
  std: string | undefined,
  etd: string | undefined,
  sta: string | undefined,
  eta: string | undefined,
): number {
  let scheduled = std || '';
  let estimated = etd || '';

  if (scheduled === '') {
    scheduled = sta || '';
    estimated = eta || '';
  }

  if (
    scheduled === '' ||
    estimated === '' ||
    estimated === 'On time' ||
    estimated === 'Delayed'
  ) {
    return 0;
  }

  const schParts = scheduled.split(':');
  const estParts = estimated.split(':');
  if (schParts.length !== 2 || estParts.length !== 2) {
    return 0;
  }

  const schMinutes = parseInt(schParts[0], 10) * 60 + parseInt(schParts[1], 10);
  const estMinutes = parseInt(estParts[0], 10) * 60 + parseInt(estParts[1], 10);

  if (isNaN(schMinutes) || isNaN(estMinutes)) {
    return 0;
  }

  let diff = estMinutes - schMinutes;
  if (diff < 0) {
    diff += 24 * 60;
  }

  return diff;
}

function toArray<T>(value: T | T[] | undefined | null): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value != null && typeof value === 'object') {
    return value as Record<string, unknown>;
  }
  return {};
}

function parseLocations(raw: unknown): Location[] {
  if (raw == null || typeof raw !== 'object') return [];
  const container = asRecord(raw);
  const locations = toArray(container['location']).map(asRecord);
  return locations.map((loc) => ({
    locationName: String(loc['locationName'] ?? ''),
    crs: String(loc['crs'] ?? ''),
    ...(loc['via'] ? { via: String(loc['via']) } : {}),
  }));
}

function parseCallingPoints(raw: unknown): CallingPoint[] {
  if (raw == null || typeof raw !== 'object') return [];
  const container = asRecord(raw);
  const lists = toArray(container['callingPointList']).map(asRecord);
  if (lists.length === 0) return [];

  const firstList = lists[0];
  const points = toArray(firstList['callingPoint']).map(asRecord);

  return points.map((cp) => ({
    locationName: String(cp['locationName'] ?? ''),
    crs: String(cp['crs'] ?? ''),
    st: String(cp['st'] ?? ''),
    ...(cp['et'] ? { et: String(cp['et']) } : {}),
    ...(cp['at'] ? { at: String(cp['at']) } : {}),
    isCancelled: cp['isCancelled'] === true || cp['isCancelled'] === 'true',
    ...(cp['length'] != null && Number(cp['length']) > 0
      ? { length: Number(cp['length']) }
      : {}),
  }));
}

function parseService(svc: Record<string, unknown>): Service {
  const serviceId = String(svc['serviceID'] ?? '');
  const isCancelled =
    svc['isCancelled'] === true || svc['isCancelled'] === 'true';
  const std = svc['std'] != null ? String(svc['std']) : undefined;
  const etd = svc['etd'] != null ? String(svc['etd']) : undefined;
  const sta = svc['sta'] != null ? String(svc['sta']) : undefined;
  const eta = svc['eta'] != null ? String(svc['eta']) : undefined;
  const length =
    svc['length'] != null && Number(svc['length']) > 0
      ? Number(svc['length'])
      : undefined;

  return {
    serviceId,
    serviceIdUrlSafe: serviceId.replace(/\//g, '_'),
    operator: String(svc['operator'] ?? ''),
    operatorCode: String(svc['operatorCode'] ?? ''),
    ...(svc['platform'] != null
      ? { platform: String(svc['platform']) }
      : {}),
    ...(std != null ? { std } : {}),
    ...(etd != null ? { etd } : {}),
    ...(sta != null ? { sta } : {}),
    ...(eta != null ? { eta } : {}),
    isCancelled,
    ...(svc['cancelReason']
      ? { cancelReason: String(svc['cancelReason']) }
      : {}),
    ...(svc['delayReason']
      ? { delayReason: String(svc['delayReason']) }
      : {}),
    origin: parseLocations(svc['origin']),
    destination: parseLocations(svc['destination']),
    ...(length != null ? { length } : {}),
    status: determineStatus(etd, eta, isCancelled),
    delayMinutes: calculateDelay(std, etd, sta, eta),
  };
}

function parseStationBoardResult(parsed: Record<string, unknown>): StationBoard {
  const envelope = parsed['Envelope'] as Record<string, unknown> | undefined;
  if (!envelope) {
    throw new Error('Invalid SOAP response: missing Envelope');
  }

  const body = envelope['Body'] as Record<string, unknown> | undefined;
  if (!body) {
    throw new Error('Invalid SOAP response: missing Body');
  }

  // Try departures, then arrivals
  const depResponse = body['GetDepBoardWithDetailsResponse'] as
    | Record<string, unknown>
    | undefined;
  const arrResponse = body['GetArrBoardWithDetailsResponse'] as
    | Record<string, unknown>
    | undefined;
  const wrapper = depResponse ?? arrResponse;

  if (!wrapper) {
    throw new Error('No station board data in response');
  }

  const result = wrapper['GetStationBoardResult'] as Record<string, unknown>;
  if (!result || !result['locationName']) {
    throw new Error('No station board data in response');
  }

  const nrccMessages: string[] = [];
  const nrccRaw = result['nrccMessages'] as Record<string, unknown> | undefined;
  if (nrccRaw) {
    const messages = toArray(nrccRaw['message'] as unknown);
    for (const msg of messages) {
      const text = typeof msg === 'string' ? msg : String(msg ?? '');
      if (text) {
        nrccMessages.push(stripHtmlTags(text));
      }
    }
  }

  const trainServices = result['trainServices'] as
    | Record<string, unknown>
    | undefined;
  const rawServices = trainServices
    ? toArray(trainServices['service']).map(asRecord)
    : [];

  const services: Service[] = rawServices.map(parseService);

  return {
    generatedAt: String(result['@_generatedAt'] ?? ''),
    locationName: String(result['locationName'] ?? ''),
    crs: String(result['crs'] ?? ''),
    ...(result['filterLocationName']
      ? { filterLocationName: String(result['filterLocationName']) }
      : {}),
    ...(result['filtercrs']
      ? { filterLocationCrs: String(result['filtercrs']) }
      : {}),
    platformAvailable:
      result['platformAvailable'] === true ||
      result['platformAvailable'] === 'true',
    nrccMessages,
    services,
  };
}

function parseServiceDetailsResult(
  parsed: Record<string, unknown>,
): ServiceDetails {
  const envelope = parsed['Envelope'] as Record<string, unknown> | undefined;
  if (!envelope) {
    throw new Error('Invalid SOAP response: missing Envelope');
  }

  const body = envelope['Body'] as Record<string, unknown> | undefined;
  if (!body) {
    throw new Error('Invalid SOAP response: missing Body');
  }

  const detailsResponse = body['GetServiceDetailsResponse'] as
    | Record<string, unknown>
    | undefined;
  if (!detailsResponse) {
    throw new Error('No service details in response');
  }

  const result = detailsResponse['GetServiceDetailsResult'] as Record<
    string,
    unknown
  >;
  if (!result || !result['locationName']) {
    throw new Error('No service details in response');
  }

  const length =
    result['length'] != null && Number(result['length']) > 0
      ? Number(result['length'])
      : undefined;

  return {
    generatedAt: String(result['@_generatedAt'] ?? ''),
    serviceType: String(result['serviceType'] ?? ''),
    locationName: String(result['locationName'] ?? ''),
    crs: String(result['crs'] ?? ''),
    operator: String(result['operator'] ?? ''),
    operatorCode: String(result['operatorCode'] ?? ''),
    ...(result['platform'] != null
      ? { platform: String(result['platform']) }
      : {}),
    ...(result['std'] != null ? { std: String(result['std']) } : {}),
    ...(result['etd'] != null ? { etd: String(result['etd']) } : {}),
    ...(result['sta'] != null ? { sta: String(result['sta']) } : {}),
    ...(result['eta'] != null ? { eta: String(result['eta']) } : {}),
    isCancelled:
      result['isCancelled'] === true || result['isCancelled'] === 'true',
    ...(result['cancelReason']
      ? { cancelReason: String(result['cancelReason']) }
      : {}),
    ...(result['delayReason']
      ? { delayReason: String(result['delayReason']) }
      : {}),
    ...(length != null ? { length } : {}),
    previousCallingPoints: parseCallingPoints(
      result['previousCallingPoints'],
    ),
    subsequentCallingPoints: parseCallingPoints(
      result['subsequentCallingPoints'],
    ),
  };
}

export class DarwinClient {
  private readonly accessToken: string;
  private readonly url: string;

  constructor(accessToken: string, url?: string) {
    this.accessToken = accessToken;
    this.url = url ?? DARWIN_URL;
  }

  async getDepartures(
    crs: string,
    rows = 10,
    filterCrs?: string,
  ): Promise<StationBoard> {
    const filterXml = filterCrs
      ? `<ldb:filterCrs>${filterCrs}</ldb:filterCrs>
         <ldb:filterType>to</ldb:filterType>`
      : '';

    const body = `<ldb:GetDepBoardWithDetailsRequest>
         <ldb:numRows>${rows}</ldb:numRows>
         <ldb:crs>${crs}</ldb:crs>
         ${filterXml}
      </ldb:GetDepBoardWithDetailsRequest>`;

    const xml = await this.makeRequest(body);
    const parsed = xmlParser.parse(xml) as Record<string, unknown>;
    return parseStationBoardResult(parsed);
  }

  async getArrivals(
    crs: string,
    rows = 10,
    filterCrs?: string,
  ): Promise<StationBoard> {
    const filterXml = filterCrs
      ? `<ldb:filterCrs>${filterCrs}</ldb:filterCrs>
         <ldb:filterType>from</ldb:filterType>`
      : '';

    const body = `<ldb:GetArrBoardWithDetailsRequest>
         <ldb:numRows>${rows}</ldb:numRows>
         <ldb:crs>${crs}</ldb:crs>
         ${filterXml}
      </ldb:GetArrBoardWithDetailsRequest>`;

    const xml = await this.makeRequest(body);
    const parsed = xmlParser.parse(xml) as Record<string, unknown>;
    return parseStationBoardResult(parsed);
  }

  async getServiceDetails(serviceId: string): Promise<ServiceDetails> {
    const body = `<ldb:GetServiceDetailsRequest>
         <ldb:serviceID>${serviceId}</ldb:serviceID>
      </ldb:GetServiceDetailsRequest>`;

    const xml = await this.makeRequest(body);
    const parsed = xmlParser.parse(xml) as Record<string, unknown>;
    return parseServiceDetailsResult(parsed);
  }

  private async makeRequest(body: string): Promise<string> {
    const envelope = SOAP_ENVELOPE
      .replace('{{TOKEN}}', this.accessToken)
      .replace('{{BODY}}', body);

    const response = await fetch(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=utf-8' },
      body: envelope,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Darwin API request failed (${response.status}): ${text}`,
      );
    }

    const text = await response.text();
    if (!text) {
      throw new Error('Darwin API returned empty response');
    }

    return text;
  }
}

export function createDarwinClient(): DarwinClient {
  const token = process.env['LDBWS_TOKEN'];
  if (!token) {
    throw new Error(
      'LDBWS_TOKEN environment variable is required for Darwin API access',
    );
  }
  return new DarwinClient(token);
}
