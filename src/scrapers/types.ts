/** Raw lot as scraped from a provider before normalization */
export interface RawLot {
  id: string;
  provider: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  rates: RawRate[];
  features: RawFeatures;
  hours: Record<string, { open: string; close: string }>;
  /** Provider-specific ID for rate lookups (e.g. Indigo grsId) */
  externalId?: string;
  /** Link to booking/detail page on provider's site */
  sourceUrl?: string;
}

export interface RawFeatures {
  ev: boolean;
  covered: boolean;
}

export interface RawRate {
  type: "flat" | "hourly" | "incremental";
  label: string;
  amount: number;
  hourlyRate?: number;
  maxDaily?: number;
}

/** Every scraper must return this shape */
export interface ScrapeResult {
  provider: string;
  timestamp: string;
  data: RawLot[];
}

/** Scraper interface — implement this for each provider */
export interface Scraper {
  provider: string;
  scrape(): Promise<ScrapeResult>;
}

/** Provider config for the scraper registry */
export interface ProviderConfig {
  name: string;
  scraper: Scraper;
  enabled: boolean;
}
