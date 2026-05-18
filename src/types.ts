export interface Location {
  locationName: string;
  crs: string;
  via?: string;
}

export interface Service {
  serviceId: string;
  serviceIdUrlSafe: string;
  operator: string;
  operatorCode: string;
  platform?: string;
  std?: string;
  etd?: string;
  sta?: string;
  eta?: string;
  isCancelled: boolean;
  cancelReason?: string;
  delayReason?: string;
  origin: Location[];
  destination: Location[];
  length?: number;
  status: 'On Time' | 'Delayed' | 'Cancelled';
  delayMinutes: number;
}

export interface CallingPoint {
  locationName: string;
  crs: string;
  st: string;
  et?: string;
  at?: string;
  isCancelled: boolean;
  length?: number;
}

export interface StationBoard {
  generatedAt: string;
  locationName: string;
  crs: string;
  filterLocationName?: string;
  filterLocationCrs?: string;
  platformAvailable: boolean;
  nrccMessages: string[];
  services: Service[];
}

export interface ServiceDetails {
  generatedAt: string;
  serviceType: string;
  locationName: string;
  crs: string;
  operator: string;
  operatorCode: string;
  platform?: string;
  std?: string;
  etd?: string;
  sta?: string;
  eta?: string;
  isCancelled: boolean;
  cancelReason?: string;
  delayReason?: string;
  length?: number;
  previousCallingPoints: CallingPoint[];
  subsequentCallingPoints: CallingPoint[];
}

export interface HspMetrics {
  fromStation: string;
  toStation: string;
  fromStationCrs: string;
  toStationCrs: string;
  totalTrains: number;
  onTimePercentage: number;
  latePercentage: number;
  cancelledPercentage: number;
  averageDelayMinutes: number;
  toleranceData: ToleranceBand[];
}

export interface ToleranceBand {
  toleranceMinutes: number;
  numServices: number;
  percentageOfServices: number;
}

export interface HspServiceMetricsResponse {
  header: {
    from_location: string;
    to_location: string;
  };
  Services: Array<{
    serviceAttributesMetrics: {
      origin_location: string;
      destination_location: string;
      gbtt_ptd: string;
      gbtt_pta: string;
      toc_code: string;
      matched_services: string;
      rids: string[];
    };
    Metrics: Array<{
      tolerance_value: string;
      num_not_tolerance: string;
      num_tolerance: string;
      percent_tolerance: string;
      global_tolerance: boolean;
    }>;
  }>;
}

// ─── BR Fares Easy Fares API Types ──────────────────────────────

export interface FareLocation {
  nlc?: string;
  crs?: string;
  code?: string;
  name?: string;
  ticketname?: string;
  longname?: string;
  rspname?: string;
  ojpname?: string;
}

export interface FareRoute {
  code?: string;
  name?: string;
  ticketname?: string;
  longname?: string;
  rspname?: string;
  ojpname?: string;
}

export interface FareTicket {
  code: string;
  tclass: number;
  print_format?: string;
  name: string;
  ticketname?: string;
  longname?: string;
  rspname?: string;
  ojpname?: string;
  rspnotes?: string;
  ojpnotes?: string;
  kb_cat?: string;
  capri_code?: string;
  idms_enabled?: boolean;
}

export interface FareRestriction {
  code?: string;
  desc?: string;
  out?: string;
  rtn?: string;
  details?: Array<{ header?: string; text?: string }>;
}

export interface FareSetter {
  code?: string;
  name?: string;
}

export interface FarePrice {
  status_code?: string;
  status_desc?: string;
  price?: number;
}

export interface DiscountGroup {
  railcard: { code: string; name: string };
  adult?: FarePrice;
  child?: FarePrice;
}

export interface FareInfo {
  type: string;
  orig: FareLocation;
  dest: FareLocation;
  route: FareRoute;
  cross_london: boolean;
  ticket: FareTicket;
  restriction: FareRestriction;
  fare_setter: FareSetter;
  discount_groups: DiscountGroup[];
  fulfilment?: string[];
}

export interface RestrictedFareGroup {
  type: string;
  orig: FareLocation;
  dest: FareLocation;
  route: FareRoute;
  cross_london: boolean;
  restriction: FareRestriction;
  fare_setter: FareSetter;
  tclass?: number;
  min_price?: number;
  max_price?: number;
  fares?: Array<{
    ticket: FareTicket;
    discount_groups: DiscountGroup[];
  }>;
  fulfilment?: string[];
  reservation_requirements?: string;
  half_return?: boolean;
}

export interface UnavailableFare extends FareInfo {
  reservation_requirements?: string;
  half_return?: boolean;
}

export interface FaresResponse {
  orig: FareLocation;
  dest: FareLocation;
  railcards: Array<{ code: string; name: string }>;
  walkup: FareInfo[];
  payg: FareInfo[];
  restricted: RestrictedFareGroup[];
  unavailable: UnavailableFare[];
  valid_date?: number;
  valid_until_date?: number;
  future_available?: boolean;
}

export interface RailcardInfo {
  code: string;
  name: string;
  online_display?: boolean;
  unattended_retail?: boolean;
  ticketname?: string;
  rspname?: string;
  ojpname?: string;
  group_restriction?: {
    desc?: string;
    min_pass?: number;
    max_pass?: number;
    min_adult?: number;
    max_adult?: number;
    min_child?: number;
    max_child?: number;
  };
}

export interface FareLocationInfo extends FareLocation {
  orig?: boolean;
  dest?: boolean;
}
