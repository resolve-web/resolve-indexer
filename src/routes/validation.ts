import { z } from "zod/v3";

/** Stellar account (G...) or contract (C...) address-ish validation. */
export const StellarAddressSchema = z
  .string()
  .min(56)
  .max(69)
  .regex(/^[GC][A-Z0-9]+$/, "invalid stellar address");

export const MarketIdSchema = z.coerce
  .number()
  .int()
  .nonnegative()
  .refine((n) => Number.isSafeInteger(n), "market id too large");

export const PaginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.coerce.number().int().positive().optional(),
});

export const MarketStatusQuerySchema = z
  .enum(["open", "resolved", "invalid"])
  .optional();

export function formatZodError(err: z.ZodError): {
  error: string;
  details: unknown;
} {
  return {
    error: "validation_error",
    details: err.flatten(),
  };
}
