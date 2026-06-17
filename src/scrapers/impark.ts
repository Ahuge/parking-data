import type { RawLot, ScrapeResult, Scraper } from "./types.js";

const SITEMAP_URL = "https://imparknow.com/ca/product-sitemap.xml";
const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

interface OSMLot {
  name: string;
  address: string;
  lat: number;
  lng: number;
  parkingType: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithTimeout(url: string, timeoutMs = 30000): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-CA,en;q=0.9",
        Referer: "https://imparknow.com/ca/shop/",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithRetry(url: string, retries = 3): Promise<string> {
  for (let i = 0; i < retries; i++) {
    try {
      return await fetchWithTimeout(url);
    } catch (e) {
      if (i === retries - 1) throw e;
      await sleep(2000 * (i + 1));
    }
  }
  throw new Error("unreachable");
}

async function queryOverpass(query: string): Promise<any> {
  for (let i = 0; i < 3; i++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30000);
      const res = await fetch(OVERPASS_URL, {
        signal: ctrl.signal,
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "VancouverParkingFinder/1.0",
        },
        body: `data=${encodeURIComponent(query)}`,
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (i === 2) throw e;
      await sleep(2000 * (i + 1));
    }
  }
}

async function getOsmLots(): Promise<OSMLot[]> {
  const q = `
    [out:json];
    nwr["amenity"="parking"]["operator"~"Impark|Imperial",i](49.0,-123.5,49.5,-122.5);
    out center;
  `;
  const data = await queryOverpass(q);
  return data.elements
    .filter((e: any) => e.tags && (e.lat || e.center))
    .map((e: any) => {
      const t = e.tags;
      const lat = e.lat ?? e.center?.lat;
      const lng = e.lon ?? e.center?.lon;
      const street = [t["addr:housenumber"], t["addr:street"]].filter(Boolean).join(" ");
      return {
        name: t.name || t.operator || "Impark",
        address: street || t.address || "",
        lat, lng,
        parkingType: t.parking || "",
      };
    })
    .filter((l: OSMLot) => l.lat && l.lng);
}

function toSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

async function getAllProductSlugs(): Promise<Map<string, string>> {
  const sitemap = await fetchWithRetry(SITEMAP_URL);
  const slugs = new Map<string, string>();
  for (const m of sitemap.matchAll(/imparknow\.com\/ca\/product\/([^<]+)\//g)) {
    slugs.set(m[1], m[1]);
  }
  return slugs;
}

function extractPricing(html: string): { hourlyRate: number | null; monthlyPrice: number | null } {
  const baseRateMatch = html.match(/baseRate[^>]*>Parking:\s*\$([0-9.]+)/);
  const hourlyRate = baseRateMatch && parseFloat(baseRateMatch[1]) > 0 ? parseFloat(baseRateMatch[1]) : null;
  const ldMatch = html.match(/<script type="application\/ld\+json">([^<]+)<\/script>/);
  let monthlyPrice: number | null = null;
  if (ldMatch) {
    try {
      const ld = JSON.parse(ldMatch[1]);
      const offers = ld.offers as Record<string, unknown> | undefined;
      if (offers) {
        const priceSpec = offers.priceSpecification as Record<string, unknown>[] | undefined;
        if (priceSpec && priceSpec.length > 0) {
          monthlyPrice = parseFloat(priceSpec[0].price as string) || null;
        }
        if (!monthlyPrice) {
          const lp = offers.lowPrice as string | undefined;
          if (lp) monthlyPrice = parseFloat(lp) || null;
        }
      }
    } catch { /* ignore */ }
  }
  return { hourlyRate, monthlyPrice };
}

function extractProductName(html: string): string | null {
  const m = html.match(/<h1[^>]*>([^<]+)<\/h1>/);
  return m ? m[1].trim() : null;
}

function guessHours(): Record<string, { open: string; close: string }> {
  const days = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const hours: Record<string, { open: string; close: string }> = {};
  for (const d of days) hours[d] = { open: "06:00", close: "23:00" };
  return hours;
}

// Enhanced matching: find the best sitemap slug for an OSM lot
function findBestSlug(osm: OSMLot, allSlugs: Map<string, string>): string | null {
  // Strategy 1: try address as slug
  if (osm.address) {
    const s = toSlug(osm.address);
    if (s && allSlugs.has(s)) return s;
  }
  // Strategy 2: try full name as slug
  if (osm.name && osm.name !== "Impark") {
    const s = toSlug(osm.name);
    if (s && allSlugs.has(s)) return s;
  }
  // Strategy 3: try name without " - Lot #NNNN" suffix
  if (osm.name && osm.name !== "Impark") {
    const stripped = osm.name.replace(/[-–]\s*Lot\s*#?\d+/i, "").trim();
    if (stripped && stripped !== osm.name) {
      const s = toSlug(stripped);
      if (s && allSlugs.has(s)) return s;
    }
  }
  // Strategy 4: split name on "/" and try each part
  if (osm.name && osm.name.includes("/")) {
    for (const part of osm.name.split("/")) {
      const s = toSlug(part.trim());
      if (s && allSlugs.has(s)) return s;
    }
  }
  // Strategy 5: fuzzy name words — find slug containing all significant name words
  if (osm.name && osm.name !== "Impark") {
    const cleaned = osm.name.replace(/[-–]\s*Lot\s*#?\d+/i, "").replace(/[\/&]/g, " ").toLowerCase();
    const words = [...new Set(cleaned.split(/\s+/).filter((w) => w.length >= 3 && !["the", "and", "for"].includes(w)))];
    if (words.length > 0) {
      for (const [slug] of allSlugs) {
        if (words.every((w) => slug.includes(w))) return slug;
      }
    }
  }
  // Strategy 6: try known named-lot slugs
  if (osm.name && osm.name !== "Impark") {
    const known: Record<string, string> = {
      "river rock casino resort": "river-rock-casino-resort",
      "lion's mark": "lions-mark",
      "station tower": "station-tower",
      "scott road park & ride": "scott-road-park-ride",
      "horseshoe bay terminal": "horseshoe-bay-terminal",
      "miramar village": "miramar-village",
    };
    const osmLower = osm.name.toLowerCase();
    for (const [key, slug] of Object.entries(known)) {
      if (osmLower.includes(key)) return slug;
    }
  }
  return null;
}

// Reverse match: find best OSM lot for a slug by comparing slug keywords to OSM lot names/addresses
function findOsmForSlug(slug: string, osmLots: OSMLot[]): OSMLot | null {
  const slugWords = slug.split("-").filter((w) => w.length >= 3 && !["the", "and", "for", "west", "east", "street", "avenue", "drive", "road", "place"].includes(w));
  if (slugWords.length === 0) return null;

  let best: { lot: OSMLot; score: number } | null = null;
  for (const lot of osmLots) {
    const target = (lot.name + " " + lot.address).toLowerCase();
    let score = 0;
    for (const w of slugWords) {
      const re = new RegExp("\\b" + w + "\\b", "i");
      if (re.test(target)) score += w.length > 4 ? 2 : 1;
    }
    if (score > 0 && (!best || score > best.score)) best = { lot, score };
  }

  return best && best.score >= 2 ? best.lot : null;
}

export const imparkScraper: Scraper = {
  provider: "impark",

  async scrape(): Promise<ScrapeResult> {
    console.log("[impark] Fetching OSM Impark lot data...");
    const osmLots = await getOsmLots();
    console.log(`[impark] ${osmLots.length} OSM Impark lots with coordinates`);

    console.log("[impark] Fetching product sitemap...");
    let allSlugs: Map<string, string>;
    try {
      allSlugs = await getAllProductSlugs();
      console.log(`[impark] ${allSlugs.size} total products in sitemap`);
    } catch {
      console.log("[impark] Could not fetch sitemap, aborting");
      return { provider: "impark", timestamp: new Date().toISOString(), data: [] };
    }

    const usedSlugs = new Set<string>();
    const lots: RawLot[] = [];

    // Phase 1: OSM→Product matching (only fetch pages for matched slugs)
    for (const osm of osmLots) {
      const slug = findBestSlug(osm, allSlugs);
      if (!slug) continue;

      usedSlugs.add(slug);
      await sleep(1500);
      const url = `https://imparknow.com/ca/product/${slug}/`;
      console.log(`[impark] Fetching ${slug}...`);

      let html: string;
      try {
        html = await fetchWithRetry(url);
      } catch {
        console.log(`[impark]   Failed to fetch ${slug}`);
        continue;
      }

      const { hourlyRate, monthlyPrice } = extractPricing(html);
      if (!hourlyRate && !monthlyPrice) {
        console.log(`[impark]   No rates for ${slug}`);
        continue;
      }

      const productName = extractProductName(html) || slug;
      const rates: RawLot["rates"] = [];
      if (hourlyRate) rates.push({ type: "hourly", label: "Hourly", amount: hourlyRate, hourlyRate });
      if (monthlyPrice) rates.push({ type: "flat", label: "Monthly", amount: monthlyPrice });

      lots.push({
        id: `impark-${slug}`,
        provider: "impark",
        name: productName,
        address: osm.address || productName,
        lat: osm.lat,
        lng: osm.lng,
        rates,
        features: { ev: false, covered: osm.parkingType === "underground" || osm.parkingType === "multi-storey" },
        hours: guessHours(),
      });
      console.log(`[impark] ✓ ${productName} — $${hourlyRate}/hr`);
    }

    // Phase 2: Reverse matching — for remaining OSM lots, try keyword-based slug→OSM matching
    const remainingLots = osmLots.filter((l) => !lots.some((r) => r.lat === l.lat && r.lng === l.lng));
    if (remainingLots.length > 0) {
      console.log(`[impark] ${remainingLots.length} OSM lots still unmatched — trying reverse keyword matching...`);
      for (const [slug] of allSlugs) {
        if (usedSlugs.has(slug)) continue;
        const osmMatch = findOsmForSlug(slug, remainingLots);
        if (!osmMatch) continue;

        usedSlugs.add(slug);
        await sleep(1500);
        const url = `https://imparknow.com/ca/product/${slug}/`;
        console.log(`[impark] Fetching ${slug}...`);

        let html: string;
        try {
          html = await fetchWithRetry(url);
        } catch {
          continue;
        }

        const { hourlyRate, monthlyPrice } = extractPricing(html);
        if (!hourlyRate && !monthlyPrice) continue;

        const productName = extractProductName(html) || slug;
        const rates: RawLot["rates"] = [];
        if (hourlyRate) rates.push({ type: "hourly", label: "Hourly", amount: hourlyRate, hourlyRate });
        if (monthlyPrice) rates.push({ type: "flat", label: "Monthly", amount: monthlyPrice });

        lots.push({
          id: `impark-${slug}`,
          provider: "impark",
          name: productName,
          address: osmMatch.address || productName,
          lat: osmMatch.lat,
          lng: osmMatch.lng,
          rates,
          features: { ev: false, covered: osmMatch.parkingType === "underground" || osmMatch.parkingType === "multi-storey" },
          hours: guessHours(),
        });
        console.log(`[impark] ✓ ${productName} — $${hourlyRate}/hr (reverse match)`);
      }
    }

    // Phase 3: Identify unmatched Vancouver-area slugs for future mapping
    const vanKeywords = new Set([
      "vancouver", "burnaby", "richmond", "surrey", "langley", "delta",
      "coquitlam", "port-moody", "port-coquitlam", "new-westminster",
      "north-vancouver", "west-vancouver",
      "granville", "georgia", "burrard", "howe", "thurlow", "hornby",
      "robson", "denman", "davie", "alberni", "nelson", "smithe",
      "helmcken", "dunsmuir", "pender", "cordova", "hastings",
      "broadway", "kingsway", "oak", "cambie", "main", "fraser",
      "knight", "victoria", "renfrew", "rupert", "gilmore", "willingdon",
      "gilford", "marinaside", "aquarius", "water", "carroll", "richards",
      "seymour", "hamilton", "beatty", "abbott", "gastown", "yaletown",
      "coal-harbour", "false-creek", "fairview", "mount-pleasant",
      "kitsilano", "point-grey", "dunbar", "kerrisdale", "marpole",
      "strathcona", "west-end", "river-rock", "scott-road", "brownsville",
      "annacis", "tilbury", "ladner", "tsawwassen", "steveston",
      "lions-gate", "ironworkers", "patullo", "knight-street",
      "granville-island", "science-world", "bc-place", "rogers-arena",
      "stanley-park", "queen-elizabeth", "van-dusen", "u-b-c", "sfu",
      "marine-drive", "kingsway", "lougheed", "barnet", "hastings-st",
    ]);
    function isVancouverSlug(slug: string): boolean {
      const slugLower = slug.toLowerCase().replace(/[^a-z0-9\s-]/g, "");
      for (const kw of vanKeywords) {
        if (slugLower.includes(kw)) return true;
      }
      return false;
    }
    const unmatchedVanSlugs: string[] = [];
    for (const [slug] of allSlugs) {
      if (!usedSlugs.has(slug) && isVancouverSlug(slug)) {
        unmatchedVanSlugs.push(slug);
      }
    }
    if (unmatchedVanSlugs.length > 0) {
      console.log(`[impark] ⚠ ${unmatchedVanSlugs.length} unmatched Vancouver-area product slugs:`);
      for (const s of unmatchedVanSlugs) console.log(`[impark]   ✗ ${s}`);
      try {
        const fs = await import("fs/promises");
        await fs.writeFile(
          "data/impark-unmatched-products.json",
          JSON.stringify({ timestamp: new Date().toISOString(), slugs: unmatchedVanSlugs }, null, 2),
        );
        console.log("[impark] Unmatched slugs written to data/impark-unmatched-products.json");
      } catch { /* non-fatal if fs unavailable */ }
    }

    console.log(`[impark] Done. ${lots.length} Impark lots with pricing`);
    return { provider: "impark", timestamp: new Date().toISOString(), data: lots };
  },
};

if (process.argv[1]?.endsWith("impark.ts")) {
  imparkScraper.scrape().then((r) => console.log(JSON.stringify(r, null, 2)));
}