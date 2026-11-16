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
