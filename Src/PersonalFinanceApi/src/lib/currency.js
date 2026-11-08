import HttpError from "../models/httpError.model.js";

// Currencies are ISO 4217 codes (NZD, USD, EUR, ...); a project's is the default for its accounts.
export const DEFAULT_CURRENCY = "NZD";
export function currencyCode(value, what = "currency") {
  const code = String(value || "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) throw new HttpError(400, "ERR-CURRENCY", `${what} is a three-letter code such as NZD, USD or EUR`);
  return code;
}
// Adds currency to each item from a lookup (account or datasource id -> code), falling back to the default.
export function withCurrency(items, currencyOf, fallback = DEFAULT_CURRENCY) {
  return items.map((item) => ({ ...item, currency: item.currency || currencyOf(item) || fallback }));
}
