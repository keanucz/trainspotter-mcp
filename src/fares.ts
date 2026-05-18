import type {
  FaresResponse,
  RailcardInfo,
  FareLocationInfo,
} from './types.js';

const BRFARES_BASE_URL =
  'https://api1.raildata.org.uk/1080-easy-fares-api-v1';

const MAX_RAILCARDS = 3;

function buildFaresUrl(
  orig: string,
  dest: string,
  railcards?: string[],
  date?: string,
): string {
  const params = new URLSearchParams();
  params.set('orig', orig.toUpperCase());
  params.set('dest', dest.toUpperCase());

  if (railcards && railcards.length > 0) {
    params.set('rlc', railcards.join(','));
  }

  if (date) {
    params.set('date', date);
  }

  return `${BRFARES_BASE_URL}/easy_fares?${params.toString()}`;
}

function isEmptyLocation(loc: unknown): boolean {
  if (loc == null || typeof loc !== 'object') return true;
  return Object.keys(loc).length === 0;
}

export class FaresClient {
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async searchFares(
    orig: string,
    dest: string,
    railcards?: string[],
    date?: string,
  ): Promise<FaresResponse> {
    if (!orig || orig.trim() === '') {
      throw new Error('orig station code is required');
    }
    if (!dest || dest.trim() === '') {
      throw new Error('dest station code is required');
    }
    if (railcards && railcards.length > MAX_RAILCARDS) {
      throw new Error(`Maximum ${MAX_RAILCARDS} railcards allowed`);
    }

    const url = buildFaresUrl(orig, dest, railcards, date);
    const data = await this.fetchJson<FaresResponse>(url);

    if (isEmptyLocation(data.orig)) {
      throw new Error('Invalid origin station code');
    }
    if (isEmptyLocation(data.dest)) {
      throw new Error('Invalid destination station code');
    }

    return data;
  }

  async listRailcards(): Promise<RailcardInfo[]> {
    const url = `${BRFARES_BASE_URL}/easy_railcards`;
    const data = await this.fetchJson<{ railcards: RailcardInfo[] }>(url);
    return data.railcards;
  }

  async listLocations(): Promise<FareLocationInfo[]> {
    const url = `${BRFARES_BASE_URL}/easy_locations`;
    const data = await this.fetchJson<{ locations: FareLocationInfo[] }>(url);
    return data.locations;
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'x-apikey': this.apiKey,
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `BR Fares API request failed (${response.status}): ${body}`,
      );
    }

    return (await response.json()) as T;
  }
}

export function createFaresClient(): FaresClient {
  const apiKey = process.env['BRFARES_API_KEY'];
  if (!apiKey) {
    throw new Error(
      'BRFARES_API_KEY environment variable is required for BR Fares API access',
    );
  }
  return new FaresClient(apiKey);
}
