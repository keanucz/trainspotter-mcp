const LDBSVWS_BASE = 'https://api1.raildata.org.uk/1010-live-departure-board---staff-version1_0/LDBSVWS/api/20220120';

interface TimetableService {
  std: string;
  etd?: string;
  operator: string;
  operatorCode?: string;
  platform?: string;
  destination: string;
  isCancelled: boolean;
  cancelReason?: string;
  delayReason?: string;
  serviceId?: string;
  length?: number;
}

interface TimetableBoard {
  locationName: string;
  crs: string;
  filterLocationName?: string;
  generatedAt: string;
  services: TimetableService[];
}

interface RawService {
  std?: string;
  etd?: string;
  operator?: string;
  operatorCode?: string;
  platform?: string;
  isCancelled?: boolean;
  cancelReason?: string;
  delayReason?: string;
  rid?: string;
  length?: number;
  destination?: Array<{ locationName?: string; crs?: string }>;
}

interface RawBoard {
  locationName?: string;
  crs?: string;
  filterLocationName?: string;
  generatedAt?: string;
  trainServices?: RawService[];
}

function formatTime(isoTime: string): string {
  const match = isoTime.match(/T(\d{2}:\d{2})/);
  return match ? match[1] : isoTime;
}

function parseService(raw: RawService): TimetableService {
  const dest = raw.destination?.[0]?.locationName ?? 'Unknown';
  return {
    std: raw.std ? formatTime(raw.std) : '??:??',
    etd: raw.etd ? formatTime(raw.etd) : undefined,
    operator: raw.operator ?? 'Unknown',
    operatorCode: raw.operatorCode,
    platform: raw.platform,
    destination: dest,
    isCancelled: raw.isCancelled ?? false,
    cancelReason: raw.cancelReason,
    delayReason: raw.delayReason,
    serviceId: raw.rid,
    length: raw.length,
  };
}

export class TimetableClient {
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async getDepartures(
    crs: string,
    datetime: string,
    filterCrs?: string,
    rows = 10,
    timeWindow = 120,
  ): Promise<TimetableBoard> {
    const url = new URL(
      `${LDBSVWS_BASE}/GetDepBoardWithDetails/${crs.toUpperCase()}/${datetime}`
    );
    url.searchParams.set('numRows', String(rows));
    url.searchParams.set('timeWindow', String(timeWindow));
    if (filterCrs) {
      url.searchParams.set('filterCrs', filterCrs.toUpperCase());
      url.searchParams.set('filterType', 'to');
    }

    const response = await fetch(url.toString(), {
      headers: { 'x-apikey': this.apiKey },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Staff LDBSVWS request failed (${response.status}): ${text.slice(0, 200)}`);
    }

    const data = (await response.json()) as RawBoard;

    const services = (data.trainServices ?? []).map(parseService);

    return {
      locationName: data.locationName ?? crs,
      crs: data.crs ?? crs,
      filterLocationName: data.filterLocationName,
      generatedAt: data.generatedAt ?? '',
      services,
    };
  }
}

export function createTimetableClient(): TimetableClient {
  const apiKey = process.env['LDBSVWS_TOKEN'];
  if (!apiKey) {
    throw new Error(
      'LDBSVWS_TOKEN environment variable is required for timetable lookups'
    );
  }
  return new TimetableClient(apiKey);
}
