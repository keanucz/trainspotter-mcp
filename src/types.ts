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
