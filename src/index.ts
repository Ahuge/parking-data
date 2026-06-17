import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { scrapeAll } from "./scrapers/index.js";
import { normalize } from "./normalizer/index.js";
import type { ParkingData } from "./lib/schemas.js";

const DATA_DIR = join(process.cwd(), "data");

async function run() {
  console.log("=== Vancouver Parking Data Pipeline ===\n");

  // Phase 1: Scrape all providers
  const results = await scrapeAll();

  // Phase 2: Normalize
  const allLots = results.flatMap((r) => r.data);
  console.log(`\n--- Normalizing ${allLots.length} lots from ${results.length} providers ---`);
  const data = normalize(allLots);

  // Phase 3: Write output
  mkdirSync(DATA_DIR, { recursive: true });
  const outFile = join(DATA_DIR, "parking-data.json");
  writeFileSync(outFile, JSON.stringify(data, null, 2));
  console.log(`\n✓ Wrote ${outFile}`);
  console.log(`  ${data.lots.length} lots, ${data.rules.length} rules, schema ${data.schema}`);
}

run().catch((err) => {
  console.error("Pipeline failed:", err);
  process.exit(1);
});
