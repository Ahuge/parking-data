import type { Scraper, ScrapeResult, ProviderConfig } from "./types.js";
import { indigoScraper } from "./indigo.js";
import { easyParkScraper } from "./easypark.js";
import { imparkScraper } from "./impark.js";

/** Register all scrapers here. Add new ones as they're built. */
const registry: Record<string, Scraper> = {
  indigo: indigoScraper,
  easypark: easyParkScraper,
  impark: imparkScraper,
};

export const PROVIDERS: ProviderConfig[] = Object.entries(registry).map(([name, scraper]) => ({
  name,
  scraper,
  enabled: true,
}));

export async function scrapeAll(): Promise<ScrapeResult[]> {
  const results: ScrapeResult[] = [];

  for (const config of PROVIDERS) {
    if (!config.enabled) {
      console.log(`[pipeline] Skipping disabled provider: ${config.name}`);
      continue;
    }
    try {
      console.log(`\n[scraper] Starting: ${config.name}`);
      const result = await config.scraper.scrape();
      console.log(`[scraper] ${config.name}: ${result.data.length} lots`);
      results.push(result);
    } catch (err) {
      console.error(`[scraper] ${config.name} FAILED:`, err);
    }
  }

  return results;
}
