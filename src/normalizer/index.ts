import type { ParkingLot, PricingRule, ParkingData } from "../lib/schemas.js";
import type { RawLot, RawRate } from "../scrapers/types.js";

function generateId(): string {
  return crypto.randomUUID().slice(0, 8);
}

function dayName(i: number): string {
  return ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][i];
}

function normalizeRate(lotId: string, rate: RawRate, index: number): PricingRule {
  const base: PricingRule = {
    id: `rule-${lotId}-${index}`,
    lotId,
    type: rate.type,
    timeRanges: [{ start: "00:00", end: "23:59", days: dayNames() }],
  };

  switch (rate.type) {
    case "flat":
      return { ...base, amount: rate.amount };
    case "hourly":
      return { ...base, hourlyRate: rate.hourlyRate ?? rate.amount, maxDaily: rate.maxDaily };
    case "incremental":
      return { ...base, amount: rate.amount, maxDaily: rate.maxDaily };
    default:
      return { ...base, hourlyRate: rate.amount };
  }
}

function dayNames(): string[] {
  return Array.from({ length: 7 }, (_, i) => dayName(i));
}

export function normalize(rawLots: RawLot[]): ParkingData {
  const lots: ParkingLot[] = [];
  const rules: PricingRule[] = [];
  const now = new Date().toISOString();

  for (const raw of rawLots) {
    const id = raw.id || `lot-${generateId()}`;

    const lot: ParkingLot = {
      id,
      operator: raw.provider as ParkingLot["operator"],
      name: raw.name,
      address: raw.address,
      coordinates: { lat: raw.lat, lng: raw.lng },
      features: { ev: raw.features.ev, covered: raw.features.covered },
      hours: raw.hours,
      metadata: {
        source: raw.provider,
        confidence: 0.7,
        lastUpdated: now,
        ...(raw.sourceUrl ? { sourceUrl: raw.sourceUrl } : {}),
      },
    };

    lots.push(lot);

    raw.rates.forEach((rate, i) => {
      rules.push(normalizeRate(id, rate, i));
    });
  }

  return {
    lots,
    rules,
    generatedAt: now,
    schema: "v1",
  };
}
