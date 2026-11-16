import type { FormatPriceRequest, FormatPriceResponse } from "__SCOPE__/contracts";
import { format, money } from "__SCOPE__/domain";

export function formatPrice(input: FormatPriceRequest): FormatPriceResponse {
  return { formatted: format(money(BigInt(input.amount), input.currency), input.locale) };
}
