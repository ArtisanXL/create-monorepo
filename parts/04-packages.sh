# --- Package helper ------------------------------------------------------------------------
lib_pkg() { # $1=dir  $2=deps-json  $3=devdeps-json  $4=extra-scripts-json
  local name deps devdeps scripts
  name="$(basename "$1")"
  deps="${2:-}"; [[ -n "$deps" ]] || deps="{}"
  devdeps="${3:-}"; [[ -n "$devdeps" ]] || devdeps="{}"
  scripts='"typecheck": "tsc -p ."'
  [[ -z "${4:-}" ]] || scripts+=", $4"
  emit "$1/package.json" <<EOF
{
  "name": "__SCOPE__/$name",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { $scripts },
  "dependencies": $deps,
  "devDependencies": $devdeps
}
EOF
  emit "$1/tsconfig.json" <<'EOF'
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "*.config.ts"]
}
EOF
}

# --- packages/domain ---------------------------------------------------------------------
lib_pkg packages/domain
emit packages/domain/src/index.ts <<'EOF'
export * from "./money/money.ts";
EOF
emit packages/domain/src/money/money.ts <<'EOF'
/** Money: amount in minor units (cents) as bigint + ISO 4217 currency. Never use number. */
export interface Money {
  readonly amount: bigint;
  readonly currency: string;
}

export class CurrencyMismatchError extends Error {
  override name = "CurrencyMismatchError";
}

const digitsCache = new Map<string, number>();

/** Number of minor-unit digits for a currency (USD: 2, JPY: 0, KWD: 3). */
export function minorDigits(currency: string): number {
  let digits = digitsCache.get(currency);
  if (digits === undefined) {
    digits =
      new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
        .maximumFractionDigits ?? 2;
    digitsCache.set(currency, digits);
  }
  return digits;
}

export function money(amount: bigint, currency: string): Money {
  const code = currency.toUpperCase();
  minorDigits(code); // throws RangeError for an invalid currency
  return { amount, currency: code };
}

export function add(a: Money, b: Money): Money {
  if (a.currency !== b.currency) {
    throw new CurrencyMismatchError(`Cannot add ${a.currency} and ${b.currency}`);
  }
  return money(a.amount + b.amount, a.currency);
}

/** Lossless decimal representation: 12345n USD → "123.45" */
export function toDecimalString(m: Money): string {
  const digits = minorDigits(m.currency);
  const negative = m.amount < 0n;
  const abs = (negative ? -m.amount : m.amount).toString().padStart(digits + 1, "0");
  const whole = digits === 0 ? abs : abs.slice(0, -digits);
  const fraction = digits === 0 ? "" : `.${abs.slice(-digits)}`;
  return `${negative ? "-" : ""}${whole}${fraction}`;
}

export function format(m: Money, locale: string): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency: m.currency }).format(
    toDecimalString(m) as `${number}`,
  );
}
EOF
emit packages/domain/src/money/money.test.ts <<'EOF'
import { describe, expect, it } from "vitest";
import { add, CurrencyMismatchError, format, money, toDecimalString } from "./money.ts";

describe("money", () => {
  it("adds amounts in the same currency", () => {
    expect(add(money(10n, "USD"), money(20n, "usd"))).toEqual(money(30n, "USD"));
  });

  it("refuses to add different currencies", () => {
    expect(() => add(money(1n, "USD"), money(1n, "EUR"))).toThrow(CurrencyMismatchError);
  });

  it("respects the currency's minor digits", () => {
    expect(toDecimalString(money(12345n, "USD"))).toBe("123.45");
    expect(toDecimalString(money(12345n, "JPY"))).toBe("12345");
    expect(toDecimalString(money(12345n, "KWD"))).toBe("12.345");
    expect(toDecimalString(money(-5n, "USD"))).toBe("-0.05");
  });

  it("does not lose precision above 2^53", () => {
    expect(toDecimalString(money(9007199254740993n, "USD"))).toBe("90071992547409.93");
  });

  it("formats for a locale", () => {
    expect(format(money(123456n, "USD"), "en-US")).toBe("$1,234.56");
  });
});
EOF

# --- packages/contracts ------------------------------------------------------------------
lib_pkg packages/contracts '{ "zod": "catalog:" }'
emit packages/contracts/src/index.ts <<'EOF'
import { z } from "zod";

export const HealthResponse = z.object({
  status: z.enum(["ok", "degraded"]),
  db: z.enum(["up", "down"]),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

export const FormatPriceRequest = z.object({
  /** Integer amount in minor units, as a string (JSON cannot carry bigint). */
  amount: z.string().regex(/^-?\d+$/, "must be an integer"),
  currency: z.string().length(3),
  locale: z.string().min(2).default("en-US"),
});
export type FormatPriceRequest = z.infer<typeof FormatPriceRequest>;

export const FormatPriceResponse = z.object({ formatted: z.string() });
export type FormatPriceResponse = z.infer<typeof FormatPriceResponse>;
EOF

# --- packages/db -------------------------------------------------------------------------
lib_pkg packages/db \
  '{ "drizzle-orm": "catalog:", "postgres": "catalog:" }' \
  '{ "drizzle-kit": "catalog:" }' \
  '"generate": "drizzle-kit generate", "migrate": "drizzle-kit migrate"'
emit packages/db/drizzle.config.ts <<'EOF'
import { defineConfig } from "drizzle-kit";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  dbCredentials: { url },
});
EOF
emit packages/db/src/schema/index.ts <<'EOF'
// Tables live in this folder, one file per table, re-exported here.
// Example: export * from "./products.ts";
export const schemaVersion = 1;
EOF
emit packages/db/src/index.ts <<'EOF'
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.ts";

export function createDb(url: string) {
  const client = postgres(url, { max: 10 });
  return drizzle({ client, schema });
}

export type Db = ReturnType<typeof createDb>;

export async function ping(db: Db): Promise<void> {
  await db.execute(sql`select 1`);
}

export { schema };
EOF

# --- packages/core -----------------------------------------------------------------------
lib_pkg packages/core \
  '{ "__SCOPE__/contracts": "workspace:*", "__SCOPE__/db": "workspace:*", "__SCOPE__/domain": "workspace:*" }'
emit packages/core/src/index.ts <<'EOF'
export { formatPrice } from "./queries/format-price.ts";
export { checkHealth } from "./queries/health.ts";
EOF
emit packages/core/src/queries/health.ts <<'EOF'
import type { HealthResponse } from "__SCOPE__/contracts";
import { type Db, ping } from "__SCOPE__/db";

export async function checkHealth(db: Db): Promise<HealthResponse> {
  try {
    await ping(db);
    return { status: "ok", db: "up" };
  } catch {
    return { status: "degraded", db: "down" };
  }
}
EOF
emit packages/core/src/queries/format-price.ts <<'EOF'
import type { FormatPriceRequest, FormatPriceResponse } from "__SCOPE__/contracts";
import { format, money } from "__SCOPE__/domain";

export function formatPrice(input: FormatPriceRequest): FormatPriceResponse {
  return { formatted: format(money(BigInt(input.amount), input.currency), input.locale) };
}
EOF

