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

interface RateResponse {
  rateItems?: RateItem[];
  ExceptionDetail?: { Message: string };
}

interface RateItem {
  lotId: string;
  description: string;
  amount: number;
  durationType: string;
  productType: string;
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

async function fetchRates(grsIds: string[]): Promise<RateItem[]> {
  if (grsIds.length === 0) return [];

  const now = new Date();
  const begin = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:00:0`;
  const end = new Date(now.getTime() + 2 * 60 * 60 * 1000);
  const endStr = `${end.getFullYear()}/${String(end.getMonth() + 1).padStart(2, "0")}/${String(end.getDate()).padStart(2, "0")} ${String(end.getHours()).padStart(2, "0")}:00:0`;

  const body: RateRequest = {
    Criteria: grsIds.map((grsId) => ({
      LotId: grsId,
      ParkingBeginDateTime: begin,
      ParkingEndDateTime: endStr,
      SalesChannelKey: "Web",
      CustomerFlowType: "RAD",
      ISOLangCode: "EN",
    })),
  };

  const res = await fetch(RATES_API, {
    method: "POST",
    headers: { "User-Agent": "vancouver-parking/1.0", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    console.log(`[indigo] Rates API HTTP ${res.status}`);
    return [];
  }

  const data: RateResponse = await res.json();
  if (data.ExceptionDetail) {
    console.log(`[indigo] Rates API: ${data.ExceptionDetail.Message}`);
    return [];
  }

  return data.rateItems || [];
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
      const rateItems = await fetchRates(grsIds);
      console.log(`[indigo]   rates returned: ${rateItems.length}`);

      const rateMap = new Map<string, RawRate[]>();
      for (const item of rateItems) {
        if (!rateMap.has(item.lotId)) rateMap.set(item.lotId, []);
        rateMap.get(item.lotId)!.push({
          type: item.durationType === "FLAT" ? "flat" : "hourly",
          label: item.description,
          amount: item.amount,
          hourlyRate: item.durationType !== "FLAT" ? item.amount : undefined,
        });
      }

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
