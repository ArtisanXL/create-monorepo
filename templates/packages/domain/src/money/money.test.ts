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
