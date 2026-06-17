# Scraper Developer Handoff

Each provider has its own scraper module. This doc captures what we know so another agent can build the remaining scrapers independently.

## Architecture

```
src/scrapers/
  types.ts        — Scraper interface, RawLot, RawRate, ScrapeResult
  index.ts        — Registry of all scrapers
  indigo.ts       — ✅ Complete. Uses Salesforce REST API.
  impark.ts       — ❌ Needs Playwright + Cloudflare bypass
  easypark.ts     — ❌ Needs Playwright + SPA interaction
```

### Scraper Contract

Every scraper exports a `Scraper` object:
```ts
export const myScraper: Scraper = {
  provider: "my-provider",
  async scrape(): Promise<ScrapeResult> {
    // Must return { provider, timestamp, data: RawLot[] }
  }
};
```

Then register it in `src/scrapers/index.ts`.

---

## Provider: Indigo ✅ (Done)

| Detail | Value |
|--------|-------|
| API type | Salesforce REST API (no auth) |
| Locations | `GET https://salesforce.parkindigo.com/locations` |
| Rates | `POST https://indigo-ca-grs-api-....azurefd.net/GetMultipleRates` |
| Status | 30 Vancouver-area lots, rates API returns "No Rates Available" for these lots |
| File | `src/scrapers/indigo.ts` |

**Bounding box param**: `box.first.x=north_lat&box.first.y=west_lng&box.second.x=south_lat&box.second.y=east_lng&page=N&size=100`

---

## Provider: Impark ❌ (Needs Agent)

### Site Info
| Detail | Value |
|--------|-------|
| URL | `https://imparknow.com/ca/` |
| Protection | **Cloudflare** — blocks curl, blocks headless Playwright after repeated requests |
| Type | Heavy SPA (Google Maps, OneTrust, Chatbase) |
| Status | Needs investigation |

### What We Know
1. **WordPress AJAX endpoint**: `https://imparknow.com/ca/wp-admin/admin-ajax.php`
2. **Working action**: `parking_get_neighborhoods&city_id=6453` — returns neighbourhoods with IDs, names, coords. Requires browser-like headers (`Referer`, `X-Requested-With`).
3. The `find-parking/` page loads via JS — needs Playwright
4. Playwright initially worked (once) then got Cloudflare-blocked

### Strategy to Try
1. **API discovery**: Load `https://imparknow.com/ca/find-parking/` in Playwright with:
   - Stealth evasions (custom user-agent, viewport, locale, etc.)
   - Fresh IP / proxy rotation if needed
   - Intercept all network requests to discover the lot/pricing API
2. **Known endpoints to probe** (via admin-ajax.php):
   - `action=parking_get_lots&neighbourhood_id=N`
   - `action=parking_get_parking_lots&neighbourhood_id=N`
   - `action=parking_get_locations&neighbourhood_id=N`
   - `action=parking_get_facilities&neighbourhood_id=N`
3. **Fallback**: Check `https://www.impark.com` (US site) for different API patterns
4. **Last resort**: Use Playwright to fill search form and extract results from DOM

### Playwright Setup
```ts
import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ...",
  viewport: { width: 1280, height: 800 },
});
// Intercept all API responses
page.on("response", async (res) => { ... });
await page.goto("https://imparknow.com/ca/find-parking/", { waitUntil: "domcontentloaded" });
```

---

## Provider: EasyPark ❌ (Needs Agent)

### Site Info
| Detail | Value |
|--------|-------|
| URL | `https://www.easypark.ca/` |
| Type | React SPA (ASP.NET backend) |
| Status | Needs investigation |

### What We Know
1. **No public REST API found** — all `/api/*` paths return ASP.NET 404
2. **`api.easypark.ca`** subdomain exists but returns empty response
3. Page is a minimal SPA shell (582 bytes HTML)
4. The mobile app likely uses a different API

### Strategy to Try
1. **API discovery**: Load `https://www.easypark.ca/find-parking` in Playwright and intercept all network requests
2. **Mobile API**: Try common mobile API patterns:
   - `https://api.easypark.ca/v1/parking`
   - `https://api.easypark.ca/v1/locations`
   - `https://api.easypark.ca/v1/rates`
3. **Mobile app reverse engineering**: Check if the EasyPark mobile app has a documented or detectable API
4. **Playwright interaction**: Click through the SPA to find where lot data loads
   - Look for network calls when searching for a city
   - Look for graphql endpoints
   - Look for Firebase/Firestore usage

### Expected Lot Structure
Based on Indigo's data, each lot should have at minimum:
- `name` — lot name
- `address` — street address
- `lat`/`lng` — coordinates
- `rates` — pricing rules (hourly, flat, incremental)
- `features.ev` / `features.covered` — amenities

---

## Testing Your Scraper

```bash
# Run just your scraper
node /path/to/tsx src/scrapers/your-provider.ts

# Run full pipeline
npm run scrape

# Run tests
npm test
```

Your scraper output should match the `RawLot` interface in `src/scrapers/types.ts`. The normalizer in `src/normalizer/index.ts` will convert it to the canonical schema automatically.

Register your completed scraper in `src/scrapers/index.ts`.
