# Parking Data — Agent Guide

## Project
Data pipeline for Vancouver parking price comparison. Scrapes provider websites/APIs, normalizes to canonical schema, outputs JSON for `parking-web` to consume.

## Status
- **Indigo scraper** ✅ — 172 lots via Salesforce REST API (expanded pagination: 30/page, up to 20 pages, stops on empty). Rates API returns "No Rates Available".
- **EasyPark scraper** ✅ — 137 Vancouver lots, ~3 rates/lot via HTML scraping. No Playwright needed.
- **Impark scraper** ✅ — Product-first: fetches all 481 WooCommerce sitemap slugs, matches to 44 OSM Impark lots (bbox expanded to 49.0,-123.5,49.5,-122.5). 6 matching strategies (address, name, suffix stripping, split, fuzzy words, named-lot lookup). Two-pass: OSM→slug + reverse slug→OSM keyword matching. **52 lots with pricing**, 66 unmatched Vancouver-area slugs in `data/impark-unmatched-products.json`.
- **Total pipeline output**: 361 lots (172 Indigo + 137 EasyPark + 52 Impark), 431 pricing rules.
- **GitHub Actions pipeline** ✅ — Daily cron at 8am UTC. Runs scrape + test + commits data.
- **PreciseParkLink** ⬜ — Backlog. API at `findparkingnearme.ca/Home/GetMapContent`. See `dump.md`.

## Architecture
```
src/
  scrapers/
    types.ts        — Shared interfaces (RawLot, Scraper, etc.)
    index.ts        — Registry of all scrapers
    indigo.ts       — ✅ Indigo scraper (Salesforce API)
    easypark.ts     — ✅ EasyPark scraper (ASP.NET HTML parsing)
    impark.ts       — ✅ WooCommerce sitemap + OSM Overpass (52 lots matched)
  normalizer/
    index.ts        — RawLot[] → ParkingData (canonical schema)
  lib/
    schemas.ts      — Zod schemas (mirrored from parking-web)
  __tests__/
    normalizer.test.ts
  index.ts          — Pipeline runner
data/
  parking-data.json         — Pipeline output (361 lots)
  impark-unmatched-products.json  — 66 unmatched Vancouver-area slugs
.github/workflows/
  scrape.yml        — Daily cron + commit
```

## Scraper Interface
Every scraper exports a `Scraper` object with `{ provider: string, scrape(): Promise<ScrapeResult> }`.
Register new scrapers in `src/scrapers/index.ts`.

## Key Commands
- `npm run scrape` — Run full pipeline, output to stdout + `/tmp/parking-scrape.log`
- `npm test` — Run tests
- `npm run scrape:impark` — Run just Impark scraper

## Provider-Specific Notes
- **Indigo**: Salesforce API at `salesforce.parkindigo.com/locations` with bounding box. Paginates at 30 results/page regardless of `size` param. Rates at Azure function, returns "No Rates Available".
- **EasyPark**: ASP.NET Sitefinity CMS. Lot list at `/find-parking/locations-and-lot-information`. Detail pages at `/find-parking/locations-and-lot-information/lot-details/{locurl}`. Plain fetch works.
- **Impark**: WordPress/WooCommerce/Cloudflare. Product-first approach: sitemap → fetch product pages for pricing → match to OSM lots for coordinates. OSM is coordinate source only. 1.5s delay between product page fetches to avoid rate-limiting. Monthly price from JSON-LD `AggregateOffer.lowPrice`. Product name from `<h1>` element (no class attribute). 66 Vancouver-area slugs still unmatched — need manual OSM mapping or additional matching strategies.
- **PreciseParkLink**: Backlog. API at `findparkingnearme.ca/Home/GetMapContent?parkType=hourly` returns JSON with prices, features.

## Data Flow
```
scraper (fetch + parse) → RawLot[] → normalize() → ParkingData (ParkingLot[] + PricingRule[])
```
- `raw/id`: `{provider}-{provider-specific-id}`, e.g. `impark-901-seymour-street`
- `raw/rates`: Array of `{ type, label, amount, hourlyRate? }`
- `normalize()` maps each `RawLot` to one `ParkingLot` + one or more `PricingRule` entries
