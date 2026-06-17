import { z } from "zod";

export const Coordinates = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

export const Features = z.object({
  ev: z.boolean(),
  covered: z.boolean(),
});

export const Metadata = z.object({
  source: z.string(),
  confidence: z.number().min(0).max(1),
  lastUpdated: z.string().datetime(),
});

export const OperatingHours = z.record(
  z.string(),
  z
    .object({
      open: z.string(),
      close: z.string(),
    })
    .nullable()
);

export const ParkingLot = z.object({
  id: z.string(),
  operator: z.enum(["easypark", "indigo", "impark", "private"]),
  name: z.string(),
  address: z.string(),
  coordinates: Coordinates,
  features: Features,
  hours: OperatingHours,
  metadata: Metadata,
});

export const PricingIncrement = z.object({
  minutes: z.number().positive(),
  price: z.number().nonnegative(),
});

export const TimeRange = z.object({
  start: z.string(),
  end: z.string(),
  days: z.array(z.string()),
});

export const PricingRule = z.object({
  id: z.string(),
  lotId: z.string(),
  type: z.enum(["flat", "hourly", "incremental"]),
  amount: z.number().nonnegative().optional(),
  hourlyRate: z.number().nonnegative().optional(),
  increments: z.array(PricingIncrement).optional(),
  maxDaily: z.number().nonnegative().optional(),
  timeRanges: z.array(TimeRange),
  conditions: z
    .object({
      minHours: z.number().nonnegative().optional(),
      maxHours: z.number().nonnegative().optional(),
    })
    .optional(),
});

export const ParkingData = z.object({
  lots: z.array(ParkingLot),
  rules: z.array(PricingRule),
  generatedAt: z.string().datetime(),
  schema: z.literal("v1"),
});

export type ParkingLot = z.infer<typeof ParkingLot>;
export type PricingRule = z.infer<typeof PricingRule>;
export type ParkingData = z.infer<typeof ParkingData>;
export type Metadata = z.infer<typeof Metadata>;
