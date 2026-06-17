import { describe, it, expect } from "vitest";
import { normalize } from "../normalizer/index.js";
import type { RawLot } from "../scrapers/types.js";

const mockRawLot: RawLot = {
  id: "indigo-999999",
  provider: "indigo",
  name: "Test Lot",
  address: "123 Test St, Vancouver, BC",
  lat: 49.282,
  lng: -123.12,
  rates: [
    { type: "hourly", label: "Hourly", amount: 5, hourlyRate: 5, maxDaily: 25 },
  ],
  features: { ev: true, covered: false },
  hours: {
    mon: { open: "06:00", close: "23:00" },
    tue: { open: "06:00", close: "23:00" },
    wed: { open: "06:00", close: "23:00" },
    thu: { open: "06:00", close: "23:00" },
    fri: { open: "06:00", close: "23:00" },
    sat: { open: "07:00", close: "22:00" },
    sun: { open: "08:00", close: "20:00" },
  },
  externalId: "999999",
};

describe("normalizer", () => {
  it("converts RawLot to ParkingLot", () => {
    const result = normalize([mockRawLot]);

    expect(result.schema).toBe("v1");
    expect(result.lots).toHaveLength(1);
    expect(result.rules).toHaveLength(1);

    const lot = result.lots[0];
    expect(lot.id).toBe("indigo-999999");
    expect(lot.operator).toBe("indigo");
    expect(lot.name).toBe("Test Lot");
    expect(lot.coordinates.lat).toBe(49.282);
    expect(lot.coordinates.lng).toBe(-123.12);
    expect(lot.features.ev).toBe(true);
    expect(lot.features.covered).toBe(false);
    expect(lot.metadata.source).toBe("indigo");
    expect(lot.metadata.confidence).toBe(0.7);
  });

  it("converts hourly rate to PricingRule", () => {
    const result = normalize([mockRawLot]);
    const rule = result.rules[0];

    expect(rule.lotId).toBe("indigo-999999");
    expect(rule.type).toBe("hourly");
    expect(rule.hourlyRate).toBe(5);
    expect(rule.maxDaily).toBe(25);
    expect(rule.timeRanges).toHaveLength(1);
  });

  it("converts flat rate", () => {
    const lot = {
      ...mockRawLot,
      rates: [{ type: "flat" as const, label: "Evening", amount: 10 }],
    };
    const result = normalize([lot]);
    const rule = result.rules[0];

    expect(rule.type).toBe("flat");
    expect(rule.amount).toBe(10);
  });

  it("handles multiple lots", () => {
    const lotB = { ...mockRawLot, id: "other", name: "Lot B" };
    const result = normalize([mockRawLot, lotB]);

    expect(result.lots).toHaveLength(2);
    expect(result.rules).toHaveLength(2);
  });

  it("handles empty rates", () => {
    const lot = { ...mockRawLot, rates: [] };
    const result = normalize([lot]);

    expect(result.lots).toHaveLength(1);
    expect(result.rules).toHaveLength(0);
  });

  it("generates metadata timestamp", () => {
    const before = new Date().toISOString();
    const result = normalize([mockRawLot]);
    const after = new Date().toISOString();

    expect(result.generatedAt >= before).toBe(true);
    expect(result.generatedAt <= after).toBe(true);
  });

  it("preserves operator from provider field", () => {
    const impark = { ...mockRawLot, provider: "impark" as const };
    const easypark = { ...mockRawLot, provider: "easypark" as const };
    const privateLot = { ...mockRawLot, provider: "private" as const };

    const result = normalize([impark, easypark, privateLot]);
    expect(result.lots[0].operator).toBe("impark");
    expect(result.lots[1].operator).toBe("easypark");
    expect(result.lots[2].operator).toBe("private");
  });
});
