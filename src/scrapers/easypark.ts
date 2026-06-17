import type { RawLot, RawRate, ScrapeResult, Scraper } from "./types.js";

const BASE = "https://www.easypark.ca";
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

interface MarkerData {
  street: string;
  title: string;
  city: string;
  LotNumber: string;
  lat: string;
  lng: string;
  locurl: string;
  features: string;
  state: string;
  thumbnail?: string;
}

function parseMarkers(html: string): MarkerData[] {
  const markers: MarkerData[] = [];
  const regex = /<marker\s+([^>]+)>/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html)) !== null) {
    const attrs: Record<string, string> = {};
    const attrRegex = /(\w+)=["']([^"']*)["']/g;
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = attrRegex.exec(match[1])) !== null) {
      attrs[attrMatch[1]] = attrMatch[2];
    }
    if (attrs.city && attrs.lat && attrs.lng && attrs.locurl) {
      markers.push(attrs as unknown as MarkerData);
    }
  }
  return markers;
}

function parseFeatures(featuresStr: string): { ev: boolean; covered: boolean } {
  const f = featuresStr.toLowerCase();
  return {
    ev: f.includes("ev charging") || f.includes("electric"),
    covered: f.includes("covered") || f.includes("parkade") || f.includes("underground"),
  };
}

function cleanHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&ndash;/g, "–")
    .replace(/\u200b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseRates(html: string): RawRate[] {
  const rates: RawRate[] = [];

  const tableRegex = /<table[^>]*>.*?<tbody>.*?<\/tbody>.*?<\/table>/gis;
  let tableMatch: RegExpExecArray | null;
  while ((tableMatch = tableRegex.exec(html)) !== null) {
    const tableHtml = tableMatch[0];

    // Skip zone number tables
    if (tableHtml.includes("Zone Number") || tableHtml.includes("ZoneNumber")) continue;

    // Check if this is a monthly/seasonal category table
    const isCategoryTable = tableHtml.includes("Category") && tableHtml.includes("Rate");

    const rows = tableHtml.match(/<tr[^>]*>.*?<\/tr>/gis) || [];
    for (const row of rows) {
      const cells = row.match(/<t[dh][^>]*>.*?<\/t[dh]>/gis) || [];
      if (cells.length < 2) continue;

      const headerText = cells[0]!.replace(/<[^>]+>/g, "");
      const rawText = cells[1]!.replace(/<[^>]+>/g, "");

      if (isCategoryTable) {
        const cat = cleanHtmlEntities(headerText);
        const val = cleanHtmlEntities(rawText);
        if (cat && cat !== "Category" && val) {
          const priceMatch = val.match(/\$?(\d+\.?\d*)/);
          if (priceMatch) {
            const amount = parseFloat(priceMatch[1]);
            if (amount < 2000) {
              rates.push({ type: "flat", label: cat, amount });
            }
          }
        }
        continue;
      }

      const label = cleanHtmlEntities(headerText);
      const text = cleanHtmlEntities(rawText);

      const dailyMaxInHeader = label.match(/Daily\s*Maximum\s*\$?(\d+\.?\d*)/i);
      const dailyMaxAmount = dailyMaxInHeader ? parseFloat(dailyMaxInHeader[1]) : undefined;

      // Extract prices from text
      const allPrices = [...text.matchAll(/\$(\d+\.?\d*)/g)].map((m) => parseFloat(m[1]));

      // Hourly rate
      const hourlyMatch = text.match(/\$(\d+\.?\d*)\s*per\s*hour/i);
      if (hourlyMatch) {
        const hourlyRate = parseFloat(hourlyMatch[1]);
        const dayMax = text.match(/\$(\d+\.?\d*)\s*Day\s*Maximum/i);
        rates.push({
          type: "hourly",
          label,
          amount: hourlyRate,
          hourlyRate,
          maxDaily: dailyMaxAmount ?? (dayMax ? parseFloat(dayMax[1]) : undefined),
        });
      }

      // Evening flat rate
      const eveningMatch = text.match(/\$(\d+\.?\d*)\s*(Evening|Night)\s*(Flat\s*)?(Rate|Maximum)/i);
      if (eveningMatch) {
        rates.push({ type: "flat", label, amount: parseFloat(eveningMatch[1]) });
      }

      // Early bird
      const earlyBirdMatch = text.match(/Early Bird[^$]*?\$(\d+\.?\d*)/i);
      if (earlyBirdMatch) {
        rates.push({
          type: "flat",
          label: "Early Bird",
          amount: parseFloat(earlyBirdMatch[1]),
          maxDaily: dailyMaxAmount,
        });
      }

      // If the cell text has a single price and no hourly/flat/early bird matched, add as flat
      if (!hourlyMatch && !eveningMatch && !earlyBirdMatch && allPrices.length === 1) {
        rates.push({ type: "flat", label, amount: allPrices[0] });
      }
    }
  }

  return rates;
}

function defaultHours(): Record<string, { open: string; close: string }> {
  const days = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const h: Record<string, { open: string; close: string }> = {};
  for (const d of days) h[d] = { open: "06:00", close: "23:00" };
  return h;
}

async function fetchWithRetry(url: string, retries = 2): Promise<string> {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
      if (res.ok) return res.text();
      throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      if (i === retries) throw err;
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw new Error("fetch failed");
}

// Exported for testing
export { fetchWithRetry, parseMarkers, parseRates };

export const easyParkScraper: Scraper = {
  provider: "easypark",

  async scrape(): Promise<ScrapeResult> {
    console.log("[easypark] Fetching lot locations page...");
    const locationsHtml = await fetchWithRetry(`${BASE}/find-parking/locations-and-lot-information`);
    const allMarkers = parseMarkers(locationsHtml);

    const vanMarkers = allMarkers.filter((m) => m.city === "Vancouver");
    console.log(`[easypark] Found ${vanMarkers.length} Vancouver lots out of ${allMarkers.length} total`);

    const rawLots: RawLot[] = [];
    const idCounts = new Map<string, number>();

    for (let i = 0; i < vanMarkers.length; i++) {
      const m = vanMarkers[i];
      console.log(`[easypark]   [${i + 1}/${vanMarkers.length}] ${m.title || m.street}...`);

      try {
        const detailHtml = await fetchWithRetry(`${BASE}/find-parking/locations-and-lot-information/lot-details/${m.locurl}`);
        const rates = parseRates(detailHtml);

        const baseId = `easypark-${m.LotNumber}`;
        const count = idCounts.get(baseId) || 0;
        const id = count === 0 ? baseId : `${baseId}-${count + 1}`;
        idCounts.set(baseId, count + 1);

        const lot: RawLot = {
          id,
          provider: "easypark",
          name: m.title || m.street,
          address: `${m.street}, ${m.city}, ${m.state}`,
          lat: parseFloat(m.lat),
          lng: parseFloat(m.lng),
          rates,
          features: parseFeatures(m.features),
          hours: defaultHours(),
          sourceUrl: `${BASE}/find-parking/locations-and-lot-information/lot-details/${m.locurl}`,
        };

        rawLots.push(lot);
      } catch (err) {
        console.log(`[easypark]     FAILED: ${err}`);
      }

      // Be polite - small delay between requests
      if (i < vanMarkers.length - 1) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    console.log(`[easypark] Done. ${rawLots.length} lots scraped with rates.`);
    return {
      provider: "easypark",
      timestamp: new Date().toISOString(),
      data: rawLots,
    };
  },
};

// Run directly: tsx src/scrapers/easypark.ts
const isMain = process.argv[1]?.includes("easypark");
if (isMain) {
  easyParkScraper.scrape().then((result) => {
    console.log(`\nScraped ${result.data.length} lots from ${result.provider}`);
    console.log(JSON.stringify(result.data.slice(0, 2), null, 2));
  });
}
