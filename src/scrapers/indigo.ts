import type { RawLot, RawRate, ScrapeResult, Scraper } from "./types.js";

const LOCATIONS_API = "https://salesforce.parkindigo.com/locations";
const RATES_API = "https://indigo-ca-grs-api-bzc5czfndad7gwhy.z01.azurefd.net/GetMultipleRates";

// Vancouver bounding box
const VANCOUVER_BOX = {
  north: 49.35,
  south: 49.15,
  west: -123.3,
  east: -122.9,
};

interface SalesforceLot {
  grsId: string;
  name: string;
  address: { lines: string[]; city: string; state: string; zipCode: string };
  geoLocation: { x: number; y: number };
  services: Record<string, boolean>;
  totalSpaces: number;
  siteIdentification: string;
  id: string;
  reservationsEnabled: boolean;
  payAsYouGoEnabled: boolean;
  currency: string;
}

interface RateRequest {
  Criteria: RateCriteria[];
}

interface RateCriteria {
  LotId: string;
  ParkingBeginDateTime: string;
  ParkingEndDateTime: string;
  SalesChannelKey: string;
  CustomerFlowType: string;
  ISOLangCode: string;
}

interface IndigoRateItem {
  LocationId: string;
  LocationName: string;
  RateName: string;
  Amount: number;
  TaxFreeAmount: number;
  DisplayRateType: string;
  ProductType: string;
  FromDate: string;
  ToDate: string;
}

interface IndigoRateResponse {
  d?: string;
  ExceptionDetail?: { Message: string };
}

function buildLocationsUrl(page: number, size: number = 100): string {
  const params = new URLSearchParams({
    "location.language": "en",
    "location.address.countries": "CA",
    "box.first.x": String(VANCOUVER_BOX.north),
    "box.first.y": String(VANCOUVER_BOX.west),
    "box.second.x": String(VANCOUVER_BOX.south),
    "box.second.y": String(VANCOUVER_BOX.east),
    page: String(page),
    size: String(size),
  });
  return `${LOCATIONS_API}?${params}`;
}

async function fetchLocationsPage(page: number): Promise<{ content: SalesforceLot[]; totalResults?: number }> {
  const res = await fetch(buildLocationsUrl(page), {
    headers: { "User-Agent": "vancouver-parking/1.0", Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Locations API HTTP ${res.status}`);
  return res.json();
}

function featuresFromServices(services?: Record<string, boolean>): { ev: boolean; covered: boolean } {
  return {
    ev: services?.electricCharging === true || services?.electricPlugin === true,
    covered: false, // Indigo doesn't expose covered status in API
  };
}

function isVancouverLot(lot: SalesforceLot): boolean {
  const city = (lot.address?.city || "").toLowerCase();
  return [
    "vancouver",
    "richmond",
    "burnaby",
    "new westminster",
    "north vancouver",
    "west vancouver",
    "surrey",
    "coquitlam",
    "port moody",
    "port coquitlam",
    "delta",
    "langley",
    "maple ridge",
    "white rock",
  ].some((c) => city.includes(c));
}

function rawLotsFromSalesforce(salesforceLots: SalesforceLot[]): RawLot[] {
  return salesforceLots.filter(isVancouverLot).map((lot) => {
    const addressLine = lot.address?.lines?.join(", ") || "";
    const city = lot.address?.city || "";
    const state = lot.address?.state || "BC";
    const zip = lot.address?.zipCode || "";
    const fullAddress = [addressLine, city, state, zip].filter(Boolean).join(", ");

    return {
      id: `indigo-${lot.grsId}`,
      provider: "indigo",
      name: lot.name,
      address: fullAddress,
      lat: lot.geoLocation?.x ?? 0,
      lng: lot.geoLocation?.y ?? 0,
      rates: [],
      features: featuresFromServices(lot.services),
      hours: defaultHours(),
      externalId: lot.grsId,
    };
  });
}

async function fetchRates(grsIds: string[]): Promise<Map<string, RawRate[]>> {
  const rateMap = new Map<string, RawRate[]>();
  if (grsIds.length === 0) return rateMap;

  const now = new Date();
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const dateStr = `${now.getFullYear()}/${pad2(now.getMonth() + 1)}/${pad2(now.getDate())}`;
  const begin = `${dateStr} ${pad2(now.getHours())}:${pad2(now.getMinutes())}:0`;
  const end = new Date(now.getTime() + 2 * 60 * 60 * 1000);
  const endStr = `${end.getFullYear()}/${pad2(end.getMonth() + 1)}/${pad2(end.getDate())} ${pad2(end.getHours())}:${pad2(end.getMinutes())}:0`;

  const body = {
    Criteria: grsIds.map((grsId) => ({
      LotId: grsId,
      ParkingBeginDateTime: begin,
      ParkingEndDateTime: endStr,
      SalesChannelKey: "Web",
      CustomerFlowType: "PNW",
      ISOLangCode: "EN",
    })),
    SalesChannelKey: "Web",
    ISOLangCode: "EN",
  };

  const res = await fetch(RATES_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": "7819b70f-2f42-41b0-9c9d-3aa89b9d0ba0",
      "x-tenant": "indigo-ext",
      "accept-language": "EN",
      "User-Agent": "Mozilla/5.0",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    console.log(`[indigo] Rates API HTTP ${res.status}`);
    return rateMap;
  }

  const data: IndigoRateResponse = await res.json();
  if (data.ExceptionDetail) {
    console.log(`[indigo] Rates API: ${data.ExceptionDetail.Message}`);
    return rateMap;
  }

  if (!data.d) return rateMap;

  let lotResults: Record<string, any>[];
  try {
    lotResults = JSON.parse(data.d);
  } catch {
    return rateMap;
  }

  for (const lotResult of lotResults) {
    const lotId = lotResult.eDataLocationId || lotResult.LocationId;
    if (!lotId) continue;
    const rateList: any[] = lotResult.DisplayRateList || [];
    const rates: RawRate[] = [];

    for (const rateItem of rateList) {
      const name = rateItem.RateName || "";
      const amount = rateItem.TaxFreeAmount || rateItem.Amount || 0;
      const type = rateItem.DisplayRateType || "";

      if (amount <= 0) continue;

      // TMD = time-based (hourly), convert to per-hour rate
      if (type === "TMD") {
        const durationHours = parseDuration(rateItem.FromDate || "", rateItem.ToDate || "");
        const hourly = durationHours > 0 ? Math.round((amount / durationHours) * 100) / 100 : amount;
        rates.push({ type: "hourly", label: name, amount: hourly, hourlyRate: hourly });
      } else {
        // FAP = Fixed Access Pass (flat daily), EVT = Event, etc.
        rates.push({ type: "flat", label: name, amount });
      }
    }

    if (rates.length > 0) rateMap.set(lotId, rates);
  }

  return rateMap;
}

function parseDuration(from: string, to: string): number {
  const f = new Date(from);
  const t = new Date(to);
  const ms = t.getTime() - f.getTime();
  return ms > 0 ? ms / (1000 * 60 * 60) : 1;
}

function defaultHours(): Record<string, { open: string; close: string }> {
  const days = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const h: Record<string, { open: string; close: string }> = {};
  for (const d of days) h[d] = { open: "06:00", close: "23:00" };
  return h;
}

export const indigoScraper: Scraper = {
  provider: "indigo",

  async scrape(): Promise<ScrapeResult> {
    console.log("[indigo] Fetching Vancouver-area parking lots...");

    const allLots: SalesforceLot[] = [];
    let page = 0;

    for (let i = 0; i < 20; i++) {
      console.log(`[indigo]   page ${page}...`);
      const result = await fetchLocationsPage(page);
      if (!result.content || result.content.length === 0) break;
      allLots.push(...result.content);
      page++;
    }

    console.log(`[indigo]   total lots from API: ${allLots.length}`);

    const rawLots = rawLotsFromSalesforce(allLots);
    console.log(`[indigo]   Vancouver-area lots: ${rawLots.length}`);

    // Try to fetch rates
    const grsIds = rawLots.map((l) => l.externalId).filter(Boolean) as string[];
    if (grsIds.length > 0) {
      console.log(`[indigo]   fetching rates for ${grsIds.length} lots...`);
      const rateMap = await fetchRates(grsIds);
      console.log(`[indigo]   lots with rates: ${rateMap.size}`);

      for (const lot of rawLots) {
        if (lot.externalId && rateMap.has(lot.externalId)) {
          lot.rates = rateMap.get(lot.externalId)!;
        }
      }
    }

    console.log(`[indigo] Done. ${rawLots.length} lots scraped.`);
    return {
      provider: "indigo",
      timestamp: new Date().toISOString(),
      data: rawLots,
    };
  },
};

// Run directly: tsx src/scrapers/indigo.ts
const isMain = process.argv[1]?.includes("indigo");
if (isMain) {
  const result = await indigoScraper.scrape();
  console.log(`\nScraped ${result.data.length} lots from ${result.provider}`);
  console.log(JSON.stringify(result.data.slice(0, 2), null, 2));
}
