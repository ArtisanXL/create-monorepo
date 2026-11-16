import { z } from "zod";

export const HealthResponse = z.object({
  status: z.enum(["ok", "degraded"]),
  db: z.enum(["up", "down"]),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

export const FormatPriceRequest = z.object({
  /** Integer amount in minor units, as a string (JSON cannot carry bigint). */
  amount: z.string().regex(/^-?\d+$/, "must be an integer"),
  currency: z.string().regex(/^[A-Za-z]{3}$/, "must be a 3-letter ISO 4217 code"),
  locale: z
    .string()
    .refine((v) => {
      try {
        return Intl.getCanonicalLocales(v).length === 1;
      } catch {
        return false;
      }
    }, "must be a valid BCP 47 locale")
    .default("en-US"),
});
export type FormatPriceRequest = z.infer<typeof FormatPriceRequest>;

export const FormatPriceResponse = z.object({ formatted: z.string() });
export type FormatPriceResponse = z.infer<typeof FormatPriceResponse>;
